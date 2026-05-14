/**
 * Spectrum-plan helpers (lookup-only dataset alongside the RRL mirror).
 *
 * See docs/superpowers/specs/2026-05-14-spectrum-plan-integration-design.md.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger.js';

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
    // Normalise to canonical mixed-case key (e.g. "KHZ" → "kHz", "MHZ" → "MHz").
    const canonicalUnit = Object.keys(UNIT_MULTIPLIER).find(
        k => k.toLowerCase() === unit.toLowerCase()
    ) ?? unit;
    const multiplier = UNIT_MULTIPLIER[canonicalUnit];
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
        log.info(`[SPECTRUM] Reseeded: ${counts.allocations} allocations, ${counts.au_footnotes} AU footnotes, ${counts.intl_footnotes} intl footnotes`);
    } catch (e) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
        throw e;
    }
}

/**
 * Dump the four spectrum_* tables to a .sql file suitable for re-applying
 * via applyReseed(). DDL is owned by TABLE_METADATA so we only emit
 * INSERT statements wrapped in a single transaction.
 */
export function dumpSpectrumPlan(db: BetterSqlite3Database, outPath: string): void {
    const lines: string[] = ['BEGIN TRANSACTION;'];

    for (const table of SPECTRUM_TABLES) {
        const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
        if (rows.length === 0) continue;
        const cols = Object.keys(rows[0]!);
        const colList = cols.join(', ');
        for (const row of rows) {
            const values = cols.map(c => sqlLiteral(row[c])).join(', ');
            lines.push(`INSERT INTO ${table}(${colList}) VALUES(${values});`);
        }
    }

    lines.push('COMMIT;');
    fs.writeFileSync(outPath, lines.join('\n') + '\n');
    log.info(`[SPECTRUM] Wrote ${outPath} (${lines.length - 2} INSERT statements)`);
}

function sqlLiteral(v: unknown): string {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'boolean') return v ? '1' : '0';
    // Strings: double single quotes, wrap in single quotes.
    const s = String(v).replace(/'/g, "''");
    return `'${s}'`;
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
                    log.warn(`[SPECTRUM] skip row (missing range or unit): range="${row.frequency_range}" unit="${row.unit}"`);
                    continue;
                }
                let bounds: { freq_start_hz: number; freq_end_hz: number };
                try {
                    bounds = parseFrequencyRange(row.frequency_range, row.unit);
                } catch (e) {
                    log.warn(`[SPECTRUM] skip row (parse failure): "${row.frequency_range}" ${row.unit} — ${(e as Error).message}`);
                    continue;
                }
                insertAlloc.run(
                    bounds.freq_start_hz, bounds.freq_end_hz,
                    row.frequency_range ?? '', row.unit ?? '',
                    row.region1 ?? '', row.region2 ?? '', row.region3 ?? '',
                    row.australian_table_of_allocations ?? '', row.common ?? '', row.footnote_ref ?? ''
                );
            }

            // Source DB uses columns `ref` and `text` (not footnote_ref/footnote_text).
            const auRows = src.prepare('SELECT ref AS footnote_ref, text AS footnote_text FROM australian_footnotes').all() as any[];
            const insertAu = db.prepare('INSERT INTO spectrum_australian_footnotes(footnote_ref, footnote_text) VALUES(?, ?)');
            for (const r of auRows) insertAu.run(r.footnote_ref, r.footnote_text);

            const intlRows = src.prepare('SELECT ref AS footnote_ref, text AS footnote_text FROM international_footnotes').all() as any[];
            const insertIntl = db.prepare('INSERT INTO spectrum_international_footnotes(footnote_ref, footnote_text) VALUES(?, ?)');
            for (const r of intlRows) insertIntl.run(r.footnote_ref, r.footnote_text);
        })();
    } finally {
        if (src.open) src.close();
    }
}

/**
 * Auto-bootstrap helper: if spectrum_allocations is empty AND the seed file
 * exists at the given path, apply it. Used at the tail of performFullSync so
 * that "delete acma.db and rebuild" produces a complete schema.
 *
 * Failure modes are non-fatal — a missing/malformed seed logs a warning and
 * leaves spectrum tables empty (the MCP server still runs without them).
 */
export function bootstrapSpectrumPlan(db: BetterSqlite3Database, seedPath: string): void {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
    if (n > 0) {
        return;
    }
    if (!fs.existsSync(seedPath)) {
        log.warn(`[SPECTRUM] Bootstrap skipped: no seed at ${seedPath}`);
        return;
    }
    try {
        log.info(`[SPECTRUM] Bootstrapping spectrum tables from ${seedPath}`);
        applyReseed(db, seedPath);
    } catch (e) {
        log.error(`[SPECTRUM] Bootstrap failed: ${(e as Error).message}. Spectrum tables remain empty.`);
    }
}

export interface FootnoteEntry {
    ref: string;
    text: string;
}

export interface AllocationEntry {
    frequency_range: string;
    unit: string;
    region1: string;
    region2: string;
    region3: string;
    australian_table_of_allocations: string;
    common: string;
    footnote_ref: string;
    footnotes?: {
        australian: FootnoteEntry[];
        international: FootnoteEntry[];
    };
}

export interface SourceProvenance {
    description: string | null;
    published_date: string | null;
    last_patch_date: string | null;
    imported_at: string | null;
}

export interface FrequencyAllocationResult {
    freq_hz: number;
    frequency_display: string;
    match_count: number;
    allocations: AllocationEntry[];
    source: SourceProvenance;
}

/**
 * Look up the ARSP allocation(s) covering a given frequency in Hz.
 *
 * Returns matching rows with their footnotes joined (when include_footnotes
 * is true) plus a source-provenance block. Always returns an array shape
 * (`allocations: []`) regardless of match count.
 */
export function lookupFrequencyAllocation(
    db: BetterSqlite3Database,
    freq_hz: number,
    include_footnotes: boolean,
): FrequencyAllocationResult {
    const rows = db.prepare(`
        SELECT frequency_range, unit, region1, region2, region3,
               australian_table_of_allocations, common, footnote_ref
        FROM spectrum_allocations
        WHERE ? BETWEEN freq_start_hz AND freq_end_hz
        ORDER BY freq_start_hz, freq_end_hz
    `).all(freq_hz) as Array<Omit<AllocationEntry, 'footnotes'>>;

    const allocations: AllocationEntry[] = rows.map(r => {
        const entry: AllocationEntry = { ...r };
        if (include_footnotes) {
            entry.footnotes = resolveFootnotes(db, r.footnote_ref ?? '');
        }
        return entry;
    });

    return {
        freq_hz,
        frequency_display: formatFrequency(freq_hz),
        match_count: allocations.length,
        allocations,
        source: readSourceProvenance(db),
    };
}

function resolveFootnotes(db: BetterSqlite3Database, footnoteRef: string): { australian: FootnoteEntry[]; international: FootnoteEntry[] } {
    const tokens = footnoteRef.split(/[\s,]+/).filter(t => t.length > 0);
    const auTokens = tokens.filter(t => /^AUS/i.test(t));
    const intlTokens = tokens.filter(t => !/^AUS/i.test(t));

    const fetch = (table: string, refs: string[]): FootnoteEntry[] => {
        if (refs.length === 0) return [];
        const placeholders = refs.map(() => '?').join(',');
        const rows = db.prepare(`SELECT footnote_ref AS ref, footnote_text AS text FROM ${table} WHERE footnote_ref IN (${placeholders})`).all(...refs) as FootnoteEntry[];
        // Preserve input order:
        const byRef = new Map(rows.map(r => [r.ref, r]));
        return refs.map(r => byRef.get(r)).filter((r): r is FootnoteEntry => r !== undefined);
    };

    return {
        australian: fetch('spectrum_australian_footnotes', auTokens),
        international: fetch('spectrum_international_footnotes', intlTokens),
    };
}

function readSourceProvenance(db: BetterSqlite3Database): SourceProvenance {
    const rows = db.prepare('SELECT key, value FROM spectrum_plan_meta').all() as Array<{ key: string; value: string }>;
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    return {
        description: map['source_description'] ?? null,
        published_date: map['published_date'] ?? null,
        last_patch_date: map['last_patch_date'] ?? null,
        imported_at: map['imported_at'] ?? null,
    };
}

function formatFrequency(hz: number): string {
    if (hz < 1_000) return `${hz} Hz`;
    if (hz < 1_000_000) return `${(hz / 1_000).toFixed(3)} kHz`;
    if (hz < 1_000_000_000) return `${(hz / 1_000_000).toFixed(3)} MHz`;
    return `${(hz / 1_000_000_000).toFixed(3)} GHz`;
}

/**
 * Apply a hand-written SQL patch file (typically UPDATEs / INSERTs / DELETEs
 * derived from an ACMA legislative amendment). Trusted input — the curator
 * wrote it. Records last_patch_date in spectrum_plan_meta.
 *
 * Warns on >50% allocation loss as a sanity check for accidentally
 * destructive patches.
 */
export function applyPatch(db: BetterSqlite3Database, patchPath: string): void {
    if (!fs.existsSync(patchPath)) {
        throw new Error(`applyPatch: patch file not found: ${patchPath}`);
    }
    const sql = fs.readFileSync(patchPath, 'utf-8');

    const before = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
    db.exec(sql);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;

    if (before > 0 && after < before / 2) {
        log.warn(`[SPECTRUM] WARNING: patch reduced allocations from ${before} to ${after} (>50% deletion).`);
    }

    const today = new Date().toISOString().slice(0, 10);
    db.prepare('INSERT OR REPLACE INTO spectrum_plan_meta(key, value) VALUES(?, ?)').run('last_patch_date', today);

    log.info(`[SPECTRUM] Applied patch ${patchPath} (allocations ${before} -> ${after})`);
}
