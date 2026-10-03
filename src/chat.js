//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


import { botIdentity } from './messages.js';
import { AI_COMMAND } from './prompt.js';
import { MAX_ROAST_LINES, MIN_ROAST_LINES, ROAST_COMMAND } from './roast.js';

const CHAT_LOG_LIMIT = 100;

export function isHumanMessage(message) {
    return Boolean(message.author) && !message.author.bot && !message.webhookId && !message.system;
}

export function rememberBotMessage(chat, message) {
    if (!(message.author?.bot || message.webhookId)) return;
    const identity = botIdentity(message);
    if (identity) chat.rememberBot(identity);
}

function identityNames(identity) {
    return [identity.username, identity.globalName, identity.nickname, identity.displayName]
        .filter((name) => typeof name === 'string' && name.length > 0);
}

function nameHit(identity, needle) {
    return identityNames(identity).some((name) => name.toLowerCase() === needle);
}

function mentionId(query) {
    const match = String(query || '').match(/<@!?(\d+)>/);
    return match ? match[1] : '';
}

export function lineFromMessage(message) {
    const content = message.content?.trim() || '';
    if (!content || ROAST_COMMAND.test(content) || AI_COMMAND.test(content)) return null;
    const user = message.author;
    const identity = botIdentity(message);
    if (!identity) return null;
    return {
        id: message.id,
        authorId: user.id,
        username: identity.username,
        globalName: identity.globalName,
        nickname: identity.nickname,
        displayName: identity.displayName || 'someone',
        content,
    };
}

export function createChat() {
    const users = new Map();
    const cutoffs = new Map();
    const locks = new Map();
    const knownBots = new Map();

    function newer(id, cutoff) {
        if (!cutoff) return true;
        try {
            return BigInt(id) > BigInt(cutoff);
        } catch {
            return id > cutoff;
        }
    }

    function bucketFor(authorId) {
        let bucket = users.get(authorId);
        if (!bucket) {
            bucket = [];
            users.set(authorId, bucket);
        }
        return bucket;
    }

    function resolveAuthor(query) {
        const mentioned = mentionId(query);
        const needle = String(query || '').trim().toLowerCase();
        let match = null;
        for (const bucket of users.values()) {
            for (let i = bucket.length - 1; i >= 0; i -= 1) {
                const line = bucket[i];
                const hit = mentioned ? line.authorId === mentioned : needle && nameHit(line, needle);
                if (!hit) continue;
                if (!match || newer(line.id, match.id)) match = line;
                break;
            }
        }
        return match;
    }

    function topicFor(authorId, displayName) {
        const bucket = users.get(authorId) || [];
        const fresh = bucket.filter((line) => newer(line.id, cutoffs.get(authorId)));
        const lock = locks.get(authorId);
        if (lock) {
            return {
                status: 'locked',
                authorId,
                displayName,
                spoken: lock.spoken,
                needed: lock.needed,
            };
        }
        if (fresh.length < MIN_ROAST_LINES) {
            return { status: 'short', authorId, displayName, have: fresh.length };
        }
        return {
            status: 'ok',
            authorId,
            displayName,
            lines: fresh.slice(-MAX_ROAST_LINES),
        };
    }

    return {
        rememberBot(identity) {
            if (!identity?.id) return;
            const previous = knownBots.get(identity.id) || {};
            const next = { ...previous, id: identity.id };
            for (const [key, value] of Object.entries(identity)) {
                if (typeof value === 'string' && value.length > 0) next[key] = value;
            }
            knownBots.set(identity.id, next);
        },

        isKnownBot(query) {
            const id = mentionId(query);
            if (id) return knownBots.has(id);
            const needle = String(query || '').trim().toLowerCase();
            if (!needle) return false;
            for (const bot of knownBots.values()) {
                if (nameHit(bot, needle)) return true;
            }
            return false;
        },

        record(line) {
            if (!line?.id || !line.authorId || !line.content) return { added: false, ready: false };
            const bucket = bucketFor(line.authorId);
            if (bucket.some((existing) => existing.id === line.id)) return { added: false, ready: false };
            bucket.push(line);
            while (bucket.length > MAX_ROAST_LINES) bucket.shift();
            const lock = locks.get(line.authorId);
            if (!lock) return { added: true, ready: false };
            lock.spoken += 1;
            if (lock.spoken < lock.needed) {
                return { added: true, ready: false, spoken: lock.spoken, needed: lock.needed };
            }
            const spoken = lock.spoken;
            const needed = lock.needed;
            locks.delete(line.authorId);
            return { added: true, ready: true, spoken, needed };
        },

        topic(query) {
            const match = resolveAuthor(query);
            if (!match) return { status: 'none' };
            return topicFor(match.authorId, match.displayName);
        },

        authorTopic(authorId) {
            const bucket = users.get(authorId);
            if (!bucket?.length) return { status: 'none' };
            const displayName = bucket[bucket.length - 1]?.displayName || authorId;
            return topicFor(authorId, displayName);
        },

        consume(authorId, newestId) {
            const needed = MIN_ROAST_LINES + Math.floor(Math.random() * (MAX_ROAST_LINES - MIN_ROAST_LINES + 1));
            cutoffs.set(authorId, newestId);
            locks.set(authorId, { needed, spoken: 0 });
            return needed;
        },
    };
}

export async function seedChat(chat, channel) {
    const history = await channel.messages.fetch({ limit: CHAT_LOG_LIMIT });
    const ordered = [...history.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    let count = 0;
    for (const message of ordered) {
        if (!isHumanMessage(message)) {
            rememberBotMessage(chat, message);
            continue;
        }
        const line = lineFromMessage(message);
        if (line && chat.record(line).added) count += 1;
    }
    return count;
}
