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
import logger from './logger.js';

export function who(message) {
    const name = message.member?.displayName || message.author.globalName || message.author.username;
    const handle = message.author.username;
    return name && name !== handle ? `${name} (${handle})` : handle;
}

export function clip(text, max = 160) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (flat.length <= max) return flat;
    return `${flat.slice(0, max - 3)}...`;
}

export function quietMessage(content) {
    return { content, flags: MessageFlags.SuppressEmbeds };
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

export async function fetchTextChannel(readyClient, id, label) {
    let channel;
    try {
        channel = await readyClient.channels.fetch(id);
    } catch (err) {
        logger.error(`Could not fetch ${label} ${id}: ${err.message}`);
        process.exit(1);
    }
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        const title = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
        logger.error(`${title} ${id} is not a text channel this bot can post in.`);
        process.exit(1);
    }
    return channel;
}
