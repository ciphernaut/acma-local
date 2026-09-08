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

describe('execute_sql worker path limit clamp', () => {
  // The live MCP tool calls executeSqlWithTimeout without maxRows — this is the
  // critical path. It spawns a worker thread; must use a file-based DB (not :memory:).
  const scratchDir = path.join(__dirname, '../scratch_test_sql_worker_limit');
  const dbPath = path.join(scratchDir, 'test.db');
  let db: Database.Database;

  beforeAll(() => {
    if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
    fs.mkdirSync(scratchDir, { recursive: true });
    db = new Database(dbPath);
    db.exec('CREATE TABLE t(n INTEGER)');
    const ins = db.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 6000; i++) ins.run(i);
    db.close();
  });

  afterAll(() => {
    if (fs.existsSync(scratchDir)) fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  test('worker path respects the 5000-row ceiling (no maxRows argument)', async () => {
    // This is the live tool path: executeSqlWithTimeout called without maxRows.
    // The worker's DEFAULT_ROW_CAP controls the ceiling; it must be 5000.
    // This is the critical test — it exercises the code path that was broken.
    const r = await executeSqlWithTimeout(dbPath, 'SELECT n FROM t', 5000, 25_000);
    expect(r.rows).toHaveLength(5000);
    expect(r.truncated).toBe(true);
  });

  test('worker path default stays 100 when limit not specified', async () => {
    const r = await executeSqlWithTimeout(dbPath, 'SELECT n FROM t', 100, 25_000);
    expect(r.rows).toHaveLength(100);
    expect(r.truncated).toBe(true);
  });
});
