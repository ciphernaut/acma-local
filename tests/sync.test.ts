import { extractZip, importCsv, applyIncrementalUpdate, parseRemoteTimestamp, isInputZipStale, shouldDoFullSync } from '../src/sync';
import { initializeDatabase } from '../src/db';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Sync Logic - Incremental Update', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_inc');
    const dbPath = path.join(scratchDir, 'test_acma.db');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) {
            fs.mkdirSync(scratchDir);
        }
        initializeDatabase(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
    });

    test('should apply incremental SQL updates', async () => {
        const updateContent = `
      -- STATUS:SUCCESS
      -- TO:2026-03-05 06:00:00
      INSERT INTO client (CLIENT_NO, LICENCEE) VALUES (10, 'Inc Corp');
      UPDATE client SET LICENCEE = 'Inc Updated' WHERE CLIENT_NO = 10;
    `;

        const timestamp = await applyIncrementalUpdate(updateContent, dbPath);
        expect(timestamp).toBe('2026-03-05 06:00:00');

        const db = new Database(dbPath);
        const client = db.prepare('SELECT * FROM client WHERE CLIENT_NO = 10').get() as any;
        expect(client.LICENCEE).toBe('Inc Updated');
        db.close();
    });
});

describe('Sync Logic - ZIP Extraction', () => {
    const scratchDir = path.join(__dirname, '../scratch_test');
    const zipPath = path.join(scratchDir, 'test.zip');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) {
            fs.mkdirSync(scratchDir);
        }
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
    });

    test('should extract files from zip', async () => {
        const zip = new AdmZip();
        zip.addFile('client.csv', Buffer.from('CLIENT_NO,LICENCEE\n1,Test Corp'));
        zip.writeZip(zipPath);

        const extractedFiles = await extractZip(zipPath, scratchDir);
        expect(extractedFiles).toContain(path.join(scratchDir, 'client.csv'));
        expect(fs.existsSync(path.join(scratchDir, 'client.csv'))).toBe(true);
    });
});

describe('Sync Logic - CSV Import', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_csv');
    const dbPath = path.join(scratchDir, 'test_acma.db');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) {
            fs.mkdirSync(scratchDir);
        }
        initializeDatabase(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
    });

    test('should import client.csv into the database', async () => {
        const csvContent = 'CLIENT_NO,LICENCEE,TRADING_NAME,ACN,ABN,POSTAL_STREET,POSTAL_SUBURB,POSTAL_STATE,POSTAL_POSTCODE,CAT_ID,CLIENT_TYPE_ID,FEE_STATUS_ID\n1,"Test Corp","Test Trading","123","456","Street","Suburb","NSW","2000",1,2,3';
        const csvPath = path.join(scratchDir, 'client.csv');
        fs.writeFileSync(csvPath, csvContent);

        await importCsv(csvPath, dbPath, 'client');

        const db = new Database(dbPath);
        const client = db.prepare('SELECT * FROM client WHERE CLIENT_NO = 1').get() as any;
        expect(client).toBeDefined();
        expect(client.LICENCEE).toBe('Test Corp');
        db.close();
    });
});

describe('parseRemoteTimestamp', () => {
    test('parses well-formed ACMA timestamp as UTC', () => {
        const d = parseRemoteTimestamp('2026-03-05 06:00:00');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-03-05T06:00:00.000Z');
    });

    test('tolerates surrounding whitespace and trailing newline', () => {
        const d = parseRemoteTimestamp('  2026-03-05 06:00:00\n');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-03-05T06:00:00.000Z');
    });

    test('returns null on malformed input', () => {
        expect(parseRemoteTimestamp('not a date')).toBeNull();
        expect(parseRemoteTimestamp('2026/03/05 06:00:00')).toBeNull();
        expect(parseRemoteTimestamp('2026-03-05T06:00:00Z')).toBeNull();
    });

    test('returns null on regex-valid but semantically invalid date', () => {
        expect(parseRemoteTimestamp('2026-13-01 00:00:00')).toBeNull();
    });

    test('returns null on empty string', () => {
        expect(parseRemoteTimestamp('')).toBeNull();
    });

    test('parses compact YYYYMMDDHHMMSS form (no sub-seconds)', () => {
        const d = parseRemoteTimestamp('20260305060000');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-03-05T06:00:00.000Z');
    });

    test('parses compact form with trailing nanosecond digits (real production shape)', () => {
        // Mirror of the value observed in data/acma.db meta.as_of after a real sync.
        const d = parseRemoteTimestamp('20260305234922793617000');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-03-05T23:49:22.000Z');
    });

    test('returns null on compact form with semantically invalid components', () => {
        expect(parseRemoteTimestamp('20261301000000')).toBeNull();
    });
});

describe('isInputZipStale', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_stale');
    const zipPath = path.join(scratchDir, 'sample.zip');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        fs.writeFileSync(zipPath, 'placeholder');
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('returns false when zip is missing', () => {
        const remote = new Date('2026-03-05T06:00:00Z');
        expect(isInputZipStale(path.join(scratchDir, 'does-not-exist.zip'), remote)).toBe(false);
    });

    test('returns true when zip mtime is older than remote timestamp', () => {
        const oldTime = new Date('2025-01-01T00:00:00Z');
        fs.utimesSync(zipPath, oldTime, oldTime);
        const remote = new Date('2026-03-05T06:00:00Z');
        expect(isInputZipStale(zipPath, remote)).toBe(true);
    });

    test('returns false when zip mtime is newer than remote timestamp', () => {
        const newTime = new Date('2026-04-01T00:00:00Z');
        fs.utimesSync(zipPath, newTime, newTime);
        const remote = new Date('2026-03-05T06:00:00Z');
        expect(isInputZipStale(zipPath, remote)).toBe(false);
    });

    test('returns false when zip mtime exactly equals remote timestamp (strict <)', () => {
        const t = new Date('2026-03-05T06:00:00Z');
        fs.utimesSync(zipPath, t, t);
        expect(isInputZipStale(zipPath, t)).toBe(false);
    });
});

describe('shouldDoFullSync', () => {
    const remote = new Date('2026-04-28T00:00:00Z');

    test('returns true when asOf is null (no DB / never synced)', () => {
        expect(shouldDoFullSync(null, remote)).toBe(true);
    });

    test('returns false when gap is under 24h', () => {
        const asOf = new Date('2026-04-27T05:00:00Z'); // 19h behind
        expect(shouldDoFullSync(asOf, remote)).toBe(false);
    });

    test('returns true when gap is over 24h', () => {
        const asOf = new Date('2026-04-26T00:00:00Z'); // 48h behind
        expect(shouldDoFullSync(asOf, remote)).toBe(true);
    });

    test('returns false when gap is exactly 24h (boundary: <= 24h is incremental)', () => {
        const asOf = new Date('2026-04-27T00:00:00Z'); // exactly 24h
        expect(shouldDoFullSync(asOf, remote)).toBe(false);
    });

    test('returns false when asOf is in the future relative to remote', () => {
        const asOf = new Date('2026-04-28T01:00:00Z');
        expect(shouldDoFullSync(asOf, remote)).toBe(false);
    });
});
