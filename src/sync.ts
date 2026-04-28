import AdmZip from 'adm-zip';
import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { parse } from 'csv-parse';
import axios from 'axios';
import { pipeline } from 'stream/promises';
import { initializeDatabase, TABLE_METADATA } from './db.js';

export interface SyncConfig {
    datasetUrl: string;
    timestampUrl: string;
    incrementalUrl: string;
    dataDir: string;
    dbPath: string;
}

export const DEFAULT_CONFIG: SyncConfig = {
    datasetUrl: 'https://web.acma.gov.au/rrl-updates/spectra_rrl.zip',
    timestampUrl: 'https://web.acma.gov.au/rrl-updates/datetime-of-extract.txt',
    incrementalUrl: 'https://web.acma.gov.au/rrl/spectra_incremental.rrl_update',
    dataDir: './data',
    dbPath: './data/acma.db',
};

export interface SyncStatus {
    isSyncing: boolean;
    progress: number; // 0-100
    currentTable?: string;
    lastError?: string;
}

let currentSyncStatus: SyncStatus = {
    isSyncing: false,
    progress: 0,
};

export function getSyncStatus(): SyncStatus {
    return { ...currentSyncStatus };
}

/**
 * Downloads a file from a URL to a target path.
 */
async function downloadFile(url: string, targetPath: string): Promise<void> {
    const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream',
    });

    await pipeline(response.data, fs.createWriteStream(targetPath));
}

/**
 * Performs a full synchronization: download, extract, and import all data.
 */
export async function performFullSync(config: SyncConfig, remoteTimestampRaw?: string): Promise<void> {
    if (currentSyncStatus.isSyncing) {
        throw new Error('Synchronization already in progress');
    }

    currentSyncStatus = { isSyncing: true, progress: 0 };

    try {
        if (!fs.existsSync(config.dataDir)) {
            fs.mkdirSync(config.dataDir, { recursive: true });
        }

        let remoteTimestamp: string;
        if (remoteTimestampRaw !== undefined) {
            remoteTimestamp = remoteTimestampRaw;
        } else {
            console.log('Fetching dataset timestamp...');
            const tsResponse = await axios.get(config.timestampUrl, { responseType: 'text' });
            remoteTimestamp = String(tsResponse.data).trim();
        }

        const zipPathFromInput = '/projects/acma-local-redux/inputs/spectra_rrl.zip';
        const zipPath = path.join(config.dataDir, 'spectra_rrl.zip');

        currentSyncStatus.progress = 5;

        const parsedRemote = parseRemoteTimestamp(remoteTimestamp);
        const inputZipExists = fs.existsSync(zipPathFromInput);
        const inputZipStale = parsedRemote !== null && isInputZipStale(zipPathFromInput, parsedRemote);

        if (inputZipExists && !inputZipStale) {
            console.log('Using local dataset from inputs/');
            fs.copyFileSync(zipPathFromInput, zipPath);
        } else {
            if (inputZipStale && parsedRemote) {
                const mtime = fs.statSync(zipPathFromInput).mtime.toISOString();
                console.log(`[SYNC] Input zip mtime=${mtime} is older than remote=${parsedRemote.toISOString()}; ignoring stale input.`);
            }
            console.log('Downloading full dataset...');
            await downloadFile(config.datasetUrl, zipPath);
        }

        currentSyncStatus.progress = 20;

        console.log('Extracting ZIP...');
        const extractDir = path.join(config.dataDir, 'extracted');
        if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
        const files = await extractZip(zipPath, extractDir);

        currentSyncStatus.progress = 30;

        console.log('Initializing database...');
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
            // Map 30-95% across table imports
            const tableProgressBase = 30 + (i / tablesToImport.length) * 65;

            console.log(`Importing ${fileName}...`);
            await importCsv(file, config.dbPath, targetTable, (p) => {
                currentSyncStatus.progress = Math.round(tableProgressBase + (p / tablesToImport.length) * (65 / 100));
            });
        }

        const db = new Database(config.dbPath);
        db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('as_of', remoteTimestamp);
        db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_sync', new Date().toISOString());
        db.close();

        currentSyncStatus.progress = 100;
        console.log('Full sync complete.');
    } catch (error: any) {
        currentSyncStatus.lastError = error.message;
        throw error;
    } finally {
        currentSyncStatus.isSyncing = false;
    }
}

/** Minimum milliseconds between any contact with the origin. */
const SYNC_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * Returns the ISO-8601 timestamp of the last successful sync stored in the
 * meta table, or null if the DB doesn't exist / has never been synced.
 */
function getLastSyncTime(dbPath: string): Date | null {
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
 * Orchestrates the sync process.
 * Will not contact the origin if the last successful sync was within 12 hours.
 */
export async function sync(config: SyncConfig = DEFAULT_CONFIG): Promise<void> {
    // ── Rate-limit guard ──────────────────────────────────────────────────────
    const lastSync = getLastSyncTime(config.dbPath);
    if (lastSync) {
        const msSinceLast = Date.now() - lastSync.getTime();
        if (msSinceLast < SYNC_COOLDOWN_MS) {
            const nextSyncIn = Math.ceil((SYNC_COOLDOWN_MS - msSinceLast) / 60_000);
            console.log(
                `[SYNC] Skipping — last sync was ${Math.floor(msSinceLast / 60_000)} min ago. ` +
                `Next allowed sync in ~${nextSyncIn} min.`
            );
            return;
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Fetch remote timestamp once; reused below to decide full vs incremental
    // and threaded through performFullSync to avoid a second fetch.
    let remoteTimestampRaw: string;
    try {
        const tsResponse = await axios.get(config.timestampUrl, { responseType: 'text' });
        remoteTimestampRaw = String(tsResponse.data).trim();
    } catch (e) {
        console.error('[SYNC] Could not fetch remote timestamp; aborting sync.', e);
        return;
    }
    const parsedRemote = parseRemoteTimestamp(remoteTimestampRaw);
    if (!parsedRemote) {
        console.log(`[SYNC] Could not parse remote timestamp '${remoteTimestampRaw}'; proceeding without staleness check.`);
    }

    const dbExists = fs.existsSync(config.dbPath);

    if (!dbExists) {
        await performFullSync(config, remoteTimestampRaw);
        return;
    }

    // Read meta.as_of for gap check
    let asOf: Date | null = null;
    if (parsedRemote) {
        const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
        try {
            const row = db.prepare("SELECT value FROM meta WHERE key = 'as_of'").get() as { value: string } | undefined;
            // meta.as_of is written by performFullSync (raw remote timestamp) and
            // applyIncrementalUpdate (-- TO: line); both produce YYYY-MM-DD HH:MM:SS today.
            asOf = row ? parseRemoteTimestamp(row.value) : null;
        } finally {
            if (db.open) db.close();
        }

        if (shouldDoFullSync(asOf, parsedRemote)) {
            const gapHours = asOf
                ? Math.round((parsedRemote.getTime() - asOf.getTime()) / 3_600_000)
                : null;
            const gapDesc = gapHours === null ? 'no prior sync' : `${gapHours}h behind`;
            console.log(`[SYNC] DB is ${gapDesc} (remote=${parsedRemote.toISOString()}); full sync required.`);
            await performFullSync(config, remoteTimestampRaw);
            return;
        }
    }

    // Within the incremental window — attempt incremental sync
    console.log('Checking for incremental updates...');
    try {
        const response = await axios.get(config.incrementalUrl);
        const updateContent = response.data;

        const newTimestamp = await applyIncrementalUpdate(updateContent, config.dbPath);
        if (newTimestamp) {
            const db = new Database(config.dbPath);
            db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('as_of', newTimestamp);
            db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_sync', new Date().toISOString());
            db.close();
            console.log(`Incremental sync successful. Database is now as-of ${newTimestamp}`);
        }
    } catch (e) {
        console.error('Incremental sync failed.', e);
        // No auto-fallback: the gap check above already routed any DB that
        // is genuinely past the incremental window. Remaining failures are
        // transient and will retry on the next scheduled sync.
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
 * Applies incremental SQL updates to the database.
 * @param sqlContent The SQL content from the .rrl_update file.
 * @param dbPath Path to the SQLite database.
 * @returns The new "as of" timestamp.
 */
export async function applyIncrementalUpdate(sqlContent: string, dbPath: string): Promise<string | null> {
    const lines = sqlContent.split('\n');
    let status = null;
    let newAsof = null;
    const sqlStatements: string[] = [];

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('-- STATUS:')) {
            status = trimmedLine.replace('-- STATUS:', '').trim();
        } else if (trimmedLine.startsWith('-- TO:')) {
            newAsof = trimmedLine.replace('-- TO:', '').trim();
        } else if (trimmedLine && !trimmedLine.startsWith('--')) {
            sqlStatements.push(trimmedLine);
        }
    }

    if (status !== 'SUCCESS') {
        throw new Error(`Incremental update failed with status: ${status}`);
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.transaction(() => {
        for (const sql of sqlStatements) {
            try {
                db.exec(sql);
            } catch (e: any) {
                // Tables not in our schema (e.g. applic_text_block, antenna_pattern) are
                // skipped silently — the incremental feed references the full ACMA schema
                // but we only persist a subset. Any other error is logged.
                if (!e?.message?.includes('no such table')) {
                    console.error(`Error executing incremental SQL: ${sql}`, e);
                }
            }
        }
    })();
    db.close();

    return newAsof;
}

/**
 * Parses ACMA's `datetime-of-extract.txt` payload (`YYYY-MM-DD HH:MM:SS`).
 * Treated as UTC so comparisons against other parsed timestamps stay consistent.
 * Returns null on any parse failure — callers fall back to existing behaviour.
 */
export function parseRemoteTimestamp(s: string): Date | null {
    const trimmed = s.trim();
    // ACMA's datetime-of-extract.txt and applyIncrementalUpdate's `-- TO:`
    // line have both been observed in two shapes: dashed `YYYY-MM-DD HH:MM:SS`
    // and a compact `YYYYMMDDHHMMSS` optionally followed by sub-second digits
    // (the production feed currently emits 9 trailing digits — nanoseconds).
    const dashed = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
    const compact = dashed ? null : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d*$/.exec(trimmed);
    const m = dashed ?? compact;
    if (!m) return null;
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
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

/** Milliseconds in the ACMA incremental update window. */
const INCREMENTAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True iff a full sync is required — either the DB has never been synced
 * (`asOf` is null) or the gap to `remoteTimestamp` exceeds the 24-hour
 * incremental update window. Equality counts as "still incremental".
 */
export function shouldDoFullSync(asOf: Date | null, remoteTimestamp: Date): boolean {
    if (!asOf) return true;
    return remoteTimestamp.getTime() - asOf.getTime() > INCREMENTAL_WINDOW_MS;
}
