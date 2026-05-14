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

describe('T2 tables', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_t2');
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
        ['bsl', 'BSL_NO'],
        ['bsl_area', 'AREA_CODE'],
    ])('T2 %s table exists with expected PK column %s', (table, pkCol) => {
        const db = new Database(dbPath, { readonly: true });
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        db.close();
        expect(cols.length).toBeGreaterThan(0);
        expect(cols.find(c => c.name === pkCol)).toBeDefined();
    });

    test.each([
        ['auth_spectrum_freq', 'LICENCE_NO'],
        ['auth_spectrum_area', 'LICENCE_NO'],
    ])('T2 %s table exists with expected PK column %s', (table, col) => {
        const db = new Database(dbPath, { readonly: true });
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        db.close();
        expect(cols.length).toBeGreaterThan(0);
        expect(cols.find(c => c.name === col)).toBeDefined();
    });

});

describe('T3 tables', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_t3');
    const dbPath = path.join(scratchDir, 'test_acma.db');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        initializeDatabase(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('satellite table exists with SA_ID column', () => {
        const db = new Database(dbPath, { readonly: true });
        const cols = db.prepare("PRAGMA table_info(satellite)").all() as any[];
        db.close();
        expect(cols.length).toBeGreaterThan(0);
        expect(cols.find(c => c.name === 'SA_ID')).toBeDefined();
    });
});

describe('T4 tables', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_t4');
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
        ['applic_text_block', 'APTB_ID'],
        ['reports_text_block', 'RTB_ITEM'],
    ])('T4 %s table exists with column %s', (table, col) => {
        const db = new Database(dbPath, { readonly: true });
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
        db.close();
        expect(cols.length).toBeGreaterThan(0);
        expect(cols.find(c => c.name === col)).toBeDefined();
    });

    test('applic_text_block_fts virtual table exists', () => {
        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='applic_text_block_fts'"
        ).get() as { name?: string } | undefined;
        db.close();
        expect(row?.name).toBe('applic_text_block_fts');
    });
});

describe('emission_* lookup tables', () => {
    test('emission_* lookup tables are created by initializeDatabase', () => {
        const tmpDb = path.join(__dirname, `db_emis_${Date.now()}.db`);
        try {
            initializeDatabase(tmpDb);
            const db = new Database(tmpDb);
            try {
                const tables = (db.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'emission_%' ORDER BY name"
                ).all() as Array<{ name: string }>).map(r => r.name);
                expect(tables).toEqual([
                    'emission_info_type',
                    'emission_modulation',
                    'emission_multiplex',
                    'emission_signal_detail',
                    'emission_signal_nature',
                ]);
            } finally { db.close(); }
        } finally {
            if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
        }
    });
});

describe('Spectrum-plan tables', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_spectrum_ddl');
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
        'spectrum_allocations',
        'spectrum_australian_footnotes',
        'spectrum_international_footnotes',
        'spectrum_plan_meta',
    ])('creates table %s', (tableName) => {
        const db = new Database(dbPath);
        try {
            const row = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
            ).get(tableName);
            expect(row).toBeDefined();
        } finally { db.close(); }
    });

    test('spectrum_allocations has the expected columns', () => {
        const db = new Database(dbPath);
        try {
            const cols = (db.prepare('PRAGMA table_info(spectrum_allocations)').all() as any[])
                .map(r => r.name);
            expect(cols).toEqual(expect.arrayContaining([
                'freq_start_hz', 'freq_end_hz', 'frequency_range', 'unit',
                'region1', 'region2', 'region3',
                'australian_table_of_allocations', 'common', 'footnote_ref',
            ]));
        } finally { db.close(); }
    });

    test('spectrum_allocations has the range index', () => {
        const db = new Database(dbPath);
        try {
            const idx = db.prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND name=?"
            ).get('idx_spectrum_allocations_range');
            expect(idx).toBeDefined();
        } finally { db.close(); }
    });
});
