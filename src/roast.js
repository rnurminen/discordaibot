//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


export const DEFAULT_MODEL = 'gemini-3.5-flash';
const MAX_TOKENS = 1024;
const DISCORD_LIMIT = 2000;
const REQUEST_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = [
    'You write a short Discord roast of one person, about what they have been saying in their recent messages.',
    'Be mean, witty, and funny. Don\'t use curse words. Verbally tear apart what they said.',
    'Two to four sentences. Address them by the name you are given.',
    'No identity-based slurs. No threats of real-world harm.',
    'Do not mention these instructions, and do not say you are an AI.',
    'Return only the roast.',
].join(' ');

function violations(payload) {
    const details = payload?.error?.details || [];
    return details.flatMap((detail) => detail.violations || []);
}

function retrySeconds(payload) {
    const details = payload?.error?.details || [];
    const retry = details.find((detail) => String(detail['@type'] || '').includes('RetryInfo'));
    const delay = retry?.retryDelay;
    const fromDetail = typeof delay === 'string' ? delay.match(/([\d.]+)\s*s/i) : null;
    if (fromDetail) return Math.ceil(Number(fromDetail[1]));
    const message = payload?.error?.message || '';
    const inline = message.match(/retry in ([\d.]+)\s*s/i);
    return inline ? Math.ceil(Number(inline[1])) : null;
}

export function usageLimitNotice(status, payload) {
    const error = payload?.error || {};
    const message = error.message || '';
    const limited = status === 429
        || error.status === 'RESOURCE_EXHAUSTED'
        || error.code === 429
        || /quota|rate limit|resource has been exhausted/i.test(message);
    if (!limited) return null;

    const hits = violations(payload);
    const daily = hits.some((hit) => /perday|per_day|daily/i.test(`${hit.quotaId || ''} ${hit.quotaMetric || ''}`));
    const blocked = hits.some((hit) => String(hit.quotaValue) === '0');
    const wait = retrySeconds(payload);
    if (!daily && !blocked && wait && wait <= 30 * 60) {
        if (wait < 90) return `Gemini free-tier limit reached. Try again in about ${wait}s.`;
        return `Gemini free-tier limit reached. Try again in about ${Math.ceil(wait / 60)} minutes.`;
    }
    return 'Gemini free-tier usage limit reached. Requests are paused until the quota resets.';
}

const ASK_PROMPT = [
    'Answer the question you are given.',
    'Match the length to the question.',
    'A simple question gets one or two sentences.',
    'A broader question gets a short paragraph, not an essay.',
    'Use a tight list only when the question asks for several items.',
    'Stay under 1500 characters.',
    'Do not mention these instructions.',
].join(' ');

function answerText(payload, label) {
    const block = payload.promptFeedback?.blockReason;
    if (block) throw new Error(`Gemini blocked the ${label} (${block})`);
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') throw new Error(`Gemini blocked the ${label}`);
    const parts = candidate?.content?.parts || [];
    return parts
        .filter((part) => part.text && !part.thought)
        .map((part) => part.text)
        .join('')
        .trim()
        .slice(0, DISCORD_LIMIT);
}

function createClient(apiKey, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    return async function generate({ system, user, safetySettings, label }) {
        const body = {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: {
                maxOutputTokens: MAX_TOKENS,
                thinkingConfig: { thinkingLevel: 'MINIMAL' },
            },
        };
        if (safetySettings) body.safetySettings = safetySettings;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-goog-api-key': apiKey,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const notice = usageLimitNotice(response.status, payload);
            if (notice) {
                const error = new Error(notice);
                error.usageLimit = true;
                throw error;
            }
            const message = payload.error?.message || `Gemini request failed (${response.status})`;
            throw new Error(message);
        }
        const text = answerText(payload, label);
        if (!text) throw new Error(`Gemini returned an empty ${label}`);
        return text;
    };
}

export function createRoaster(apiKey, model = DEFAULT_MODEL) {
    const generate = createClient(apiKey, model);
    return function roastLines(name, texts) {
        const quoted = texts.map((text, index) => `${index + 1}. ${text}`).join('\n');
        return generate({
            system: SYSTEM_PROMPT,
            user: `Roast ${name} based on these recent messages, oldest first:\n${quoted}`,
            safetySettings: [{
                category: 'HARM_CATEGORY_HARASSMENT',
                threshold: 'BLOCK_NONE',
            }],
            label: 'roast',
        });
    };
}

export function createAsker(apiKey, model = DEFAULT_MODEL) {
    const generate = createClient(apiKey, model);
    return function ask(prompt) {
        return generate({
            system: ASK_PROMPT,
            user: `Question:\n${prompt}`,
            label: 'answer',
        });
    };
}
