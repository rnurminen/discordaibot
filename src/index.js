//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


import 'dotenv/config';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { FEEDS, commitRetry, commitSuccess, fetchFeed, formatMessage, formatStatusReport, shouldAnnounce } from './feeds.js';
import { feedState, loadState, saveState } from './state.js';

const token = process.env.DISCORD_TOKEN?.trim();
const channelId = process.env.DISCORD_CHANNEL_ID?.trim();
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 60_000);

if (!token || !channelId) {
    console.error('Set DISCORD_TOKEN and DISCORD_CHANNEL_ID. See .env.example.');
    process.exit(1);
}

if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    console.error('POLL_INTERVAL_MS must be a number of milliseconds, at least 1000.');
    process.exit(1);
}

function describeWait(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 120) return `${seconds}s`;
    return `${Math.round(seconds / 60)}m`;
}

function logResult(feed, result) {
    const limitText = Object.entries(result.limits || {})
        .map(([name, value]) => `${name}=${value}`)
        .join(' ');
    const suffix = limitText ? ` ${limitText}` : '';
    const wait = `next poll in ${describeWait(result.wait)}`;
    if (result.kind === 'error') {
        console.error(`[${feed.name}] ${result.error}, ${wait}${suffix}`);
        return;
    }
    if (result.kind === 'not-modified') {
        console.log(`[${feed.name}] 304, ${wait}${suffix}`);
        return;
    }
    console.log(`[${feed.name}] 200, ${result.items.length} items, ${wait}${suffix}`);
}

let sendQueue = Promise.resolve();

function quietMessage(content) {
    return { content, flags: MessageFlags.SuppressEmbeds };
}

function enqueueSend(channel, content) {
    const pending = sendQueue.then(() => channel.send(quietMessage(content)));
    sendQueue = pending.then(() => undefined, () => undefined);
    return pending;
}

function changedItems(current, items) {
    const next = {};
    const toPost = [];
    let refreshed = 0;
    for (const item of items) {
        next[item.guid] = item.fingerprint;
        const stored = current.incidents[item.guid];
        if (current.seeded && typeof stored === 'string' && !stored.startsWith('v2|')) refreshed += 1;
        if (current.seeded && shouldAnnounce(stored, item.fingerprint)) toPost.push(item);
    }
    return { next, toPost, refreshed };
}

async function pollFeed(feed, state, channel) {
    const current = feedState(state, feed.id);
    const result = await fetchFeed(feed, current, pollIntervalMs);
    logResult(feed, result);
    if (result.kind !== 'ok') return;

    const wasSeeded = current.seeded;
    const { next, toPost, refreshed } = changedItems(current, result.items);
    if (refreshed) {
        console.log(`[${feed.name}] refreshed ${refreshed} saved incidents without posting`);
    }
    const latest = result.items[0];
    if (!wasSeeded) {
        commitSuccess(current, {
            etag: result.etag,
            lastModified: result.lastModified,
            incidents: next,
            wait: result.wait,
            latest,
        });
        console.log(`[${feed.name}] recorded ${result.items.length} current incidents`);
        return;
    }

    let failed = false;
    for (const item of toPost) {
        try {
            await enqueueSend(channel, formatMessage(feed.name, item));
            console.log(`[${feed.name}] posted ${item.title}`);
        } catch (err) {
            failed = true;
            console.error(`[${feed.name}] failed to post ${item.title}: ${err.message}`);
            if (current.incidents[item.guid]) next[item.guid] = current.incidents[item.guid];
            else delete next[item.guid];
        }
    }

    if (failed) {
        commitRetry(current, { incidents: next, wait: result.wait, latest });
        return;
    }

    commitSuccess(current, {
        etag: result.etag,
        lastModified: result.lastModified,
        incidents: next,
        wait: result.wait,
        latest,
    });
}

async function tick(state, channel) {
    try {
        const now = Date.now();
        const due = FEEDS.filter((feed) => feedState(state, feed.id).nextPollAt <= now);
        await Promise.all(due.map((feed) => pollFeed(feed, state, channel)));
    } catch (err) {
        console.error(`Poll failed: ${err.message}`);
    } finally {
        try {
            await saveState(state);
        } catch (err) {
            console.error(`Could not save state: ${err.message}`);
        }
        const nextAt = Math.min(...FEEDS.map((feed) => feedState(state, feed.id).nextPollAt));
        const delay = Math.max(1000, nextAt - Date.now());
        setTimeout(() => {
            tick(state, channel);
        }, delay);
    }
}

const STATUS_COMMAND = /^!aistatus(?:\s|$)/i;

let appState = null;

function statusReport(state) {
    return formatStatusReport(FEEDS.map((feed) => ({
        name: feed.name,
        item: feedState(state, feed.id).latest,
    })));
}

async function replyStatus(message) {
    const parts = appState ? statusReport(appState) : ['Still fetching status feeds. Try again in a moment.'];
    await message.reply(quietMessage(parts[0]));
    for (const part of parts.slice(1)) {
        await enqueueSend(message.channel, part);
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.on(Events.Error, (err) => {
    console.error(`Discord error: ${err.message}`);
});

client.once(Events.ClientReady, async (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
    let channel;
    try {
        channel = await readyClient.channels.fetch(channelId);
    } catch (err) {
        console.error(`Could not fetch channel ${channelId}: ${err.message}`);
        process.exit(1);
    }
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        console.error(`Channel ${channelId} is not a text channel this bot can post in.`);
        process.exit(1);
    }
    appState = await loadState();
    console.log(`Watching ${FEEDS.map((feed) => feed.name).join(', ')} (base interval ${describeWait(pollIntervalMs)})`);
    console.log('!aistatus in that channel replies with the latest incident from each feed');
    await tick(appState, channel);
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || message.channelId !== channelId) return;
    if (!STATUS_COMMAND.test(message.content.trim())) return;
    try {
        await replyStatus(message);
    } catch (err) {
        console.error(`Failed to reply to !aistatus: ${err.message}`);
    }
});

client.login(token).catch((err) => {
    console.error(`Login failed: ${err.message}`);
    if (/disallowed intents/i.test(err.message)) {
        console.error('In the developer portal, open Bot and turn on Message Content Intent under Privileged Gateway Intents, then start the bot again.');
    }
    process.exit(1);
});
