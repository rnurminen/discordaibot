//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


export const CHAT_LOG_LIMIT = 100;
export const MIN_ROAST_LINES = 3;
export const MAX_ROAST_LINES = 10;
export const ROAST_COMMAND = /^!roast(?:\s+([\s\S]+))?$/i;
export const GEMINI_COMMAND = /^!gemini(?:\s+([\s\S]+))?$/i;

export function roastName(content) {
    const match = String(content || '').trim().match(ROAST_COMMAND);
    if (!match) return null;
    return (match[1] || '').trim();
}

export function geminiPrompt(content) {
    const match = String(content || '').trim().match(GEMINI_COMMAND);
    if (!match) return null;
    return (match[1] || '').trim();
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
    if (!content || ROAST_COMMAND.test(content) || GEMINI_COMMAND.test(content)) return null;
    const user = message.author;
    return {
        id: message.id,
        authorId: user.id,
        username: user.username || '',
        globalName: user.globalName || '',
        nickname: message.member?.nickname || '',
        displayName: message.member?.displayName || user.globalName || user.username || 'someone',
        content,
    };
}

export function botIdentity(message) {
    const user = message.author;
    if (!user?.id) return null;
    return {
        id: user.id,
        username: user.username || '',
        globalName: user.globalName || '',
        nickname: message.member?.nickname || '',
        displayName: message.member?.displayName || user.globalName || user.username || '',
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

        roastable() {
            const found = [];
            for (const [authorId, bucket] of users) {
                const displayName = bucket[bucket.length - 1]?.displayName || authorId;
                const topic = topicFor(authorId, displayName);
                if (topic.status === 'ok') found.push(topic);
            }
            return found;
        },

        consume(authorId, newestId) {
            const needed = MIN_ROAST_LINES + Math.floor(Math.random() * (MAX_ROAST_LINES - MIN_ROAST_LINES + 1));
            cutoffs.set(authorId, newestId);
            locks.set(authorId, { needed, spoken: 0 });
            return needed;
        },
    };
}
