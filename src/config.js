//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


export function loadConfig(env = process.env) {
    const token = env.DISCORD_TOKEN?.trim() || '';
    const statusChannelId = env.DISCORD_STATUS_CHANNEL_ID?.trim() || '';
    const chatChannelId = env.DISCORD_CHAT_CHANNEL_ID?.trim() || '';
    const pollIntervalMs = Number(env.POLL_INTERVAL_MS || 60_000);

    if (!token || !statusChannelId) {
        throw new Error('Set DISCORD_TOKEN and DISCORD_STATUS_CHANNEL_ID. See .env.example.');
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
        throw new Error('POLL_INTERVAL_MS must be a number of milliseconds, at least 1000.');
    }

    return { token, statusChannelId, chatChannelId, pollIntervalMs };
}
