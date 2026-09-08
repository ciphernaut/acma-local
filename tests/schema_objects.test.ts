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
