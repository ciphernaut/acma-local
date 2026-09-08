import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase } from '../src/db.js';

// better-sqlite3 against a temp file: initializeDatabase opens and closes its
// own handle, so :memory: would evaporate between calls.
export function freshDb(): { path: string; open: () => Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), 'acma-schema-'));
  const path = join(dir, 'test.db');
  initializeDatabase(path);
  return { path, open: () => new Database(path, { readonly: true }) };
}

describe('device_details indexes', () => {
  test('frequency, call sign and station class are indexed', () => {
    const db = freshDb().open();
    const names = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='device_details'`)
      .all()
      .map((r: any) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['device_freq_idx', 'device_callsign_idx', 'device_class_idx']),
    );
    db.close();
  });

  test('initializeDatabase is idempotent', () => {
    const f = freshDb();
    expect(() => initializeDatabase(f.path)).not.toThrow(); // second run
  });
});

describe('views', () => {
  const open = () => freshDb().open();

  test('all three exist with the layout skeleton columns', () => {
    const db = open();
    const cols = (v: string) =>
      db.prepare(`SELECT name FROM pragma_table_info('${v}')`).all().map((r: any) => r.name);
    expect(cols('v_emitters')).toEqual(['id','lat','lon','label','site_id','state','postcode',
      'frequency_hz','bandwidth_hz','transmitter_power_w','eirp_raw','device_type','call_sign',
      'emission','modulation','signal_nature','info_type','station_class','licence_no',
      'licence_status','service','licensee','trading_name']);
    expect(cols('v_sites')).toEqual(['id','lat','lon','label','state','postcode',
      'device_count','freq_min_hz','freq_max_hz']);
    expect(cols('v_links')).toEqual(['id','lat_a','lon_a','label_a','lat_b','lon_b','label_b',
      'site_id_a','site_id_b','frequency_hz','service','licensee']);
    db.close();
  });

  test('a device with NULL lookups keeps its row (Invariant 6)', () => {
    const f = freshDb();
    const db = new Database(f.path);
    db.prepare(`INSERT INTO site (SITE_ID, LATITUDE, LONGITUDE, NAME) VALUES ('S1', -27.0, 153.0, 'Test Site')`).run();
    // No licence row, no emission, no station class — every lookup misses.
    db.prepare(`INSERT INTO device_details (SDD_ID, SITE_ID, DEVICE_TYPE) VALUES (1, 'S1', 'T')`).run();
    const row = db.prepare(`SELECT * FROM v_emitters WHERE id = 1`).get() as any;
    expect(row).toBeDefined();
    expect(row.label).toBe('Test Site');
    expect(row.modulation).toBeNull();
    expect(row.licensee).toBeNull();
    db.close();
  });

  test('v_links pairs registered links once, lower site first', () => {
    const f = freshDb();
    const db = new Database(f.path);
    db.prepare(`INSERT INTO site (SITE_ID, LATITUDE, LONGITUDE, NAME) VALUES ('A', -27, 153, 'Alpha'), ('B', -28, 152, 'Bravo')`).run();
    // Reciprocal pair, as the register stores them.
    db.prepare(`INSERT INTO device_details (SDD_ID, SITE_ID, EFL_ID, RELATED_EFL_ID, FREQUENCY) VALUES
      (10, 'A', 100, 200, 8000000000), (20, 'B', 200, 100, 8000000000)`).run();
    const rows = db.prepare(`SELECT * FROM v_links`).all() as any[];
    expect(rows).toHaveLength(1);          // one row per pair, not two
    expect(rows[0].label_a).toBe('Alpha'); // a.SITE_ID < b.SITE_ID
    expect(rows[0].label_b).toBe('Bravo');
    db.close();
  });

  test('views are recreated, not stale, on re-init', () => {
    const f = freshDb();
    initializeDatabase(f.path); // second run must DROP+CREATE without error
    const db = f.open();
    expect(db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='view'`).get()).toEqual({ n: 3 });
    db.close();
  });

  // The NULL-lookup fixture above proves a missing lookup doesn't drop the row,
  // but it can't catch a *wrong* lookup: nothing asserts what v_emitters resolves
  // a real code to, so swapping SUBSTR(...,5,1) -> (...,4,1), or transposing which
  // lookup table joins to signal_nature vs info_type, still passes every other
  // test in this file. This fixture seeds real lookup rows and a device whose
  // EMISSION/CLASS_OF_STATION_CODE resolve through every joined lookup, and
  // pins the expected labels.
  function seedResolvedFixture(db: Database.Database) {
    db.prepare(`INSERT INTO emission_modulation (code, description, group_name)
      VALUES ('F', 'Angle-modulated, single channel', 'angle')`).run();
    db.prepare(`INSERT INTO emission_signal_nature (code, description)
      VALUES ('3', 'Single channel containing analogue information')`).run();
    db.prepare(`INSERT INTO emission_info_type (code, description)
      VALUES ('E', 'Telephony (including sound broadcasting)')`).run();
    db.prepare(`INSERT INTO class_of_station (code, DESCRIPTION)
      VALUES ('FB', 'Base station')`).run();
    db.prepare(`INSERT INTO licence_service (SV_ID, SV_NAME) VALUES (10, 'Land Mobile')`).run();
    db.prepare(`INSERT INTO client (CLIENT_NO, LICENCEE, TRADING_NAME) VALUES (1, 'Acme Co', 'Acme')`).run();
    db.prepare(`INSERT INTO licence (LICENCE_NO, CLIENT_NO, SV_ID, STATUS_TEXT)
      VALUES ('L1', 1, 10, 'Current')`).run();
    db.prepare(`INSERT INTO site (SITE_ID, LATITUDE, LONGITUDE, NAME) VALUES ('S1', -27.0, 153.0, 'Resolved Site')`).run();
    db.prepare(`INSERT INTO device_details
      (SDD_ID, LICENCE_NO, SITE_ID, SV_ID, EMISSION, CLASS_OF_STATION_CODE)
      VALUES (1, 'L1', 'S1', 10, '16K0F3E', 'FB')`).run();
  }

  test('v_emitters resolves every joined lookup for a real code (not just NULL)', () => {
    const f = freshDb();
    const db = new Database(f.path);
    seedResolvedFixture(db);
    const row = db.prepare(`SELECT * FROM v_emitters WHERE id = 1`).get() as any;
    expect(row.modulation).toBe('angle');
    expect(row.signal_nature).toBe('Single channel containing analogue information');
    expect(row.info_type).toBe('Telephony (including sound broadcasting)');
    expect(row.station_class).toBe('Base station');
    expect(row.service).toBe('Land Mobile');
    expect(row.licensee).toBe('Acme Co');
    db.close();
  });

  test('v_emitters has no fan-out: one row per device on a clean fixture', () => {
    // The true invariant: id is unique in v_emitters. A duplicate lookup row
    // (e.g. a bad sync leaving two licence_service rows for the same SV_ID)
    // would fan a single device out into multiple rows via the LEFT JOINs —
    // this is the guard that catches that, rather than shipping it silently.
    const f = freshDb();
    const db = new Database(f.path);
    seedResolvedFixture(db);
    const { total, distinct_ids } = db.prepare(
      `SELECT COUNT(*) AS total, COUNT(DISTINCT id) AS distinct_ids FROM v_emitters`
    ).get() as any;
    expect(total).toBe(distinct_ids);
    db.close();
  });
});
