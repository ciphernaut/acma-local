import { parseEmissionBandwidth } from '../src/emissions.js';

describe('parseEmissionBandwidth', () => {
    test('100H → 100 Hz', () => {
        expect(parseEmissionBandwidth('100H')).toEqual({ value_hz: 100, display: '100 Hz' });
    });
    test('2K80 → 2.80 kHz = 2800 Hz', () => {
        expect(parseEmissionBandwidth('2K80')).toEqual({ value_hz: 2800, display: '2.80 kHz' });
    });
    test('10K1 → 10.1 kHz = 10100 Hz', () => {
        expect(parseEmissionBandwidth('10K1')).toEqual({ value_hz: 10100, display: '10.1 kHz' });
    });
    test('16K0 → 16 kHz', () => {
        expect(parseEmissionBandwidth('16K0')).toEqual({ value_hz: 16000, display: '16.0 kHz' });
    });
    test('320K → 320 kHz', () => {
        expect(parseEmissionBandwidth('320K')).toEqual({ value_hz: 320_000, display: '320 kHz' });
    });
    test('6M25 → 6.25 MHz', () => {
        expect(parseEmissionBandwidth('6M25')).toEqual({ value_hz: 6_250_000, display: '6.25 MHz' });
    });
    test('145M → 145 MHz', () => {
        expect(parseEmissionBandwidth('145M')).toEqual({ value_hz: 145_000_000, display: '145 MHz' });
    });
    test('999G → 999 GHz', () => {
        expect(parseEmissionBandwidth('999G')).toEqual({ value_hz: 999_000_000_000, display: '999 GHz' });
    });

    test('rejects empty', () => { expect(() => parseEmissionBandwidth('')).toThrow(); });
    test('rejects wrong length', () => { expect(() => parseEmissionBandwidth('10K')).toThrow(); });
    test('rejects no unit letter', () => { expect(() => parseEmissionBandwidth('1234')).toThrow(); });
    test('rejects unit at position 0', () => { expect(() => parseEmissionBandwidth('K100')).toThrow(); });
    test('rejects two unit letters', () => { expect(() => parseEmissionBandwidth('1H2H')).toThrow(); });
    test('rejects non-digit numeral', () => { expect(() => parseEmissionBandwidth('1KA0')).toThrow(); });
    test("rejects first-numeral-zero per spec", () => { expect(() => parseEmissionBandwidth('0K01')).toThrow(); });
});

import { decodeEmissionDesignator } from '../src/emissions.js';

describe('decodeEmissionDesignator', () => {
    test('16K0F3E — classic UHF land-mobile FM telephony', () => {
        const d = decodeEmissionDesignator('16K0F3E');
        expect(d.valid).toBe(true);
        expect(d.bandwidth).toEqual({ value_hz: 16000, display: '16.0 kHz', raw: '16K0' });
        expect(d.modulation?.code).toBe('F');
        expect(d.modulation?.group).toBe('angle');
        expect(d.signal_nature?.code).toBe('3');
        expect(d.info_type?.code).toBe('E');
        expect(d.signal_detail).toBeNull();
        expect(d.multiplex).toBeNull();
        expect(d.warnings).toEqual([]);
    });

    test('10K1F3E — VHF land-mobile FM telephony', () => {
        const d = decodeEmissionDesignator('10K1F3E');
        expect(d.valid).toBe(true);
        expect(d.bandwidth?.value_hz).toBe(10100);
        expect(d.modulation?.code).toBe('F');
        expect(d.info_type?.code).toBe('E');
    });

    test('10M0W7D — common 10 MHz combined-mode multi-channel digital data', () => {
        const d = decodeEmissionDesignator('10M0W7D');
        expect(d.valid).toBe(true);
        expect(d.bandwidth?.value_hz).toBe(10_000_000);
        expect(d.modulation?.code).toBe('W');
        expect(d.signal_nature?.code).toBe('7');
        expect(d.info_type?.code).toBe('D');
    });

    test('19M8W7DEW — 9-char form with signal_detail and multiplex', () => {
        const d = decodeEmissionDesignator('19M8W7DEW');
        expect(d.valid).toBe(true);
        expect(d.bandwidth?.value_hz).toBe(19_800_000);
        expect(d.signal_detail?.code).toBe('E');
        expect(d.multiplex?.code).toBe('W');
    });

    test('145MW7D — 7-char short form (no fractional bandwidth digit)', () => {
        const d = decodeEmissionDesignator('145MW7D');
        expect(d.valid).toBe(true);
        expect(d.bandwidth?.value_hz).toBe(145_000_000);
    });

    test('"16K0F3E  " — trailing whitespace tolerated, warning emitted', () => {
        const d = decodeEmissionDesignator('16K0F3E  ');
        expect(d.valid).toBe(true);
        expect(d.modulation?.code).toBe('F');
        expect(d.warnings.some(w => /whitespace/i.test(w))).toBe(true);
    });

    test('10K1Z3E — unknown modulation letter', () => {
        const d = decodeEmissionDesignator('10K1Z3E');
        expect(d.valid).toBe(false);
        expect(d.modulation).toBeNull();
        expect(d.warnings.length).toBeGreaterThan(0);
    });

    test('10K1F3EZN — unknown signal_detail letter', () => {
        const d = decodeEmissionDesignator('10K1F3EZN');
        expect(d.valid).toBe(true);
        expect(d.signal_detail).toBeNull();
        expect(d.warnings.some(w => /signal-detail/i.test(w))).toBe(true);
    });

    test('empty string — invalid, no fields set', () => {
        const d = decodeEmissionDesignator('');
        expect(d.valid).toBe(false);
        expect(d.bandwidth).toBeNull();
        expect(d.modulation).toBeNull();
        expect(d.warnings.length).toBeGreaterThan(0);
    });

    test('8-char input — invalid (must be 7 or 9)', () => {
        const d = decodeEmissionDesignator('10K1F3EZ');
        expect(d.valid).toBe(false);
        expect(d.warnings.some(w => /length/i.test(w))).toBe(true);
    });

    test('2K80J3E — HF marine SSB suppressed-carrier telephony', () => {
        const d = decodeEmissionDesignator('2K80J3E');
        expect(d.valid).toBe(true);
        expect(d.modulation?.code).toBe('J');
        expect(d.info_type?.code).toBe('E');
    });

    test('6M25C3F — vestigial-sideband analogue TV', () => {
        const d = decodeEmissionDesignator('6M25C3F');
        expect(d.valid).toBe(true);
        expect(d.modulation?.code).toBe('C');
        expect(d.info_type?.code).toBe('F');
    });

    test('0K00F3E — bandwidth first-char-zero, early exit, body not attempted', () => {
        const d = decodeEmissionDesignator('0K00F3E');
        expect(d.valid).toBe(false);
        expect(d.bandwidth).toBeNull();
        expect(d.modulation).toBeNull();
        expect(d.warnings.some(w => /bandwidth/i.test(w))).toBe(true);
    });
});

import { dumpSeedFromCodeTables, bootstrapEmissionTables, applyEmissionReseed, resolveEmissionCode } from '../src/emissions.js';
import { initializeDatabase } from '../src/db.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('seed generation + bootstrap', () => {
    let tmpDir: string;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emissions-test-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('dumpSeedFromCodeTables produces SQL with all 56 rows', () => {
        const out = path.join(tmpDir, 'emissions.sql');
        dumpSeedFromCodeTables(out);
        const sql = fs.readFileSync(out, 'utf-8');
        expect(sql).toContain('SAVEPOINT');
        expect(sql).toContain('RELEASE SAVEPOINT');
        expect(sql).toContain("INSERT INTO emission_modulation");
        expect(sql).toContain("'F'");  // FM code
        expect(sql).toContain("'Facsimile'");  // info_type C description
        // 18 + 8 + 9 + 15 + 6 = 56 INSERTs.
        const insertCount = (sql.match(/^INSERT INTO emission_/gm) ?? []).length;
        expect(insertCount).toBe(56);
    });

    test('bootstrapEmissionTables seeds an empty DB', () => {
        const dbPath = path.join(tmpDir, 'test.db');
        initializeDatabase(dbPath);
        const seedPath = path.join(tmpDir, 'emissions.sql');
        dumpSeedFromCodeTables(seedPath);

        const db = new Database(dbPath);
        try {
            bootstrapEmissionTables(db, seedPath);
            const counts = {
                modulation: (db.prepare('SELECT COUNT(*) AS n FROM emission_modulation').get() as { n: number }).n,
                signal_nature: (db.prepare('SELECT COUNT(*) AS n FROM emission_signal_nature').get() as { n: number }).n,
                info_type: (db.prepare('SELECT COUNT(*) AS n FROM emission_info_type').get() as { n: number }).n,
                signal_detail: (db.prepare('SELECT COUNT(*) AS n FROM emission_signal_detail').get() as { n: number }).n,
                multiplex: (db.prepare('SELECT COUNT(*) AS n FROM emission_multiplex').get() as { n: number }).n,
            };
            expect(counts).toEqual({ modulation: 18, signal_nature: 8, info_type: 9, signal_detail: 15, multiplex: 6 });
        } finally { db.close(); }
    });

    test('bootstrapEmissionTables is a no-op when tables are already populated', () => {
        const dbPath = path.join(tmpDir, 'test.db');
        initializeDatabase(dbPath);
        const seedPath = path.join(tmpDir, 'emissions.sql');
        dumpSeedFromCodeTables(seedPath);

        const db = new Database(dbPath);
        try {
            bootstrapEmissionTables(db, seedPath);
            // Manually mutate a description to detect re-application.
            db.prepare("UPDATE emission_info_type SET description = 'MUTATED' WHERE code = 'C'").run();
            bootstrapEmissionTables(db, seedPath);
            const desc = (db.prepare("SELECT description FROM emission_info_type WHERE code = 'C'").get() as { description: string }).description;
            expect(desc).toBe('MUTATED');  // bootstrap did not re-apply
        } finally { db.close(); }
    });

    test('bootstrapEmissionTables warns and returns when seed file is missing', () => {
        const dbPath = path.join(tmpDir, 'test.db');
        initializeDatabase(dbPath);
        const db = new Database(dbPath);
        try {
            expect(() => bootstrapEmissionTables(db, path.join(tmpDir, 'does-not-exist.sql'))).not.toThrow();
            const n = (db.prepare('SELECT COUNT(*) AS n FROM emission_modulation').get() as { n: number }).n;
            expect(n).toBe(0);
        } finally { db.close(); }
    });

    test('applyEmissionReseed throws when seed file is missing', () => {
        const dbPath = path.join(tmpDir, 'test.db');
        initializeDatabase(dbPath);
        const db = new Database(dbPath);
        try {
            expect(() => applyEmissionReseed(db, path.join(tmpDir, 'nope.sql'))).toThrow(/seed not found/);
        } finally { db.close(); }
    });

    test('applyEmissionReseed rolls back on malformed SQL', () => {
        const dbPath = path.join(tmpDir, 'test.db');
        initializeDatabase(dbPath);
        const seedPath = path.join(tmpDir, 'emissions.sql');
        dumpSeedFromCodeTables(seedPath);

        const db = new Database(dbPath);
        try {
            // Seed normally first so we know the rollback restores a real state.
            applyEmissionReseed(db, seedPath);
            const beforeCount = (db.prepare('SELECT COUNT(*) AS n FROM emission_modulation').get() as { n: number }).n;
            expect(beforeCount).toBe(18);

            // Now feed it a broken seed.
            const badSeedPath = path.join(tmpDir, 'bad.sql');
            fs.writeFileSync(badSeedPath, 'SAVEPOINT emissions_load;\nINSERT INTO emission_modulation(code, description, group_name) VALUES (\'BAD\', \'bad\', \'bad\');\nSELECT * FROM nonexistent_table;\nRELEASE SAVEPOINT emissions_load;\n');
            expect(() => applyEmissionReseed(db, badSeedPath)).toThrow();

            // Rollback should have restored the prior state — 18 rows, no 'BAD' row.
            const afterCount = (db.prepare('SELECT COUNT(*) AS n FROM emission_modulation').get() as { n: number }).n;
            expect(afterCount).toBe(18);
            const bad = db.prepare("SELECT code FROM emission_modulation WHERE code = 'BAD'").get();
            expect(bad).toBeUndefined();
        } finally { db.close(); }
    });
});

describe('resolveEmissionCode', () => {
    let dbPath: string;
    let db: Database.Database;
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emissions-resolve-'));
        dbPath = path.join(tmpDir, 'test.db');
        initializeDatabase(dbPath);
        const seedPath = path.join(tmpDir, 'emissions.sql');
        dumpSeedFromCodeTables(seedPath);
        db = new Database(dbPath);
        applyEmissionReseed(db, seedPath);
    });
    afterEach(() => {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('single-letter exact match (modulation F)', () => {
        const r = resolveEmissionCode(db, 'modulation', 'F');
        expect(r.kind).toBe('ok');
        if (r.kind === 'ok') expect(r.code).toBe('F');
    });

    test('single-letter unknown (modulation Z)', () => {
        const r = resolveEmissionCode(db, 'modulation', 'Z');
        expect(r.kind).toBe('unknown');
    });

    test('description substring unambiguous: "facsimile" → C', () => {
        const r = resolveEmissionCode(db, 'info_type', 'facsimile');
        expect(r.kind).toBe('ok');
        if (r.kind === 'ok') expect(r.code).toBe('C');
    });

    test('description substring case-insensitive', () => {
        const r = resolveEmissionCode(db, 'info_type', 'FACSIMILE');
        expect(r.kind).toBe('ok');
        if (r.kind === 'ok') expect(r.code).toBe('C');
    });

    test('description substring ambiguous: "sideband" → multiple', () => {
        const r = resolveEmissionCode(db, 'modulation', 'sideband');
        expect(r.kind).toBe('ambiguous');
        if (r.kind === 'ambiguous') {
            const codes = r.candidates.map(c => c.code).sort();
            // SSB variants: H, R, J + double-sideband A + independent-sideband B + vestigial-sideband C
            expect(codes).toEqual(['A', 'B', 'C', 'H', 'J', 'R']);
        }
    });

    test('description substring no match', () => {
        const r = resolveEmissionCode(db, 'modulation', 'quantum-bogon');
        expect(r.kind).toBe('not_found');
    });

    test('description "reduced" → R (single match)', () => {
        const r = resolveEmissionCode(db, 'modulation', 'reduced');
        expect(r.kind).toBe('ok');
        if (r.kind === 'ok') expect(r.code).toBe('R');
    });
});
