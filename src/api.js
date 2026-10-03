//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


const DEFAULT_MODEL = 'openrouter/free';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 20_000;

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

export class Api {
    static fromEnv(env = process.env) {
        const apiKey = env.OPENROUTER_API_KEY?.trim() || '';
        const requested = env.OPENROUTER_MODEL?.trim() || '';
        return new Api(apiKey, requested);
    }

    static isUsageLimit(err) {
        return Boolean(err?.usageLimit);
    }

    constructor(apiKey, requestedModel = '') {
        this.apiKey = String(apiKey || '').trim();
        this.requested = String(requestedModel || '').trim();
        this.model = freeModel(this.requested);
    }

    get configured() {
        return this.apiKey.length > 0;
    }

    modelWarning() {
        if (!this.requested || this.requested === this.model) return '';
        return `OPENROUTER_MODEL ${this.requested} is not a free model. Using ${this.model}.`;
    }

    configurationWarning() {
        if (this.configured) return '';
        return 'OPENROUTER_API_KEY is not set. !roast and !ai will say they are not configured.';
    }

    missingKeyMessage(feature) {
        return `OPENROUTER_API_KEY is not set, so ${feature} are not configured.`;
    }

    async complete({ system, user }) {
        const response = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
                max_tokens: MAX_TOKENS,
            }),
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
