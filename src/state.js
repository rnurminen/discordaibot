//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const statePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'state.json');

export function emptyFeedState() {
    return {
        etag: null,
        lastModified: null,
        nextPollAt: 0,
        backoffMs: null,
        failures: 0,
        seeded: false,
        latest: null,
        incidents: {},
    };
}

export async function loadState() {
    try {
        const raw = await readFile(statePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { feeds: {} };
        }
        if (!parsed.feeds || typeof parsed.feeds !== 'object') parsed.feeds = {};
        return parsed;
    } catch (err) {
        if (err.code === 'ENOENT') return { feeds: {} };
        throw err;
    }
}

export function feedState(state, id) {
    if (!state.feeds[id]) state.feeds[id] = emptyFeedState();
    const current = state.feeds[id];
    if (!current.incidents || typeof current.incidents !== 'object') current.incidents = {};
    return current;
}

export async function saveState(state) {
    await mkdir(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, statePath);
}
