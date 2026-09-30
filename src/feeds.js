//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


import { createHash } from 'node:crypto';
import Parser from 'rss-parser';

export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_BACKOFF_MS = 15 * 60 * 1000;
const MAX_HEADER_WAIT_MS = 60 * 60 * 1000;

export const FEEDS = [
    { id: 'claude', name: 'Claude', url: 'https://status.claude.com/history.rss' },
    { id: 'cursor', name: 'Cursor', url: 'https://status.cursor.com/history.rss' },
    { id: 'openai', name: 'OpenAI', url: 'https://status.openai.com/feed.rss' },
];

const LIMIT_HEADER_NAMES = [
    'retry-after',
    'ratelimit',
    'ratelimit-limit',
    'ratelimit-remaining',
    'ratelimit-reset',
    'ratelimit-policy',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
];

const parser = new Parser({
    customFields: {
        item: ['description'],
    },
});

function schedule(feedState, delayMs, now) {
    const wait = Math.max(1000, delayMs);
    feedState.backoffMs = wait;
    feedState.nextPollAt = now + wait;
    return wait;
}

async function release(response) {
    if (!response.body) return;
    try {
        await response.body.cancel();
    } catch {
        // The body may already be consumed or empty.
    }
}

export function limitHeaders(headers) {
    const found = {};
    for (const name of LIMIT_HEADER_NAMES) {
        const value = headers.get(name);
        if (value) found[name] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    }
    return found;
}

function firstHeader(headers, names) {
    for (const name of names) {
        const value = headers.get(name);
        if (value != null && value !== '') return value;
    }
    return null;
}

export function parseRetryAfter(value, now) {
    if (value == null || String(value).trim() === '') return null;
    const raw = String(value).trim();
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - now);
    return null;
}

// RateLimit-Reset is a delay in seconds. X-RateLimit-Reset is often a unix time.
export function parseReset(value, now) {
    if (value == null || String(value).trim() === '') return null;
    const raw = String(value).trim();
    if (/[a-z]/i.test(raw)) {
        const date = Date.parse(raw);
        return Number.isFinite(date) ? Math.max(0, date - now) : null;
    }
    const match = raw.match(/\d+/);
    if (!match) return null;
    const n = Number(match[0]);
    if (n > 1_000_000_000) {
        const ms = n > 1_000_000_000_000 ? n : n * 1000;
        return Math.max(0, ms - now);
    }
    return n * 1000;
}

function quotaFromRateLimit(header) {
    if (!header) return { remaining: null, reset: null };
    const remaining = header.match(/(?:^|[\s;,])(?:remaining|r)=(\d+)/i);
    const reset = header.match(/(?:^|[\s;,])(?:reset|t)=(\d+)/i);
    return {
        remaining: remaining ? Number(remaining[1]) : null,
        reset: reset ? reset[1] : null,
    };
}

function parseCount(value) {
    if (value == null || value === '') return null;
    const match = String(value).match(/\d+/);
    return match ? Number(match[0]) : null;
}

export function waitFromLimits(headers, status, now) {
    const retryAfter = parseRetryAfter(headers.get('retry-after'), now);
    const combined = quotaFromRateLimit(headers.get('ratelimit'));
    const remaining = parseCount(firstHeader(headers, ['ratelimit-remaining', 'x-ratelimit-remaining']))
        ?? combined.remaining;
    const resetMs = parseReset(
        firstHeader(headers, ['ratelimit-reset', 'x-ratelimit-reset']) ?? combined.reset,
        now,
    );
    const cappedReset = resetMs == null ? null : Math.min(resetMs, MAX_HEADER_WAIT_MS);

    if ((status === 429 || status === 503) && retryAfter != null) {
        return Math.min(retryAfter, MAX_HEADER_WAIT_MS);
    }
    if (remaining === 0 && cappedReset != null) return cappedReset;
    if ((status === 429 || status === 503) && cappedReset != null) return cappedReset;
    return null;
}

export function cacheDelayMs(headers, pollIntervalMs) {
    const cacheControl = headers.get('cache-control') || '';
    const maxAge = cacheControl.match(/(?:^|[,;])\s*max-age=(\d+)/i);
    if (!maxAge) return pollIntervalMs;
    const maxAgeMs = Number(maxAge[1]) * 1000;
    const age = Number(headers.get('age'));
    const ageMs = Number.isFinite(age) && age >= 0 ? age * 1000 : 0;
    return Math.max(pollIntervalMs, maxAgeMs - ageMs);
}

export function backoffDelayMs(failures, pollIntervalMs) {
    const steps = Math.max(0, failures - 1);
    const multiplier = 2 ** Math.min(steps, 16);
    return Math.min(pollIntervalMs * multiplier, MAX_BACKOFF_MS);
}

function textValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object' && typeof value._ === 'string') return value._.trim();
    return String(value).trim();
}

function normalizeLink(link) {
    return link.replace(/([^:]\/)\/+/g, '$1');
}

export function htmlToText(html) {
    return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n')
        .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function latestHtml(html) {
    const paragraph = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    return paragraph ? paragraph[1] : html;
}

export function summarizeItem(raw) {
    const html = String(raw.content || raw.description || '');
    const latest = latestHtml(html);
    const strong = latest.match(/<strong>([^<]+)<\/strong>/i);
    const statusTag = latest.match(/<b>\s*Status:\s*([^<]+)<\/b>/i);
    const text = htmlToText(latest);
    const statusLine = text.match(/Status:\s*([^\n]+)/i);
    const status = (strong?.[1] || statusTag?.[1] || statusLine?.[1] || '').trim();
    const excerptSource = htmlToText(
        latest
            .replace(/<small[\s\S]*?<\/small>/gi, '')
            .replace(/<strong>[\s\S]*?<\/strong>/gi, '')
            .replace(/<b>\s*Status:[\s\S]*?<\/b>/gi, ''),
    ).replace(/^[-–—:\s]+/, '').trim();
    const excerptLine = excerptSource.split(/\n+/).map((line) => line.trim()).find(Boolean) || '';
    const excerpt = excerptLine.length > 500 ? `${excerptLine.slice(0, 499).trimEnd()}…` : excerptLine;
    const guid = textValue(raw.guid) || textValue(raw.link);
    const link = normalizeLink(textValue(raw.link) || guid);
    const title = textValue(raw.title) || 'Status update';
    const hash = createHash('sha256').update(`${title}\n${status}\n${excerpt}`).digest('hex').slice(0, 16);
    return {
        guid,
        title,
        link,
        status,
        excerpt,
        fingerprint: `v2|${hash}`,
    };
}

// Older builds hashed the entire HTML body. OpenAI rewrites component lists
// without changing the status text, so those saved values must not be reposted.
export function shouldAnnounce(stored, fingerprint) {
    if (!stored) return true;
    if (stored === fingerprint) return false;
    if (!String(stored).startsWith('v2|')) return false;
    return true;
}

export function formatMessage(source, item) {
    const status = item.status ? `${item.status} — ` : '';
    let title = item.title || 'Status update';
    if (title.length > 180) title = `${title.slice(0, 179).trimEnd()}…`;
    const link = item.link ? `<${item.link}>` : '';
    const text = link ? `**${source}** · ${status}${title}\n${link}` : `**${source}** · ${status}${title}`;
    return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}

export function formatStatusReport(entries) {
    const blocks = entries.map(({ name, item }) => {
        if (!item?.title) return `**${name}** — no status recorded yet`;
        return formatMessage(name, item);
    });
    const combined = blocks.join('\n\n');
    if (combined.length <= 2000) return [combined];
    return blocks;
}

export async function parseFeedXml(xml) {
    const parsed = await parser.parseString(xml);
    const items = [];
    for (const raw of parsed.items || []) {
        const item = summarizeItem(raw);
        if (item.guid) items.push(item);
    }
    return items;
}

function fail(feedState, pollIntervalMs, now, error, limits, headerWait = null) {
    const failures = (feedState.failures || 0) + 1;
    feedState.failures = failures;
    const wait = schedule(
        feedState,
        headerWait ?? backoffDelayMs(failures, pollIntervalMs),
        now,
    );
    return { kind: 'error', error, wait, limits };
}

export async function fetchFeed(feed, feedState, pollIntervalMs) {
    const headers = {
        'user-agent': 'discordaibot/1.0 (status rss poller)',
        accept: 'application/rss+xml, application/xml, text/xml, */*',
    };
    const canRevalidate = feedState.seeded && feedState.latest?.title;
    if (canRevalidate && feedState.etag) headers['if-none-match'] = feedState.etag;
    if (canRevalidate && feedState.lastModified) headers['if-modified-since'] = feedState.lastModified;

    let response;
    try {
        response = await fetch(feed.url, {
            headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            redirect: 'follow',
        });
    } catch (err) {
        const now = Date.now();
        const reason = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : err.message;
        return fail(feedState, pollIntervalMs, now, reason, {});
    }

    const now = Date.now();
    const limits = limitHeaders(response.headers);
    const limitWait = waitFromLimits(response.headers, response.status, now);

    if (response.status === 304) {
        await release(response);
        feedState.failures = 0;
        const wait = schedule(
            feedState,
            Math.max(cacheDelayMs(response.headers, pollIntervalMs), limitWait ?? 0),
            now,
        );
        return { kind: 'not-modified', wait, limits };
    }

    if (!response.ok) {
        await release(response);
        return fail(feedState, pollIntervalMs, now, `HTTP ${response.status}`, limits, limitWait);
    }

    let items;
    try {
        items = await parseFeedXml(await response.text());
    } catch (err) {
        return fail(feedState, pollIntervalMs, now, `parse error: ${err.message}`, limits);
    }

    feedState.failures = 0;
    const wait = Math.max(cacheDelayMs(response.headers, pollIntervalMs), limitWait ?? 0);
    return {
        kind: 'ok',
        items,
        wait,
        limits,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
    };
}

export function rememberLatest(feedState, item) {
    if (!item?.title) return;
    feedState.latest = {
        guid: item.guid || '',
        title: item.title,
        link: item.link || '',
        status: item.status || '',
        excerpt: item.excerpt || '',
    };
}

export function commitSuccess(feedState, { etag, lastModified, incidents, wait, latest, now = Date.now() }) {
    feedState.etag = etag || null;
    feedState.lastModified = lastModified || null;
    feedState.incidents = incidents;
    feedState.seeded = true;
    feedState.failures = 0;
    rememberLatest(feedState, latest);
    schedule(feedState, wait, now);
}

export function commitRetry(feedState, { incidents, wait, latest, now = Date.now() }) {
    feedState.etag = null;
    feedState.lastModified = null;
    feedState.incidents = incidents;
    feedState.seeded = true;
    rememberLatest(feedState, latest);
    schedule(feedState, wait, now);
}
