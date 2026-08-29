/**
 * Spectrum-plan helpers (lookup-only dataset alongside the RRL mirror).
 *
 * See docs/superpowers/specs/2026-05-14-spectrum-plan-integration-design.md.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger.js';
import { TABLE_METADATA } from './db.js';

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
    'spectrum_region_allocations',
    'spectrum_australian_footnotes',
    'spectrum_international_footnotes',
    'spectrum_plan_meta',
] as const;

/**
 * Drop and recreate all spectrum_* tables using the current DDL from TABLE_METADATA.
 * Used when a legacy schema is detected, to migrate to the new column layout.
 */
export function resetSpectrumTables(db: BetterSqlite3Database): void {
    db.exec(`
        DROP TABLE IF EXISTS spectrum_allocations;
        DROP TABLE IF EXISTS spectrum_region_allocations;
        DROP TABLE IF EXISTS spectrum_australian_footnotes;
        DROP TABLE IF EXISTS spectrum_international_footnotes;
        DROP TABLE IF EXISTS spectrum_plan_meta;
    `);
    for (const name of SPECTRUM_TABLES) {
        const meta = TABLE_METADATA[name];
        if (!meta) continue;
        db.exec(meta.ddl);
        if (meta.post_load_ddl) db.exec(meta.post_load_ddl);
    }
}

/**
 * Execute a generated seed file inside a SAVEPOINT.
 *
 * The generator emits its own BEGIN/COMMIT, which better-sqlite3 runs verbatim.
 * If a statement fails mid-file, that transaction is left OPEN on the
 * connection: any later work on the same connection then silently rolls back
 * when it closes (e.g. the emission-table bootstrap that shares this
 * connection in performFullSync). Strip the file's own transaction control and
 * impose our own, so a failed load rolls back exactly itself and leaves the
 * connection usable.
 */
export function execSeedSql(db: BetterSqlite3Database, sql: string): void {
    const stripped = sql
        .replace(/^\s*BEGIN(\s+TRANSACTION)?\s*;/gim, '')
        .replace(/^\s*COMMIT\s*;/gim, '');
    const savepoint = 'spectrum_seed';
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
        db.exec(stripped);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (e) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
        throw e;
    }
}

/**
 * Returns true if spectrum_allocations exists but has the old column layout
 * (pre-Task-9 schema: frequency_range TEXT or region1 TEXT columns).
 */
export function spectrumSchemaIsLegacy(db: BetterSqlite3Database): boolean {
    const cols = db.prepare("PRAGMA table_info(spectrum_allocations)").all() as Array<{ name: string }>;
    if (cols.length === 0) return false;
    return cols.some(c => c.name === 'frequency_range' || c.name === 'region1');
}

/**
 * Auto-bootstrap helper: if spectrum_allocations is empty AND the seed file
 * exists at the given path, apply it. If the table has the legacy schema,
 * drops and recreates all spectrum_* tables first.
 *
 * Used at the tail of performFullSync so that "delete acma.db and rebuild"
 * produces a complete schema. Failure modes are non-fatal — a missing/malformed
 * seed logs a warning and leaves spectrum tables empty (the MCP server still
 * runs without them).
 */
export function bootstrapSpectrumPlan(db: BetterSqlite3Database, seedPath: string): void {
    // Migrate legacy schema if present.
    if (spectrumSchemaIsLegacy(db)) {
        log.warn('[SPECTRUM] Legacy schema detected — dropping and recreating spectrum tables.');
        resetSpectrumTables(db);
    }

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
        const sql = fs.readFileSync(seedPath, 'utf-8');
        execSeedSql(db, sql);
    } catch (e) {
        log.error(`[SPECTRUM] Bootstrap failed: ${(e as Error).message}. Spectrum tables remain empty.`);
    }
}

export interface Service {
    name: string;
    primary: boolean;
    inline_footnotes: string[];
    qualifier?: string;
}

export interface AllocationRow {
    freq_start_hz: number;
    freq_end_hz: number;
    unit: string;
    page: number;
    services: Service[];
    footnotes: string[];
    raw: string;
    region?: number;  // only present on region rows (1/2/3)
}

export interface LookupResult {
    match_count: number;
    allocation: AllocationRow | null;
    regions: {
        1: AllocationRow | null;
        2: AllocationRow | null;
        3: AllocationRow | null;
    };
    resolved_footnotes?: Record<string, string>;
    source: {
        published_date: string | null;
        last_patch_date: string | null;
    };
}

type RawDbRow = {
    freq_start_hz: number;
    freq_end_hz: number;
    unit: string;
    page: number;
    services_json: string;
    footnotes_json: string;
    raw: string;
};

function rowToAllocationRow(row: RawDbRow, region?: number): AllocationRow {
    const result: AllocationRow = {
        freq_start_hz: row.freq_start_hz,
        freq_end_hz: row.freq_end_hz,
        unit: row.unit,
        page: row.page,
        services: row.services_json ? JSON.parse(row.services_json) as Service[] : [],
        footnotes: row.footnotes_json ? JSON.parse(row.footnotes_json) as string[] : [],
        raw: row.raw,
    };
    if (region !== undefined) {
        result.region = region;
    }
    return result;
}

/**
 * Look up the ARSP allocation covering a given frequency in Hz.
 *
 * Returns the AU row as the primary surface plus R1/R2/R3 contrast rows.
 * When includeFootnotes is true, resolves all footnote refs (AU + international)
 * from both the AU row and region rows into a flat resolved_footnotes map.
 */
export function lookupFrequencyAllocation(
    db: BetterSqlite3Database,
    freqHz: number,
    includeFootnotes: boolean = true,
): LookupResult {
    const auRows = db.prepare(
        'SELECT freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw FROM spectrum_allocations WHERE ? >= freq_start_hz AND ? < freq_end_hz ORDER BY freq_start_hz, freq_end_hz'
    ).all(freqHz, freqHz) as RawDbRow[];

    const allocation = auRows.length > 0 ? rowToAllocationRow(auRows[0]!) : null;
    const matchCount = auRows.length;

    const regions: { 1: AllocationRow | null; 2: AllocationRow | null; 3: AllocationRow | null } = { 1: null, 2: null, 3: null };
    for (const region of [1, 2, 3] as const) {
        const row = db.prepare(
            'SELECT freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw FROM spectrum_region_allocations WHERE region = ? AND ? >= freq_start_hz AND ? < freq_end_hz ORDER BY freq_start_hz, freq_end_hz LIMIT 1'
        ).get(region, freqHz, freqHz) as RawDbRow | undefined;
        if (row) {
            regions[region] = rowToAllocationRow(row, region);
        }
    }

    const result: LookupResult = {
        match_count: matchCount,
        allocation,
        regions,
        source: readSourceMeta(db),
    };

    if (includeFootnotes) {
        const refs = new Set<string>();
        for (const row of [allocation, regions[1], regions[2], regions[3]]) {
            if (!row) continue;
            for (const r of row.footnotes) refs.add(r);
            for (const svc of row.services) {
                for (const r of svc.inline_footnotes) refs.add(r);
            }
        }
        const resolved: Record<string, string> = {};
        for (const ref of refs) {
            const isAu = /^AUS/i.test(ref);
            const table = isAu ? 'spectrum_australian_footnotes' : 'spectrum_international_footnotes';
            const row = db.prepare(`SELECT footnote_text FROM ${table} WHERE footnote_ref = ?`).get(ref) as { footnote_text?: string } | undefined;
            if (row?.footnote_text) resolved[ref] = row.footnote_text;
        }
        result.resolved_footnotes = resolved;
    }

    return result;
}

function readSourceMeta(db: BetterSqlite3Database): { published_date: string | null; last_patch_date: string | null } {
    const published = db.prepare("SELECT value FROM spectrum_plan_meta WHERE key = 'published_date'").get() as { value?: string } | undefined;
    const lastPatch = db.prepare("SELECT value FROM spectrum_plan_meta WHERE key = 'last_patch_date'").get() as { value?: string } | undefined;
    return {
        published_date: published?.value ?? null,
        last_patch_date: lastPatch?.value ?? null,
    };
}

/**
 * @deprecated Use generate-spectrum-seed.ts CLI (npx tsx scripts/generate-spectrum-seed.ts)
 * instead. Kept for backwards compatibility only.
 */
export function applyReseed(db: BetterSqlite3Database, sourcePath: string): void {
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`applyReseed: source not found: ${sourcePath}`);
    }
    const ext = path.extname(sourcePath).toLowerCase();
    if (ext !== '.sql') {
        throw new Error(`applyReseed: only .sql sources are supported in the new pipeline. Got: ${sourcePath}`);
    }
    resetSpectrumTables(db);
    const sql = fs.readFileSync(sourcePath, 'utf-8');
    execSeedSql(db, sql);
    const now = new Date().toISOString();
    db.prepare('INSERT OR REPLACE INTO spectrum_plan_meta(key, value) VALUES(?, ?)').run('imported_at', now);
    log.info(`[SPECTRUM] Reseeded from ${sourcePath}`);
}
