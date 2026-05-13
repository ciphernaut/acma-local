import { initializeDatabase } from '../src/db';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Database Initialization', () => {
    const dbPath = path.join(__dirname, 'test_acma.db');

    beforeEach(() => {
        if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
        }
    });

    afterAll(() => {
        if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
        }
    });

    test('should create all required tables', () => {
        initializeDatabase(dbPath);
        const db = new Database(dbPath);
        const tables = ['site', 'client', 'licence', 'device_details', 'antenna'].map(name =>
            db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
        );
        tables.forEach(table => expect(table).toBeDefined());
        db.close();
    });
});

describe('T1 lookup tables', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_t1');
    const dbPath = path.join(scratchDir, 'test_acma.db');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        initializeDatabase(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test.each([
        ['client_type', 'TYPE_ID'],
        ['fee_status', 'FEE_STATUS_ID'],
        ['industry_cat', 'CAT_ID'],
        ['licence_service', 'SV_ID'],
        ['licence_subservice', 'SS_ID'],
        ['licence_status', 'STATUS'],
        ['nature_of_service', 'CODE'],
        ['class_of_station', 'CODE'],
        ['licensing_area', 'LICENSING_AREA_ID'],
        ['antenna_polarity', 'POLARISATION_CODE'],
    ])('%s table exists and has expected PK column %s', (table, pkCol) => {
        const db = new Database(dbPath, { readonly: true });
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        db.close();
        expect(cols.length).toBeGreaterThan(0);
        expect(cols.find(c => c.name === pkCol)).toBeDefined();
    });
});
