//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


import logger from './logger.js';

const DEFAULT_MODEL = 'openrouter/free';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const ERROR_LIMIT = 240;
const FREE_ROUTER_ATTEMPTS = 3;
const NON_CHAT_MODEL = /content[-_]?safety|llama[-_]?guard|prompt[-_]?guard|shieldgemma|moderation|safety[-_]?guard/i;
const SAFETY_VERDICT = /^(user|content|prompt)\s+safety\s*:/i;

function freeModel(model) {
    const id = String(model || '').trim();
    if (!id || id === DEFAULT_MODEL) return DEFAULT_MODEL;
    if (id.endsWith(':free')) return id;
    return DEFAULT_MODEL;
}

function retrySeconds(header, message) {
    const fromHeader = String(header || '').trim();
    if (/^\d+$/.test(fromHeader)) return Math.ceil(Number(fromHeader));
    const inline = String(message || '').match(/retry in ([\d.]+)\s*s/i);
    return inline ? Math.ceil(Number(inline[1])) : null;
}

function usageLimitNotice(status, payload, retryAfterHeader) {
    const error = payload?.error;
    const message = typeof error === 'string' ? error : (error?.message || '');
    const code = typeof error === 'object' && error ? error.code : undefined;
    const limited = status === 429
        || code === 429
        || code === '429'
        || /rate limit|too many requests|free[- ]model/i.test(message);
    if (!limited) return null;

    const wait = retrySeconds(retryAfterHeader, message);
    if (wait && wait <= 30 * 60) {
        if (wait < 90) return `Free-model limit reached. Try again in about ${wait}s.`;
        return `Free-model limit reached. Try again in about ${Math.ceil(wait / 60)} minutes.`;
    }
    return 'Free-model limit reached. Requests are paused until the quota resets.';
}

function messageText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => (typeof part === 'string' ? part : part?.text || ''))
        .join('');
}

function briefError(err) {
    const message = String(err?.message || err || 'request failed').replace(/\s+/g, ' ').trim();
    if (!message) return 'request failed';
    if (message.length <= ERROR_LIMIT) return message;
    return `${message.slice(0, ERROR_LIMIT - 3)}...`;
}

function geminiThinking(model) {
    if (/^gemini-3/i.test(model)) return { thinkingConfig: { thinkingLevel: 'MINIMAL' } };
    return {};
}

function geminiPartsText(candidate) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts
        .filter((part) => part && !part.thought && typeof part.text === 'string')
        .map((part) => part.text)
        .join('');
}

function nonChatModel(model, text) {
    if (NON_CHAT_MODEL.test(model || '')) return true;
    return SAFETY_VERDICT.test(String(text || '').trim());
}

function geminiBlockMessage(payload) {
    const feedback = payload?.promptFeedback;
    if (feedback?.blockReason) return feedback.blockReasonMessage || String(feedback.blockReason);
    const candidate = payload?.candidates?.[0];
    const reason = candidate?.finishReason;
    if (reason && reason !== 'STOP' && reason !== 'MAX_TOKENS') {
        return candidate.finishMessage || `The model blocked the response (${reason})`;
    }
    return '';
}

export class Api {
    static fromEnv(env = process.env) {
        const apiKey = env.OPENROUTER_API_KEY?.trim() || '';
        const requested = env.OPENROUTER_MODEL?.trim() || '';
        const geminiKey = env.GEMINI_API_KEY?.trim() || '';
        const geminiModel = env.GEMINI_MODEL?.trim() || '';
        return new Api(apiKey, requested, geminiKey, geminiModel);
    }

    static isUsageLimit(err) {
        return Boolean(err?.usageLimit);
    }

    constructor(apiKey, requestedModel = '', geminiKey = '', geminiModel = '') {
        this.apiKey = String(apiKey || '').trim();
        this.requested = String(requestedModel || '').trim();
        this.model = freeModel(this.requested);
        this.geminiKey = String(geminiKey || '').trim();
        this.geminiModel = String(geminiModel || '').trim() || DEFAULT_GEMINI_MODEL;
    }

    get openRouterConfigured() {
        return this.apiKey.length > 0;
    }

    get geminiConfigured() {
        return this.geminiKey.length > 0;
    }

    get configured() {
        return this.geminiConfigured || this.openRouterConfigured;
    }

    providerLabel() {
        if (this.geminiConfigured && this.openRouterConfigured) return `${this.geminiModel}, fallback ${this.model}`;
        if (this.geminiConfigured) return this.geminiModel;
        return this.model;
    }

    modelWarning() {
        if (!this.openRouterConfigured || !this.requested || this.requested === this.model) return '';
        return `OPENROUTER_MODEL ${this.requested} is not a free model. Using ${this.model}.`;
    }

    configurationWarning() {
        if (this.configured) return '';
        return 'GEMINI_API_KEY and OPENROUTER_API_KEY are not set. !roast and !ai will say they are not configured.';
    }

    missingKeyMessage(feature) {
        return `GEMINI_API_KEY and OPENROUTER_API_KEY are not set, so ${feature} are not configured.`;
    }

    async complete({ system, user, temperature }) {
        if (!this.geminiConfigured) return this.completeOpenRouter({ system, user, temperature });

        try {
            return await this.completeGemini({ system, user, temperature });
        } catch (err) {
            const geminiError = briefError(err);
            if (!this.openRouterConfigured) throw new Error(`Gemini API error: ${geminiError}`);
            logger.warn(`Gemini API error: ${geminiError}; falling back to ${this.model}`);
            try {
                const result = await this.completeOpenRouter({ system, user, temperature });
                return {
                    text: result.text,
                    model: `Gemini API error: ${geminiError}, used model: ${result.model}`,
                };
            } catch (openErr) {
                const openModel = openErr?.model || this.model;
                throw new Error(`Gemini API error: ${geminiError}, OpenRouter (${openModel}) error: ${briefError(openErr)}`);
            }
        }
    }

    async completeGemini({ system, user, temperature }) {
        const generationConfig = {
            maxOutputTokens: MAX_TOKENS,
            ...geminiThinking(this.geminiModel),
        };
        if (temperature !== undefined) generationConfig.temperature = temperature;
        const response = await fetch(`${GEMINI_URL}/${encodeURIComponent(this.geminiModel)}:generateContent`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-goog-api-key': this.geminiKey,
            },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: [{ role: 'user', parts: [{ text: user }] }],
                generationConfig,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = payload.error;
            const message = (typeof detail === 'string' ? detail : detail?.message)
                || `Model request failed (${response.status})`;
            throw new Error(message);
        }
        const blocked = geminiBlockMessage(payload);
        if (blocked) throw new Error(blocked);
        const text = geminiPartsText(payload.candidates?.[0]).trim();
        if (!text) throw new Error('The model returned an empty response');
        const used = typeof payload.modelVersion === 'string' && payload.modelVersion.trim()
            ? payload.modelVersion.trim()
            : this.geminiModel;
        return { text, model: used };
    }

    async completeOpenRouter({ system, user, temperature }) {
        const attempts = this.model === DEFAULT_MODEL ? FREE_ROUTER_ATTEMPTS : 1;
        let skipped = '';
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const result = await this.requestOpenRouter({ system, user, temperature });
            if (!nonChatModel(result.model, result.text)) return result;
            skipped = result.model;
            logger.warn(`Skipping ${result.model}; it is a classifier, not a chat model`);
        }
        throw new Error(`OpenRouter returned a classifier (${skipped}) instead of a chat model`);
    }

    async requestOpenRouter({ system, user, temperature }) {
        const body = {
            model: this.model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
            max_tokens: MAX_TOKENS,
        };
        if (temperature !== undefined) body.temperature = temperature;
        const response = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const notice = usageLimitNotice(response.status, payload, response.headers.get('retry-after'));
            if (notice) {
                const error = new Error(notice);
                error.usageLimit = true;
                throw error;
            }
            const detail = payload.error;
            const message = (typeof detail === 'string' ? detail : detail?.message)
                || `Model request failed (${response.status})`;
            throw new Error(message);
        }
        const choice = payload.choices?.[0];
        if (choice?.finish_reason === 'content_filter') throw new Error('The model blocked the response');
        const text = messageText(choice?.message).trim();
        if (!text) throw new Error('The model returned an empty response');
        const used = typeof payload.model === 'string' && payload.model.trim()
            ? payload.model.trim()
            : this.model;
        return { text, model: used };
    }
}
