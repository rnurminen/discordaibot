//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


export const CHAT_LOG_LIMIT = 50;
export const REPLY_COMMAND = /^!reply(?:\s+([\s\S]+))?$/i;
export const GEMINI_COMMAND = /^!gemini(?:\s+([\s\S]+))?$/i;

export function replyName(content) {
    const match = String(content || '').trim().match(REPLY_COMMAND);
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
    if (!content || REPLY_COMMAND.test(content) || GEMINI_COMMAND.test(content)) return null;
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
    const lines = [];
    const lockedUsers = new Set();
    const knownBots = new Map();

    function unlockOthers(authorId) {
        let cleared = 0;
        for (const id of [...lockedUsers]) {
            if (id !== authorId) {
                lockedUsers.delete(id);
                cleared += 1;
            }
        }
        return cleared;
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
            if (!line?.id || !line.authorId || !line.content) return { added: false, cleared: 0 };
            if (lines.some((existing) => existing.id === line.id)) return { added: false, cleared: 0 };
            lines.push(line);
            if (lines.length > CHAT_LOG_LIMIT) lines.shift();
            return { added: true, cleared: unlockOthers(line.authorId) };
        },

        unlockOthers,

        findLatest(query) {
            const mentioned = mentionId(query);
            const needle = String(query || '').trim().toLowerCase();
            let authorId = mentioned;
            if (!authorId) {
                for (let i = lines.length - 1; i >= 0; i -= 1) {
                    if (needle && nameHit(lines[i], needle)) {
                        authorId = lines[i].authorId;
                        break;
                    }
                }
            }
            if (!authorId) return null;
            for (let i = lines.length - 1; i >= 0; i -= 1) {
                if (lines[i].authorId === authorId) return lines[i];
            }
            return null;
        },

        isLocked(userId) {
            return lockedUsers.has(userId);
        },

        lock(userId) {
            lockedUsers.add(userId);
        },
    };
}
