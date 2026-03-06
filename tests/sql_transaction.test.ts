import Database from 'better-sqlite3';
import { executeSqlWithTimeout } from '../src/sql.js';

async function run() {
  const dbPath = './data/acma.db';
  const db = new Database(dbPath);

  console.log('--- Creating test table... ---');
  db.exec('CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY, msg TEXT)');
  db.exec("INSERT INTO test_table (msg) VALUES ('hello')");

  console.log('--- Testing query via executeSqlWithTimeout ---');
  try {
    const res = await executeSqlWithTimeout(dbPath, 'SELECT * FROM test_table', 10, 5000);
    console.log('SELECT OK rows:', res.rowCount, res.rows);
  } catch (e) {
    console.error('SELECT ERR:', e.message);
  }

  console.log('--- Attempting to modify via executeSqlWithTimeout ---');
  try {
    const res = await executeSqlWithTimeout(dbPath, "INSERT INTO test_table (msg) VALUES ('world')", 10, 5000);
    console.log('INSERT OK rows:', res.rowCount);
  } catch (e) {
    console.error('INSERT ERR:', e.message);
  }

  console.log('--- Checking if modification persisted ---');
  const finalRows = db.prepare('SELECT * FROM test_table').all();
  console.log('Final rows in table:', finalRows);

  db.exec('DROP TABLE test_table');
  db.close();
}

run().catch(console.error);
