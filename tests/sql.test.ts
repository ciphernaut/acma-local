import { executeSql, listSampleQueries, executeSqlWithTimeout, describeSchema } from '../src/sql.js';
import { initializeDatabase } from '../src/db.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const scratchDir_p2 = path.join(__dirname, '../scratch_test_describe_schema');
const dbPath_p2 = path.join(scratchDir_p2, 'test_acma.db');

describe('executeSql', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_sql');
    const dbPath = path.join(scratchDir, 'test_acma.db');
    let db: Database.Database;

    beforeAll(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        initializeDatabase(dbPath);
        db = new Database(dbPath);
        db.prepare("INSERT INTO site (SITE_ID, NAME, POSTCODE, STATE) VALUES ('S1', 'Sydney Tower', '2000', 'NSW')").run();
        db.prepare("INSERT INTO site (SITE_ID, NAME, POSTCODE, STATE) VALUES ('S2', 'Melbourne Tower', '3000', 'VIC')").run();
    });

    afterAll(() => {
        if (db) db.close();
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('returns columns and rows for a valid SELECT', () => {
        const result = executeSql(db, "SELECT SITE_ID, NAME FROM site ORDER BY SITE_ID");
        expect(result.columns).toEqual(['SITE_ID', 'NAME']);
        expect(result.rows).toHaveLength(2);
        expect(result.rows[0]).toEqual(['S1', 'Sydney Tower']);
        expect(result.truncated).toBe(false);
    });

    test('enforces row limit and sets truncated flag', () => {
        // Insert enough rows to exceed limit=1
        const result = executeSql(db, "SELECT * FROM site", 1);
        expect(result.rows).toHaveLength(1);
        expect(result.truncated).toBe(true);
    });

    test('rejects INSERT with clear error', () => {
        expect(() =>
            executeSql(db, "INSERT INTO site (SITE_ID) VALUES ('X')")
        ).toThrow(/SELECT/i);
    });

    test('rejects DROP TABLE', () => {
        expect(() =>
            executeSql(db, "DROP TABLE site")
        ).toThrow(/SELECT/i);
    });

    test('rejects empty string', () => {
        expect(() => executeSql(db, '')).toThrow();
    });

    test('rejects UPDATE statement', () => {
        expect(() =>
            executeSql(db, "UPDATE site SET NAME='x' WHERE SITE_ID='S1'")
        ).toThrow(/SELECT/i);
    });

    test('executeSql accepts CTE (WITH ... SELECT ...) queries', () => {
        const db = new Database(':memory:');
        db.exec(`CREATE TABLE t(id INTEGER); INSERT INTO t VALUES (1), (2), (3);`);
        const result = executeSql(db, 'WITH doubled AS (SELECT id * 2 AS d FROM t) SELECT d FROM doubled', 100);
        db.close();
        expect(result.rows.map(r => r[0])).toEqual([2, 4, 6]);
    });

    test('executeSql accepts WITH RECURSIVE queries', () => {
        const db = new Database(':memory:');
        const result = executeSql(
            db,
            'WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM counter WHERE n < 3) SELECT n FROM counter',
            100
        );
        db.close();
        expect(result.rows.map(r => r[0])).toEqual([1, 2, 3]);
    });

    test('executeSql still rejects mutating statements', () => {
        const db = new Database(':memory:');
        db.exec(`CREATE TABLE t(id INTEGER);`);
        expect(() => executeSql(db, 'INSERT INTO t VALUES (1)', 100)).toThrow(/Only SELECT.WITH statements/);
        expect(() => executeSql(db, 'DELETE FROM t', 100)).toThrow(/Only SELECT.WITH statements/);
        expect(() => executeSql(db, 'DROP TABLE t', 100)).toThrow(/Only SELECT.WITH statements/);
        db.close();
    });
});

describe('listSampleQueries', () => {
    test('returns at least 45 entries across all categories', () => {
        const valid = ['lookup', 'statistics', 'geospatial', 'text-search', 'power-user', 'data-dict'];
        let total = 0;
        for (const cat of valid) {
            total += (listSampleQueries({ category: cat as any }) as any[]).length;
        }
        expect(total).toBeGreaterThanOrEqual(45);
    });

    test('every entry has a non-empty description and query', () => {
        const valid = ['lookup', 'statistics', 'geospatial', 'text-search', 'power-user', 'data-dict'];
        for (const cat of valid) {
            const qs = listSampleQueries({ category: cat as any }) as any[];
            for (const q of qs) {
                expect(typeof q.description).toBe('string');
                expect(q.description.trim().length).toBeGreaterThan(0);
                expect(typeof q.query).toBe('string');
                expect(q.query.trim().length).toBeGreaterThan(0);
            }
        }
    });

    test('every query starts with SELECT or WITH (case-insensitive)', () => {
        const result = listSampleQueries({ category: 'lookup' }) as any[];
        // Use a filtered call to get actual SampleQuery objects; for the regex check
        // we iterate all categories to cover every entry.
        const valid = ['lookup', 'statistics', 'geospatial', 'text-search', 'power-user', 'data-dict'];
        for (const cat of valid) {
            const qs = listSampleQueries({ category: cat as any }) as any[];
            for (const q of qs) {
                expect(q.query.trim()).toMatch(/^(SELECT|WITH)/i);
            }
        }
    });

    test('listSampleQueries() with no filter returns a category summary', () => {
        const result = listSampleQueries();
        expect(Array.isArray(result)).toBe(false);
        const summary = result as { categories: Array<{ category: string; count: number; descriptions: string[] }> };
        expect(summary.categories.length).toBeGreaterThan(0);
        for (const c of summary.categories) {
            expect(c.count).toBeGreaterThan(0);
            expect(c.descriptions.length).toBe(c.count);
        }
        const total = summary.categories.reduce((s, c) => s + c.count, 0);
        expect(total).toBeGreaterThanOrEqual(45);
    });

    test('listSampleQueries({ category }) returns matching SampleQuery[]', () => {
        const result = listSampleQueries({ category: 'lookup' }) as any[];
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);
        for (const q of result) {
            expect(q.category).toBe('lookup');
            expect(typeof q.description).toBe('string');
            expect(typeof q.query).toBe('string');
        }
    });

    test('listSampleQueries({ name }) does substring match on description', () => {
        const result = listSampleQueries({ name: 'NBN' }) as any[];
        expect(Array.isArray(result)).toBe(true);
        expect(result.length).toBeGreaterThan(0);
        for (const q of result) {
            expect(q.description.toLowerCase()).toContain('nbn');
        }
    });

    test('listSampleQueries every entry has a valid category', () => {
        const valid = new Set(['lookup', 'statistics', 'geospatial', 'text-search', 'power-user', 'data-dict']);
        const all: any[] = [];
        for (const cat of valid) {
            all.push(...(listSampleQueries({ category: cat as any }) as any[]));
        }
        expect(all.length).toBeGreaterThanOrEqual(45);
        for (const q of all) {
            expect(valid.has(q.category)).toBe(true);
        }
    });
});

describe('executeSqlWithTimeout', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_sql_timeout');
    const dbPath = path.join(scratchDir, 'test_acma.db');

    beforeAll(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        initializeDatabase(dbPath);
        // Seed one row for the fast-query test
        const db = new Database(dbPath);
        db.prepare("INSERT INTO site (SITE_ID, NAME) VALUES ('T1', 'Test Site')").run();
        db.close();
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('resolves with correct result for a fast query', async () => {
        const result = await executeSqlWithTimeout(dbPath, "SELECT SITE_ID, NAME FROM site", 100, 5000);
        expect(result.columns).toEqual(['SITE_ID', 'NAME']);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toEqual(['T1', 'Test Site']);
    }, 10000);

    test('rejects with timeout error when query exceeds timeoutMs', async () => {
        // A 1ms timeout is shorter than worker startup time, so it always fires
        // first regardless of query complexity. This tests the timeout mechanism
        // itself (not a specific slow query).
        await expect(
            executeSqlWithTimeout(dbPath, "SELECT SITE_ID FROM site", 100, 1)
        ).rejects.toThrow(/timed out/i);
    }, 5000);

    test('rejects non-SELECT through the worker', async () => {
        await expect(
            executeSqlWithTimeout(dbPath, "DROP TABLE site", 100, 5000)
        ).rejects.toThrow(/SELECT/i);
    }, 10000);
});

describe('describeSchema', () => {
    beforeEach(() => {
        if (!fs.existsSync(scratchDir_p2)) fs.mkdirSync(scratchDir_p2);
        if (fs.existsSync(dbPath_p2)) fs.unlinkSync(dbPath_p2);
        initializeDatabase(dbPath_p2);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir_p2)) fs.rmSync(scratchDir_p2, { recursive: true, force: true });
    });

    test('describeSchema returns all tables when called without filter', () => {
        const db = new Database(dbPath_p2);
        const result = describeSchema(db);
        db.close();
        const names = result.map(t => t.name).sort();
        expect(names).toContain('client');
        expect(names).toContain('bsl');
        expect(names).toContain('auth_spectrum_freq');
        expect(names).toContain('applic_text_block');
        expect(names).toContain('applic_text_block_fts');
        expect(names).toContain('meta');
    });

    test('describeSchema filters by table names', () => {
        const db = new Database(dbPath_p2);
        const result = describeSchema(db, ['client', 'bsl']);
        db.close();
        expect(result).toHaveLength(2);
        expect(result.map(t => t.name).sort()).toEqual(['bsl', 'client']);
    });

    test('describeSchema exposes column types and PK columns', () => {
        const db = new Database(dbPath_p2);
        const result = describeSchema(db, ['licence']);
        db.close();
        const licence = result[0]!;
        expect(licence.columns.find(c => c.name === 'LICENCE_NO')).toBeDefined();
        expect(licence.columns.find(c => c.name === 'STATUS')?.type).toBe('TEXT');
        // Indexes from post_load_ddl
        expect(licence.indexes.length).toBeGreaterThan(0);
        expect(licence.indexes.find(i => i.columns.includes('LICENCE_NO'))).toBeDefined();
    });

    test('describeSchema flags FTS5 virtual tables', () => {
        const db = new Database(dbPath_p2);
        const result = describeSchema(db, ['applic_text_block_fts']);
        db.close();
        expect(result).toHaveLength(1);
        expect(result[0]!.isVirtual).toBe(true);
    });
});

