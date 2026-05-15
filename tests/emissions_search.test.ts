import { jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initializeDatabase } from '../src/db.js';
import { dumpSeedFromCodeTables, applyEmissionReseed } from '../src/emissions.js';
import { searchDevicesByEmission } from '../src/emissions_search.js';

describe('searchDevicesByEmission', () => {
    let tmpDir: string;
    let dbPath: string;
    let db: Database.Database;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emissions-search-'));
        dbPath = path.join(tmpDir, 'test.db');
        initializeDatabase(dbPath);
        const seedPath = path.join(tmpDir, 'emissions.sql');
        dumpSeedFromCodeTables(seedPath);
        db = new Database(dbPath);
        applyEmissionReseed(db, seedPath);

        // Seed a handful of device_details rows for the test.
        db.prepare(`INSERT INTO device_details(SDD_ID, LICENCE_NO, EMISSION, FREQUENCY, SITE_ID) VALUES
            (1, 'L001', '16K0F3E',  150000000, 'S1'),
            (2, 'L002', '10K1F3E',  151000000, 'S1'),
            (3, 'L003', '10M0W7D', 2400000000, 'S2'),
            (4, 'L004', '2K80J3E',    7000000, 'S3'),
            (5, 'L005', '6M25C3F',  500000000, 'S2'),
            (6, 'L006', '10K1R3C',  152000000, 'S1'),
            (7, 'L007', '19M8W7DEW', 900000000, 'S1')`).run();
        db.prepare(`INSERT INTO licence(LICENCE_NO, CLIENT_NO) VALUES
            ('L001', 100), ('L002', 100), ('L003', 200),
            ('L004', 300), ('L005', 400), ('L006', 500),
            ('L007', 700)`).run();
        db.prepare(`INSERT INTO site(SITE_ID, STATE) VALUES
            ('S1', 'NSW'), ('S2', 'QLD'), ('S3', 'VIC')`).run();
    });
    afterEach(() => {
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('modulation: "F", info_type: "E" → two rows', () => {
        const r = searchDevicesByEmission(db, { modulation: 'F', info_type: 'E' });
        expect(r.rows.map(x => x.LICENCE_NO).sort()).toEqual(['L001', 'L002']);
        expect(r.resolved_filters.modulation).toEqual({ code: 'F', description: 'Frequency modulation' });
        expect(r.resolved_filters.info_type?.code).toBe('E');
    });

    test('description-resolution: modulation "reduced", info_type "facsimile" → one row', () => {
        const r = searchDevicesByEmission(db, { modulation: 'reduced', info_type: 'facsimile' });
        expect(r.rows.map(x => x.LICENCE_NO)).toEqual(['L006']);
        expect(r.resolved_filters.modulation?.code).toBe('R');
        expect(r.resolved_filters.info_type?.code).toBe('C');
    });

    test('decoded sub-field is present on each row', () => {
        const r = searchDevicesByEmission(db, { modulation: 'F' });
        expect(r.rows[0]!.decoded.modulation_code).toBe('F');
        expect(r.rows[0]!.decoded.modulation_description).toBe('Frequency modulation');
        expect(r.rows[0]!.decoded.info_type_description).toContain('Telephony');
    });

    test('ambiguous description → error with candidates', () => {
        const r = searchDevicesByEmission(db, { modulation: 'sideband' });
        expect(r._error).toBeDefined();
        expect(r._error).toContain('ambiguous');
        expect(r._error).toContain('R');  // one of the candidates
    });

    test('no filters → error', () => {
        const r = searchDevicesByEmission(db, {});
        expect(r._error).toBe('At least one filter is required.');
    });

    test('unknown code letter → error', () => {
        const r = searchDevicesByEmission(db, { modulation: 'Z' });
        expect(r._error).toContain('Z');
    });

    test('not-found description → error', () => {
        const r = searchDevicesByEmission(db, { modulation: 'quantum-bogon' });
        expect(r._error).toContain('quantum-bogon');
    });

    test('state filter joins site', () => {
        const r = searchDevicesByEmission(db, { modulation: 'F', state: 'NSW' });
        expect(r.rows.map(x => x.LICENCE_NO).sort()).toEqual(['L001', 'L002']);
    });

    test('state filter excludes non-matching states', () => {
        const r = searchDevicesByEmission(db, { modulation: 'W', state: 'VIC' });
        expect(r.rows).toEqual([]);
    });

    test('bandwidth bounds', () => {
        const r = searchDevicesByEmission(db, { modulation: 'F', min_bandwidth_hz: 15000, max_bandwidth_hz: 20000 });
        expect(r.rows.map(x => x.LICENCE_NO)).toEqual(['L001']);  // 16K0F3E only, not 10K1F3E
    });

    test('limit caps results', () => {
        const r = searchDevicesByEmission(db, { modulation: 'F', limit: 1 });
        expect(r.rows).toHaveLength(1);
        expect(r.truncated).toBe(true);
    });

    test('truncated=false when below limit', () => {
        const r = searchDevicesByEmission(db, { modulation: 'F', limit: 100 });
        expect(r.truncated).toBe(false);
    });

    test('signal_detail filter (9-char form)', () => {
        const r = searchDevicesByEmission(db, { signal_detail: 'E' });
        expect(r.rows.map(x => x.LICENCE_NO)).toEqual(['L007']);
    });

    test('multiplex filter (9-char form)', () => {
        const r = searchDevicesByEmission(db, { multiplex: 'W' });
        expect(r.rows.map(x => x.LICENCE_NO)).toEqual(['L007']);
    });

    test('licence_no filter', () => {
        const r = searchDevicesByEmission(db, { licence_no: 'L001' });
        expect(r.rows.map(x => x.LICENCE_NO)).toEqual(['L001']);
    });

    test('bandwidth-only filter (no code filters) is allowed', () => {
        const r = searchDevicesByEmission(db, { min_bandwidth_hz: 5_000_000, max_bandwidth_hz: 20_000_000 });
        // 10M0W7D (10 MHz), 6M25C3F (6.25 MHz), 19M8W7DEW (19.8 MHz) — three matches
        const codes = r.rows.map(x => x.LICENCE_NO).sort();
        expect(codes).toEqual(['L003', 'L005', 'L007']);
    });
});
