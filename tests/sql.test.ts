import { executeSql, listSampleQueries } from '../src/sql.js';
import { initializeDatabase } from '../src/db.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
});

describe('listSampleQueries', () => {
    test('returns exactly 44 entries', () => {
        const queries = listSampleQueries();
        expect(queries).toHaveLength(44);
    });

    test('every entry has a non-empty description and query', () => {
        const queries = listSampleQueries();
        for (const q of queries) {
            expect(typeof q.description).toBe('string');
            expect(q.description.trim().length).toBeGreaterThan(0);
            expect(typeof q.query).toBe('string');
            expect(q.query.trim().length).toBeGreaterThan(0);
        }
    });

    test('every query starts with SELECT (case-insensitive)', () => {
        const queries = listSampleQueries();
        for (const q of queries) {
            expect(q.query.trim().toUpperCase()).toMatch(/^SELECT/);
        }
    });
});
