import { parseFrequencyRange } from '../src/spectrum_plan';

describe('parseFrequencyRange', () => {
    test('plain MHz range', () => {
        expect(parseFrequencyRange('87-88', 'MHz')).toEqual({
            freq_start_hz: 87_000_000,
            freq_end_hz: 88_000_000,
        });
    });

    test('plain kHz range', () => {
        expect(parseFrequencyRange('9-14', 'kHz')).toEqual({
            freq_start_hz: 9_000,
            freq_end_hz: 14_000,
        });
    });

    test('plain GHz range', () => {
        expect(parseFrequencyRange('2.4-2.5', 'GHz')).toEqual({
            freq_start_hz: 2_400_000_000,
            freq_end_hz: 2_500_000_000,
        });
    });

    test('plain Hz range', () => {
        expect(parseFrequencyRange('100-300', 'Hz')).toEqual({
            freq_start_hz: 100,
            freq_end_hz: 300,
        });
    });

    test('decimal MHz range', () => {
        expect(parseFrequencyRange('87.5-108', 'MHz')).toEqual({
            freq_start_hz: 87_500_000,
            freq_end_hz: 108_000_000,
        });
    });

    test('range with trailing unit token (unit-in-range)', () => {
        expect(parseFrequencyRange('9-14 kHz', 'kHz')).toEqual({
            freq_start_hz: 9_000,
            freq_end_hz: 14_000,
        });
    });

    test('range with embedded en-dash separator', () => {
        expect(parseFrequencyRange('87–88', 'MHz')).toEqual({
            freq_start_hz: 87_000_000,
            freq_end_hz: 88_000_000,
        });
    });

    test('open-ended top-of-spectrum entry uses 3 THz sentinel', () => {
        expect(parseFrequencyRange('3000-', 'GHz')).toEqual({
            freq_start_hz: 3_000_000_000_000,
            freq_end_hz: 3_000_000_000_000,
        });
    });

    test('throws on unknown unit', () => {
        expect(() => parseFrequencyRange('1-2', 'BogusHz')).toThrow(/unknown unit/i);
    });

    test('throws on malformed range', () => {
        expect(() => parseFrequencyRange('not-a-range', 'MHz')).toThrow(/malformed range/i);
    });

    test('open-ended range with non-sentinel start (1 GHz open-ended)', () => {
        expect(parseFrequencyRange('1-', 'GHz')).toEqual({
            freq_start_hz: 1_000_000_000,
            freq_end_hz: 3_000_000_000_000,
        });
    });

    test('throws when end < start', () => {
        expect(() => parseFrequencyRange('100-50', 'MHz')).toThrow(/end .* start/i);
    });

    test('whitespace tolerated around tokens', () => {
        expect(parseFrequencyRange('  87  -  88  ', 'MHz')).toEqual({
            freq_start_hz: 87_000_000,
            freq_end_hz: 88_000_000,
        });
    });
});

import { applyReseed } from '../src/spectrum_plan';
import { initializeDatabase } from '../src/db';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('applyReseed', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_spectrum_reseed');
    const dbPath = path.join(scratchDir, 'test.db');
    const sqlPath = path.join(scratchDir, 'seed.sql');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        initializeDatabase(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('applies a .sql dump to populate spectrum tables', () => {
        const seed = `
BEGIN TRANSACTION;
INSERT INTO spectrum_allocations VALUES(87000000, 88000000, '87-88', 'MHz', 'BROADCASTING', 'BROADCASTING', 'BROADCASTING', 'BROADCASTING', 'FM broadcast band', '5.87 AUS37');
INSERT INTO spectrum_australian_footnotes VALUES('AUS37', 'AUS37 footnote body.');
INSERT INTO spectrum_international_footnotes VALUES('5.87', '5.87 ITU footnote body.');
INSERT INTO spectrum_plan_meta VALUES('source_description', 'Test fixture');
INSERT INTO spectrum_plan_meta VALUES('published_date', '2018-01-01');
COMMIT;
        `.trim();
        fs.writeFileSync(sqlPath, seed);

        const db = new Database(dbPath);
        try {
            applyReseed(db, sqlPath);
            const allocCount = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as any).n;
            const auCount = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_australian_footnotes').get() as any).n;
            const intlCount = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_international_footnotes').get() as any).n;
            expect(allocCount).toBe(1);
            expect(auCount).toBe(1);
            expect(intlCount).toBe(1);

            const published = (db.prepare("SELECT value FROM spectrum_plan_meta WHERE key='published_date'").get() as any).value;
            expect(published).toBe('2018-01-01');

            const importedAt = (db.prepare("SELECT value FROM spectrum_plan_meta WHERE key='imported_at'").get() as any).value;
            expect(importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        } finally { db.close(); }
    });

    test('re-applying a seed is idempotent (DELETEs first)', () => {
        const seed = `
BEGIN TRANSACTION;
INSERT INTO spectrum_allocations VALUES(87000000, 88000000, '87-88', 'MHz', '', '', 'BROADCASTING', '', '', '');
COMMIT;
        `.trim();
        fs.writeFileSync(sqlPath, seed);

        const db = new Database(dbPath);
        try {
            applyReseed(db, sqlPath);
            applyReseed(db, sqlPath);
            const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as any).n;
            expect(n).toBe(1);  // not 2
        } finally { db.close(); }
    });

    test('applies a .db source with range parsing', () => {
        // Build a synthetic source .db that mimics the pre-built frequency_allocations.db schema
        const sourceDbPath = path.join(scratchDir, 'source.db');
        if (fs.existsSync(sourceDbPath)) fs.unlinkSync(sourceDbPath);
        const sdb = new Database(sourceDbPath);
        sdb.exec(`
            CREATE TABLE allocations(
                frequency_range TEXT, unit TEXT,
                region1 TEXT, region2 TEXT, region3 TEXT,
                australian_table_of_allocations TEXT, common TEXT, footnote_ref TEXT
            );
            CREATE TABLE australian_footnotes(footnote_ref TEXT, footnote_text TEXT);
            CREATE TABLE international_footnotes(footnote_ref TEXT, footnote_text TEXT);
            INSERT INTO allocations VALUES('87-88', 'MHz', '', '', 'BROADCASTING', 'BROADCASTING', 'FM broadcast band', '5.87 AUS37');
            INSERT INTO australian_footnotes VALUES('AUS37', 'AU body');
            INSERT INTO international_footnotes VALUES('5.87', '5.87 body');
        `);
        sdb.close();

        const db = new Database(dbPath);
        try {
            applyReseed(db, sourceDbPath);
            const row = db.prepare('SELECT * FROM spectrum_allocations').get() as any;
            expect(row.freq_start_hz).toBe(87_000_000);
            expect(row.freq_end_hz).toBe(88_000_000);
            expect(row.region3).toBe('BROADCASTING');

            const auCount = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_australian_footnotes').get() as any).n;
            expect(auCount).toBe(1);
        } finally { db.close(); }
    });

    test('throws when source file does not exist', () => {
        const db = new Database(dbPath);
        try {
            expect(() => applyReseed(db, path.join(scratchDir, 'no_such_file.sql'))).toThrow(/source not found/i);
        } finally { db.close(); }
    });

    test('skips source rows with missing range or unit (does not default unit)', () => {
        const sourceDbPath = path.join(scratchDir, 'source_null.db');
        if (fs.existsSync(sourceDbPath)) fs.unlinkSync(sourceDbPath);
        const sdb = new Database(sourceDbPath);
        sdb.exec(`
            CREATE TABLE allocations(
                frequency_range TEXT, unit TEXT, region1 TEXT, region2 TEXT, region3 TEXT,
                australian_table_of_allocations TEXT, common TEXT, footnote_ref TEXT
            );
            CREATE TABLE australian_footnotes(footnote_ref TEXT, footnote_text TEXT);
            CREATE TABLE international_footnotes(footnote_ref TEXT, footnote_text TEXT);
            INSERT INTO allocations VALUES('87-88', NULL, '', '', 'BROADCASTING', '', '', '');
            INSERT INTO allocations VALUES(NULL, 'MHz', '', '', 'BROADCASTING', '', '', '');
            INSERT INTO allocations VALUES('87-88', 'MHz', '', '', 'BROADCASTING', '', '', '');
        `);
        sdb.close();

        const db = new Database(dbPath);
        try {
            applyReseed(db, sourceDbPath);
            const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
            expect(n).toBe(1);  // Only the third row survives
        } finally { db.close(); }
    });

    test('atomic: if load fails mid-way, original data is preserved', () => {
        // Seed: 2 rows
        const initial = `BEGIN TRANSACTION;
INSERT INTO spectrum_allocations VALUES(1,2,'a','Hz','','','','','','');
INSERT INTO spectrum_allocations VALUES(3,4,'b','Hz','','','','','','');
COMMIT;`;
        const initPath = path.join(scratchDir, 'init.sql');
        fs.writeFileSync(initPath, initial);
        const db = new Database(dbPath);
        try {
            applyReseed(db, initPath);
            expect((db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n).toBe(2);

            // Bad seed: syntax error halfway through
            const bad = `BEGIN TRANSACTION;
INSERT INTO spectrum_allocations VALUES(99,100,'c','Hz','','','','','','');
THIS IS NOT VALID SQL;
COMMIT;`;
            const badPath = path.join(scratchDir, 'bad.sql');
            fs.writeFileSync(badPath, bad);

            expect(() => applyReseed(db, badPath)).toThrow();

            // Original 2 rows must still be present (rollback)
            expect((db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n).toBe(2);
        } finally { db.close(); }
    });
});
