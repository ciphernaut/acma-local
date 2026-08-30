import { hasStatementSeparator, executeSqlWithTimeout, listSampleQueries } from '../src/sql.js';
import { initializeDatabase } from '../src/db.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('hasStatementSeparator', () => {
    test('detects a genuine statement separator', () => {
        expect(hasStatementSeparator('SELECT 1; DROP TABLE site')).toBe(true);
        expect(hasStatementSeparator('SELECT 1;')).toBe(true);
    });

    test('ignores a semicolon inside a single-quoted string literal', () => {
        // The bug: this was rejected as "multiple statements".
        expect(hasStatementSeparator("SELECT 'a; b' AS note")).toBe(false);
        expect(hasStatementSeparator("SELECT CASE WHEN x=0 THEN 'check; here' ELSE '' END")).toBe(false);
    });

    test('handles doubled quotes inside a literal', () => {
        expect(hasStatementSeparator("SELECT 'it''s; fine'")).toBe(false);
        expect(hasStatementSeparator("SELECT 'it''s'; DROP TABLE site")).toBe(true);
    });

    test('ignores a semicolon inside a quoted identifier', () => {
        expect(hasStatementSeparator('SELECT "odd;name" FROM t')).toBe(false);
        expect(hasStatementSeparator('SELECT `odd;name` FROM t')).toBe(false);
        expect(hasStatementSeparator('SELECT [odd;name] FROM t')).toBe(false);
    });

    test('ignores a semicolon inside comments', () => {
        expect(hasStatementSeparator('SELECT 1 -- ; not a statement\n')).toBe(false);
        expect(hasStatementSeparator('SELECT 1 /* ; still not */ FROM t')).toBe(false);
    });

    test('still catches a separator after a string or comment closes', () => {
        expect(hasStatementSeparator("SELECT 'safe' -- c\n; DROP TABLE site")).toBe(true);
        expect(hasStatementSeparator('SELECT 1 /* c */ ; DROP TABLE site')).toBe(true);
    });
});

describe('the three copies of the scanner stay in sync', () => {
    // The worker deliberately inlines its logic rather than importing from
    // src/sql.ts (ESM resolution differs between tsx and the compiled dist/).
    // That is a standing drift hazard, so compare the copies directly: strip
    // types, comments and whitespace, and require the bodies to be identical.
    const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

    function bodyOf(src: string): string {
        const start = src.indexOf('function hasStatementSeparator');
        expect(start).toBeGreaterThan(-1);
        let i = src.indexOf('{', start);
        let depth = 0;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) break;
        }
        return src.slice(start, i + 1)
            .replace(/\(sql: string\): boolean/, '(sql)')   // strip the TS signature
            .replace(/\/\/[^\n]*/g, '')                      // strip line comments
            .replace(/\s+/g, ' ')                            // normalise whitespace
            .trim();
    }

    test('src/sql.ts, sql_worker.ts and sql_worker.cjs agree', () => {
        const canonical = bodyOf(read('src/sql.ts'));
        expect(bodyOf(read('src/sql_worker.ts'))).toBe(canonical);
        expect(bodyOf(read('src/sql_worker.cjs'))).toBe(canonical);
    });
});

describe('built-in sample queries are runnable', () => {
    // list_sample_queries advertises these, so execute_sql must accept them.
    // Two shipped with a trailing semicolon, which the validator rejects — and
    // which would be a syntax error anyway once wrapped in SELECT * FROM (...).
    test('no sample query trips the statement-separator check', () => {
        const summary: any = listSampleQueries();
        const cats: string[] = (summary.categories ?? []).map((c: any) => c.category ?? c.name ?? c);
        const all: any[] = cats.flatMap(c => {
            const rows: any = listSampleQueries({ category: c });
            return Array.isArray(rows) ? rows : [];
        });
        expect(all.length).toBeGreaterThan(40);
        const bad = all.filter(q => hasStatementSeparator(q.query));
        expect(bad.map(q => q.description)).toEqual([]);
    });
});

describe('execute_sql worker path', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_sep');
    const dbPath = path.join(scratchDir, 'test.db');

    beforeAll(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        initializeDatabase(dbPath);
        const db = new Database(dbPath);
        db.prepare("INSERT INTO site (SITE_ID, NAME, POSTCODE, STATE) VALUES ('S1','Tower','2000','NSW')").run();
        db.close();
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('accepts a query whose string literal contains a semicolon', async () => {
        const r = await executeSqlWithTimeout(
            dbPath,
            "SELECT NAME, 'note; with semicolon' AS DATA_NOTE FROM site",
        );
        expect(r.rowCount).toBe(1);
        expect(r.rows[0]![1]).toBe('note; with semicolon');
    });

    test('still rejects an actual second statement', async () => {
        await expect(
            executeSqlWithTimeout(dbPath, 'SELECT 1; DROP TABLE site'),
        ).rejects.toThrow(/Multiple SQL statements/);
    });
});
