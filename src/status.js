//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


import {
    FEEDS,
    commitRetry,
    commitSuccess,
    fetchFeed,
    formatMessage,
    formatStatusReport,
    shouldAnnounce,
} from './feeds.js';
import logger from './logger.js';
import { quietMessage, who } from './messages.js';
import { feedState, saveState } from './state.js';

const STATUS_COMMAND = /^!aistatus(?:\s|$)/i;

function describeWait(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 120) return `${seconds}s`;
    return `${Math.round(seconds / 60)}m`;
}

export function createStatus({ pollIntervalMs, getState }) {
    let sendQueue = Promise.resolve();

    function enqueueSend(channel, content) {
        const pending = sendQueue.then(() => channel.send(quietMessage(content)));
        sendQueue = pending.then(() => undefined, () => undefined);
        return pending;
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

    function statusReport(state) {
        return formatStatusReport(FEEDS.map((feed) => ({
            name: feed.name,
            item: feedState(state, feed.id).latest,
        })));
    }

    return {
        matches(content) {
            return STATUS_COMMAND.test(content);
        },

        announce(channel, channelId) {
            const statusName = channel.name ? `#${channel.name}` : channelId;
            logger.info(`Status channel ${statusName}: watching ${FEEDS.map((feed) => feed.name).join(', ')} (base interval ${describeWait(pollIntervalMs)})`);
            logger.info('!aistatus in the status channel replies with the latest incident from each feed');
        },

        start(channel) {
            return tick(getState(), channel);
        },

        async reply(message) {
            try {
                logger.info(`[!aistatus] ${who(message)}`);
                const state = getState();
                const parts = state ? statusReport(state) : ['Still fetching status feeds. Try again in a moment.'];
                await message.reply(quietMessage(parts[0]));
                for (const part of parts.slice(1)) {
                    await enqueueSend(message.channel, part);
                }
            } catch (err) {
                logger.error(`[!aistatus] ${who(message)} failed: ${err.message}`);
            }
        },
    };
}
