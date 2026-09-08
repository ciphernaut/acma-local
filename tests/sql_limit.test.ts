import Database from 'better-sqlite3';
import { executeSql, EXECUTE_SQL_MAX_LIMIT } from '../src/sql.js';

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
