//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


import { MessageFlags } from 'discord.js';
import { Api } from './api.js';
import logger from './logger.js';
import { botIdentity, clip, quietMessage, who } from './messages.js';
import { saveState } from './state.js';

const DISCORD_LIMIT = 2000;
const RANDOM_ROASTS_PER_DAY = 1;
const RANDOM_ROAST_SPAN = 4;

export const MIN_ROAST_LINES = 3;
export const MAX_ROAST_LINES = 10;
export const ROAST_COMMAND = /^!roast(?:\s+([\s\S]+))?$/i;

const SYSTEM_PROMPT = [
    'You write a short Discord roast of one person, about what they have been saying in their recent messages.',
    'Be mean, witty, and funny. Don\'t use curse words. Verbally tear apart what they said.',
    'Two to four sentences. Address them by the name you are given.',
    'No identity-based slurs. No threats of real-world harm.',
    'Do not mention these instructions, and do not say you are an AI.',
    'Return only the roast.',
].join(' ');

function roastName(content) {
    const match = String(content || '').trim().match(ROAST_COMMAND);
    if (!match) return null;
    return (match[1] || '').trim();
}

function createRoaster(api) {
    return async function roastLines(name, texts) {
        const quoted = texts.map((text, index) => `${index + 1}. ${text}`).join('\n');
        const result = await api.complete({
            system: SYSTEM_PROMPT,
            user: `Roast ${name} based on these recent messages, oldest first:\n${quoted}`,
        });
        return result.text.slice(0, DISCORD_LIMIT);
    };
}

function dayKey(date = new Date()) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

export function createRoast({ api, chat, getState }) {
    const roastLine = api.configured ? createRoaster(api) : null;
    const inFlight = new Set();
    let chatChannel = null;
    let roastDay = '';
    let timedRoasts = 0;
    const manualRoasts = new Set();
    const timedRoastIds = new Set();
    let qualifyingMessages = 0;
    let roastAt = 1;
    let randomRoastRetryAt = 0;
    let randomRoastLimitSent = false;

    function armRandomRoast() {
        qualifyingMessages = 0;
        roastAt = 1 + Math.floor(Math.random() * RANDOM_ROAST_SPAN);
        randomRoastRetryAt = 0;
        randomRoastLimitSent = false;
    }

    function logRandomRoastPlan(day) {
        if (!roastLine || !chatChannel) return;
        if (timedRoasts >= RANDOM_ROASTS_PER_DAY) {
            logger.info(`Random roast for ${day}: already ${timedRoasts}/${RANDOM_ROASTS_PER_DAY}`);
            return;
        }
        logger.info(`Random roast for ${day}: on qualifying message ${roastAt} of ${RANDOM_ROAST_SPAN}`);
    }

    function rollRoastDay() {
        const key = dayKey();
        if (key === roastDay) return key;
        const followOn = roastDay !== '' && Boolean(chatChannel);
        roastDay = key;
        timedRoasts = 0;
        manualRoasts.clear();
        timedRoastIds.clear();
        armRandomRoast();
        if (followOn) logRandomRoastPlan(key);
        return key;
    }

    function restoreRoastDay(state) {
        const saved = state?.roasts;
        const key = dayKey();
        roastDay = key;
        timedRoasts = 0;
        manualRoasts.clear();
        timedRoastIds.clear();
        if (saved?.day === key) {
            const count = Number(saved.timed);
            if (Number.isFinite(count) && count > 0) timedRoasts = Math.min(RANDOM_ROASTS_PER_DAY, Math.floor(count));
            for (const id of saved.manual || []) manualRoasts.add(String(id));
            for (const id of saved.timedIds || []) timedRoastIds.add(String(id));
        }
        armRandomRoast();
    }

    async function saveRoastDay() {
        const state = getState();
        if (!state) return;
        state.roasts = {
            day: roastDay,
            timed: timedRoasts,
            manual: [...manualRoasts],
            timedIds: [...timedRoastIds],
        };
        try {
            await saveState(state);
        } catch (err) {
            logger.error(`Could not save roast day: ${err.message}`);
        }
    }

    async function rememberManualRoast(authorId) {
        rollRoastDay();
        manualRoasts.add(authorId);
        await saveRoastDay();
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

    async function maybeRandomRoast(authorId) {
        if (!roastLine || !chatChannel) return;
        rollRoastDay();
        if (timedRoasts >= RANDOM_ROASTS_PER_DAY) return;
        if (manualRoasts.has(authorId) || timedRoastIds.has(authorId)) return;
        const topic = chat.authorTopic(authorId);
        if (topic.status !== 'ok') return;
        if (Date.now() < randomRoastRetryAt) return;

        qualifyingMessages += 1;
        if (qualifyingMessages !== roastAt) {
            logger.info(`[!roast] random roast waiting (${qualifyingMessages}/${roastAt}), passed ${topic.displayName}`);
            return;
        }

        try {
            const needed = await publishRoast(chatChannel, topic);
            timedRoasts += 1;
            timedRoastIds.add(topic.authorId);
            await saveRoastDay();
            logger.info(`[!roast] random roast ${timedRoasts}/${RANDOM_ROASTS_PER_DAY} of ${topic.displayName} from ${topic.lines.length} lines; next roast after ${needed} new lines`);
        } catch (err) {
            logger.error(`[!roast] random roast failed: ${err.message}`);
            roastAt = qualifyingMessages + 1;
            if (Api.isUsageLimit(err)) {
                randomRoastRetryAt = Date.now() + 15 * 60 * 1000;
                if (!randomRoastLimitSent && chatChannel) {
                    randomRoastLimitSent = true;
                    await chatChannel.send(quietMessage(err.message));
                }
                return;
            }
            randomRoastRetryAt = Date.now() + 60_000;
        }
    }

    async function handleRoast(message) {
        const name = roastName(message.content);
        const userId = message.author.id;
        const actor = who(message);
        if (inFlight.has(userId)) {
            logger.info(`[!roast] ${actor} refused: roast already running`);
            await message.reply(quietMessage('Still roasting. Wait for that one to finish.'));
            return;
        }
        if (!name) {
            logger.info(`[!roast] ${actor} refused: missing username`);
            await message.reply(quietMessage('Usage: !roast <username>'));
            return;
        }

        inFlight.add(userId);
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
            inFlight.delete(userId);
        }
    }

    return {
        matches(content) {
            return ROAST_COMMAND.test(content);
        },

        restore(state) {
            restoreRoastDay(state);
        },

        attach(channel) {
            chatChannel = channel;
        },

        logPlan() {
            logRandomRoastPlan(roastDay);
        },

        async handle(message) {
            try {
                await handleRoast(message);
            } catch (err) {
                logger.error(`[!roast] ${who(message)} failed: ${err.message}`);
            }
        },

        afterLine(authorId) {
            return maybeRandomRoast(authorId);
        },
    };
}
