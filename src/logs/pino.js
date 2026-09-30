//
//
// Discord AI status bot
//
// Copyright 2026 Riku Nurminen <riku@nurminen.dev>
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
//


import pino from 'pino';

const options = { level: process.env.LOG_LEVEL || 'info' };

if (process.env.NODE_ENV !== 'production') {
    options.transport = {
        target: 'pino-pretty',
        options: { colorize: true },
    };
}

const logger = pino(options);

export default logger;
