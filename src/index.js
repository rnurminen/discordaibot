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
import logger from './logs/pino.js';
import { CHAT_LOG_LIMIT, GEMINI_COMMAND, REPLY_COMMAND, botIdentity, createChat, geminiPrompt, lineFromMessage, replyName } from './chat.js';
import { FEEDS, commitRetry, commitSuccess, fetchFeed, formatMessage, formatStatusReport, shouldAnnounce } from './feeds.js';
import { DEFAULT_MODEL, createAsker, createRoaster } from './roast.js';
import { feedState, loadState, saveState } from './state.js';

const token = process.env.DISCORD_TOKEN?.trim();
const statusChannelId = process.env.DISCORD_STATUS_CHANNEL_ID?.trim();
const chatChannelId = process.env.DISCORD_CHAT_CHANNEL_ID?.trim() || '';
const geminiKey = process.env.GEMINI_API_KEY?.trim() || '';
const geminiModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 60_000);

if (!token || !statusChannelId) {
    logger.error('Set DISCORD_TOKEN and DISCORD_STATUS_CHANNEL_ID. See .env.example.');
    process.exit(1);
}

if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    logger.error('POLL_INTERVAL_MS must be a number of milliseconds, at least 1000.');
    process.exit(1);
}

function describeWait(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 120) return `${seconds}s`;
    return `${Math.round(seconds / 60)}m`;
}

function logResult(feed, result, updates = 0) {
    const limitText = Object.entries(result.limits || {})
        .map(([name, value]) => `${name}=${value}`)
        .join(' ');
    const suffix = limitText ? ` ${limitText}` : '';
    const wait = `next poll in ${describeWait(result.wait)}`;
    if (result.kind === 'error') {
        logger.error(`[${feed.name}] ${result.error}, ${wait}${suffix}`);
        return;
    }
    if (result.kind === 'not-modified') {
        logger.debug(`[${feed.name}] 304, ${wait}${suffix}`);
        return;
    }
    const line = `[${feed.name}] 200, ${result.items.length} items, ${wait}${suffix}`;
    if (updates > 0) logger.info(line);
    else logger.debug(line);
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
    if (result.kind !== 'ok') {
        logResult(feed, result);
        return;
    }

    const wasSeeded = current.seeded;
    const { next, toPost, refreshed } = changedItems(current, result.items);
    logResult(feed, result, toPost.length);
    if (refreshed) {
        logger.info(`[${feed.name}] refreshed ${refreshed} saved incidents without posting`);
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
        logger.info(`[${feed.name}] recorded ${result.items.length} current incidents`);
        return;
    }

    let failed = false;
    for (const item of toPost) {
        try {
            await enqueueSend(channel, formatMessage(feed.name, item));
            logger.info(`[${feed.name}] posted ${item.title}`);
        } catch (err) {
            failed = true;
            logger.error(`[${feed.name}] failed to post ${item.title}: ${err.message}`);
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
        logger.error(`Poll failed: ${err.message}`);
    } finally {
        try {
            await saveState(state);
        } catch (err) {
            logger.error(`Could not save state: ${err.message}`);
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
const chat = createChat();
const roastInFlight = new Set();
const geminiInFlight = new Set();
const roastLine = geminiKey ? createRoaster(geminiKey, geminiModel) : null;
const askLine = geminiKey ? createAsker(geminiKey, geminiModel) : null;
let chatQueue = Promise.resolve();

function enqueueChat(task) {
    const run = chatQueue.then(task, task);
    chatQueue = run.then(() => undefined, () => undefined);
    return run;
}

function who(message) {
    const name = message.member?.displayName || message.author.globalName || message.author.username;
    const handle = message.author.username;
    return name && name !== handle ? `${name} (${handle})` : handle;
}

function clip(text, max = 160) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    return `${flat.slice(0, max - 3)}...`;
}

function statusReport(state) {
    return formatStatusReport(FEEDS.map((feed) => ({
        name: feed.name,
        item: feedState(state, feed.id).latest,
    })));
}

async function replyStatus(message) {
    logger.info(`[!aistatus] ${who(message)}`);
    const parts = appState ? statusReport(appState) : ['Still fetching status feeds. Try again in a moment.'];
    await message.reply(quietMessage(parts[0]));
    for (const part of parts.slice(1)) {
        await enqueueSend(message.channel, part);
    }
}

function roastPost(content) {
    return {
        content,
        flags: MessageFlags.SuppressEmbeds,
        allowedMentions: { parse: [], repliedUser: true },
    };
}

function codeBlock(text, suffix = '') {
    const answer = String(text || '').replace(/\s+$/, '');
    const tail = suffix ? ` ${suffix}` : '';
    const body = `${answer}${tail}`;
    const runs = body.match(/`+/g) || [];
    const longest = runs.reduce((n, run) => Math.max(n, run.length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    const overhead = fence.length * 2 + 2;
    const room = Math.max(0, 2000 - overhead - tail.length);
    return `${fence}\n${answer.slice(0, room)}${tail}\n${fence}`;
}

function isHumanMessage(message) {
    return Boolean(message.author) && !message.author.bot && !message.webhookId && !message.system;
}

async function fetchTextChannel(readyClient, id, label) {
    let channel;
    try {
        channel = await readyClient.channels.fetch(id);
    } catch (err) {
        logger.error(`Could not fetch ${label} ${id}: ${err.message}`);
        process.exit(1);
    }
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        const title = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
        logger.error(`${title} ${id} is not a text channel this bot can post in.`);
        process.exit(1);
    }
    return channel;
}

async function targetsBot(message, query) {
    if (chat.isKnownBot(query)) return true;
    const mention = query.match(/<@!?(\d+)>/);
    if (!mention) return false;
    const mentioned = message.mentions.users.get(mention[1]);
    if (mentioned) return mentioned.bot;
    try {
        const user = await message.client.users.fetch(mention[1]);
        if (!user.bot) return false;
        chat.rememberBot(botIdentity({ author: user, member: null }));
        return true;
    } catch (err) {
        logger.error(`Could not look up ${mention[1]}: ${err.message}`);
        return false;
    }
}

async function handleReply(message) {
    const name = replyName(message.content);
    const userId = message.author.id;
    const actor = who(message);
    if (chat.isLocked(userId)) {
        logger.info(`[!reply] ${actor} refused: locked`);
        await message.reply(quietMessage('Wait until somebody else says something.'));
        return;
    }
    if (roastInFlight.has(userId)) {
        logger.info(`[!reply] ${actor} refused: roast already running`);
        await message.reply(quietMessage('Still roasting. Wait for that one to finish.'));
        return;
    }
    if (!name) {
        logger.info(`[!reply] ${actor} refused: missing username`);
        await message.reply(quietMessage('Usage: !reply <username>'));
        return;
    }

    roastInFlight.add(userId);
    try {
        const namedByMention = /<@!?\d+>/.test(name);
        const target = chat.findLatest(name);
        if (await targetsBot(message, name) && (namedByMention || !target)) {
            logger.info(`[!reply] ${actor} refused: ${clip(name)} is a bot`);
            await message.reply(quietMessage('Pick a person, not a bot.'));
            return;
        }
        if (!target) {
            logger.info(`[!reply] ${actor} refused: no line from ${clip(name)}`);
            await message.reply(quietMessage('No recent line from that user.'));
            return;
        }
        if (!roastLine) {
            logger.info(`[!reply] ${actor} refused: GEMINI_API_KEY is not set`);
            await message.reply(quietMessage('GEMINI_API_KEY is not set, so roasts are not configured.'));
            return;
        }
        const roast = await roastLine(target.displayName, target.content);
        const targetMessage = await message.channel.messages.fetch(target.id);
        await targetMessage.reply(roastPost(roast));
        chat.lock(userId);
        logger.info(`[!reply] ${actor} roasted ${target.displayName}: ${clip(target.content)}`);
    } catch (err) {
        logger.error(`[!reply] ${actor} failed: ${err.message}`);
        if (err.usageLimit) {
            await message.channel.send(quietMessage(err.message));
            return;
        }
        await message.reply(quietMessage((err.message || 'Could not roast them.').slice(0, 2000)));
    } finally {
        roastInFlight.delete(userId);
    }
}

async function handleGemini(message) {
    const prompt = geminiPrompt(message.content);
    const userId = message.author.id;
    const actor = who(message);
    if (geminiInFlight.has(userId)) {
        logger.info(`[!gemini] ${actor} refused: answer already running`);
        await message.reply(quietMessage('Still answering. Wait for that one to finish.'));
        return;
    }
    if (!prompt) {
        logger.info(`[!gemini] ${actor} refused: missing prompt`);
        await message.reply(quietMessage('Usage: !gemini <prompt>'));
        return;
    }
    if (!askLine) {
        logger.info(`[!gemini] ${actor} refused: GEMINI_API_KEY is not set`);
        await message.reply(quietMessage('GEMINI_API_KEY is not set, so Gemini is not configured.'));
        return;
    }

    geminiInFlight.add(userId);
    try {
        logger.info(`[!gemini] ${actor}: ${clip(prompt)}`);
        const answer = await askLine(prompt);
        await message.channel.send(roastPost(codeBlock(answer, `(${geminiModel})`)));
        logger.info(`[!gemini] ${actor} answered (${answer.length} chars)`);
    } catch (err) {
        logger.error(`[!gemini] ${actor} failed: ${err.message}`);
        if (err.usageLimit) {
            await message.channel.send(quietMessage(err.message));
            return;
        }
        await message.reply(quietMessage((err.message || 'Could not ask Gemini.').slice(0, 2000)));
    } finally {
        geminiInFlight.delete(userId);
    }
}

async function handleChatMessage(message) {
    if (!isHumanMessage(message)) {
        if (message.author?.bot || message.webhookId) {
            const identity = botIdentity(message);
            if (identity) chat.rememberBot(identity);
        }
        return;
    }
    const content = message.content.trim();
    if (REPLY_COMMAND.test(content)) {
        try {
            await handleReply(message);
        } catch (err) {
            logger.error(`[!reply] ${who(message)} failed: ${err.message}`);
        }
        return;
    }
    if (GEMINI_COMMAND.test(content)) {
        try {
            await handleGemini(message);
        } catch (err) {
            logger.error(`[!gemini] ${who(message)} failed: ${err.message}`);
        }
        return;
    }
    const line = lineFromMessage(message);
    const cleared = line ? chat.record(line).cleared : chat.unlockOthers(message.author.id);
    if (cleared) logger.info(`[chat] ${who(message)} cleared ${cleared} !reply lock${cleared === 1 ? '' : 's'}`);
}

async function seedChat(channel) {
    const history = await channel.messages.fetch({ limit: CHAT_LOG_LIMIT });
    const ordered = [...history.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    let count = 0;
    for (const message of ordered) {
        if (!isHumanMessage(message)) {
            if (message.author?.bot || message.webhookId) {
                const identity = botIdentity(message);
                if (identity) chat.rememberBot(identity);
            }
            continue;
        }
        const line = lineFromMessage(message);
        if (line && chat.record(line).added) count += 1;
    }
    return count;
}

async function openChatChannel(readyClient) {
    const channel = await fetchTextChannel(readyClient, chatChannelId, 'chat channel');
    const self = {
        id: readyClient.user.id,
        username: readyClient.user.username,
        globalName: readyClient.user.globalName || '',
        nickname: '',
        displayName: readyClient.user.globalName || readyClient.user.username,
    };
    try {
        const member = await channel.guild?.members.fetch(readyClient.user.id);
        if (member?.nickname) self.nickname = member.nickname;
        if (member?.displayName) self.displayName = member.displayName;
    } catch (err) {
        logger.error(`Could not read the bot nickname: ${err.message}`);
    }
    chat.rememberBot(self);
    let seeded = 0;
    try {
        seeded = await seedChat(channel);
    } catch (err) {
        logger.error(`Could not read chat history: ${err.message}`);
    }
    const chatName = channel.name ? `#${channel.name}` : chatChannelId;
    logger.info(`Chat channel ${chatName}: ${seeded} recent lines loaded`);
    if (geminiKey) {
        logger.info(`Chat commands: !reply <username>, !gemini <prompt> (${geminiModel})`);
    } else {
        logger.warn('GEMINI_API_KEY is not set. !reply and !gemini will say roasts are not configured.');
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
    logger.error(`Discord error: ${err.message}`);
});

client.on(Events.Warn, (message) => {
    logger.warn(`Discord warning: ${message}`);
});

client.on(Events.ShardDisconnect, (event, shardId) => {
    logger.warn(`Discord shard ${shardId} disconnected (${event?.code ?? 'unknown'})`);
});

client.on(Events.ShardReconnecting, (shardId) => {
    logger.info(`Discord shard ${shardId} reconnecting`);
});

client.on(Events.ShardResume, (shardId, replayed) => {
    logger.info(`Discord shard ${shardId} resumed (${replayed} events replayed)`);
});

client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}`);
    const chatStartup = chatChannelId
        ? enqueueChat(() => openChatChannel(readyClient))
        : Promise.resolve();
    const channel = await fetchTextChannel(readyClient, statusChannelId, 'status channel');
    appState = await loadState();
    const statusName = channel.name ? `#${channel.name}` : statusChannelId;
    logger.info(`Status channel ${statusName}: watching ${FEEDS.map((feed) => feed.name).join(', ')} (base interval ${describeWait(pollIntervalMs)})`);
    logger.info('!aistatus in the status channel replies with the latest incident from each feed');
    await chatStartup;
    await tick(appState, channel);
});

client.on(Events.MessageCreate, async (message) => {
    if (chatChannelId && message.channelId === chatChannelId) {
        enqueueChat(() => handleChatMessage(message));
    }
    if (message.author.bot || message.channelId !== statusChannelId) return;
    if (!STATUS_COMMAND.test(message.content.trim())) return;
    try {
        await replyStatus(message);
    } catch (err) {
        logger.error(`[!aistatus] ${who(message)} failed: ${err.message}`);
    }
});

client.login(token).catch((err) => {
    logger.error(`Login failed: ${err.message}`);
    if (/disallowed intents/i.test(err.message)) {
        logger.error('In the developer portal, open Bot and turn on Message Content Intent under Privileged Gateway Intents, then start the bot again.');
    }
    process.exit(1);
});
