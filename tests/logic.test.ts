import {
    searchSites,
    getSiteDetails,
    searchLicences,
    searchClients,
    getLicenceDetails,
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
});
