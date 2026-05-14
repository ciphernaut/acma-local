/**
 * ACMA RRL MCP Server - Network Mode
 *
 * Per-session StreamableHTTPServerTransport (official MCP multi-client pattern).
 * Full tool catalog: search_sites, search_licences, search_clients,
 *                    get_licence_details, get_site_details, sync_data,
 *                    execute_sql, list_sample_queries, export_kml,
 *                    search_bsl, search_spectrum_band, search_application_text,
 *                    describe_schema, describe_tool.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG, sync, getSyncStatus } from './sync.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
    searchSites,
    searchLicences,
    searchClients,
    getLicenceDetails,
    getSiteDetails,
    searchBsl,
    searchSpectrumBand,
    searchApplicationText,
} from './logic.js';
import { executeSqlWithTimeout, listSampleQueries, describeSchema } from './sql.js';
import { generateKml } from './kml.js';

const dbPath = process.env.ACMA_DB_PATH || DEFAULT_CONFIG.dbPath;
const PORT = process.env.PORT || 3000;

// ─── Tool Documentation Map ───────────────────────────────────────────────────

interface ToolDoc {
    summary: string;      // ≤150 chars; appears in tools/list
    tags: string[];       // ['primary'], ['geospatial'], ['fts'], ['meta'], ['sync'], ['sql'], etc.
    fullDescription: string;  // returned by describe_tool
}

export const TOOL_DOCS: Record<string, ToolDoc> = {
    search_licences: {
        summary: 'Search ACMA licences by licence number (substring match). [primary]',
        tags: ['primary', 'sql'],
        fullDescription: `
### [Licence Search] PRIMARY SEARCH TOOL
Search ACMA RRL licences by licence number.

## Usage
- Use this first when given a licence number (e.g. "1191324/1", "1191324")
- Results include: LICENCE_NO, STATUS, LICENCE_TYPE_NAME, CLIENT_NO, DATE_OF_EXPIRY

## Input
- query: Licence number or partial number`,
    },
    get_licence_details: {
        summary: 'Full licence record: holder + up to 50 devices with site coordinates.',
        tags: ['lookup', 'geospatial-result'],
        fullDescription: `
### [Licence Details]
Get full details for a specific licence: client info and all associated radio devices.

## Usage
- Use after finding a licence number via search_licences
- Returns: licence record, client/owner info, up to 50 device records (with site coordinates)
- If results contain geospatial data, a result_id is returned for optional KML export via export_kml

## Input
- licence_no: Exact licence number (e.g. "1191324/1")`,
    },
    search_sites: {
        summary: 'Search transmission sites by name or postcode.',
        tags: ['lookup', 'geospatial-result'],
        fullDescription: `
### [Site Search]
Search transmission sites by site name or postcode.

## Usage
- Use when asked about a transmitter location or site
- Results include: SITE_ID, NAME, STATE, POSTCODE, LATITUDE, LONGITUDE
- A result_id is returned for optional KML export via export_kml

## Input
- query: Site name or postcode`,
    },
    get_site_details: {
        summary: 'Full site record + up to 50 devices registered there.',
        tags: ['lookup', 'geospatial-result'],
        fullDescription: `
### [Site Details]
Get full details for a specific site including all devices registered at that site.

## Usage
- Use after finding a SITE_ID via search_sites
- Returns: site record, up to 50 associated device_details records
- A result_id is returned for optional KML export via export_kml

## Input
- site_id: Exact Site ID from site search results`,
    },
    search_clients: {
        summary: 'Search licence holders (clients) by company name or trading name.',
        tags: ['lookup'],
        fullDescription: `
### [Client / Licensee Search]
Search for licence holders (clients) by company name or trading name.

## Usage
- Use when asked about who holds licences, e.g. "who operates on this frequency?"
- Results include: CLIENT_NO, LICENCEE, TRADING_NAME, ABN, ACN, STATE

## Input
- query: Business name or trading name`,
    },
    search_bsl: {
        summary: 'Search broadcasting service licences by call sign, BSL number, or on-air ID.',
        tags: ['broadcasting'],
        fullDescription: `
### [Broadcasting Licence Search]
Search broadcasting service licences (BSLs) by call sign, BSL number, or on-air ID.

## Usage
- Use for queries about broadcast/TV/radio operators (e.g. "what's the call sign for ABC Sydney?")
- Results include: BSL_NO, CALL_SIGN, MEDIUM_CATEGORY, REGION_CATEGORY, BSL_STATE, DATE_COMMENCED, ON_AIR_ID, AREA_NAME

## Input
- query: CALL_SIGN, BSL_NO, or ON_AIR_ID`,
    },
    search_spectrum_band: {
        summary: 'Find licences authorised in a frequency band (Hz).',
        tags: ['spectrum'],
        fullDescription: `
### [Spectrum Authorisation Search]
Find licences authorised in a frequency range. Frequencies are in Hertz (Hz).

## Usage
- Use for queries like "who's licenced between 1800 and 1900 MHz?"
- Pass freq_min_hz and freq_max_hz; result rows overlap the requested range
- Results include LICENCE_NO, AREA_NAME, frequency endpoints, CLIENT_NO

## Input
- freq_min_hz: Lower bound of the band, in Hz (e.g. 1800000000 for 1.8 GHz)
- freq_max_hz: Upper bound of the band, in Hz`,
    },
    search_application_text: {
        summary: 'FTS5 full-text search over licence application narrative.',
        tags: ['fts'],
        fullDescription: `
### [Licence Application Text Search]
Full-text search across licence application narrative (conditions, exemptions, special clauses).

## Usage
- Pass an FTS5 query string. Supports: phrase ("text in quotes"), AND/OR, NEAR/N, prefix*.
- Results return APTB_ID, LICENCE_NO, APTB_CATEGORY, APTB_DESCRIPTION, a snippet with «match» markers, and a BM25 rank score (lower is better).
- For full text of a matching APTB_ID, follow up with execute_sql: SELECT APTB_TEXT FROM applic_text_block WHERE APTB_ID = ...

## Input
- query: FTS5 query (e.g. 'aeronautical', '"marine emergency"', 'ICAO OR ITU')`,
    },
    sync_data: {
        summary: 'Sync local RRL mirror. mode=auto applies incrementals; mode=full re-pulls the 70 MB extract.',
        tags: ['sync'],
        fullDescription: `
### [Data Synchronization]
Download and import the latest ACMA RRL changes. Safe to call while server is running.

## Usage
- Default mode='auto' applies incremental change-zips only (cheap, mobile-friendly).
- Use mode='full' to force a full extract reimport (~70 MB) when 'gap-exceeded' is reported.
- Call once to start sync, then poll to check progress.

## Status fields
- progress: 0-100%
- currentTable: which CSV is being imported
- dataAsOf: how fresh the local data is (ISO 8601)
- remoteAsOf: latest available upstream (ISO 8601)
- behindByHours: derived staleness; 0 when current`,
    },
    list_sample_queries: {
        summary: '[SQL] List sample queries. Bare call returns category index; filter by category/name for details.',
        tags: ['sql', 'meta'],
        fullDescription: `
### [SQL Sample Queries]
Curated SQL examples grouped by category. Bare call returns a compact category index; filter to drill in.

## Usage
- Call once with no args to see categories and query descriptions
- Then call with { category: "geospatial" } or { name: "NBN" } to fetch the SQL bodies

## Categories
- lookup: "All <table>" queries
- statistics: counts and aggregates
- geospatial: lat/lng and KML-friendly queries
- text-search: applic_text_block / client / site text matches
- power-user: CTE templates and advanced joins
- data-dict: sqlite_master introspection`,
    },
    execute_sql: {
        summary: '[SQL] Run a read-only SELECT/WITH query against the RRL database (max 500 rows).',
        tags: ['sql'],
        fullDescription: `
### [SQL Query Executor]
Run a read-only SELECT or WITH (CTE) query directly against the ACMA RRL SQLite database.

## Usage
- Use describe_schema to discover available tables and columns at runtime
- Use list_sample_queries first if unsure what to query
- Only SELECT/WITH statements are allowed — no INSERT, UPDATE, DELETE, DROP etc.
- Results capped at 'limit' rows (default 100, max 500)
- If results contain geospatial columns (LATITUDE/LONGITUDE or GEOMETRY), a result_id is returned for optional KML export via export_kml

## Output
{ columns: string[], rows: any[][], truncated: boolean, rowCount: number, result_id?: string, _hints?: ... }`,
    },
    export_kml: {
        summary: '[KML] Render a previously-cached query result as a KML overlay.',
        tags: ['geospatial'],
        fullDescription: `
### [KML Export]
Generate a KML file from cached query results.

## Usage
- Call this AFTER running a query that returned a result_id (e.g. execute_sql, search_sites, get_site_details, get_licence_details)
- Returns a KML <Placemark> collection ready to drop into Google Earth or any KML-aware viewer

## Input
- result_id: the result_id returned by the previous tool call`,
    },
    describe_schema: {
        summary: '[Meta] Returns columns, indexes, row counts for one or more tables; omit `tables` for all.',
        tags: ['meta', 'sql'],
        fullDescription: `
### [Schema Introspection]
Runtime schema discovery. Returns columns + indexes + row counts for the named tables.

## Usage
- Call with no args to enumerate every materialised table
- Pass { tables: ['licence', 'site'] } to drill in to specific tables
- Virtual tables (e.g. applic_text_block_fts) appear with isVirtual: true

## Output
Array of { name, columns, indexes, rowCount, isVirtual } records.`,
    },
    describe_tool: {
        summary: '[Meta] Returns the full markdown documentation for a tool by name.',
        tags: ['meta'],
        fullDescription: `
### [Tool Documentation]
Returns the verbose, full-markdown documentation for any tool advertised by this server.

## Usage
- tools/list gives a compact summary per tool
- Call describe_tool({ name: 'search_licences' }) for the full description, including Usage notes, Input fields, and Output shape

## Input
- name: Exact tool name (case-sensitive)`,
    },
};

// ─── Result Cache ────────────────────────────────────────────────────────────
// Caches query results (columns + rows) so KML can be generated on demand
// without re-running the query. 30-minute TTL.

interface CachedResult {
    columns: string[];
    rows: unknown[][];
    expires: number;
}

const resultCache = new Map<string, CachedResult>();

function cacheResult(columns: string[], rows: unknown[][]): string {
    const id = randomUUID();
    resultCache.set(id, { columns, rows, expires: Date.now() + 30 * 60 * 1000 });
    return id;
}

// Cleanup expired results every 5 mins
setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of resultCache.entries()) {
        if (now > entry.expires) resultCache.delete(id);
    }
}, 300_000).unref();

/**
 * Detects whether a result set contains geospatial data (lat/lng or geometry columns).
 */
function hasGeospatialData(columns: string[]): boolean {
    const lCols = columns.map(c => c.toLowerCase());
    const hasLatLng = lCols.includes('latitude') && lCols.includes('longitude');
    const hasGeometry = lCols.includes('geometry');
    return hasLatLng || hasGeometry;
}

// ─── DB Helper ───────────────────────────────────────────────────────────────

function openDb() {
    return new Database(dbPath, { readonly: true });
}

function createServer(): Server {
    const server = new Server(
        { name: 'acma-rrl-server', version: '1.7.0' },
        { capabilities: { tools: {} } }
    );

    // ─── Tool Catalog ───────────────────────────────────────────────────────────

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: 'search_licences',
                description: TOOL_DOCS.search_licences!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Licence number or partial number, e.g. "1191324"' },
                        limit: { type: 'number', description: 'Max results (default 10)' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'get_licence_details',
                description: TOOL_DOCS.get_licence_details!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        licence_no: { type: 'string', description: 'Exact licence number, e.g. "1191324/1"' },
                    },
                    required: ['licence_no'],
                },
            },
            {
                name: 'search_sites',
                description: TOOL_DOCS.search_sites!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Site name or postcode' },
                        limit: { type: 'number', description: 'Max results (default 10)' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'get_site_details',
                description: TOOL_DOCS.get_site_details!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        site_id: { type: 'string', description: 'Site ID, e.g. "124"' },
                    },
                    required: ['site_id'],
                },
            },
            {
                name: 'search_clients',
                description: TOOL_DOCS.search_clients!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Licensee or trading name' },
                        limit: { type: 'number', description: 'Max results (default 10)' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'search_bsl',
                description: TOOL_DOCS.search_bsl!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'CALL_SIGN, BSL_NO, or ON_AIR_ID' },
                        limit: { type: 'number', description: 'Max rows (default 10)' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'search_spectrum_band',
                description: TOOL_DOCS.search_spectrum_band!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        freq_min_hz: { type: 'number', description: 'Lower bound (Hz)' },
                        freq_max_hz: { type: 'number', description: 'Upper bound (Hz)' },
                        limit:       { type: 'number', description: 'Max rows (default 20)' },
                    },
                    required: ['freq_min_hz', 'freq_max_hz'],
                },
            },
            {
                name: 'search_application_text',
                description: TOOL_DOCS.search_application_text!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'FTS5 query string' },
                        limit: { type: 'number', description: 'Max rows (default 20)' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'sync_data',
                description: TOOL_DOCS.sync_data!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        mode: {
                            type: 'string',
                            enum: ['auto', 'full'],
                            description:
                                "'auto' (default) applies incremental change-zips only. " +
                                "'full' force-pulls and reimports the ~70 MB full extract — " +
                                "use after a long offline period or to recover from gap-exceeded.",
                        },
                    },
                },
            },
            {
                name: 'list_sample_queries',
                description: TOOL_DOCS.list_sample_queries!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        category: {
                            type: 'string',
                            enum: ['lookup', 'statistics', 'geospatial', 'text-search', 'power-user', 'data-dict'],
                            description: 'Filter to one category',
                        },
                        name: {
                            type: 'string',
                            description: 'Substring match on description',
                        },
                    },
                },
            },
            {
                name: 'describe_schema',
                description: TOOL_DOCS.describe_schema!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        tables: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Optional list of table names (case-insensitive); omit for all.',
                        },
                    },
                },
            },
            {
                name: 'execute_sql',
                description: TOOL_DOCS.execute_sql!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        sql: {
                            type: 'string',
                            description: 'A SELECT SQL query to run against the ACMA RRL database',
                        },
                        limit: {
                            type: 'number',
                            description: 'Max rows to return (default 100, max 500)',
                        },
                    },
                    required: ['sql'],
                },
            },
            {
                name: 'export_kml',
                description: TOOL_DOCS.export_kml!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        result_id: { type: 'string', description: 'The result_id from a previous query response' },
                    },
                    required: ['result_id'],
                },
            },
            {
                name: 'describe_tool',
                description: TOOL_DOCS.describe_tool!.summary,
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Exact tool name (case-sensitive)' },
                    },
                    required: ['name'],
                },
            },
        ],
    }));

    // ─── Tool Handlers ──────────────────────────────────────────────────────────

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        if (name === 'search_licences') {
            const db = openDb();
            try {
                const results = searchLicences(db, args?.query as string, (args?.limit as number) ?? 10);
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'get_licence_details') {
            const db = openDb();
            try {
                const result = getLicenceDetails(db, args?.licence_no as string);
                if (!result) return { content: [{ type: 'text', text: `No licence found for: ${args?.licence_no}` }] };

                // Cache devices for potential KML export (devices now include site coords)
                let resultId: string | undefined;
                if (result.devices.length > 0) {
                    const columns = Object.keys(result.devices[0] as object);
                    if (hasGeospatialData(columns)) {
                        const rows = result.devices.map(r => columns.map(c => (r as any)[c]));
                        resultId = cacheResult(columns, rows);
                    }
                }

                const response: any = { ...result };
                if (resultId) response.result_id = resultId;

                return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'search_sites') {
            const db = openDb();
            try {
                const results = searchSites(db, args?.query as string, (args?.limit as number) ?? 10);

                // Cache results for potential KML export
                let resultId: string | undefined;
                if (results.length > 0) {
                    const columns = Object.keys(results[0] as object);
                    if (hasGeospatialData(columns)) {
                        const rows = results.map(r => columns.map(c => (r as any)[c]));
                        resultId = cacheResult(columns, rows);
                    }
                }

                const response: any = { results, result_id: resultId };
                return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'get_site_details') {
            const db = openDb();
            try {
                const result = getSiteDetails(db, args?.site_id as string);
                if (!result) return { content: [{ type: 'text', text: `No site found for ID: ${args?.site_id}` }] };

                // Cache site record for potential KML export
                let resultId: string | undefined;
                const columns = Object.keys(result.site as object);
                if (hasGeospatialData(columns)) {
                    const rows = [columns.map(c => (result.site as any)[c])];
                    resultId = cacheResult(columns, rows);
                }

                const response: any = { ...result };
                if (resultId) response.result_id = resultId;

                return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'search_clients') {
            const db = openDb();
            try {
                const results = searchClients(db, args?.query as string, (args?.limit as number) ?? 10);
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'search_bsl') {
            const db = openDb();
            try {
                const results = searchBsl(db, args?.query as string, (args?.limit as number) ?? 10);
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'search_spectrum_band') {
            const db = openDb();
            try {
                const results = searchSpectrumBand(
                    db,
                    args?.freq_min_hz as number,
                    args?.freq_max_hz as number,
                    (args?.limit as number) ?? 20
                );
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } finally { db.close(); }
        }

        if (name === 'search_application_text') {
            const db = openDb();
            try {
                const results = searchApplicationText(
                    db,
                    args?.query as string,
                    (args?.limit as number) ?? 20
                );
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } finally { db.close(); }
        }

        if (name === 'sync_data') {
            // Trigger the sync (mode defaults to 'auto'). Fire-and-forget; the
            // user polls by calling sync_data again to read getSyncStatus().
            const mode = args?.['mode'] === 'full' ? 'full' : 'auto';
            const wasSyncing = getSyncStatus().isSyncing;
            let launched = false;
            if (!wasSyncing) {
                // Kick off async; intentionally not awaited so this response is fast.
                sync(DEFAULT_CONFIG, mode).catch((e: unknown) => {
                    console.error('[MCP] sync_data background failure:', e);
                });
                launched = true;
            }

            const status = getSyncStatus();
            const decisionLine = status.reason
                ? `Last decision: ${status.mode ? `${status.mode} sync — ` : ''}${status.reason}` +
                  (status.detail ? ` (${status.detail})` : '') +
                  (status.lastDecisionAt ? ` at ${status.lastDecisionAt}` : '')
                : null;

            const freshness: string[] = [];
            if (status.dataAsOf) freshness.push(`dataAsOf: ${status.dataAsOf}`);
            if (status.remoteAsOf) freshness.push(`remoteAsOf: ${status.remoteAsOf}`);
            if (status.behindByHours !== undefined) freshness.push(`behindByHours: ${status.behindByHours}`);
            if (status.lastSyncAt) freshness.push(`lastSyncAt: ${status.lastSyncAt}`);

            if (status.isSyncing) {
                const lines = [
                    `Sync in progress${status.mode ? ` (${status.mode})` : ''}: ${status.progress}% — step: ${status.currentTable ?? 'Initializing'}.`,
                    'Poll sync_data again soon.',
                ];
                if (decisionLine) lines.push(decisionLine);
                if (freshness.length) lines.push(...freshness);
                return { content: [{ type: 'text', text: lines.join('\n') }] };
            }

            const lines: string[] = [];
            if (decisionLine) lines.push(decisionLine);
            if (freshness.length) lines.push(...freshness);
            if (lines.length === 0) {
                lines.push(launched ? 'Sync triggered.' : 'Sync already in progress.');
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        if (name === 'list_sample_queries') {
            const filter: { category?: any; name?: string } = {};
            if (args?.category !== undefined) filter.category = args.category as any;
            if (args?.name !== undefined) filter.name = args.name as string;
            const result = listSampleQueries(Object.keys(filter).length > 0 ? filter : undefined);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        if (name === 'describe_schema') {
            const db = openDb();
            try {
                const result = describeSchema(db, args?.tables as string[] | undefined);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } finally { db.close(); }
        }

        if (name === 'describe_tool') {
            const toolName = args?.name as string | undefined;
            if (!toolName) {
                return { content: [{ type: 'text', text: 'Error: missing required argument `name`.' }] };
            }
            const doc = TOOL_DOCS[toolName];
            if (!doc) {
                return { content: [{ type: 'text', text: `Unknown tool: ${toolName}. Call tools/list for available tools.` }] };
            }
            return { content: [{ type: 'text', text: doc.fullDescription.trim() }] };
        }

        if (name === 'execute_sql') {
            const sql = args?.sql as string;
            const limit = (args?.limit as number) ?? 100;
            try {
                const result = await executeSqlWithTimeout(dbPath, sql, limit, 25_000);

                // Cache results for potential KML export if geospatial data detected
                let resultId: string | undefined;
                if (result.rowCount > 0 && hasGeospatialData(result.columns)) {
                    resultId = cacheResult(result.columns, result.rows);
                }

                const response: any = { ...result };
                if (resultId) response.result_id = resultId;

                return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
            } catch (err: any) {
                return {
                    content: [{ type: 'text', text: `SQL Error: ${err.message}` }],
                    isError: true,
                };
            }
        }

        if (name === 'export_kml') {
            const id = args?.result_id as string;
            if (!id) {
                return {
                    content: [{ type: 'text', text: 'Missing required parameter: result_id' }],
                    isError: true,
                };
            }
            const entry = resultCache.get(id);
            if (!entry) {
                return {
                    content: [{ type: 'text', text: `Result not found or expired (result_id: ${id}). Please re-run the original query to get a fresh result_id.` }],
                    isError: true,
                };
            }
            const kml = generateKml(entry.columns, entry.rows);
            return {
                content: [{ type: 'text', text: kml }]
            };
        }

        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    });

    return server;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

async function main() {
    const app = express();
    app.use(express.json());

    app.get('/health', (_req, res) => res.send('OK'));

    app.all('/mcp', async (req, res) => {
        if (process.env.DEBUG_NETWORK) {
            console.error(`[NETWORK] ${req.method} | session=${req.headers['mcp-session-id'] ?? 'none'}`);
        }

        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        // Route to existing session
        if (sessionId && transports.has(sessionId)) {
            try {
                await transports.get(sessionId)!.handleRequest(req, res, req.body);
            } catch (err: any) {
                console.error('[MCP] Transport error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: err.message });
            }
            return;
        }

        // New session — only POST initialize can start one
        if (req.method === 'POST') {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (newId) => {
                    transports.set(newId, transport);
                    console.error(`[SESSION] Opened: ${newId}`);
                },
            });

            transport.onclose = () => {
                if (transport.sessionId) {
                    transports.delete(transport.sessionId);
                    console.error(`[SESSION] Closed: ${transport.sessionId}`);
                }
            };

            await createServer().connect(transport as any);

            try {
                await transport.handleRequest(req, res, req.body);
            } catch (err: any) {
                console.error('[MCP] Init error:', err.message);
                if (!res.headersSent) res.status(500).json({ error: err.message });
            }
            return;
        }

        res.status(400).json({
            error: 'Send POST /mcp with initialize to start a session first.',
        });
    });

    const port = Number(PORT);
    app.listen(port, '0.0.0.0', () => {
        console.error(`ACMA RRL MCP Server v1.6.0 running on port ${port} at http://localhost:${port}/mcp`);
        console.error('Tools: search_licences, get_licence_details, search_sites, get_site_details, search_clients, sync_data, execute_sql, list_sample_queries, export_kml, search_bsl, search_spectrum_band, search_application_text, describe_schema, describe_tool');
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
