/**
 * sql_worker.ts — Worker thread entry point for execute_sql.
 *
 * Receives { dbPath, sql, limit } via workerData, opens its own read-only
 * DB connection (connections cannot cross thread boundaries), runs the query,
 * and posts the result (or error) back to the parent via parentPort.
 *
 * NOTE: The SQL logic is inlined here (not imported from sql.ts) to avoid
 * ESM module resolution differences between tsx and compiled environments
 * when running as a Worker.
 */
import { workerData, parentPort } from 'worker_threads';
import Database from 'better-sqlite3';

const { dbPath, sql, limit } = workerData as {
    dbPath: string;
    sql: string;
    limit: number;
};

function runQuery(dbPath: string, sql: string, limit: number) {
    const trimmed = sql.trim();
    if (!trimmed) throw new Error('SQL query cannot be empty.');

    const firstWord = (trimmed.split(/\s+/)[0] ?? '').toUpperCase();
    if (firstWord !== 'SELECT') {
        throw new Error(
            `Only SELECT statements are allowed. Received: ${firstWord}. ` +
            `Use execute_sql for querying data only.`
        );
    }

    const cap = Math.min(Math.max(1, limit), 500);
    const wrapped = `SELECT * FROM (${trimmed}) LIMIT ${cap + 1}`;

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const stmt = db.prepare(wrapped);
        const rawRows = stmt.all() as Record<string, unknown>[];
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
    parentPort!.postMessage({ ok: true, result });
} catch (err: any) {
    parentPort!.postMessage({ ok: false, error: err.message });
}
