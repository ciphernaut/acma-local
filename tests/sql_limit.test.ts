/**
 * Tests for execute_sql row limit clamp. These cover both the in-process path
 * (executeSql) and the worker path (executeSqlWithTimeout). The live MCP tool
 * uses the worker path, so both must be tested. Note: the worker loads sql_worker.cjs
 * (not .ts) at runtime — they must be kept in lockstep; see sql_projection_rows.test.ts
 * for parity assertions.
 */
import Database from 'better-sqlite3';
import { executeSql, executeSqlWithTimeout, EXECUTE_SQL_MAX_LIMIT } from '../src/sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('execute_sql limit clamp', () => {
  const db = new Database(':memory:');
  beforeAll(() => {
    db.exec('CREATE TABLE t(n INTEGER)');
    const ins = db.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 6000; i++) ins.run(i);
  });
  afterAll(() => db.close());

  test('ceiling is 5000', () => expect(EXECUTE_SQL_MAX_LIMIT).toBe(5000));
  test('default stays 100', () => expect(executeSql(db, 'SELECT n FROM t').rows).toHaveLength(100));
  test.each([[1, 1], [100, 100], [5000, 5000], [5001, 5000]])(
    'limit %i returns %i rows', (limit, expected) => {
      expect(executeSql(db, 'SELECT n FROM t', limit).rows).toHaveLength(expected);
    });
  test('truncated flag still set at the ceiling', () => {
    expect(executeSql(db, 'SELECT n FROM t', 5000).truncated).toBe(true);
  });
});

describe('execute_sql worker constant parity', () => {
  // The live MCP tool calls executeSqlWithTimeout without maxRows, so the
  // worker's DEFAULT_ROW_CAP is the actual ceiling. Both .ts and .cjs workers
  // must have DEFAULT_ROW_CAP = 5000 and HARD_ROW_CAP >= 5000.
  // Parity is also checked in sql_projection_rows.test.ts.

  test('both worker files have DEFAULT_ROW_CAP = 5000', () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    const defaultOf = (s: string) => s.match(/const DEFAULT_ROW_CAP = ([0-9_]+);/)?.[1];
    const ts = defaultOf(read('sql_worker.ts'));
    const cjs = defaultOf(read('sql_worker.cjs'));
    expect(ts).toBe('5000');
    expect(cjs).toBe('5000');
  });

  test('both worker files have HARD_ROW_CAP >= 5000', () => {
    const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    const hardOf = (s: string) => {
      const m = s.match(/const HARD_ROW_CAP = ([0-9_]+);/);
      return m ? Number(m[1].replace(/_/g, '')) : null;
    };
    const ts = hardOf(read('sql_worker.ts'));
    const cjs = hardOf(read('sql_worker.cjs'));
    expect(ts).not.toBeNull();
    expect(cjs).not.toBeNull();
    expect(ts).toBeGreaterThanOrEqual(5000);
    expect(cjs).toEqual(ts);
  });
});
