import { extractZip, importCsv, parseRemoteTimestamp, isInputZipStale } from '../src/sync';
import { pickSpectraRrl, fetchExtractsManifest, decideSyncAction } from '../src/sync';
import { applyCsvDiffZip } from '../src/sync';
import { sync, getSyncStatus } from '../src/sync';
import type { ExtractItem, ExtractsManifest, SyncAction } from '../src/sync';
import { initializeDatabase } from '../src/db';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { jest } from '@jest/globals';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Sync Logic - ZIP Extraction', () => {
    const scratchDir = path.join(__dirname, '../scratch_test');
    const zipPath = path.join(scratchDir, 'test.zip');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) {
            fs.mkdirSync(scratchDir);
        }
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
    });

    test('should extract files from zip', async () => {
        const zip = new AdmZip();
        zip.addFile('client.csv', Buffer.from('CLIENT_NO,LICENCEE\n1,Test Corp'));
        zip.writeZip(zipPath);

        const extractedFiles = await extractZip(zipPath, scratchDir);
        expect(extractedFiles).toContain(path.join(scratchDir, 'client.csv'));
        expect(fs.existsSync(path.join(scratchDir, 'client.csv'))).toBe(true);
    });
});

describe('Sync Logic - CSV Import', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_csv');
    const dbPath = path.join(scratchDir, 'test_acma.db');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) {
            fs.mkdirSync(scratchDir);
        }
        initializeDatabase(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
    });

    test('should import client.csv into the database', async () => {
        const csvContent = 'CLIENT_NO,LICENCEE,TRADING_NAME,ACN,ABN,POSTAL_STREET,POSTAL_SUBURB,POSTAL_STATE,POSTAL_POSTCODE,CAT_ID,CLIENT_TYPE_ID,FEE_STATUS_ID\n1,"Test Corp","Test Trading","123","456","Street","Suburb","NSW","2000",1,2,3';
        const csvPath = path.join(scratchDir, 'client.csv');
        fs.writeFileSync(csvPath, csvContent);

        await importCsv(csvPath, dbPath, 'client');

        const db = new Database(dbPath);
        const client = db.prepare('SELECT * FROM client WHERE CLIENT_NO = 1').get() as any;
        expect(client).toBeDefined();
        expect(client.LICENCEE).toBe('Test Corp');
        db.close();
    });
});

describe('parseRemoteTimestamp', () => {
    test('parses well-formed ACMA timestamp as UTC', () => {
        const d = parseRemoteTimestamp('2026-03-05 06:00:00');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-03-05T06:00:00.000Z');
    });

    test('tolerates surrounding whitespace and trailing newline', () => {
        const d = parseRemoteTimestamp('  2026-03-05 06:00:00\n');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-03-05T06:00:00.000Z');
    });

    test('returns null on malformed input', () => {
        expect(parseRemoteTimestamp('not a date')).toBeNull();
        expect(parseRemoteTimestamp('2026/03/05 06:00:00')).toBeNull();
    });

    test('returns null on regex-valid but semantically invalid date', () => {
        expect(parseRemoteTimestamp('2026-13-01 00:00:00')).toBeNull();
    });

    test('returns null on empty string', () => {
        expect(parseRemoteTimestamp('')).toBeNull();
    });

    test('parses compact YYYYMMDDHHMMSS form (no sub-seconds)', () => {
        const d = parseRemoteTimestamp('20260305060000');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-03-05T06:00:00.000Z');
    });

    test('parses compact form with trailing nanosecond digits (real production shape)', () => {
        // Mirror of the value observed in data/acma.db meta.as_of after a real sync.
        const d = parseRemoteTimestamp('20260305234922793617000');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-03-05T23:49:22.000Z');
    });

    test('returns null on compact form with semantically invalid components', () => {
        expect(parseRemoteTimestamp('20261301000000')).toBeNull();
    });

    test('parses ISO 8601 UTC form (no fractional seconds)', () => {
        const d = parseRemoteTimestamp('2026-05-12T21:51:36Z');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-05-12T21:51:36.000Z');
    });

    test('tolerates surrounding whitespace in ISO 8601 form', () => {
        const d = parseRemoteTimestamp('  2026-05-12T21:51:36Z\n');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-05-12T21:51:36.000Z');
    });

    test('parses ISO 8601 UTC form with fractional seconds', () => {
        const d = parseRemoteTimestamp('2026-05-12T21:51:36.123Z');
        expect(d).not.toBeNull();
        expect(d!.toISOString()).toBe('2026-05-12T21:51:36.123Z');
    });

    test('returns null on ISO 8601 with non-UTC timezone', () => {
        // We only support 'Z'; offsets like +10:00 are intentionally rejected
        // because ACMA's manifest always emits 'Z'.
        expect(parseRemoteTimestamp('2026-05-12T21:51:36+10:00')).toBeNull();
    });

    test('returns null on ISO 8601 with semantically invalid components', () => {
        expect(parseRemoteTimestamp('2026-13-12T21:51:36Z')).toBeNull();
    });
});

describe('isInputZipStale', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_stale');
    const zipPath = path.join(scratchDir, 'sample.zip');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        fs.writeFileSync(zipPath, 'placeholder');
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('returns false when zip is missing', () => {
        const remote = new Date('2026-03-05T06:00:00Z');
        expect(isInputZipStale(path.join(scratchDir, 'does-not-exist.zip'), remote)).toBe(false);
    });

    test('returns true when zip mtime is older than remote timestamp', () => {
        const oldTime = new Date('2025-01-01T00:00:00Z');
        fs.utimesSync(zipPath, oldTime, oldTime);
        const remote = new Date('2026-03-05T06:00:00Z');
        expect(isInputZipStale(zipPath, remote)).toBe(true);
    });

    test('returns false when zip mtime is newer than remote timestamp', () => {
        const newTime = new Date('2026-04-01T00:00:00Z');
        fs.utimesSync(zipPath, newTime, newTime);
        const remote = new Date('2026-03-05T06:00:00Z');
        expect(isInputZipStale(zipPath, remote)).toBe(false);
    });

    test('returns false when zip mtime exactly equals remote timestamp (strict <)', () => {
        const t = new Date('2026-03-05T06:00:00Z');
        fs.utimesSync(zipPath, t, t);
        expect(isInputZipStale(zipPath, t)).toBe(false);
    });
});

describe('pickSpectraRrl', () => {
    const item = (FileName: string): ExtractItem => ({
        Description: 'x', Format: 'CSV', FileSize: 0,
        FileName, FileUrl: `https://cdn.example/${FileName}`,
    });

    test('returns the spectra_rrl entry when present alongside hrp', () => {
        const items = [
            item('spectra_rrl.zip'),
            item('spectra_licence_hrp.zip'),
        ];
        expect(pickSpectraRrl(items)?.FileName).toBe('spectra_rrl.zip');
    });

    test('returns spectra_rrl-changes-YYYY-MM-DD.zip from an incremental entry', () => {
        const items = [item('spectra_rrl-changes-2026-03-15.zip')];
        expect(pickSpectraRrl(items)?.FileName).toBe('spectra_rrl-changes-2026-03-15.zip');
    });

    test('returns null when only hrp is present', () => {
        const items = [item('spectra_licence_hrp.zip')];
        expect(pickSpectraRrl(items)).toBeNull();
    });

    test('returns null on empty list', () => {
        expect(pickSpectraRrl([])).toBeNull();
    });
});

describe('decideSyncAction', () => {
    // Default manifest: full=May 12, three incrementals on May 10/11/12.
    const fixtureManifest = (): ExtractsManifest => ([
        {
            IsFullExtract: true,
            LastMdified: '2026-05-12T21:51:36Z',
            Items: [{
                Description: 'Spectra dataset', Format: 'CSV', FileSize: 71666767,
                FileName: 'spectra_rrl.zip',
                FileUrl: 'https://cdn.acma.gov.au/rrl/spectra_rrl.zip',
            }],
        },
        {
            IsFullExtract: false, DateOfChanges: '2026-05-12',
            LastMdified: '2026-05-12T13:20:59Z',
            Items: [{
                Description: 'Spectra dataset', Format: 'CSV', FileSize: 250000,
                FileName: 'spectra_rrl-changes-2026-05-12.zip',
                FileUrl: 'https://cdn.acma.gov.au/rrl/changes/spectra_rrl-changes-2026-05-12.zip',
            }],
        },
        {
            IsFullExtract: false, DateOfChanges: '2026-05-11',
            LastMdified: '2026-05-11T13:00:00Z',
            Items: [{
                Description: 'Spectra dataset', Format: 'CSV', FileSize: 250000,
                FileName: 'spectra_rrl-changes-2026-05-11.zip',
                FileUrl: 'https://cdn.acma.gov.au/rrl/changes/spectra_rrl-changes-2026-05-11.zip',
            }],
        },
        {
            IsFullExtract: false, DateOfChanges: '2026-05-10',
            LastMdified: '2026-05-10T13:00:00Z',
            Items: [{
                Description: 'Spectra dataset', Format: 'CSV', FileSize: 250000,
                FileName: 'spectra_rrl-changes-2026-05-10.zip',
                FileUrl: 'https://cdn.acma.gov.au/rrl/changes/spectra_rrl-changes-2026-05-10.zip',
            }],
        },
    ]);
    const now = new Date('2026-05-13T08:00:00Z');

    test('cooldown active → noop/cooldown (regardless of state)', () => {
        // lastSync only 1h ago, < 12h cooldown
        const lastSync = new Date('2026-05-13T07:00:00Z');
        const action = decideSyncAction(null, fixtureManifest(), 'auto', lastSync, now);
        expect(action).toEqual({ kind: 'noop', reason: 'cooldown' });
    });

    test('bootstrap when asOf is null and no cooldown applies', () => {
        const action = decideSyncAction(null, fixtureManifest(), 'auto', null, now);
        expect(action.kind).toBe('full');
        if (action.kind !== 'full') throw new Error('expected full');
        expect(action.reason).toBe('bootstrap');
        expect(action.entry.IsFullExtract).toBe(true);
    });

    test('mode=full → forced (even when current)', () => {
        const asOf = new Date('2026-05-12T21:51:36Z'); // exactly current
        const action = decideSyncAction(asOf, fixtureManifest(), 'full', null, now);
        expect(action).toMatchObject({ kind: 'full', reason: 'forced' });
    });

    test('noop/current when asOf >= full.LastMdified', () => {
        const asOf = new Date('2026-05-12T21:51:36Z'); // equal
        const action = decideSyncAction(asOf, fixtureManifest(), 'auto', null, now);
        expect(action).toEqual({ kind: 'noop', reason: 'current' });
    });

    test('noop/current when asOf is past full.LastMdified', () => {
        const asOf = new Date('2026-05-12T22:00:00Z'); // 9m past
        const action = decideSyncAction(asOf, fixtureManifest(), 'auto', null, now);
        expect(action).toEqual({ kind: 'noop', reason: 'current' });
    });

    test('incremental with ascending-sorted applicable entries', () => {
        // asOf is just before the May 11 change-zip → should include May 11 and May 12.
        const asOf = new Date('2026-05-11T08:00:00Z');
        const action = decideSyncAction(asOf, fixtureManifest(), 'auto', null, now);
        expect(action.kind).toBe('incremental');
        if (action.kind !== 'incremental') throw new Error('expected incremental');
        expect(action.entries.map(e => e.DateOfChanges)).toEqual(['2026-05-11', '2026-05-12']);
    });

    test('gap-exceeded when asOf is older than 30 h before oldest applicable', () => {
        // asOf is 4 days before May 12 full; oldest available is May 10. Gap > 30h.
        const asOf = new Date('2026-05-08T00:00:00Z');
        const action = decideSyncAction(asOf, fixtureManifest(), 'auto', null, now);
        expect(action.kind).toBe('gap-exceeded');
        if (action.kind !== 'gap-exceeded') throw new Error('expected gap-exceeded');
        expect(action.behindHours).toBeGreaterThan(48);
    });

    test('gap-exceeded when no incrementals are applicable but asOf < full', () => {
        // asOf newer than every incremental but older than the full.
        // (Manifest only carries 3 most recent incrementals; older full re-published.)
        const asOf = new Date('2026-05-12T20:00:00Z');
        const noIncrementals: ExtractsManifest = [fixtureManifest()[0]!];
        const action = decideSyncAction(asOf, noIncrementals, 'auto', null, now);
        expect(action.kind).toBe('gap-exceeded');
    });

    test('cooldown takes precedence over forced mode', () => {
        const lastSync = new Date('2026-05-13T07:00:00Z'); // 1h ago
        const asOf = new Date('2026-05-11T00:00:00Z');
        const action = decideSyncAction(asOf, fixtureManifest(), 'full', lastSync, now);
        expect(action).toEqual({ kind: 'noop', reason: 'cooldown' });
    });

    test('throws if manifest has no full extract entry', () => {
        const onlyIncrementals: ExtractsManifest = fixtureManifest().slice(1);
        expect(() => decideSyncAction(null, onlyIncrementals, 'auto', null, now))
            .toThrow('Manifest has no full extract entry');
    });
});

describe('fetchExtractsManifest', () => {
    let axiosGetSpy: ReturnType<typeof jest.spyOn>;

    beforeEach(() => {
        axiosGetSpy = jest.spyOn(axios, 'get');
    });

    afterEach(() => { jest.restoreAllMocks(); });

    test('parses the manifest payload, preserving LastMdified typo', async () => {
        const payload: ExtractsManifest = [
            {
                IsFullExtract: true,
                LastMdified: '2026-05-12T21:51:36Z',
                Items: [{
                    Description: 'Spectra dataset', Format: 'CSV', FileSize: 71666767,
                    FileName: 'spectra_rrl.zip',
                    FileUrl: 'https://cdn.acma.gov.au/rrl/spectra_rrl.zip',
                }],
            },
            {
                IsFullExtract: false,
                DateOfChanges: '2026-03-15',
                LastMdified: '2026-03-15T13:20:59Z',
                Items: [{
                    Description: 'Spectra dataset', Format: 'CSV', FileSize: 12600026,
                    FileName: 'spectra_rrl-changes-2026-03-15.zip',
                    FileUrl: 'https://cdn.acma.gov.au/rrl/changes/spectra_rrl-changes-2026-03-15.zip',
                }],
            },
        ];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        axiosGetSpy.mockResolvedValueOnce({ data: payload } as any);

        const m = await fetchExtractsManifest('https://example/v1/Extracts');

        expect(m).toEqual(payload);
        expect(m[0]!.LastMdified).toBe('2026-05-12T21:51:36Z');
        expect(axiosGetSpy).toHaveBeenCalledWith('https://example/v1/Extracts');
    });

    test('propagates axios errors', async () => {
        axiosGetSpy.mockRejectedValueOnce(new Error('network down') as never);
        await expect(fetchExtractsManifest('https://example/v1/Extracts'))
            .rejects.toThrow('network down');
    });

    test('throws on non-array response payload', async () => {
        axiosGetSpy.mockResolvedValueOnce({ data: { error: 'oops' } } as any);
        await expect(fetchExtractsManifest('https://example/v1/Extracts'))
            .rejects.toThrow('unexpected response shape');
    });
});

describe('applyCsvDiffZip', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_csv_diff');
    const dbPath = path.join(scratchDir, 'test_acma.db');
    const zipPath = path.join(scratchDir, 'change.zip');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        initializeDatabase(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    function buildChangeZip(files: Record<string, string>): void {
        const zip = new AdmZip();
        for (const [name, content] of Object.entries(files)) {
            zip.addFile(name, Buffer.from(content, 'utf-8'));
        }
        zip.writeZip(zipPath);
    }

    test('Added rows are inserted, Updated rows replace, Deleted rows are removed', async () => {
        // Seed the client table with two existing rows.
        const seedDb = new Database(dbPath);
        seedDb.prepare("INSERT INTO client (CLIENT_NO, LICENCEE) VALUES (1, 'Old Name')").run();
        seedDb.prepare("INSERT INTO client (CLIENT_NO, LICENCEE) VALUES (2, 'Doomed')").run();
        seedDb.close();

        // Change zip: add #3, update #1, delete #2.
        buildChangeZip({
            'client.csv':
                'CLIENT_NO,LICENCEE,TRADING_NAME,ACN,ABN,POSTAL_STREET,POSTAL_SUBURB,POSTAL_STATE,POSTAL_POSTCODE,CAT_ID,CLIENT_TYPE_ID,FEE_STATUS_ID,CHANGE\n' +
                '3,New Corp,,,,,,,,,,,Added\n' +
                '1,Updated Name,,,,,,,,,,,Updated\n' +
                '2,,,,,,,,,,,,Deleted\n',
        });

        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath);
        const rows = db.prepare('SELECT CLIENT_NO, LICENCEE FROM client ORDER BY CLIENT_NO').all() as any[];
        db.close();
        expect(rows).toEqual([
            { CLIENT_NO: 1, LICENCEE: 'Updated Name' },
            { CLIENT_NO: 3, LICENCEE: 'New Corp' },
        ]);
    });

    test('device_detail.csv (singular) is applied to device_details table (plural)', async () => {
        // 55-column header: 54 schema cols + CHANGE.
        const header = [
            'SDD_ID','LICENCE_NO','DEVICE_REGISTRATION_IDENTIFIER','FORMER_DEVICE_IDENTIFIER',
            'AUTHORISATION_DATE','CERTIFICATION_METHOD','GROUP_FLAG','SITE_RADIUS','FREQUENCY',
            'BANDWIDTH','CARRIER_FREQ','EMISSION','DEVICE_TYPE','TRANSMITTER_POWER',
            'TRANSMITTER_POWER_UNIT','SITE_ID','ANTENNA_ID','POLARISATION','AZIMUTH','HEIGHT',
            'TILT','FEEDER_LOSS','LEVEL_OF_PROTECTION','EIRP','EIRP_UNIT','SV_ID','SS_ID',
            'EFL_ID','EFL_FREQ_IDENT','EFL_SYSTEM','LEQD_MODE','RECEIVER_THRESHOLD',
            'AREA_AREA_ID','CALL_SIGN','AREA_DESCRIPTION','AP_ID','CLASS_OF_STATION_CODE',
            'SUPPLIMENTAL_FLAG','EQ_FREQ_RANGE_MIN','EQ_FREQ_RANGE_MAX','NATURE_OF_SERVICE_ID',
            'HOURS_OF_OPERATION','SA_ID','RELATED_EFL_ID','EQP_ID','ANTENNA_MULTI_MODE',
            'POWER_IND','LPON_CENTER_LONGITUDE','LPON_CENTER_LATITUDE','TCS_ID','TECH_SPEC_ID',
            'DROPTHROUGH_ID','STATION_TYPE','STATION_NAME','CHANGE',
        ];
        // SDD_ID=999, LICENCE_NO='L1', 52 empty cols, CHANGE='Added' → 55 fields.
        const row = ['999', 'L1', ...new Array(52).fill(''), 'Added'];
        buildChangeZip({
            'device_detail.csv': header.join(',') + '\n' + row.join(',') + '\n',
        });

        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath);
        const got = db.prepare('SELECT SDD_ID, LICENCE_NO FROM device_details WHERE SDD_ID = 999').get() as any;
        db.close();
        expect(got).toEqual({ SDD_ID: 999, LICENCE_NO: 'L1' });
    });

    test('CSVs for tables not in our schema are skipped silently', async () => {
        // access_area is in the ACMA change zip but not in our materialised schema.
        buildChangeZip({
            'access_area.csv':
                'AREA_ID,AREA_NAME,CHANGE\n' +
                '99999,Some Area,Deleted\n',
        });
        // Should not throw.
        await expect(applyCsvDiffZip(zipPath, dbPath)).resolves.toBeUndefined();
    });

    test('header-only CSV (no row changes) is a no-op', async () => {
        // Insert a row, then apply a change-zip whose client.csv has only a header.
        const seedDb = new Database(dbPath);
        seedDb.prepare("INSERT INTO client (CLIENT_NO, LICENCEE) VALUES (42, 'Survivor')").run();
        seedDb.close();

        buildChangeZip({
            'client.csv':
                'CLIENT_NO,LICENCEE,TRADING_NAME,ACN,ABN,POSTAL_STREET,POSTAL_SUBURB,POSTAL_STATE,POSTAL_POSTCODE,CAT_ID,CLIENT_TYPE_ID,FEE_STATUS_ID,CHANGE\n',
        });
        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath);
        const count = (db.prepare('SELECT COUNT(*) AS n FROM client').get() as any).n;
        db.close();
        expect(count).toBe(1);
    });

    test('Updated row that is not yet in DB is inserted (idempotency)', async () => {
        // DB starts empty. The change-zip contains an Updated row for CLIENT_NO=99.
        // DELETE-then-INSERT means the DELETE silently matches zero rows, then INSERT
        // adds the new row. This documents idempotency: replaying a change-zip is safe.
        buildChangeZip({
            'client.csv':
                'CLIENT_NO,LICENCEE,TRADING_NAME,ACN,ABN,POSTAL_STREET,POSTAL_SUBURB,POSTAL_STATE,POSTAL_POSTCODE,CAT_ID,CLIENT_TYPE_ID,FEE_STATUS_ID,CHANGE\n' +
                '99,Late Arrival,,,,,,,,,,,Updated\n',
        });

        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath);
        const row = db.prepare('SELECT CLIENT_NO, LICENCEE FROM client WHERE CLIENT_NO = 99').get() as any;
        db.close();
        expect(row).toEqual({ CLIENT_NO: 99, LICENCEE: 'Late Arrival' });
    });

    test('throws when CSV is missing the CHANGE column', async () => {
        buildChangeZip({
            'client.csv':
                'CLIENT_NO,LICENCEE\n' +
                '1,No Change Column Here\n',
        });
        await expect(applyCsvDiffZip(zipPath, dbPath))
            .rejects.toThrow(/Expected CHANGE column/);
    });

    test('throws on unexpected column name (SQL-injection guard)', async () => {
        buildChangeZip({
            'client.csv':
                'CLIENT_NO,"BAD;COL",CHANGE\n' +
                '1,whatever,Added\n',
        });
        await expect(applyCsvDiffZip(zipPath, dbPath))
            .rejects.toThrow(/Unexpected column name/);
    });

    test('auth_spectrum_freq incremental (4-column composite PK)', async () => {
        // Seed two rows with the same LICENCE_NO + AREA_CODE but different freq starts.
        const seedDb = new Database(dbPath);
        seedDb.exec(`
            INSERT INTO auth_spectrum_freq
                (LICENCE_NO, AREA_CODE, AREA_NAME, LW_FREQUENCY_START, LW_FREQUENCY_END, UP_FREQUENCY_START, UP_FREQUENCY_END)
                VALUES ('L1', 'A1', 'X', 100, 200, 300, 400);
            INSERT INTO auth_spectrum_freq
                (LICENCE_NO, AREA_CODE, AREA_NAME, LW_FREQUENCY_START, LW_FREQUENCY_END, UP_FREQUENCY_START, UP_FREQUENCY_END)
                VALUES ('L1', 'A1', 'X', 500, 600, 700, 800);
        `);
        seedDb.close();

        // Delete only the (L1, A1, 100, 300) row.
        buildChangeZip({
            'auth_spectrum_freq.csv':
                'LICENCE_NO,AREA_CODE,AREA_NAME,LW_FREQUENCY_START,LW_FREQUENCY_END,UP_FREQUENCY_START,UP_FREQUENCY_END,CHANGE\n' +
                'L1,A1,,100,,300,,Deleted\n',
        });
        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath);
        const rows = db.prepare('SELECT LW_FREQUENCY_START FROM auth_spectrum_freq ORDER BY LW_FREQUENCY_START').all() as any[];
        db.close();
        expect(rows).toEqual([{ LW_FREQUENCY_START: 500 }]);
    });

    test('applic_text_block incremental updates FTS5 mirror', async () => {
        const seedDb = new Database(dbPath);
        seedDb.exec(`
            INSERT INTO applic_text_block (APTB_ID, APTB_TEXT, APTB_DESCRIPTION)
                VALUES (10, 'Initial conditions for the licence.', 'Initial');
            INSERT INTO applic_text_block_fts(applic_text_block_fts) VALUES('rebuild');
        `);
        seedDb.close();

        // Change-zip: Update row 10's APTB_TEXT, Add row 20, Delete row 10's twin (none — should be no-op).
        buildChangeZip({
            'applic_text_block.csv':
                'APTB_ID,APTB_TABLE_PREFIX,APTB_TABLE_ID,LICENCE_NO,APTB_DESCRIPTION,APTB_CATEGORY,APTB_TEXT,APTB_ITEM,CHANGE\n' +
                '10,,,,Updated description,,Revised conditions about emission masks.,,Updated\n' +
                '20,,,,New description,,Newly added emission text.,,Added\n',
        });
        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath, { readonly: true });
        // The old text "Initial conditions" should no longer match.
        const oldHits = db.prepare(`
            SELECT rowid FROM applic_text_block_fts WHERE applic_text_block_fts MATCH 'initial'
        `).all();
        // The new text "Revised conditions" should match for row 10.
        const newHits = db.prepare(`
            SELECT rowid FROM applic_text_block_fts WHERE applic_text_block_fts MATCH 'revised'
        `).all() as any[];
        // The added row 20 should match for "newly".
        const addedHits = db.prepare(`
            SELECT rowid FROM applic_text_block_fts WHERE applic_text_block_fts MATCH 'newly'
        `).all() as any[];
        db.close();

        expect(oldHits).toHaveLength(0);
        expect(newHits.map(h => h.rowid)).toEqual([10]);
        expect(addedHits.map(h => h.rowid)).toEqual([20]);
    });

    test('composite-PK table: DELETE binds all PK columns positionally', async () => {
        // Add a synthetic composite-PK entry to PK_BY_TABLE via a real table.
        // licence_subservice is the smallest real composite-PK table; its schema
        // arrives in Task 2 of this plan but for THIS test we create it inline so
        // Task 1 is independently testable.
        const seedDb = new Database(dbPath);
        seedDb.exec(`
            CREATE TABLE IF NOT EXISTS licence_subservice(
                SS_ID INTEGER, SV_SV_ID INTEGER, SS_NAME TEXT
            );
            INSERT INTO licence_subservice VALUES (101, 1, 'HF Domestic');
            INSERT INTO licence_subservice VALUES (101, 2, 'HF Domestic clone');
        `);
        seedDb.close();

        // Change-zip: delete (SS_ID=101, SV_SV_ID=1) — the other row must survive.
        buildChangeZip({
            'licence_subservice.csv':
                'SS_ID,SV_SV_ID,SS_NAME,CHANGE\n' +
                '101,1,,Deleted\n',
        });

        await applyCsvDiffZip(zipPath, dbPath);

        const db = new Database(dbPath);
        const rows = db.prepare('SELECT * FROM licence_subservice ORDER BY SV_SV_ID').all() as any[];
        db.close();
        expect(rows).toEqual([{ SS_ID: 101, SV_SV_ID: 2, SS_NAME: 'HF Domestic clone' }]);
    });
});

describe('FTS5: applic_text_block_fts', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_fts5');
    const dbPath = path.join(scratchDir, 'test_acma.db');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        initializeDatabase(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('FTS5 rebuild populates index from applic_text_block', () => {
        const db = new Database(dbPath);
        db.exec(`
            INSERT INTO applic_text_block (APTB_ID, APTB_TEXT, APTB_DESCRIPTION)
                VALUES (1, 'Operation must comply with the radio regulations.', 'Radio compliance');
            INSERT INTO applic_text_block (APTB_ID, APTB_TEXT, APTB_DESCRIPTION)
                VALUES (2, 'Spurious emissions must be suppressed.', 'Emissions');
        `);
        // Rebuild populates the index.
        db.exec(`INSERT INTO applic_text_block_fts(applic_text_block_fts) VALUES('rebuild');`);

        const hits = db.prepare(`
            SELECT rowid FROM applic_text_block_fts WHERE applic_text_block_fts MATCH ?
        `).all('spurious') as any[];
        db.close();
        expect(hits.map(h => h.rowid)).toEqual([2]);
    });
});

describe('sync() orchestrator (mocked axios)', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_orchestrator');
    const dbPath = path.join(scratchDir, 'test_acma.db');
    const dataDir = scratchDir;
    const cfg = { extractsUrl: 'https://example/v1/Extracts', dataDir, dbPath };

    let axiosGetSpy: ReturnType<typeof jest.spyOn>;

    // Track whether we moved the real inputs zip so we can restore it.
    const realInputsZip = path.resolve('inputs/spectra_rrl.zip');
    const realInputsZipBackup = path.resolve('inputs/spectra_rrl.zip.bak');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        axiosGetSpy = jest.spyOn(axios, 'get');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        // Restore inputs zip if we moved it during bootstrap test.
        if (fs.existsSync(realInputsZipBackup) && !fs.existsSync(realInputsZip)) {
            fs.renameSync(realInputsZipBackup, realInputsZip);
        }
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
        // Safety net: restore backup if somehow still present.
        if (fs.existsSync(realInputsZipBackup) && !fs.existsSync(realInputsZip)) {
            fs.renameSync(realInputsZipBackup, realInputsZip);
        }
    });

    const manifestWithCurrentAsOf = (asOf: string): ExtractsManifest => ([
        {
            IsFullExtract: true,
            LastMdified: asOf,
            Items: [{
                Description: 'Spectra dataset', Format: 'CSV', FileSize: 0,
                FileName: 'spectra_rrl.zip',
                FileUrl: 'https://cdn.example/spectra_rrl.zip',
            }],
        },
    ]);

    test('noop/current — DB already at remote as_of, no fetch happens', async () => {
        // Seed an existing DB with meta.as_of equal to the manifest.
        initializeDatabase(dbPath);
        const seed = new Database(dbPath);
        seed.prepare("REPLACE INTO meta (key, value) VALUES ('as_of', '2026-05-12T21:51:36Z')").run();
        seed.close();

        axiosGetSpy.mockResolvedValueOnce({
            data: manifestWithCurrentAsOf('2026-05-12T21:51:36Z'),
        } as any);

        await sync(cfg, 'auto');

        const status = getSyncStatus();
        expect(status.reason).toBe('current');
        expect(status.dataAsOf).toBe('2026-05-12T21:51:36.000Z');
        expect(status.remoteAsOf).toBe('2026-05-12T21:51:36Z');
        expect(status.behindByHours).toBe(0);
        // The only axios call should have been the manifest fetch.
        expect(axiosGetSpy).toHaveBeenCalledTimes(1);
    });

    test('bootstrap — no DB; full sync triggered regardless of mode', async () => {
        // Move the real inputs zip out of the way so performFullSync uses
        // the mocked downloadFile instead of copying the local shortcut.
        if (fs.existsSync(realInputsZip)) {
            fs.renameSync(realInputsZip, realInputsZipBackup);
        }

        // The manifest has only the full entry. downloadFile uses axios.get with
        // responseType: 'stream', so we spy on it too and return a Readable.
        const fullManifest = manifestWithCurrentAsOf('2026-05-12T21:51:36Z');
        axiosGetSpy.mockResolvedValueOnce({ data: fullManifest } as any);

        // Build a tiny valid zip in memory for the "download" to return.
        const fakeZipPath = path.join(scratchDir, 'fake_full.zip');
        const fakeZip = new AdmZip();
        fakeZip.addFile('placeholder.txt', Buffer.from('not a csv'));
        fakeZip.writeZip(fakeZipPath);
        const fakeBytes = fs.readFileSync(fakeZipPath);
        const { Readable } = await import('stream');
        axiosGetSpy.mockResolvedValueOnce({ data: Readable.from(fakeBytes) } as any);

        await sync(cfg, 'auto');

        const status = getSyncStatus();
        expect(status.reason).toBe('no-db');
        expect(status.mode).toBe('full');
        const db = new Database(dbPath, { readonly: true });
        const row = db.prepare("SELECT value FROM meta WHERE key = 'as_of'").get() as any;
        const n = (db.prepare('SELECT COUNT(*) AS n FROM emission_modulation').get() as { n: number }).n;
        db.close();
        expect(row.value).toBe('2026-05-12T21:51:36Z');
        expect(n).toBe(18);
    });

    test('gap-exceeded — auto mode does NOT trigger full download', async () => {
        initializeDatabase(dbPath);
        const seed = new Database(dbPath);
        seed.prepare("REPLACE INTO meta (key, value) VALUES ('as_of', '2026-05-01T00:00:00Z')").run();
        seed.close();

        axiosGetSpy.mockResolvedValueOnce({
            data: manifestWithCurrentAsOf('2026-05-12T21:51:36Z'),
        } as any);

        await sync(cfg, 'auto');

        const status = getSyncStatus();
        expect(status.reason).toBe('gap-exceeded');
        expect('mode' in status).toBe(false);
        expect(status.detail).toMatch(/h behind/);
        expect(axiosGetSpy).toHaveBeenCalledTimes(1); // ONLY the manifest call
    });

    test('incremental — applies daily change-zip and updates meta.as_of', async () => {
        // Seed the DB at an as_of one day before the latest change-zip.
        initializeDatabase(dbPath);
        const seed = new Database(dbPath);
        seed.prepare("REPLACE INTO meta (key, value) VALUES ('as_of', '2026-05-12T13:20:59Z')").run();
        seed.prepare("INSERT INTO client (CLIENT_NO, LICENCEE) VALUES (1, 'Old Name')").run();
        seed.close();

        // Manifest with full=May 13 and a single change-zip for May 13.
        const manifest: ExtractsManifest = [
            {
                IsFullExtract: true,
                LastMdified: '2026-05-13T13:20:59Z',
                Items: [{
                    Description: 'Spectra dataset', Format: 'CSV', FileSize: 0,
                    FileName: 'spectra_rrl.zip',
                    FileUrl: 'https://cdn.example/spectra_rrl.zip',
                }],
            },
            {
                IsFullExtract: false, DateOfChanges: '2026-05-13',
                LastMdified: '2026-05-13T13:00:00Z',
                Items: [{
                    Description: 'Spectra dataset', Format: 'CSV', FileSize: 0,
                    FileName: 'spectra_rrl-changes-2026-05-13.zip',
                    FileUrl: 'https://cdn.example/changes/spectra_rrl-changes-2026-05-13.zip',
                }],
            },
        ];

        axiosGetSpy.mockResolvedValueOnce({ data: manifest } as any);

        // Build a change-zip that updates client 1.
        const changeZipPath = path.join(scratchDir, 'fake_change.zip');
        const changeZip = new AdmZip();
        changeZip.addFile(
            'client.csv',
            Buffer.from(
                'CLIENT_NO,LICENCEE,TRADING_NAME,ACN,ABN,POSTAL_STREET,POSTAL_SUBURB,POSTAL_STATE,POSTAL_POSTCODE,CAT_ID,CLIENT_TYPE_ID,FEE_STATUS_ID,CHANGE\n' +
                '1,Updated Name,,,,,,,,,,,Updated\n',
                'utf-8',
            ),
        );
        changeZip.writeZip(changeZipPath);
        const changeBytes = fs.readFileSync(changeZipPath);
        const { Readable } = await import('stream');
        axiosGetSpy.mockResolvedValueOnce({ data: Readable.from(changeBytes) } as any);

        await sync(cfg, 'auto');

        const status = getSyncStatus();
        expect(status.reason).toBe('incremental-success');
        expect(status.mode).toBe('incremental');
        // Verify meta.as_of advanced and the row was updated.
        const db = new Database(dbPath, { readonly: true });
        const asOfRow = db.prepare("SELECT value FROM meta WHERE key = 'as_of'").get() as any;
        const clientRow = db.prepare('SELECT LICENCEE FROM client WHERE CLIENT_NO = 1').get() as any;
        db.close();
        expect(asOfRow.value).toBe('2026-05-13T13:00:00Z');
        expect(clientRow.LICENCEE).toBe('Updated Name');
    });
});

describe('ANALYZE after full sync', () => {
    const scratchDir = path.join(__dirname, '../scratch_test_analyze');
    const dbPath = path.join(scratchDir, 'test_acma.db');

    beforeEach(() => {
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir);
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    });

    afterAll(() => {
        if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    test('ANALYZE populates sqlite_stat1', () => {
        initializeDatabase(dbPath);
        const db = new Database(dbPath);
        db.exec(`INSERT INTO client (CLIENT_NO, LICENCEE) VALUES (1, 'Test')`);
        db.exec('ANALYZE');
        const stat = db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get();
        db.close();
        expect(stat).toBeDefined();
    });
});
