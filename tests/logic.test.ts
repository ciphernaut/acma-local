import {
    searchSites,
    getSiteDetails,
    searchLicences,
    searchClients,
    getLicenceDetails,
    searchBsl,
    searchSpectrumBand,
} from '../src/logic.js';
import { initializeDatabase } from '../src/db.js';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Logic Layer', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_logic');
    const dbPath = path.join(scratchDir, 'test_acma.db');
    let db: Database.Database;

    beforeAll(() => {
        if (!fs.existsSync(scratchDir)) {
            fs.mkdirSync(scratchDir);
        }
        initializeDatabase(dbPath);
        db = new Database(dbPath);

        // Seed data
        db.prepare("INSERT INTO site (SITE_ID, NAME, POSTCODE) VALUES ('S1', 'Sydney Tower', '2000')").run();
        db.prepare("INSERT INTO client (CLIENT_NO, LICENCEE) VALUES (1, 'Test Client')").run();
        db.prepare("INSERT INTO licence (LICENCE_NO, CLIENT_NO) VALUES ('L1', 1)").run();
        db.prepare("INSERT INTO device_details (SDD_ID, SITE_ID, LICENCE_NO, FREQUENCY) VALUES (101, 'S1', 'L1', 100000000)").run();
    });

    afterAll(() => {
        if (db) db.close();
        if (fs.existsSync(scratchDir)) {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
    });

    test('searchSites should find site by name', () => {
        const results = searchSites(db, 'Sydney');
        expect(results).toHaveLength(1);
        expect((results[0] as any).NAME).toBe('Sydney Tower');
    });

    test('getSiteDetails should return site and devices', () => {
        const results = getSiteDetails(db, 'S1');
        expect(results).not.toBeNull();
        expect((results!.site as any).NAME).toBe('Sydney Tower');
        expect(results!.devices).toHaveLength(1);
        expect((results!.devices[0] as any).FREQUENCY).toBe(100000000);
    });

    test('searchLicences should find licence by no', () => {
        const results = searchLicences(db, 'L1');
        expect(results).toHaveLength(1);
    });

    test('searchClients should find client by name', () => {
        const results = searchClients(db, 'Test');
        expect(results).toHaveLength(1);
    });

    test('getLicenceDetails should return licence, client and devices', () => {
        const results = getLicenceDetails(db, 'L1');
        expect(results).not.toBeNull();
        expect((results!.licence as any).LICENCE_NO).toBe('L1');
        expect((results!.client as any).LICENCEE).toBe('Test Client');
        expect(results!.devices).toHaveLength(1);
    });

    test('searchLicences returns SERVICE_NAME, SUBSERVICE_NAME, STATUS_NAME via JOINs', () => {
        // Seed the lookups (call sites adjust per existing test infrastructure).
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO licence_service (SV_ID, SV_NAME) VALUES (3, 'Land Mobile');
            INSERT INTO licence_subservice (SS_ID, SV_SV_ID, SS_NAME) VALUES (304, 3, 'Land Mobile System');
            INSERT INTO licence_status (STATUS, STATUS_TEXT) VALUES ('10', 'Expired');
            INSERT INTO licence (LICENCE_NO, CLIENT_NO, SV_ID, SS_ID, STATUS) VALUES ('LM1', 1, 3, 304, '10');
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchLicences(db2, 'LM1', 10) as any[];
        db2.close();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            LICENCE_NO: 'LM1',
            SV_ID: 3,
            SERVICE_NAME: 'Land Mobile',
            SUBSERVICE_NAME: 'Land Mobile System',
            STATUS_NAME: 'Expired',
        });
    });

    test('searchClients returns CLIENT_TYPE_NAME, FEE_STATUS_NAME, INDUSTRY_NAME via JOINs', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO client_type (TYPE_ID, NAME) VALUES (5, 'Company');
            INSERT INTO fee_status (FEE_STATUS_ID, FEE_STATUS_TEXT) VALUES (1, 'Normal');
            INSERT INTO industry_cat (CAT_ID, DESCRIPTION, NAME) VALUES (3, 'Manufacturing', 'Manufacturing');
            INSERT INTO client (CLIENT_NO, LICENCEE, CAT_ID, CLIENT_TYPE_ID, FEE_STATUS_ID)
                VALUES (42, 'Acme Pty Ltd', 3, 5, 1);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchClients(db2, 'Acme', 10) as any[];
        db2.close();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            LICENCEE: 'Acme Pty Ltd',
            CLIENT_TYPE_NAME: 'Company',
            FEE_STATUS_NAME: 'Normal',
            INDUSTRY_NAME: 'Manufacturing',
        });
    });

    test('searchSites returns LICENSING_AREA_NAME via JOIN', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO licensing_area (LICENSING_AREA_ID, DESCRIPTION) VALUES (1, 'Australia');
            INSERT INTO site (SITE_ID, NAME, POSTCODE, LICENSING_AREA_ID)
                VALUES ('S1_LA', 'Test Site', '2000', 1);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchSites(db2, 'Test Site', 10) as any[];
        db2.close();
        expect(results[0]?.LICENSING_AREA_NAME).toBe('Australia');
    });

    test('searchBsl matches by call sign and joins bsl_area for AREA_NAME', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO bsl_area (AREA_CODE, AREA_NAME) VALUES (162, 'ADELAIDE TV1');
            INSERT INTO bsl
                (BSL_NO, MEDIUM_CATEGORY, REGION_CATEGORY, BSL_STATE, DATE_COMMENCED, ON_AIR_ID, CALL_SIGN, AREA_CODE)
                VALUES (85, 'TV', 'Regional', 'ACT', '1962-06-02', '10', 'CTC', 162);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchBsl(db2, 'CTC', 10) as any[];
        db2.close();
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            BSL_NO: 85,
            CALL_SIGN: 'CTC',
            MEDIUM_CATEGORY: 'TV',
            BSL_STATE: 'ACT',
            AREA_NAME: 'ADELAIDE TV1',
        });
    });

    test('searchBsl matches by BSL_NO (numeric string)', () => {
        const db = new Database(dbPath);
        db.exec(`INSERT INTO bsl (BSL_NO, CALL_SIGN) VALUES (123, 'XYZ');`);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        const results = searchBsl(db2, '123', 10) as any[];
        db2.close();
        expect(results[0]?.BSL_NO).toBe(123);
    });

    test('searchSpectrumBand finds licences whose band overlaps the query', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO auth_spectrum_area
                (LICENCE_NO, AREA_CODE, AREA_NAME, AREA_DESCRIPTION)
                VALUES ('10143110', 'AP_10143110_3918', 'Brisbane', 'KX6G, KX6H...');
            INSERT INTO auth_spectrum_freq
                (LICENCE_NO, AREA_CODE, AREA_NAME, LW_FREQUENCY_START, LW_FREQUENCY_END, UP_FREQUENCY_START, UP_FREQUENCY_END)
                VALUES ('10143110', 'AP_10143110_3918', 'Brisbane', 1960000000, 1970000000, 2150000000, 2160000000);
        `);
        db.close();

        const db2 = new Database(dbPath, { readonly: true });
        // Query 1.96-1.97 GHz — overlaps the LW range.
        const overlap = searchSpectrumBand(db2, 1_960_000_000, 1_970_000_000, 50) as any[];
        // Query 0-100 Hz — far outside; should return none.
        const outside = searchSpectrumBand(db2, 0, 100, 50) as any[];
        // Query 1.965 GHz to 2.155 GHz — straddles both bands.
        const straddle = searchSpectrumBand(db2, 1_965_000_000, 2_155_000_000, 50) as any[];
        db2.close();

        expect(overlap).toHaveLength(1);
        expect(overlap[0]).toMatchObject({ LICENCE_NO: '10143110', AREA_NAME: 'Brisbane' });
        expect(outside).toHaveLength(0);
        expect(straddle).toHaveLength(1);
    });
});
