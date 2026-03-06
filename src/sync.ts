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
export async function performFullSync(config: SyncConfig): Promise<void> {
    if (currentSyncStatus.isSyncing) {
        throw new Error('Synchronization already in progress');
    }

    currentSyncStatus = { isSyncing: true, progress: 0 };

    try {
        if (!fs.existsSync(config.dataDir)) {
            fs.mkdirSync(config.dataDir, { recursive: true });
        }

        console.log('Fetching dataset timestamp...');
        const tsResponse = await axios.get(config.timestampUrl, { responseType: 'text' });
        const remoteTimestamp = String(tsResponse.data).trim();

        const zipPathFromInput = '/projects/acma-local-redux/inputs/spectra_rrl.zip';
        const zipPath = path.join(config.dataDir, 'spectra_rrl.zip');

        currentSyncStatus.progress = 5;

        if (fs.existsSync(zipPathFromInput)) {
            console.log('Using local dataset from inputs/');
            fs.copyFileSync(zipPathFromInput, zipPath);
        } else {
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

    const dbExists = fs.existsSync(config.dbPath);

    if (!dbExists) {
        await performFullSync(config);
        return;
    }

    // Check if we can do an incremental sync
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
        console.error('Incremental sync failed, might need full sync or it is outside 24h window.', e);
        // Fallback or just report error
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
            const values = columns.map(col => row[col]);
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
