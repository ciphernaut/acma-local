/**
 * sql_worker.cjs — Worker thread entry point (CommonJS, no transpilation needed).
 *
 * Receives { dbPath, sql, limit, maxRows } via workerData, opens its own read-only
 * DB connection, runs the SELECT query, and posts the result back.
 *
 * Written as plain CJS so it works without tsx/ESM loader registration.
 */
'use strict';
const { workerData, parentPort } = require('worker_threads');
const Database = require('better-sqlite3');

const { dbPath, sql, limit, maxRows } = workerData;

// Kept textually in sync with hasStatementSeparator() in src/sql.ts — the worker
// cannot import from there (ESM resolution differs between tsx and dist/), so the
// logic is inlined. tests/sql_statement_separator.test.ts asserts the copies match.
// A naive includes(';') rejected legitimate queries whose STRING LITERALS contain
// a semicolon; only a separator outside quotes/comments is a real second statement.
function hasStatementSeparator(sql) {
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            i++;
            while (i < sql.length) {
                if (sql[i] === quote) {
                    if (sql[i + 1] === quote) { i += 2; continue; }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (ch === '[') {
            while (i < sql.length && sql[i] !== ']') i++;
            i++;
            continue;
        }
        if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && sql[i + 1] === '*') {
            i += 2;
            while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (ch === ';') return true;
        i++;
    }
    return false;
}

/**
 * Row ceiling for a result an agent will read. The projection path passes an
 * explicit, higher maxRows: rolling device rows up into site entities has to see
 * every device row, and at ~27 rows per site a 500-row cap reaches 18 sites.
 * The ceiling that matters downstream is 500 ENTITIES, enforced in the projection.
 */
const DEFAULT_ROW_CAP = 500;

function runQuery(dbPath, sql, limit, maxRows) {
    const trimmed = sql.trim();
    if (!trimmed) throw new Error('SQL query cannot be empty.');

    const firstWord = (trimmed.split(/\s+/)[0] || '').toUpperCase();
    if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
        throw new Error(
            `Only SELECT/WITH statements are allowed. Received: ${firstWord}. ` +
            `Use execute_sql for read-only queries only.`
        );
    }

    const cap = Math.min(Math.max(1, limit), maxRows ?? DEFAULT_ROW_CAP);
    const wrapped = `SELECT * FROM (${trimmed}) LIMIT ${cap + 1}`;

    // Open the DB normally (not readonly) so we don't trip over WAL file writes,
    // but we will sandbox the query inside a transaction that ALWAYS rolls back.
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    // Increase cache to 64MB and use memory for temp tables to prevent
    // query optimizer from choosing catastrophic iteration plans on cross joins
    db.pragma('cache_size = -64000');
    db.pragma('temp_store = MEMORY');

    // Prevent multiple statements from executing by separating the validation
    if (hasStatementSeparator(wrapped)) {
        throw new Error("Multiple SQL statements are not allowed.");
    }

    try {
        db.exec('BEGIN TRANSACTION;');

        try {
            const stmt = db.prepare(wrapped);
            const rawRows = stmt.all();
            const truncated = rawRows.length > cap;
            const resultRows = truncated ? rawRows.slice(0, cap) : rawRows;
            const firstRow = resultRows[0];
            const columns = firstRow ? Object.keys(firstRow) : [];
            const rows = resultRows.map(row => columns.map(col => row[col]));
            return { columns, rows, truncated, rowCount: rows.length };
        } finally {
            db.exec('ROLLBACK;');
        }
    } finally {
        if (db.open) db.close();
    }
}

try {
    const result = runQuery(dbPath, sql, limit, maxRows);
    parentPort.postMessage({ ok: true, result });
} catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
}
