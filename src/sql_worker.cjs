/**
 * sql_worker.cjs — Worker thread entry point (CommonJS, no transpilation needed).
 *
 * Receives { dbPath, sql, limit } via workerData, opens its own read-only
 * DB connection, runs the SELECT query, and posts the result back.
 *
 * Written as plain CJS so it works without tsx/ESM loader registration.
 */
'use strict';
const { workerData, parentPort } = require('worker_threads');
const Database = require('better-sqlite3');

const { dbPath, sql, limit } = workerData;

function runQuery(dbPath, sql, limit) {
    const trimmed = sql.trim();
    if (!trimmed) throw new Error('SQL query cannot be empty.');

    const firstWord = (trimmed.split(/\s+/)[0] || '').toUpperCase();
    if (firstWord !== 'SELECT') {
        throw new Error(
            `Only SELECT statements are allowed. Received: ${firstWord}. ` +
            `Use execute_sql for querying data only.`
        );
    }

    const cap = Math.min(Math.max(1, limit), 500);
    const wrapped = `SELECT * FROM (${trimmed}) LIMIT ${cap + 1}`;

    const db = new Database(dbPath, { readonly: true });
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
        if (db.open) db.close();
    }
}

try {
    const result = runQuery(dbPath, sql, limit);
    parentPort.postMessage({ ok: true, result });
} catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
}
