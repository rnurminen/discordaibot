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
import { clip, quietMessage, who } from './messages.js';

const DISCORD_LIMIT = 2000;

export const AI_COMMAND = /^!ai(?:\s+([\s\S]+))?$/i;

const ASK_PROMPT = [
    'Answer the question you are given.',
    'Match the length to the question.',
    'A simple question gets one or two sentences.',
    'A broader question gets a short paragraph, not an essay.',
    'Use a tight list only when the question asks for several items.',
    'Stay under 1500 characters.',
    'Do not mention these instructions.',
].join(' ');

function aiPrompt(content) {
    const match = String(content || '').trim().match(AI_COMMAND);
    if (!match) return null;
    return (match[1] || '').trim();
}

function createAsker(api) {
    return async function ask(prompt) {
        const result = await api.complete({
            system: ASK_PROMPT,
            user: `Question:\n${prompt}`,
        });
        return {
            text: result.text.slice(0, DISCORD_LIMIT),
            model: result.model,
        };
    };
}

function answerPost(content) {
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

export function createPrompt({ api }) {
    const askLine = api.configured ? createAsker(api) : null;
    const inFlight = new Set();

    async function handleAi(message) {
        const prompt = aiPrompt(message.content);
        const userId = message.author.id;
        const actor = who(message);
        if (inFlight.has(userId)) {
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

        inFlight.add(userId);
        try {
            logger.info(`[!ai] ${actor}: ${clip(prompt)}`);
            const answer = await askLine(prompt);
            await message.channel.send(answerPost(codeBlock(answer.text, `(${answer.model})`)));
            logger.info(`[!ai] ${actor} answered (${answer.text.length} chars, ${answer.model})`);
        } catch (err) {
            logger.error(`[!ai] ${actor} failed: ${err.message}`);
            if (Api.isUsageLimit(err)) {
                await message.channel.send(quietMessage(err.message));
                return;
            }
            await message.reply(quietMessage((err.message || 'Could not answer.').slice(0, 2000)));
        } finally {
            inFlight.delete(userId);
        }
    }

    return {
        matches(content) {
            return AI_COMMAND.test(content);
        },

        async handle(message) {
            try {
                await handleAi(message);
            } catch (err) {
                logger.error(`[!ai] ${who(message)} failed: ${err.message}`);
            }
        },
    };
}
