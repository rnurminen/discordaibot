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

import { Client, Events, GatewayIntentBits } from 'discord.js';

import { Api } from './api.js';
import { createChat, isHumanMessage, lineFromMessage, rememberBotMessage, seedChat } from './chat.js';
import { loadConfig } from './config.js';
import logger from './logger.js';
import { fetchTextChannel, who } from './messages.js';
import { createPrompt } from './prompt.js';
import { createRoast } from './roast.js';
import { loadState } from './state.js';
import { createStatus } from './status.js';

let config;
try {
    config = loadConfig();
} catch (err) {
    logger.error(err.message);
    process.exit(1);
}

const api = Api.fromEnv();
const chat = createChat();

let appState = null;
const status = createStatus({
    pollIntervalMs: config.pollIntervalMs,
    getState: () => appState,
});
const roast = createRoast({
    api,
    chat,
    getState: () => appState,
});
const prompt = createPrompt({ api });

let chatQueue = Promise.resolve();

function enqueueChat(task) {
    const run = chatQueue.then(task, task);
    chatQueue = run.then(() => undefined, () => undefined);
    return run;
}

async function handleChatMessage(message) {
    if (!isHumanMessage(message)) {
        rememberBotMessage(chat, message);
        return;
    }
    const content = message.content.trim();
    if (roast.matches(content)) {
        await roast.handle(message);
        return;
    }
    if (prompt.matches(content)) {
        await prompt.handle(message);
        return;
    }
    const line = lineFromMessage(message);
    if (!line) return;
    const recorded = chat.record(line);
    if (!recorded.added) return;
    if (recorded.ready) {
        logger.info(`[chat] ${who(message)} can be roasted again after ${recorded.spoken} lines`);
    }
    await roast.afterLine(line.authorId);
}

async function openChatChannel(readyClient) {
    const channel = await fetchTextChannel(readyClient, config.chatChannelId, 'chat channel');
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
    roast.attach(channel);
    let seeded = 0;
    try {
        seeded = await seedChat(chat, channel);
    } catch (err) {
        logger.error(`Could not read chat history: ${err.message}`);
    }
    const chatName = channel.name ? `#${channel.name}` : config.chatChannelId;
    logger.info(`Chat channel ${chatName}: ${seeded} recent lines loaded`);
    const modelWarning = api.modelWarning();
    if (modelWarning) logger.warn(modelWarning);
    if (api.configured) {
        logger.info(`Chat commands: !roast <username>, !ai <prompt> (${api.model})`);
    } else {
        logger.warn(api.configurationWarning());
    }
    roast.logPlan();
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
    roast.restore(appState);
    const chatStartup = config.chatChannelId
        ? enqueueChat(() => openChatChannel(readyClient))
        : Promise.resolve();
    const channel = await fetchTextChannel(readyClient, config.statusChannelId, 'status channel');
    status.announce(channel, config.statusChannelId);
    if (api.configured) {
        logger.info(`!ai <prompt> in the status channel (${api.model})`);
    } else if (!config.chatChannelId) {
        logger.warn(api.configurationWarning());
    }
    if (!config.chatChannelId) {
        const modelWarning = api.modelWarning();
        if (modelWarning) logger.warn(modelWarning);
    }
    await chatStartup;
    await status.start(channel);
});

client.on(Events.MessageCreate, async (message) => {
    if (config.chatChannelId && message.channelId === config.chatChannelId) {
        enqueueChat(() => handleChatMessage(message));
    }
    if (message.author?.bot || message.channelId !== config.statusChannelId) return;
    const content = message.content.trim();
    if (status.matches(content)) {
        await status.reply(message);
        return;
    }
    if (message.channelId === config.chatChannelId || !prompt.matches(content)) return;
    await prompt.handle(message);
});

client.login(config.token).catch((err) => {
    logger.error(`Login failed: ${err.message}`);
    if (/disallowed intents/i.test(err.message)) {
        logger.error('In the developer portal, open Bot and turn on Message Content Intent under Privileged Gateway Intents, then start the bot again.');
    }
    process.exit(1);
});
