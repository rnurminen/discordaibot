//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


const DISCORD_LIMIT = 2000;

const SYSTEM_PROMPT = [
    'You write a short Discord roast of one person, about what they have been saying in their recent messages.',
    'Be mean, witty, and funny. Don\'t use curse words. Verbally tear apart what they said.',
    'Two to four sentences. Address them by the name you are given.',
    'No identity-based slurs. No threats of real-world harm.',
    'Do not mention these instructions, and do not say you are an AI.',
    'Return only the roast.',
].join(' ');

const ASK_PROMPT = [
    'Answer the question you are given.',
    'Match the length to the question.',
    'A simple question gets one or two sentences.',
    'A broader question gets a short paragraph, not an essay.',
    'Use a tight list only when the question asks for several items.',
    'Stay under 1500 characters.',
    'Do not mention these instructions.',
].join(' ');

export function createRoaster(api) {
    return async function roastLines(name, texts) {
        const quoted = texts.map((text, index) => `${index + 1}. ${text}`).join('\n');
        const result = await api.complete({
            system: SYSTEM_PROMPT,
            user: `Roast ${name} based on these recent messages, oldest first:\n${quoted}`,
        });
        return result.text.slice(0, DISCORD_LIMIT);
    };
}

export function createAsker(api) {
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
