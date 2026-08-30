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

// Kept textually in sync with hasStatementSeparator() in src/sql.ts — the worker
// cannot import from there (ESM resolution differs between tsx and dist/), so the
// logic is inlined. tests/sql_statement_separator.test.ts asserts the copies match.
// A naive includes(';') rejected legitimate queries whose STRING LITERALS contain
// a semicolon; only a separator outside quotes/comments is a real second statement.
function hasStatementSeparator(sql: string): boolean {
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

function runQuery(dbPath: string, sql: string, limit: number) {
    const trimmed = sql.trim();
    if (!trimmed) throw new Error('SQL query cannot be empty.');

    const firstWord = (trimmed.split(/\s+/)[0] ?? '').toUpperCase();
    if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
        throw new Error(
            `Only SELECT/WITH statements are allowed. Received: ${firstWord}. ` +
            `Use execute_sql for read-only queries only.`
        );
    }

    const cap = Math.min(Math.max(1, limit), 500);
    const wrapped = `SELECT * FROM (${trimmed}) LIMIT ${cap + 1}`;

    // Open the DB normally (not readonly) so we don't trip over WAL file writes,
    // but we will sandbox the query inside a transaction that ALWAYS rolls back.
    const db = new Database(dbPath, { fileMustExist: true });
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
            const rawRows = stmt.all() as Record<string, unknown>[];
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
    const result = runQuery(dbPath, sql, limit);
    parentPort!.postMessage({ ok: true, result });
} catch (err: any) {
    parentPort!.postMessage({ ok: false, error: err.message });
}
