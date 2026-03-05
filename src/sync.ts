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
    if (!fs.existsSync(config.dataDir)) {
        fs.mkdirSync(config.dataDir, { recursive: true });
    }

    console.log('Fetching dataset timestamp...');
    const tsResponse = await axios.get(config.timestampUrl, { responseType: 'text' });
    const remoteTimestamp = String(tsResponse.data).trim();

    const zipPathFromInput = '/projects/acma-local-redux/inputs/spectra_rrl.zip';
    const zipPath = path.join(config.dataDir, 'spectra_rrl.zip');

    if (fs.existsSync(zipPathFromInput)) {
        console.log('Using local dataset from inputs/');
        fs.copyFileSync(zipPathFromInput, zipPath);
    } else {
        console.log('Downloading full dataset...');
        await downloadFile(config.datasetUrl, zipPath);
    }

    console.log('Extracting ZIP...');
    const extractDir = path.join(config.dataDir, 'extracted');
    if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });
    const files = await extractZip(zipPath, extractDir);

    console.log('Initializing database...');
    initializeDatabase(config.dbPath);

    for (const file of files) {
        const fileName = path.basename(file);
        // client.csv -> client
        const targetTable = fileName.split('.')[0]!;
        if (Object.keys(TABLE_METADATA).includes(targetTable)) {
            console.log(`Importing ${fileName}...`);
            await importCsv(file, config.dbPath, targetTable);
        }
    }

    const db = new Database(config.dbPath);
    db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('as_of', remoteTimestamp);
    db.prepare('REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_sync', new Date().toISOString());
    db.close();

    console.log('Full sync complete.');
}

/**
 * Orchestrates the sync process.
 */
export async function sync(config: SyncConfig = DEFAULT_CONFIG): Promise<void> {
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
export async function importCsv(csvPath: string, dbPath: string, tableName: string): Promise<void> {
    const db = new Database(dbPath);
    let insert: any = null;
    let columns: string[] = [];

    const parser = fs.createReadStream(csvPath).pipe(parse({
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
    db.transaction(() => {
        for (const sql of sqlStatements) {
            try {
                db.exec(sql);
            } catch (e) {
                console.error(`Error executing incremental SQL: ${sql}`, e);
                // We might want to continue or rollback depending on requirements.
                // The web app continues but logs failures.
            }
        }
    })();
    db.close();

    return newAsof;
}
