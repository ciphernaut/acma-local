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
    expect(cols('v_emitters')).toEqual(
      expect.arrayContaining(['id', 'lat', 'lon', 'label', 'frequency_hz', 'call_sign',
        'modulation', 'signal_nature', 'info_type', 'station_class', 'service',
        'licensee', 'trading_name', 'licence_status', 'state', 'device_type',
        'transmitter_power_w', 'bandwidth_hz']),
    );
    expect(cols('v_sites')).toEqual(
      expect.arrayContaining(['id', 'lat', 'lon', 'label', 'state', 'postcode',
        'device_count', 'freq_min_hz', 'freq_max_hz']),
    );
    expect(cols('v_links')).toEqual(
      expect.arrayContaining(['id', 'lat_a', 'lon_a', 'lat_b', 'lon_b',
        'label_a', 'label_b', 'frequency_hz', 'service', 'licensee']),
    );
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
});
