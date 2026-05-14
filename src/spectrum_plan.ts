/**
 * Spectrum-plan helpers (lookup-only dataset alongside the RRL mirror).
 *
 * See docs/superpowers/specs/2026-05-14-spectrum-plan-integration-design.md.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const UNIT_MULTIPLIER: Record<string, number> = {
    'Hz': 1,
    'kHz': 1_000,
    'MHz': 1_000_000,
    'GHz': 1_000_000_000,
    'THz': 1_000_000_000_000,
};

const TOP_OF_SPECTRUM_HZ = 3_000_000_000_000;  // 3 THz sentinel for open-ended bands

/**
 * Parse a frequency-range string + unit into integer Hz bounds.
 *
 * Examples:
 *   parseFrequencyRange('87-88', 'MHz')        → { 87_000_000, 88_000_000 }
 *   parseFrequencyRange('9-14 kHz', 'kHz')     → { 9_000, 14_000 }
 *   parseFrequencyRange('3000-', 'GHz')        → { 3 THz, 3 THz } (open-ended)
 *
 * Accepts en-dash (U+2013) as well as hyphen separator. Trailing unit token
 * inside the range string is stripped before parsing.
 */
export function parseFrequencyRange(rangeText: string, unit: string): { freq_start_hz: number; freq_end_hz: number } {
    const multiplier = UNIT_MULTIPLIER[unit];
    if (multiplier === undefined) {
        throw new Error(`parseFrequencyRange: unknown unit "${unit}"`);
    }

    // Strip a trailing unit token (e.g. "9-14 kHz" → "9-14") and whitespace.
    const stripped = rangeText
        .replace(/\b(Hz|kHz|MHz|GHz|THz)\b/g, '')
        .trim();

    // Normalise en-dash to ASCII hyphen.
    const normalised = stripped.replace(/–/g, '-');

    // Open-ended entry: "3000-" → parse actual start; freq_end_hz uses 3 THz sentinel.
    const openMatch = normalised.match(/^(\d+(?:\.\d+)?)\s*-\s*$/);
    if (openMatch) {
        const start = Number(openMatch[1]);
        return {
            freq_start_hz: Math.round(start * multiplier),
            freq_end_hz: TOP_OF_SPECTRUM_HZ,
        };
    }

    const parts = normalised.split(/\s*-\s*/);
    if (parts.length !== 2) {
        throw new Error(`parseFrequencyRange: malformed range "${rangeText}"`);
    }

    const start = Number(parts[0]);
    const end = Number(parts[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error(`parseFrequencyRange: non-numeric bound in "${rangeText}"`);
    }
    if (end < start) {
        throw new Error(`parseFrequencyRange: end (${end}) < start (${start}) in "${rangeText}"`);
    }

    return {
        freq_start_hz: Math.round(start * multiplier),
        freq_end_hz: Math.round(end * multiplier),
    };
}

const SPECTRUM_TABLES = [
    'spectrum_allocations',
    'spectrum_australian_footnotes',
    'spectrum_international_footnotes',
    'spectrum_plan_meta',
] as const;

/**
 * Wipe all spectrum_* tables and repopulate from a seed source.
 *
 * Source detection:
 *   - .sql / .SQL  → read as text, db.exec()
 *   - .db / .sqlite / any other → opened as SQLite, copied via SELECT
 *     with parseFrequencyRange normalisation
 *
 * The entire operation (wipe + load + meta updates) runs under a single
 * SAVEPOINT so a failure during load rolls back to the prior state rather
 * than leaving the spectrum tables empty.
 *
 * Always updates spectrum_plan_meta.imported_at to the current ISO timestamp.
 */
export function applyReseed(db: BetterSqlite3Database, sourcePath: string): void {
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`applyReseed: source not found: ${sourcePath}`);
    }

    const ext = path.extname(sourcePath).toLowerCase();
    const isSql = ext === '.sql';

    const savepoint = 'spectrum_reseed';
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
        for (const t of SPECTRUM_TABLES) {
            db.exec(`DELETE FROM ${t};`);
        }

        if (isSql) {
            const rawSql = fs.readFileSync(sourcePath, 'utf-8');
            const stripped = rawSql
                .replace(/^\s*BEGIN\s+TRANSACTION\s*;/gim, '')
                .replace(/^\s*COMMIT\s*;/gim, '');
            db.exec(stripped);
        } else {
            copyFromSourceDb(db, sourcePath);
        }

        const now = new Date().toISOString();
        db.prepare('INSERT OR REPLACE INTO spectrum_plan_meta(key, value) VALUES(?, ?)')
            .run('imported_at', now);

        const counts = {
            allocations: (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as any).n,
            au_footnotes: (db.prepare('SELECT COUNT(*) AS n FROM spectrum_australian_footnotes').get() as any).n,
            intl_footnotes: (db.prepare('SELECT COUNT(*) AS n FROM spectrum_international_footnotes').get() as any).n,
        };
        db.prepare('INSERT OR REPLACE INTO spectrum_plan_meta(key, value) VALUES(?, ?)')
            .run('row_counts', JSON.stringify(counts));

        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        console.error(`[SPECTRUM] Reseeded: ${counts.allocations} allocations, ${counts.au_footnotes} AU footnotes, ${counts.intl_footnotes} intl footnotes`);
    } catch (e) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
        throw e;
    }
}

/**
 * Copy data from a pre-built source SQLite database into the runtime spectrum_* tables.
 * The source uses the legacy schema (frequency_range TEXT + unit TEXT); we normalise
 * to freq_start_hz/freq_end_hz here using parseFrequencyRange.
 *
 * Source schema (from /Projects/ACMA/frequency_allocations.db):
 *   allocations(frequency_range, unit, region1, region2, region3,
 *               australian_table_of_allocations, common, footnote_ref)
 *   australian_footnotes(footnote_ref, footnote_text)
 *   international_footnotes(footnote_ref, footnote_text)
 */
function copyFromSourceDb(db: BetterSqlite3Database, sourcePath: string): void {
    const src = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
        const allocs = src.prepare(`
            SELECT frequency_range, unit, region1, region2, region3,
                   australian_table_of_allocations, common, footnote_ref
            FROM allocations
        `).all() as any[];

        const insertAlloc = db.prepare(`
            INSERT INTO spectrum_allocations(
                freq_start_hz, freq_end_hz, frequency_range, unit,
                region1, region2, region3,
                australian_table_of_allocations, common, footnote_ref
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        db.transaction(() => {
            for (const row of allocs) {
                if (!row.frequency_range || !row.unit) {
                    console.error(`[SPECTRUM] skip row (missing range or unit): range="${row.frequency_range}" unit="${row.unit}"`);
                    continue;
                }
                let bounds: { freq_start_hz: number; freq_end_hz: number };
                try {
                    bounds = parseFrequencyRange(row.frequency_range, row.unit);
                } catch (e) {
                    console.error(`[SPECTRUM] skip row (parse failure): "${row.frequency_range}" ${row.unit} — ${(e as Error).message}`);
                    continue;
                }
                insertAlloc.run(
                    bounds.freq_start_hz, bounds.freq_end_hz,
                    row.frequency_range ?? '', row.unit ?? '',
                    row.region1 ?? '', row.region2 ?? '', row.region3 ?? '',
                    row.australian_table_of_allocations ?? '', row.common ?? '', row.footnote_ref ?? ''
                );
            }

            const auRows = src.prepare('SELECT footnote_ref, footnote_text FROM australian_footnotes').all() as any[];
            const insertAu = db.prepare('INSERT INTO spectrum_australian_footnotes(footnote_ref, footnote_text) VALUES(?, ?)');
            for (const r of auRows) insertAu.run(r.footnote_ref, r.footnote_text);

            const intlRows = src.prepare('SELECT footnote_ref, footnote_text FROM international_footnotes').all() as any[];
            const insertIntl = db.prepare('INSERT INTO spectrum_international_footnotes(footnote_ref, footnote_text) VALUES(?, ?)');
            for (const r of intlRows) insertIntl.run(r.footnote_ref, r.footnote_text);
        })();
    } finally {
        if (src.open) src.close();
    }
}
