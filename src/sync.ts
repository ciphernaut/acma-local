import AdmZip from 'adm-zip';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { parse } from 'csv-parse';
import { parse as parseCsvSync } from 'csv-parse/sync';
import axios from 'axios';
import { pipeline } from 'stream/promises';
import { initializeDatabase, TABLE_METADATA } from './db.js';

export interface SyncConfig {
    extractsUrl: string;
    dataDir: string;
    dbPath: string;
}

export const DEFAULT_CONFIG: SyncConfig = {
    extractsUrl: 'https://backend.acma.gov.au/rrl/v1/Extracts',
    dataDir: './data',
    dbPath: './data/acma.db',
};

// ── ACMA /v1/Extracts manifest types ─────────────────────────────────────────
//
// Mirrors the JSON returned by GET https://backend.acma.gov.au/rrl/v1/Extracts.
// `LastMdified` is misspelled on ACMA's side; preserved verbatim so JSON.parse
// hits it directly. Each entry's Items array may contain spectra_rrl.zip and
// (for full entries) spectra_licence_hrp.zip — we ignore the latter this sprint.

export interface ExtractItem {
    Description: string;
    Format: string;
    FileSize: number;
    FileName: string;
    FileUrl: string;
}

export interface ExtractEntry {
    IsFullExtract: boolean;
    LastMdified: string;       // ISO 8601, e.g. "2026-05-12T21:51:36Z"
    DateOfChanges?: string;    // YYYY-MM-DD; present only when IsFullExtract === false
    Items: ExtractItem[];
}

export type ExtractsManifest = ExtractEntry[];

/**
 * Returns the spectra_rrl* item from an entry's Items array, or null if none.
 * Filters out spectra_licence_hrp.zip (Device Power Patterns — out of scope).
 */
export function pickSpectraRrl(items: ExtractItem[]): ExtractItem | null {
    return items.find(i => i.FileName.startsWith('spectra_rrl')) ?? null;
}

/**
 * Fetches and returns the ACMA /v1/Extracts manifest. The manifest contains
 * the latest full extract entry plus the most recent (~3) daily change-zip
 * entries. Throws on network / parse failure.
 */
export async function fetchExtractsManifest(url: string): Promise<ExtractsManifest> {
    const response = await axios.get(url);
    if (!Array.isArray(response.data)) {
        throw new Error(`fetchExtractsManifest: unexpected response shape (expected array, got ${typeof response.data})`);
    }
    return response.data as ExtractsManifest;
}

// ── Sync routing: pure decision function ─────────────────────────────────────

export type SyncMode = 'auto' | 'full';

export type SyncAction =
    | { kind: 'noop'; reason: 'cooldown' | 'current' }
    | { kind: 'full'; entry: ExtractEntry; reason: 'bootstrap' | 'forced' }
    | { kind: 'incremental'; entries: ExtractEntry[] }
    | { kind: 'gap-exceeded'; behindHours: number };

/** Minimum milliseconds between any sync attempt. */
const SYNC_COOLDOWN_MS = 12 * 60 * 60 * 1000;   // 12 hours

/**
 * Maximum allowed gap (in ms) between meta.as_of and the oldest applicable
 * incremental. Equal to the manifest's 24 h-per-zip window plus 6 h of slack
 * so that we don't false-trigger on slow daily extract generation.
 */
const GAP_TOLERANCE_MS = 30 * 60 * 60 * 1000;   // 30 hours

/**
 * Decides what sync action to take given the local DB freshness, the remote
 * manifest, and the user-requested mode. Pure — no I/O, no clock reads.
 *
 * Decision rules, in order:
 *  1. Cooldown active → noop/cooldown.
 *  2. asOf === null → full/bootstrap (mode is ignored; first-run must succeed).
 *  3. mode === 'full' → full/forced.
 *  4. asOf >= manifest.full.LastMdified → noop/current.
 *  5. No applicable incrementals OR gap > GAP_TOLERANCE_MS → gap-exceeded.
 *  6. Otherwise → incremental with applicable entries sorted ascending.
 */
export function decideSyncAction(
    asOf: Date | null,
    manifest: ExtractsManifest,
    mode: SyncMode,
    lastSync: Date | null,
    now: Date,
): SyncAction {
    if (lastSync !== null && now.getTime() - lastSync.getTime() < SYNC_COOLDOWN_MS) {
        return { kind: 'noop', reason: 'cooldown' };
    }
    const fullEntry = manifest.find(e => e.IsFullExtract);
    if (!fullEntry) {
        throw new Error('Manifest has no full extract entry');
    }
    if (asOf === null) {
        return { kind: 'full', entry: fullEntry, reason: 'bootstrap' };
    }
    if (mode === 'full') {
        return { kind: 'full', entry: fullEntry, reason: 'forced' };
    }
    const fullTime = new Date(fullEntry.LastMdified).getTime();
    if (asOf.getTime() >= fullTime) {
        return { kind: 'noop', reason: 'current' };
    }
    const applicable = manifest
        .filter(e => !e.IsFullExtract)
        .map(e => ({ e, t: new Date(e.LastMdified).getTime() }))
        .filter(({ t }) => t > asOf.getTime())
        .sort((a, b) => a.t - b.t);
    if (applicable.length === 0 ||
        applicable[0]!.t - asOf.getTime() > GAP_TOLERANCE_MS) {
        const behindHours = Math.round((fullTime - asOf.getTime()) / 3_600_000);
        return { kind: 'gap-exceeded', behindHours };
    }
    return { kind: 'incremental', entries: applicable.map(({ e }) => e) };
}

// ── CSV-diff incremental application ─────────────────────────────────────────

/**
 * Single-column primary keys for the tables we materialise. ACMA's full extract
 * does not declare PKs and the schema does not enforce them; we use these to
 * key the DELETE step of incremental application.
 */
const PK_BY_TABLE: Record<string, string> = {
    client: 'CLIENT_NO',
    licence: 'LICENCE_NO',
    site: 'SITE_ID',
    device_details: 'SDD_ID',
    antenna: 'ANTENNA_ID',
};

/**
 * Translates a change-zip CSV basename to a schema table name. ACMA's daily
 * change-zip names device data `device_detail.csv` (singular) while the full
 * extract names it `device_details.csv` (plural). Likely an ACMA-side bug; we
 * handle both here so the diff applier sees a single canonical table name.
 */
function csvToTable(csvBasename: string): string {
    const stem = csvBasename.replace(/\.csv$/i, '');
    return stem === 'device_detail' ? 'device_details' : stem;
}

/**
 * Applies a single daily change-zip to the SQLite database. The zip is the
 * payload of one https://cdn.acma.gov.au/rrl/changes/spectra_rrl-changes-*.zip
 * file. Each CSV in the zip carries the table's columns plus a trailing
 * CHANGE column; rows are Added / Updated / Deleted.
 */
export async function applyCsvDiffZip(zipPath: string, dbPath: string): Promise<void> {
    const zip = new AdmZip(zipPath);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    try {
        for (const entry of zip.getEntries()) {
            if (entry.isDirectory) continue;
            const baseName = path.basename(entry.entryName);
            if (!baseName.toLowerCase().endsWith('.csv')) continue;
            const tableName = csvToTable(baseName);
            if (!(tableName in PK_BY_TABLE)) continue;   // skip non-materialised tables
            applyCsvDiff(entry.getData(), tableName, db);
        }
    } finally {
        db.close();
    }
}

/**
 * Applies one CSV diff (the contents of one entry in a change-zip) to the
 * named table. DELETE-then-INSERT for Added/Updated; DELETE for Deleted.
 * Idempotent under repeated application, which protects us against replays.
 */
function applyCsvDiff(csvBuffer: Buffer, tableName: string, db: Database.Database): void {
    const rows: Record<string, string>[] = parseCsvSync(csvBuffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    });
    if (rows.length === 0) return;     // header-only CSV

    const columns = Object.keys(rows[0]!);
    if (!columns.includes('CHANGE')) {
        throw new Error(`Expected CHANGE column in ${tableName} change-zip`);
    }
    const COLUMN_NAME_RE = /^[A-Z_][A-Z0-9_]*$/i;
    const invalidCol = columns.find(c => !COLUMN_NAME_RE.test(c));
    if (invalidCol) {
        throw new Error(`Unexpected column name '${invalidCol}' in ${tableName} change-zip`);
    }
    const pk = PK_BY_TABLE[tableName]!;
    const dataCols = columns.filter(c => c !== 'CHANGE');
    const placeholders = dataCols.map(() => '?').join(',');
    const insertStmt = db.prepare(
        `INSERT INTO ${tableName} (${dataCols.join(',')}) VALUES (${placeholders})`
    );
    const deleteStmt = db.prepare(`DELETE FROM ${tableName} WHERE ${pk} = ?`);

    const apply = db.transaction(() => {
        for (const row of rows) {
            const change = row.CHANGE;
            const pkValue = row[pk];
            if (change === 'Deleted') {
                deleteStmt.run(pkValue);
            } else if (change === 'Added' || change === 'Updated') {
                deleteStmt.run(pkValue);
                const values = dataCols.map(c => row[c] === '' ? null : row[c]);
                insertStmt.run(...values);
            } else {
                console.error(`Unknown CHANGE='${change}' in ${tableName}; skipping row pk=${pkValue}`);
            }
        }
    });
    apply();
}

/**
 * The reason for the most recent sync decision. Outcome reasons are set at
 * the end of an attempt; decision reasons (`cooldown`, `current`,
 * `gap-exceeded`, etc.) are set when sync() routes a request.
 */
export type SyncReason =
    | 'cooldown'
    | 'current'
    | 'manifest-fetch-failed'
    | 'manifest-invalid'
    | 'no-db'
    | 'gap-exceeded'
    | 'forced'
    | 'incremental-success'
    | 'incremental-failed'
    | 'full-failed';

export interface SyncStatus {
    isSyncing: boolean;
    progress: number; // 0-100
    currentTable?: string;
    lastError?: string;
    /** The mode of the most recent executed sync. Absent when the last decision was a noop or gap-exceeded. */
    mode?: SyncMode | 'incremental';
    /** Reason / outcome of the most recent decision. */
    reason?: SyncReason;
    /** ISO-8601 timestamp of the most recent decision. */
    lastDecisionAt?: string;
    /** Free-form context for the decision (e.g. "3 change-zips applied"). */
    detail?: string;
    /** "How fresh is the data?" — mirror of meta.as_of in ISO 8601. */
    dataAsOf?: string;
    /** "When did our pipeline last successfully run?" — mirror of meta.last_sync. */
    lastSyncAt?: string;
    /** "What is upstream's latest data?" — last seen manifest full.LastMdified. */
    remoteAsOf?: string;
    /** Derived: (remoteAsOf - dataAsOf) rounded to hours; 0 when current. */
    behindByHours?: number;
}

let currentSyncStatus: SyncStatus = {
    isSyncing: false,
    progress: 0,
};

export function getSyncStatus(): SyncStatus {
    return { ...currentSyncStatus };
}

function recordDecision(
    reason: SyncReason,
    mode: SyncStatus['mode'] | undefined,
    detail?: string
): void {
    // Rebuild the status object so that `mode` and `detail` are cleared when
    // the caller passes undefined — spread-merging would otherwise leave stale
    // values from a previous call (e.g. mode='full' leaking into gap-exceeded).
    const { mode: _m, detail: _d, ...rest } = currentSyncStatus;
    void _m; void _d;
    currentSyncStatus = {
        ...rest,
        reason,
        lastDecisionAt: new Date().toISOString(),
        ...(mode !== undefined ? { mode } : {}),
        ...(detail !== undefined ? { detail } : {}),
    };
}

/**
 * Downloads a file from a URL to a target path.
 */
async function downloadFile(url: string, targetPath: string): Promise<void> {
    const response = await axios.get(url, { responseType: 'stream' });
    await pipeline(response.data, fs.createWriteStream(targetPath));
}

/**
 * Performs a full synchronization: download, extract, and import all data.
 * Takes the full ExtractEntry from the manifest as input — the URL and the
 * authoritative as_of timestamp both come from there.
 */
export async function performFullSync(config: SyncConfig, fullEntry: ExtractEntry): Promise<void> {
    if (currentSyncStatus.isSyncing) {
        throw new Error('Synchronization already in progress');
    }

    const spectra = pickSpectraRrl(fullEntry.Items);
    if (!spectra) {
        throw new Error('Full extract entry has no spectra_rrl item');
    }

    // Reset transient run state but preserve decision metadata.
    const { currentTable: _ct, lastError: _le, ...preserved } = currentSyncStatus;
    void _ct; void _le;
    currentSyncStatus = { ...preserved, isSyncing: true, progress: 0 };

    try {
        if (!fs.existsSync(config.dataDir)) {
            fs.mkdirSync(config.dataDir, { recursive: true });
        }

        const zipPathFromInput = path.resolve('inputs/spectra_rrl.zip');
        const zipPath = path.join(config.dataDir, 'spectra_rrl.zip');

        currentSyncStatus.progress = 5;

        const remoteTimestamp = new Date(fullEntry.LastMdified);
        const inputZipExists = fs.existsSync(zipPathFromInput);
        const inputZipStale = inputZipExists && isInputZipStale(zipPathFromInput, remoteTimestamp);

        if (inputZipExists && !inputZipStale) {
            console.error('Using local dataset from inputs/');
            fs.copyFileSync(zipPathFromInput, zipPath);
        } else {
            if (inputZipStale) {
                const mtime = fs.statSync(zipPathFromInput).mtime.toISOString();
                console.error(`[SYNC] Input zip mtime=${mtime} is older than remote=${remoteTimestamp.toISOString()}; ignoring stale input.`);
            }
            console.error(`Downloading full dataset from ${spectra.FileUrl}...`);
            await downloadFile(spectra.FileUrl, zipPath);
        }

        currentSyncStatus.progress = 20;

        console.error('Extracting ZIP...');
        const extractDir = path.join(config.dataDir, 'extracted');
        if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
        const files = await extractZip(zipPath, extractDir);

        currentSyncStatus.progress = 30;

        console.error('Initializing database...');
        initializeDatabase(config.dbPath);

        const tablesToImport = files.filter(file => {
            const fileName = path.basename(file);
            const targetTable = fileName.split('.')[0]!;
            return Object.keys(TABLE_METADATA).includes(targetTable);
        });

        for (let i = 0; i < tablesToImport.length; i++) {
            const file = tablesToImport[i]!;
            const fileName = path.basename(file);
            const targetTable = fileName.split('.')[0]!;

            currentSyncStatus.currentTable = targetTable;
            const tableProgressBase = 30 + (i / tablesToImport.length) * 65;

            console.error(`Importing ${fileName}...`);
            // Import-loop maps to the 30..95 range (65 points total), divided evenly
            // across `tablesToImport.length` files. Within each file's slice, `p`
            // (0..100 from importCsv) advances progress by `sliceSize` points.
            const sliceSize = 65 / tablesToImport.length;
            await importCsv(file, config.dbPath, targetTable, (p) => {
                currentSyncStatus.progress = Math.round(tableProgressBase + (p / 100) * sliceSize);
            });
        }

        const db = new Database(config.dbPath);
        try {
            db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('as_of', fullEntry.LastMdified);
            db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_sync', new Date().toISOString());
        } finally {
            db.close();
        }

        currentSyncStatus.progress = 100;
        console.error('Full sync complete.');
    } catch (error: any) {
        currentSyncStatus.lastError = error.message;
        throw error;
    } finally {
        currentSyncStatus.isSyncing = false;
    }
}

// ── DB freshness helpers ─────────────────────────────────────────────────────

function getDbAsOf(dbPath: string): Date | null {
    if (!fs.existsSync(dbPath)) return null;
    try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare("SELECT value FROM meta WHERE key = 'as_of'").get() as { value: string } | undefined;
            return row ? parseRemoteTimestamp(row.value) : null;
        } finally {
            if (db.open) db.close();
        }
    } catch {
        return null;
    }
}

function getDbLastSync(dbPath: string): Date | null {
    if (!fs.existsSync(dbPath)) return null;
    try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").get() as { value: string } | undefined;
            return row ? new Date(row.value) : null;
        } finally {
            if (db.open) db.close();
        }
    } catch {
        return null;
    }
}

/**
 * Returns the ISO-8601 timestamp of the last successful sync stored in the
 * meta table, or null if the DB doesn't exist / has never been synced.
 * Thin wrapper over getDbLastSync for backwards compatibility.
 */
function getLastSyncTime(dbPath: string): Date | null {
    return getDbLastSync(dbPath);
}

function updateFreshnessStatus(
    asOf: Date | null,
    fullEntry: ExtractEntry,
    lastSync: Date | null,
): void {
    const remoteAsOf = fullEntry.LastMdified;
    const dataAsOf = asOf?.toISOString();
    const behindByHours = asOf
        ? Math.max(0, Math.round((new Date(remoteAsOf).getTime() - asOf.getTime()) / 3_600_000))
        : undefined;
    currentSyncStatus = {
        ...currentSyncStatus,
        ...(dataAsOf !== undefined ? { dataAsOf } : {}),
        remoteAsOf,
        ...(behindByHours !== undefined ? { behindByHours } : {}),
        ...(lastSync !== null ? { lastSyncAt: lastSync.toISOString() } : {}),
    };
}

function refreshFreshnessAfter(dbPath: string, newAsOf: string, fullEntry: ExtractEntry): void {
    const asOfDate = parseRemoteTimestamp(newAsOf);
    updateFreshnessStatus(asOfDate, fullEntry, getDbLastSync(dbPath));
}

/**
 * Orchestrates the sync process using the ACMA /v1/Extracts manifest as the
 * source of truth. Never auto-pulls the full 70 MB extract on `mode='auto'` —
 * caller must pass `mode='full'` (typically via the MCP sync_data tool) to
 * force a full re-download when the DB is too far behind the manifest window.
 */
export async function sync(
    config: SyncConfig = DEFAULT_CONFIG,
    mode: SyncMode = 'auto',
): Promise<void> {
    const lastSync = getLastSyncTime(config.dbPath);

    let manifest: ExtractsManifest;
    try {
        manifest = await fetchExtractsManifest(config.extractsUrl);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const reason: SyncReason = msg.includes('unexpected response shape')
            ? 'manifest-invalid'
            : 'manifest-fetch-failed';
        console.error(`[SYNC] Manifest ${reason}: ${msg}`);
        recordDecision(reason, undefined, msg);
        return;
    }

    const fullEntry = manifest.find(e => e.IsFullExtract);
    if (!fullEntry) {
        console.error('[SYNC] Manifest has no full extract entry; aborting.');
        recordDecision('manifest-invalid', undefined, 'no full entry in manifest');
        return;
    }

    const asOf = getDbAsOf(config.dbPath);
    updateFreshnessStatus(asOf, fullEntry, getDbLastSync(config.dbPath));

    const action = decideSyncAction(asOf, manifest, mode, lastSync, new Date());

    switch (action.kind) {
        case 'noop':
            recordDecision(action.reason, undefined);
            return;

        case 'gap-exceeded': {
            const detail = `${action.behindHours}h behind manifest window — run sync_data mode=full to recover`;
            console.error(`[SYNC] ${detail}`);
            recordDecision('gap-exceeded', undefined, detail);
            return;
        }

        case 'full': {
            try {
                await performFullSync(config, action.entry);
                refreshFreshnessAfter(config.dbPath, action.entry.LastMdified, fullEntry);
                recordDecision(
                    action.reason === 'bootstrap' ? 'no-db' : 'forced',
                    'full',
                    `as-of ${action.entry.LastMdified}`,
                );
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                recordDecision('full-failed', 'full', msg);
                throw e;
            }
            return;
        }

        case 'incremental': {
            currentSyncStatus.isSyncing = true;
            try {
                if (!fs.existsSync(config.dataDir)) {
                    fs.mkdirSync(config.dataDir, { recursive: true });
                }
                const changesDir = path.join(config.dataDir, 'changes');
                if (!fs.existsSync(changesDir)) fs.mkdirSync(changesDir, { recursive: true });

                for (const entry of action.entries) {
                    const item = pickSpectraRrl(entry.Items);
                    if (!item) {
                        throw new Error(`Incremental entry for ${entry.DateOfChanges} has no spectra_rrl item`);
                    }
                    const safeName = path.basename(item.FileName);
                    if (!safeName || safeName !== item.FileName) {
                        throw new Error(`Suspicious FileName in manifest: ${item.FileName}`);
                    }
                    const zipPath = path.join(changesDir, safeName);
                    console.error(`[SYNC] Downloading ${item.FileUrl}...`);
                    await downloadFile(item.FileUrl, zipPath);
                    console.error(`[SYNC] Applying ${safeName}...`);
                    await applyCsvDiffZip(zipPath, config.dbPath);
                }

                const newAsOf = action.entries.at(-1)!.LastMdified;
                const db = new Database(config.dbPath);
                try {
                    db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('as_of', newAsOf);
                    db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_sync', new Date().toISOString());
                } finally {
                    db.close();
                }

                refreshFreshnessAfter(config.dbPath, newAsOf, fullEntry);
                recordDecision(
                    'incremental-success',
                    'incremental',
                    `${action.entries.length} change-zip(s) applied; as-of ${newAsOf}`,
                );
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error('[SYNC] Incremental sync failed.', e);
                recordDecision('incremental-failed', 'incremental', msg);
            } finally {
                currentSyncStatus.isSyncing = false;
            }
            return;
        }
    }
}

// Run if called directly
if (process.argv[1]?.endsWith('sync.ts') || process.argv[1]?.endsWith('sync.js')) {
    sync().catch(console.error);
}

/**
 * Extracts a ZIP file to a target directory.
 * @param zipPath Path to the ZIP file.
 * @param targetDir Directory to extract files into.
 * @returns List of absolute paths to extracted files.
 */
export async function extractZip(zipPath: string, targetDir: string): Promise<string[]> {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(targetDir, true);

    const entries = zip.getEntries();
    return entries.map(entry => path.join(targetDir, entry.entryName));
}

/**
 * Imports a CSV file into a SQLite table.
 * @param csvPath Path to the CSV file.
 * @param dbPath Path to the SQLite database.
 * @param tableName Name of the target table.
 */
export async function importCsv(
    csvPath: string,
    dbPath: string,
    tableName: string,
    onProgress?: (percent: number) => void
): Promise<void> {
    const db = new Database(dbPath);
    let insert: any = null;
    let columns: string[] = [];

    // Get total size for progress estimation
    const stats = fs.statSync(csvPath);
    const totalBytes = stats.size;
    let processedBytes = 0;

    const readStream = fs.createReadStream(csvPath);
    readStream.on('data', (chunk) => {
        processedBytes += chunk.length;
        if (onProgress) {
            onProgress(Math.round((processedBytes / totalBytes) * 100));
        }
    });

    const parser = readStream.pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }));

    const BATCH_SIZE = 5000;
    let batch: any[] = [];

    const doBatch = db.transaction((rows: any[]) => {
        for (const row of rows) {
            const values = columns.map(col => row[col] === '' ? null : row[col]);
            insert.run(...values);
        }
    });

    for await (const record of parser) {
        if (!insert) {
            columns = Object.keys(record as object);
            const placeholders = columns.map(() => '?').join(',');
            const sql = `INSERT INTO ${tableName} (${columns.join(',')}) VALUES (${placeholders})`;
            insert = db.prepare(sql);
        }

        batch.push(record);
        if (batch.length >= BATCH_SIZE) {
            doBatch(batch);
            batch = [];
        }
    }

    if (batch.length > 0) {
        doBatch(batch);
    }

    db.close();
}

/**
 * Parses ACMA's `datetime-of-extract.txt` payload (`YYYY-MM-DD HH:MM:SS`).
 * Treated as UTC so comparisons against other parsed timestamps stay consistent.
 * Returns null on any parse failure — callers fall back to existing behaviour.
 */
export function parseRemoteTimestamp(s: string): Date | null {
    const trimmed = s.trim();
    // Three accepted forms:
    //   1. Dashed `YYYY-MM-DD HH:MM:SS` (legacy datetime-of-extract.txt).
    //   2. Compact `YYYYMMDDHHMMSS` optionally followed by sub-second digits
    //      (production feed at one point emitted 9 trailing digits).
    //   3. ISO 8601 UTC `YYYY-MM-DDTHH:MM:SS[.fff]Z` (new manifest LastMdified).
    const dashed = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
    const compact = dashed ? null : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d*$/.exec(trimmed);
    const iso = (dashed || compact) ? null : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(trimmed);
    const m = dashed ?? compact ?? iso;
    if (!m) return null;
    // Construct ISO-8601 in UTC and validate by round-trip.
    // Compare against the input components so values like month=13 → null.
    const iso8601 = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const d = new Date(iso8601);
    if (isNaN(d.getTime())) return null;
    // Validate components round-trip (rejects 2026-13-12T... etc.)
    if (d.getUTCFullYear() !== Number(m[1]) ||
        d.getUTCMonth() + 1 !== Number(m[2]) ||
        d.getUTCDate() !== Number(m[3])) {
        return null;
    }
    // Preserve fractional seconds when present (ISO form only).
    if (iso) {
        return new Date(trimmed);
    }
    return d;
}

/**
 * True iff the file at `zipPath` exists AND its mtime is earlier than
 * `remoteTimestamp`. Returns false if the file is missing — the caller
 * decides whether that means "download" or "error".
 */
export function isInputZipStale(zipPath: string, remoteTimestamp: Date): boolean {
    if (!fs.existsSync(zipPath)) return false;
    const mtime = fs.statSync(zipPath).mtime;
    return mtime < remoteTimestamp;
}

