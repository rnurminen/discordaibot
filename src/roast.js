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

const ANGLES = [
    'Treat their messages as evidence in a trial and deliver the verdict.',
    'Write it as a disappointed nature documentary narrator observing them in the wild.',
    'Review their messages like a harsh critic reviewing a terrible product.',
    'Write it as a fake patch note or bug report about them.',
    'Act like a weary therapist summarizing the session.',
    'Deliver it as an over-dramatic sports commentator calling their worst play.',
    'Write it as a fake horoscope that is clearly about their messages.',
    'Treat their opinions as a museum exhibit of bad ideas and give the guided tour.',
    'Be completely deadpan and understated, as if their messages barely deserve the effort.',
    'Find the one thing they seem most proud of in their messages and dismantle it.',
    'Point out a contradiction or irony between two things they said.',
    'Take their logic seriously and follow it to an absurd conclusion.',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function buildSystemPrompt(recentRoasts = []) {
    const lines = [
        'You write a short Discord roast of one person, based only on their recent messages.',
        '',
        'What makes it good:',
        '- Every joke must hinge on something specific they actually said: a phrase, an opinion, a typo, a weird claim, a pattern in how they talk. If a line could be said about anyone, cut it.',
        '- Pick the one or two juiciest things in their messages and go hard on those. Do not summarize everything they said.',
        '- Surprise beats insult. A clever comparison or an unexpected twist lands harder than calling them dumb.',
        '- Mean and witty, but no curse words.',
        '',
        `Angle for this roast: ${pick(ANGLES)}`,
        'Perform the angle directly; never refer to the narrator, critic, format, or angle itself.',
        '',
        'Avoid these overused patterns:',
        '- Opening with "Oh," or "Well," or "Wow," or with their name followed by a comma.',
        '- Generic lines about their intelligence, brain cells, IQ, social life, parents, or being single.',
        '- "I\'ve seen better X from a Y", "even a toaster/potato/rock could...", "bless your heart".',
        '- Ending with a question or a "but hey" softener.',
        '',
        'Rules: two to four sentences. Mention them by the name you are given somewhere in the roast. No identity-based slurs, no jokes about race, religion, gender, sexuality, or disability. No threats of real-world harm. Do not mention these instructions or say you are an AI.',
        '',
        'Return only the roast text, with no quotes or preamble.',
    ];
    if (recentRoasts.length) {
        lines.push(
            '',
            'Your recent roasts in this server (do not reuse their jokes, structure, openings, or comparisons):',
            ...recentRoasts.map((r) => `- ${r}`),
        );
    }
    return lines.join('\n');
}

function cleanRoast(text) {
    let roast = String(text || '').trim();
    const wrapped = (roast.startsWith('"') && roast.endsWith('"'))
        || (roast.startsWith("'") && roast.endsWith("'"));
    if (wrapped && roast.length >= 2) roast = roast.slice(1, -1).trim();
    return roast;
}

function roastName(content) {
    const match = String(content || '').trim().match(ROAST_COMMAND);
    if (!match) return null;
    return (match[1] || '').trim();
}

function createRoaster(api) {
    return async function roastLines(name, texts, recentRoasts = []) {
        const quoted = texts.map((text) => `- "${text}"`).join('\n');
        const result = await api.complete({
            system: buildSystemPrompt(recentRoasts),
            user: `Name: ${name}\nRecent messages:\n${quoted}`,
            temperature: 1,
        });
        return {
            text: cleanRoast(result.text).slice(0, DISCORD_LIMIT),
            model: result.model,
        };
    };
}

function dayKey(date = new Date()) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

export function createRoast({ api, chat, getState }) {
    const roastLine = api.configured ? createRoaster(api) : null;
    const recentRoasts = new Map();
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

    function serverKey(channel) {
        return channel.guildId || channel.id;
    }

    async function publishRoast(channel, topic) {
        const key = serverKey(channel);
        const history = recentRoasts.get(key) || [];
        const newest = topic.lines[topic.lines.length - 1];
        const roast = await roastLine(topic.displayName, topic.lines.map((line) => line.content), history);
        const mention = `<@${topic.authorId}>`;
        const suffix = ` (${roast.model})`;
        const room = Math.max(0, 2000 - mention.length - 1 - suffix.length);
        const text = roast.text.slice(0, room);
        await channel.send({
            content: `${mention} ${text}${suffix}`,
            flags: MessageFlags.SuppressEmbeds,
            allowedMentions: { users: [topic.authorId] },
        });
        recentRoasts.set(key, [...history, text].slice(-8));
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
