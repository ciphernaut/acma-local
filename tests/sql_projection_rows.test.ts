import { executeSqlWithTimeout } from '../src/sql.js';
import { initializeDatabase } from '../src/db.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * The 500-row cap on execute_sql is right for a result an agent will read.
 * It is wrong for the projection path: rolling device rows up into site
 * entities needs to SEE every device row, and Queensland alone is ~27 device
 * rows per site. Capped at 500 rows, a site-level projection can reach 18
 * sites — so whole-region coverage was unreachable, which is what pushed a
 * downstream consumer into doing the rollup in SQL instead.
 *
 * The cap that matters downstream is 500 ENTITIES, which generatePolybolos
 * already enforces. These tests pin the higher row ceiling for the projection
 * path only.
 */
describe('projection row ceiling', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_projection_rows');
    const dbPath = path.join(scratchDir, 'test_acma.db');
    let db: Database.Database;

    beforeAll(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        initializeDatabase(dbPath);
        db = new Database(dbPath);
        // 30 sites x 40 devices = 1200 rows: over the 500-row cap, but only
        // 30 entities once rolled up — the shape the projection path exists for.
        const site = db.prepare(
            "INSERT INTO site (SITE_ID, NAME, LATITUDE, LONGITUDE, STATE) VALUES (?, ?, ?, ?, 'QLD')");
        const dev = db.prepare(
            'INSERT INTO device_details (SDD_ID, LICENCE_NO, SITE_ID, FREQUENCY) VALUES (?, ?, ?, ?)');
        const load = db.transaction(() => {
            for (let s = 1; s <= 30; s++) {
                site.run(`S${s}`, `Site ${s}`, -27 - s / 100, 153 + s / 100);
                for (let d = 1; d <= 40; d++) {
                    dev.run(`${s}-${d}`, `L${s}`, `S${s}`, 150_000_000 + d * 1000);
                }
            }
        });
        load();
    });

    afterAll(() => {
        if (db) db.close();
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    const JOIN = `SELECT s.SITE_ID, s.NAME AS SITE_NAME, s.LATITUDE, s.LONGITUDE,
                         d.SDD_ID, d.FREQUENCY
                  FROM device_details d JOIN site s ON s.SITE_ID = d.SITE_ID`;

    it('still caps the ordinary read path at 500 rows', async () => {
        const r = await executeSqlWithTimeout(dbPath, JOIN, 500, 25_000);
        expect(r.rows).toHaveLength(500);
        expect(r.truncated).toBe(true);
    });

    it('returns beyond 500 rows when a projection ceiling is given', async () => {
        const r = await executeSqlWithTimeout(dbPath, JOIN, 50_000, 25_000, 50_000);
        expect(r.rows).toHaveLength(1200);
        expect(r.truncated).toBe(false);
    });

    it('still reports truncation honestly at the projection ceiling', async () => {
        const r = await executeSqlWithTimeout(dbPath, JOIN, 800, 25_000, 800);
        expect(r.rows).toHaveLength(800);
        // Never silently: the caller must be able to tell a complete set from a cut one.
        expect(r.truncated).toBe(true);
    });

    it('does not let the projection ceiling raise the ordinary default', async () => {
        // No maxRows argument: the 500 cap stands, whatever limit is asked for.
        const r = await executeSqlWithTimeout(dbPath, JOIN, 5000, 25_000);
        expect(r.rows).toHaveLength(500);
        expect(r.truncated).toBe(true);
    });
});

describe('worker parity', () => {
    // src/sql_worker.cjs is hand-maintained alongside src/sql_worker.ts and is
    // the file actually loaded at runtime when present. Nothing else guards
    // them against drifting apart.
    const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

    it('both worker implementations derive the row cap the same way', () => {
        const ts = read('sql_worker.ts');
        const cjs = read('sql_worker.cjs');
        const capOf = (s: string) => s.match(/const cap = ([^\n;]+);/)?.[1]?.replace(/\s+/g, ' ').trim();
        expect(capOf(ts)).toBeDefined();
        expect(capOf(cjs)).toBe(capOf(ts));
    });

    it('both worker implementations destructure the same workerData fields', () => {
        // Must read the DESTRUCTURE, not the file. Filtering a fixed list by
        // file.includes(name) passes even when a field is missing from the
        // destructure, because both files name all of them in their header
        // comments — a guard that cannot fail is not a guard.
        const destructured = (s: string) => {
            const m = s.match(/const \{([^}]*)\} = workerData/);
            if (!m) return null;
            return m[1]!.split(',').map(f => f.trim()).filter(Boolean).sort();
        };
        const ts = destructured(read('sql_worker.ts'));
        const cjs = destructured(read('sql_worker.cjs'));
        expect(ts).not.toBeNull();
        expect(cjs).not.toBeNull();
        expect(ts).toContain('maxRows');
        expect(cjs).toEqual(ts);
    });
});
