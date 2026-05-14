/**
 * Tiny level-filtered logger backed by console.error.
 *
 * All log lines go to stderr (the convention this codebase has always used —
 * stdout is reserved for JSON-RPC frames in stdio MCP mode). Level is
 * controlled by LOG_LEVEL env var; default 'info'.
 *
 *   LOG_LEVEL=error  → only log.error() lines emit
 *   LOG_LEVEL=warn   → error + warn
 *   LOG_LEVEL=info   → error + warn + info (default)
 *   LOG_LEVEL=debug  → all four (includes network/sync debug detail)
 *
 * Message style matches the existing convention: prefix the channel in
 * brackets, e.g. log.info('[SYNC] starting'). Prefixes stay grep-able.
 */

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;
type Level = (typeof LEVELS)[number];

function resolveThreshold(): number {
    let raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
    // Legacy alias: DEBUG_NETWORK=true (documented in CLAUDE.md) implies debug.
    if (process.env.DEBUG_NETWORK && raw === 'info') {
        raw = 'debug';
    }
    const idx = LEVELS.indexOf(raw as Level);
    return idx >= 0 ? idx : LEVELS.indexOf('info');
}

const threshold = resolveThreshold();

function emit(level: Level, args: unknown[]): void {
    if (LEVELS.indexOf(level) <= threshold) {
        console.error(...args);
    }
}

export const log = {
    error: (...args: unknown[]) => emit('error', args),
    warn: (...args: unknown[]) => emit('warn', args),
    info: (...args: unknown[]) => emit('info', args),
    debug: (...args: unknown[]) => emit('debug', args),
};

/** True when the current LOG_LEVEL admits debug output. Useful for gating
 *  expensive computations behind a debug check (don't format strings you
 *  won't print). */
export const debugEnabled = LEVELS.indexOf('debug') <= threshold;
