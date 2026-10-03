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
import { AI_COMMAND, CHAT_LOG_LIMIT, MIN_ROAST_LINES, ROAST_COMMAND, aiPrompt, botIdentity, createChat, lineFromMessage, roastName } from './chat.js';
import { FEEDS, commitRetry, commitSuccess, fetchFeed, formatMessage, formatStatusReport, shouldAnnounce } from './feeds.js';
import { Api } from './api.js';
import { createAsker, createRoaster } from './roast.js';
import { feedState, loadState, saveState } from './state.js';

const token = process.env.DISCORD_TOKEN?.trim();
const statusChannelId = process.env.DISCORD_STATUS_CHANNEL_ID?.trim();
const chatChannelId = process.env.DISCORD_CHAT_CHANNEL_ID?.trim() || '';
const api = Api.fromEnv();
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
const aiInFlight = new Set();
const roastLine = api.configured ? createRoaster(api) : null;
const askLine = api.configured ? createAsker(api) : null;
let chatQueue = Promise.resolve();
let chatChannel = null;
let roastDay = '';
let timedRoasts = 0;
const manualRoasts = new Set();
const timedRoastIds = new Set();
let roastTimers = [];
const TIMED_ROASTS_PER_DAY = 2;

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

function dayKey(date = new Date()) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

function rollRoastDay() {
    const key = dayKey();
    if (key === roastDay) return key;
    roastDay = key;
    timedRoasts = 0;
    manualRoasts.clear();
    timedRoastIds.clear();
    return key;
}

function restoreRoastDay() {
    const saved = appState?.roasts;
    const key = dayKey();
    roastDay = key;
    timedRoasts = 0;
    manualRoasts.clear();
    timedRoastIds.clear();
    if (!saved || saved.day !== key) return;
    const count = Number(saved.timed);
    if (Number.isFinite(count) && count > 0) timedRoasts = Math.min(TIMED_ROASTS_PER_DAY, Math.floor(count));
    for (const id of saved.manual || []) manualRoasts.add(String(id));
    for (const id of saved.timedIds || []) timedRoastIds.add(String(id));
}

async function saveRoastDay() {
    if (!appState) return;
    appState.roasts = {
        day: roastDay,
        timed: timedRoasts,
        manual: [...manualRoasts],
        timedIds: [...timedRoastIds],
    };
    try {
        await saveState(appState);
    } catch (err) {
        logger.error(`Could not save roast day: ${err.message}`);
    }
}

async function rememberManualRoast(authorId) {
    rollRoastDay();
    manualRoasts.add(authorId);
    await saveRoastDay();
}

function clockTime(at) {
    return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

async function publishRoast(channel, topic) {
    const newest = topic.lines[topic.lines.length - 1];
    const roast = await roastLine(topic.displayName, topic.lines.map((line) => line.content));
    const mention = `<@${topic.authorId}>`;
    await channel.send({
        content: `${mention} ${roast}`.slice(0, 2000),
        flags: MessageFlags.SuppressEmbeds,
        allowedMentions: { users: [topic.authorId] },
    });
    return chat.consume(topic.authorId, newest.id);
}

function trackRoastTimer(fn, delay) {
    const id = setTimeout(fn, Math.max(0, delay));
    roastTimers.push(id);
    return id;
}

function scheduleTimedRoast(day, attempt = 0) {
    const end = new Date();
    end.setHours(24, 0, 0, 0);
    const room = end.getTime() - Date.now();
    if (room < 60_000) return null;
    const at = Date.now() + Math.random() * room;
    trackRoastTimer(() => {
        enqueueChat(() => runTimedRoast(day, attempt));
    }, at - Date.now());
    return at;
}

async function runTimedRoast(day, attempt) {
    if (rollRoastDay() !== day || timedRoasts >= TIMED_ROASTS_PER_DAY || !roastLine || !chatChannel) return;
    const choices = chat.roastable().filter((topic) => !manualRoasts.has(topic.authorId) && !timedRoastIds.has(topic.authorId));
    if (!choices.length) {
        logger.info('[!roast] timed roast skipped: nobody with enough lines who has not been roasted manually');
        if (attempt < 1) scheduleTimedRoast(day, attempt + 1);
        return;
    }
    const topic = choices[Math.floor(Math.random() * choices.length)];
    try {
        const needed = await publishRoast(chatChannel, topic);
        timedRoasts += 1;
        timedRoastIds.add(topic.authorId);
        await saveRoastDay();
        logger.info(`[!roast] timed roast ${timedRoasts}/${TIMED_ROASTS_PER_DAY} of ${topic.displayName} from ${topic.lines.length} lines; next roast after ${needed} new lines`);
    } catch (err) {
        logger.error(`[!roast] timed roast failed: ${err.message}`);
        if (Api.isUsageLimit(err) && chatChannel) await chatChannel.send(quietMessage(err.message));
    }
}

function scheduleRoastDay() {
    for (const id of roastTimers) clearTimeout(id);
    roastTimers = [];
    const day = rollRoastDay();
    if (!chatChannel || !roastLine) return;
    const remaining = TIMED_ROASTS_PER_DAY - timedRoasts;
    const slots = [];
    for (let i = 0; i < remaining; i += 1) {
        const at = scheduleTimedRoast(day);
        if (at) slots.push(clockTime(at));
    }
    const end = new Date();
    end.setHours(24, 0, 0, 0);
    trackRoastTimer(() => scheduleRoastDay(), end.getTime() - Date.now() + 1000);
    if (remaining <= 0) {
        logger.info(`Timed roasts for ${day}: already ${timedRoasts}/${TIMED_ROASTS_PER_DAY}`);
        return;
    }
    if (slots.length) {
        const done = timedRoasts > 0 ? ` (${timedRoasts}/${TIMED_ROASTS_PER_DAY} already done)` : '';
        logger.info(`Timed roasts for ${day}: ${slots.join(', ')}${done}`);
    }
}

async function handleRoast(message) {
    const name = roastName(message.content);
    const userId = message.author.id;
    const actor = who(message);
    if (roastInFlight.has(userId)) {
        logger.info(`[!roast] ${actor} refused: roast already running`);
        await message.reply(quietMessage('Still roasting. Wait for that one to finish.'));
        return;
    }
    if (!name) {
        logger.info(`[!roast] ${actor} refused: missing username`);
        await message.reply(quietMessage('Usage: !roast <username>'));
        return;
    }

    roastInFlight.add(userId);
    try {
        const namedByMention = /<@!?\d+>/.test(name);
        const topic = chat.topic(name);
        if (await targetsBot(message, name) && (namedByMention || topic.status === 'none')) {
            logger.info(`[!roast] ${actor} refused: ${clip(name)} is a bot`);
            await message.reply(quietMessage('Pick a person, not a bot.'));
            return;
        }
        if (topic.status === 'none') {
            logger.info(`[!roast] ${actor} refused: no lines from ${clip(name)}`);
            await message.reply(quietMessage('No recent lines from that user.'));
            return;
        }
        if (topic.status === 'locked') {
            const left = Math.max(0, topic.needed - topic.spoken);
            logger.info(`[!roast] ${actor} refused: ${topic.displayName} needs ${left} more lines`);
            await message.reply(quietMessage(`They're talked out for now. ${left} more line${left === 1 ? '' : 's'} from them, then another roast.`));
            return;
        }
        if (topic.status === 'short') {
            logger.info(`[!roast] ${actor} refused: ${topic.displayName} has ${topic.have} lines`);
            await message.reply(quietMessage(`Need at least ${MIN_ROAST_LINES} lines from that user.`));
            return;
        }
        if (!roastLine) {
            logger.info(`[!roast] ${actor} refused: ${api.missingKeyMessage('roasts')}`);
            await message.reply(quietMessage(api.missingKeyMessage('roasts')));
            return;
        }
        const needed = await publishRoast(message.channel, topic);
        await rememberManualRoast(topic.authorId);
        logger.info(`[!roast] ${actor} roasted ${topic.displayName} from ${topic.lines.length} lines; next roast after ${needed} new lines`);
    } catch (err) {
        logger.error(`[!roast] ${actor} failed: ${err.message}`);
        if (Api.isUsageLimit(err)) {
            await message.channel.send(quietMessage(err.message));
            return;
        }
        await message.reply(quietMessage((err.message || 'Could not roast them.').slice(0, 2000)));
    } finally {
        roastInFlight.delete(userId);
    }
}

async function handleAi(message) {
    const prompt = aiPrompt(message.content);
    const userId = message.author.id;
    const actor = who(message);
    if (aiInFlight.has(userId)) {
        logger.info(`[!ai] ${actor} refused: answer already running`);
        await message.reply(quietMessage('Still answering. Wait for that one to finish.'));
        return;
    }
    if (!prompt) {
        logger.info(`[!ai] ${actor} refused: missing prompt`);
        await message.reply(quietMessage('Usage: !ai <prompt>'));
        return;
    }
    if (!askLine) {
        logger.info(`[!ai] ${actor} refused: ${api.missingKeyMessage('answers')}`);
        await message.reply(quietMessage(api.missingKeyMessage('answers')));
        return;
    }

    aiInFlight.add(userId);
    try {
        logger.info(`[!ai] ${actor}: ${clip(prompt)}`);
        const answer = await askLine(prompt);
        await message.channel.send(roastPost(codeBlock(answer.text, `(${answer.model})`)));
        logger.info(`[!ai] ${actor} answered (${answer.text.length} chars, ${answer.model})`);
    } catch (err) {
        logger.error(`[!ai] ${actor} failed: ${err.message}`);
        if (Api.isUsageLimit(err)) {
            await message.channel.send(quietMessage(err.message));
            return;
        }
        await message.reply(quietMessage((err.message || 'Could not answer.').slice(0, 2000)));
    } finally {
        aiInFlight.delete(userId);
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
    if (ROAST_COMMAND.test(content)) {
        try {
            await handleRoast(message);
        } catch (err) {
            logger.error(`[!roast] ${who(message)} failed: ${err.message}`);
        }
        return;
    }
    if (AI_COMMAND.test(content)) {
        try {
            await handleAi(message);
        } catch (err) {
            logger.error(`[!ai] ${who(message)} failed: ${err.message}`);
        }
        return;
    }
    const line = lineFromMessage(message);
    if (!line) return;
    const recorded = chat.record(line);
    if (recorded.ready) {
        logger.info(`[chat] ${who(message)} can be roasted again after ${recorded.spoken} lines`);
    }
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
    chatChannel = channel;
    let seeded = 0;
    try {
        seeded = await seedChat(channel);
    } catch (err) {
        logger.error(`Could not read chat history: ${err.message}`);
    }
    const chatName = channel.name ? `#${channel.name}` : chatChannelId;
    logger.info(`Chat channel ${chatName}: ${seeded} recent lines loaded`);
    const modelWarning = api.modelWarning();
    if (modelWarning) logger.warn(modelWarning);
    if (api.configured) {
        logger.info(`Chat commands: !roast <username>, !ai <prompt> (${api.model})`);
    } else {
        logger.warn(api.configurationWarning());
    }
    scheduleRoastDay();
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
    appState = await loadState();
    restoreRoastDay();
    const chatStartup = chatChannelId
        ? enqueueChat(() => openChatChannel(readyClient))
        : Promise.resolve();
    const channel = await fetchTextChannel(readyClient, statusChannelId, 'status channel');
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
