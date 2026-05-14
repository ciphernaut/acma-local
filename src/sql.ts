import Database from 'better-sqlite3';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


export interface SqlResult {
    columns: string[];
    rows: unknown[][];
    truncated: boolean;
    rowCount: number;
}

/**
 * Execute a read-only SELECT query against the ACMA RRL database.
 * Enforces SELECT-only: any other statement type throws an error.
 * Applies a row limit (default 100, max 500).
 */
export function executeSql(
    db: Database.Database,
    sql: string,
    limit: number = 100
): SqlResult {
    const trimmed = sql.trim();
    if (!trimmed) {
        throw new Error('SQL query cannot be empty.');
    }

    const firstWord = (trimmed.split(/\s+/)[0] ?? '').toUpperCase();
    if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
        throw new Error(
            `Only SELECT/WITH statements are allowed. Received: ${firstWord}. ` +
            `Use execute_sql for read-only queries only.`
        );
    }

    const cap = Math.min(Math.max(1, limit), 500);

    // Wrap the query to enforce the row limit without altering user's SQL
    const wrapped = `SELECT * FROM (${trimmed}) LIMIT ${cap + 1}`;

    const stmt = db.prepare(wrapped);
    const rawRows = stmt.all() as Record<string, unknown>[];

    const truncated = rawRows.length > cap;
    const resultRows = truncated ? rawRows.slice(0, cap) : rawRows;

    const firstRow = resultRows[0];
    const columns = firstRow ? Object.keys(firstRow) : [];
    const rows = resultRows.map(row => columns.map(col => row[col]));

    return { columns, rows, truncated, rowCount: rows.length };
}

export interface TableDescription {
    name: string;
    columns: Array<{ name: string; type: string; notnull: boolean; pk: boolean }>;
    indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
    rowCount: number;
    isVirtual: boolean;
}

/**
 * Returns column, index, and row-count metadata for the named tables.
 * When `tables` is omitted, returns descriptions for every user table.
 * Uses PRAGMA queries; safe to call on a read-only connection.
 */
export function describeSchema(
    db: Database.Database,
    tables?: string[]
): TableDescription[] {
    const masterRows = db.prepare(
        `SELECT name, type, sql FROM sqlite_master
         WHERE type = 'table'
         ORDER BY name`
    ).all() as Array<{ name: string; type: string; sql: string | null }>;

    // Drop SQLite internal tables (sqlite_*, FTS5 shadow tables ending in _data/_idx/_content/_docsize/_config).
    const isUserTable = (name: string) =>
        !name.startsWith('sqlite_') &&
        !/_(data|idx|content|docsize|config)$/.test(name);

    let userTables = masterRows.filter(r => isUserTable(r.name));

    if (tables && tables.length > 0) {
        const wanted = new Set(tables.map(t => t.toLowerCase()));
        userTables = userTables.filter(r => wanted.has(r.name.toLowerCase()));
    }

    return userTables.map(({ name, sql }) => {
        const isVirtual = sql !== null && /CREATE\s+VIRTUAL\s+TABLE/i.test(sql);

        const colRows = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{
            name: string; type: string; notnull: number; pk: number;
        }>;
        const columns = colRows.map(c => ({
            name: c.name,
            type: c.type,
            notnull: c.notnull !== 0,
            pk: c.pk !== 0,
        }));

        const idxRows = db.prepare(`PRAGMA index_list(${name})`).all() as Array<{
            name: string; unique: number;
        }>;
        const indexes = idxRows
            .filter(i => !i.name.startsWith('sqlite_autoindex_'))
            .map(i => {
                const cols = db.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string }>;
                return {
                    name: i.name,
                    columns: cols.map(c => c.name),
                    unique: i.unique !== 0,
                };
            });

        let rowCount = 0;
        try {
            const r = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
            rowCount = r.n;
        } catch {
            // Virtual tables may not support COUNT(*) directly; leave at 0.
            rowCount = 0;
        }

        return { name, columns, indexes, rowCount, isVirtual };
    });
}

export type SampleQueryCategory =
    | 'lookup'
    | 'statistics'
    | 'geospatial'
    | 'text-search'
    | 'power-user'
    | 'data-dict';

export interface SampleQuery {
    description: string;
    query: string;
    category: SampleQueryCategory;
}

export interface SampleQuerySummary {
    categories: Array<{
        category: SampleQueryCategory;
        count: number;
        descriptions: string[];
    }>;
}

/**
 * Curated SQL examples from the original ACMA offline RRL web app, extended
 * with a category tag for paginated discovery.
 */
const ALL_SAMPLE_QUERIES: SampleQuery[] = [
    // ── lookup: "All <table>" queries
    { category: 'lookup', description: 'All access_area', query: 'select * from access_area order by area_id' },
    { category: 'lookup', description: 'All antenna', query: 'select * from antenna order by antenna_id' },
    { category: 'lookup', description: 'All antenna_pattern', query: 'select * from antenna_pattern order by antenna_id, az_type, angle' },
    { category: 'lookup', description: 'All antenna_polarity', query: 'select * from antenna_polarity order by polarisation_code' },
    { category: 'lookup', description: 'All applic_text_block', query: 'select * from applic_text_block order by aptb_id' },
    { category: 'lookup', description: 'All auth_spectrum_area', query: 'select * from auth_spectrum_area order by licence_no, area_code' },
    { category: 'lookup', description: 'All auth_spectrum_freq', query: 'select * from auth_spectrum_freq order by licence_no, area_code' },
    { category: 'lookup', description: 'All class_of_station', query: 'select * from class_of_station order by code' },
    { category: 'lookup', description: 'All client', query: 'select * from client order by client_no' },
    { category: 'lookup', description: 'All client_type', query: 'select * from client_type order by type_id' },
    { category: 'lookup', description: 'All device_details', query: 'select * from device_details' },
    { category: 'lookup', description: 'All industry_cat', query: 'select * from industry_cat order by cat_id' },
    { category: 'lookup', description: 'All licence', query: 'select * from licence order by licence_no' },
    { category: 'lookup', description: 'All licence_service', query: 'select * from licence_service order by sv_id' },
    { category: 'lookup', description: 'All licence_status', query: 'select * from licence_status order by status' },
    { category: 'lookup', description: 'All licence_subservice', query: 'select * from licence_subservice order by sv_sv_id, ss_id' },
    { category: 'lookup', description: 'All licensing_area', query: 'select * from licensing_area order by licensing_area_id' },
    { category: 'lookup', description: 'All nature_of_service', query: 'select * from nature_of_service order by code' },
    { category: 'lookup', description: 'All reports_text_block', query: 'select * from reports_text_block order by rtb_item' },
    { category: 'lookup', description: 'All satellite', query: 'select * from satellite order by sa_id' },
    { category: 'lookup', description: 'All site', query: 'select * from site order by site_id' },
    { category: 'lookup', description: 'All client fee status', query: 'select * from fee_status' },
    { category: 'lookup', description: 'All BSLs', query: 'select * from bsl' },
    { category: 'lookup', description: 'All BSL Areas', query: 'select * from bsl_area' },

    // ── data-dict: sqlite_master introspection
    { category: 'data-dict', description: 'Data Dictionary', query: 'select * from sqlite_master' },
    { category: 'data-dict', description: 'All Data Dictionary tables', query: "select * from sqlite_master where type='table' order by name" },

    // ── statistics: counts + aggregates
    { category: 'statistics', description: 'Count summary',
      query: `select 'antenna' as table_name, count(*) as row_count from antenna
              union all select 'client', count(*) from client
              union all select 'licence', count(*) from licence
              union all select 'site', count(*) from site
              union all select 'device_details', count(*) from device_details` },
    { category: 'statistics', description: 'Total Granted licences held by Licencee',
      query: `select c.licencee, count(*) as total
              from licence l join client c on c.client_no = l.client_no
              where l.status = '1' group by c.licencee order by total desc` },
    { category: 'statistics', description: 'Total and Granted Licences by Type',
      query: `select distinct licence_type_name "Licence Type",
                     count(*) "Total",
                     sum(case when status='1' then 1 else 0 end) "Granted"
              from licence group by licence_type_name order by 2 desc` },
    { category: 'statistics', description: 'Granted Licences by Client Industry',
      query: `select i.name "Client Industry", count(*) "Granted Licences"
              from licence l
                join client c on c.client_no = l.client_no
                join industry_cat i on i.cat_id = c.cat_id
              where l.status = '1' group by i.name order by 2 desc` },
    { category: 'statistics', description: 'Granted Licences by Client Type',
      query: `select t.name "Client Type", count(*) "Granted Licences"
              from licence l
                join client c on c.client_no = l.client_no
                join client_type t on t.type_id = c.client_type_id
              where l.status = '1' group by t.name order by 2 desc` },
    { category: 'statistics', description: 'Licences Expiring Next Year by Month',
      query: `select strftime('%m', date_of_expiry) "Month Expires",
                     count(*) "Total"
              from licence
              where date_of_expiry >= date('now') and date_of_expiry < date('now', '+1 year')
              group by 1 order by 1` },
    { category: 'statistics', description: 'Licences by Subservice (Category)',
      query: `select licence_type_name, licence_category_name, count(*) "Total Licences"
              from licence group by 1, 2 order by 3 desc` },
    { category: 'statistics', description: 'Total Sites by State',
      query: `select state, count(*) as "Total Sites" from site group by state order by 2 desc` },

    // ── geospatial: KML / coordinate queries
    { category: 'geospatial', description: 'Assignments by PostCode/Frequency Range (2600-2699, 450-500MHz)',
      query: `select d.frequency,
                     d.transmitter_power, d.transmitter_power_unit,
                     d.eirp, d.eirp_unit,
                     s.latitude, s.longitude, s.name as site_name,
                     s.state, s.postcode
              from device_details d
                join site s on s.site_id = d.site_id
              where s.postcode between '2600' and '2699'
                and d.frequency between 450000000 and 500000000` },
    { category: 'geospatial', description: 'Map Test (longitude/latitude)',
      query: `select 134 as longitude, -29 as latitude, 'Centre of Australia' as name` },
    { category: 'geospatial', description: 'Map Test (geometries)',
      query: `select 'POINT(134 -29)' as geometry, 'Centre of Australia' as name` },
    { category: 'geospatial', description: 'Vodafone sited assignments (850-960MHz)',
      query: `select s.latitude, s.longitude, s.name as site_name,
                     d.frequency, d.eirp, d.eirp_unit
              from device_details d
                join site s on s.site_id = d.site_id
                join licence l on l.licence_no = d.licence_no
                join client c on c.client_no = l.client_no
              where c.licencee like '%Vodafone%'
                and d.frequency between 850000000 and 960000000` },
    { category: 'geospatial', description: 'NBN sited assignments and Point to Point links',
      query: `select distinct 'LINESTRING('||
                     min(s.longitude)||' '||min(s.latitude)||','||
                     max(s.longitude)||' '||max(s.latitude)||')' as geometry,
                     l.licence_no
              from device_details d
                join site s on s.site_id = d.site_id
                join licence l on l.licence_no = d.licence_no
                join client c on c.client_no = l.client_no
              where c.licencee like '%NBN%'
              group by l.licence_no
              having count(distinct s.site_id) = 2` },

    // ── text-search: text matches
    { category: 'text-search', description: 'All Licence Special Conditions/Advisory Notes',
      query: `select * from applic_text_block where aptb_table_prefix='LI'` },
    { category: 'text-search', description: 'Client Relational Text search',
      query: `select * from client where licencee like '%test%' or trading_name like '%test%'` },
    { category: 'text-search', description: 'Site Relational Text Search (Sydney)',
      query: `select s.* from site s where s.name like '%Sydney%' or s.postcode like '2000%'` },

    // ── power-user: advanced templates (the CTE example relies on P1's WITH support)
    { category: 'power-user', description: 'Site Search Relational',
      query: `select s.* from site s
                join device_details d on d.site_id = s.site_id
                join licence l on l.licence_no = d.licence_no
                where l.status = '1'
                limit 100` },
    { category: 'power-user', description: 'Fetching beyond the 100 row display limit',
      query: `select s.* from site s limit 500` },
    { category: 'power-user', description: 'CTE example: top 10 active service types',
      query: `with active as (
                  select sv_id, count(*) as n from licence where status = '1' group by sv_id
              )
              select s.sv_name, a.n
              from active a join licence_service s on s.sv_id = a.sv_id
              order by a.n desc limit 10` },
];

export function listSampleQueries(filter?: {
    category?: SampleQueryCategory;
    name?: string;
}): SampleQuery[] | SampleQuerySummary {
    if (!filter || (filter.category === undefined && filter.name === undefined)) {
        const byCategory = new Map<SampleQueryCategory, SampleQuery[]>();
        for (const q of ALL_SAMPLE_QUERIES) {
            const arr = byCategory.get(q.category) ?? [];
            arr.push(q);
            byCategory.set(q.category, arr);
        }
        const categories = Array.from(byCategory.entries()).map(([category, items]) => ({
            category,
            count: items.length,
            descriptions: items.map(i => i.description),
        }));
        return { categories };
    }

    let filtered = ALL_SAMPLE_QUERIES;
    if (filter.category !== undefined) {
        filtered = filtered.filter(q => q.category === filter.category);
    }
    if (filter.name !== undefined) {
        const needle = filter.name.toLowerCase();
        filtered = filtered.filter(q => q.description.toLowerCase().includes(needle));
    }
    return filtered;
}

/**
 * Run a SQL query inside a worker thread with a wall-clock timeout.
 *
 * Because better-sqlite3 is synchronous and blocks the Node.js event loop,
 * long-running queries prevent the MCP server from processing heartbeats
 * or responding to client timeouts. This function offloads the query to a
 * Worker, then races it against a setTimeout. If the timeout fires first,
 * the worker is terminated and an error is thrown.
 *
 * @param dbPath  Absolute path to the SQLite database file
 * @param sql     A SELECT statement to execute
 * @param limit   Max rows to return (default 100, max 500)
 * @param timeoutMs  Wall-clock deadline in milliseconds (default 25000)
 */
export function executeSqlWithTimeout(
    dbPath: string,
    sql: string,
    limit: number = 100,
    timeoutMs: number = 25_000
): Promise<SqlResult> {
    return new Promise((resolve, reject) => {
        // Prefer the pre-compiled CJS worker (runs on any Node.js without tsx/ESM).
        // Fall back to .ts only when running directly under tsx without Jest subprocess.
        const workerBase = path.join(__dirname, 'sql_worker');
        const workerScript =
            fs.existsSync(workerBase + '.cjs') ? workerBase + '.cjs'
                : fs.existsSync(workerBase + '.ts') ? workerBase + '.ts'
                    : workerBase + '.js';

        const worker = new Worker(workerScript, {
            workerData: { dbPath, sql, limit },
            // No execArgv propagation needed — .cjs workers run without tsx
        });

        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error(
                `SQL query timed out after ${timeoutMs / 1000}s. ` +
                `Try a more specific query with WHERE clauses or a lower row limit.`
            ));
        }, timeoutMs);

        worker.once('message', (msg: { ok: true; result: SqlResult } | { ok: false; error: string }) => {
            clearTimeout(timer);
            if (msg.ok) {
                resolve(msg.result);
            } else {
                reject(new Error(msg.error));
            }
        });

        worker.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
