/**
 * ACMA RRL MCP Server - Network Mode
 *
 * Per-session StreamableHTTPServerTransport (official MCP multi-client pattern).
 * Full tool catalog: search_sites, search_licences, search_clients,
 *                    get_licence_details, get_site_details, sync_data.
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
} from './logic.js';
import { executeSql, listSampleQueries } from './sql.js';

const dbPath = process.env.ACMA_DB_PATH || DEFAULT_CONFIG.dbPath;
const PORT = process.env.PORT || 3000;

function openDb() {
    return new Database(dbPath, { readonly: true });
}

function createServer(): Server {
    const server = new Server(
        { name: 'acma-rrl-server', version: '1.4.0' },
        { capabilities: { tools: {} } }
    );

    // ─── Tool Catalog ───────────────────────────────────────────────────────────

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: 'search_licences',
                description: `
### [Licence Search] PRIMARY SEARCH TOOL
Search ACMA RRL licences by licence number.

## Usage
- Use this first when given a licence number (e.g. "1191324/1", "1191324")
- Results include: LICENCE_NO, STATUS, LICENCE_TYPE_NAME, CLIENT_NO, DATE_OF_EXPIRY

## Input
- query: Licence number or partial number`,
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
                description: `
### [Licence Details]
Get full details for a specific licence: client info and all associated radio devices.

## Usage
- Use after finding a licence number via search_licences
- Returns: licence record, client/owner info, up to 50 device records

## Input
- licence_no: Exact licence number (e.g. "1191324/1")`,
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
                description: `
### [Site Search]
Search transmission sites by site name or postcode.

## Usage
- Use when asked about a transmitter location or site
- Results include: SITE_ID, NAME, STATE, POSTCODE, LATITUDE, LONGITUDE

## Input
- query: Site name or postcode`,
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
                description: `
### [Site Details]
Get full details for a specific site including all devices registered at that site.

## Usage
- Use after finding a SITE_ID via search_sites
- Returns: site record, up to 50 associated device_details records

## Input
- site_id: Exact Site ID from site search results`,
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
                description: `
### [Client / Licensee Search]
Search for licence holders (clients) by company name or trading name.

## Usage
- Use when asked about who holds licences, e.g. "who operates on this frequency?"
- Results include: CLIENT_NO, LICENCEE, TRADING_NAME, ABN, ACN, STATE

## Input
- query: Business name or trading name`,
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
                name: 'sync_data',
                description: `
### [Data Synchronization]
Download and import the latest ACMA RRL dataset. Safe to call while server is running.

## Usage
- Call once to start sync, then poll to check progress
- Returns progress percentage while syncing

## Status fields
- progress: 0-100%
- currentTable: which CSV is being imported`,
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'list_sample_queries',
                description: `
### [SQL Sample Queries]
Returns 44 named example SQL queries from the ACMA RRL database.

## Usage
- Call this first to discover what SQL queries are available
- Use the returned queries as templates or run them directly with execute_sql
- Covers: licence counts, assignments by frequency/postcode, site/client searches, licensing statistics, satellite data and more

## Output
Array of { description, query } objects`,
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'execute_sql',
                description: `
### [SQL Query Executor]
Run a read-only SELECT query directly against the ACMA RRL SQLite database.

## Usage
- Use list_sample_queries first if unsure what to query
- Only SELECT statements are allowed — no INSERT, UPDATE, DELETE, DROP etc.
- Results capped at 'limit' rows (default 100, max 500)

## Available tables
client, licence, site, device_details, antenna, antenna_pattern, antenna_polarity,
access_area, applic_text_block, auth_spectrum_area, auth_spectrum_freq,
bsl, bsl_area, class_of_station, client_type, fee_status, industry_cat,
licence_service, licence_status, licence_subservice, licensing_area,
nature_of_service, reports_text_block, satellite, meta

## Output
{ columns: string[], rows: any[][], truncated: boolean, rowCount: number }`,
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
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'search_sites') {
            const db = openDb();
            try {
                const results = searchSites(db, args?.query as string, (args?.limit as number) ?? 10);
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'get_site_details') {
            const db = openDb();
            try {
                const result = getSiteDetails(db, args?.site_id as string);
                if (!result) return { content: [{ type: 'text', text: `No site found for ID: ${args?.site_id}` }] };
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'search_clients') {
            const db = openDb();
            try {
                const results = searchClients(db, args?.query as string, (args?.limit as number) ?? 10);
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } finally { if (db.open) db.close(); }
        }

        if (name === 'sync_data') {
            const status = getSyncStatus();
            if (status.isSyncing) {
                return {
                    content: [{
                        type: 'text',
                        text: `Sync in progress: ${status.progress}% — step: ${status.currentTable ?? 'Initializing'}. Poll again soon.`
                    }]
                };
            }
            sync(DEFAULT_CONFIG).catch(err => console.error('[SYNC] Error:', err));
            return { content: [{ type: 'text', text: 'Sync started. Call sync_data again to check progress.' }] };
        }

        if (name === 'list_sample_queries') {
            const queries = listSampleQueries();
            return { content: [{ type: 'text', text: JSON.stringify(queries, null, 2) }] };
        }

        if (name === 'execute_sql') {
            const sql = args?.sql as string;
            const limit = (args?.limit as number) ?? 100;
            const db = openDb();
            try {
                const result = executeSql(db, sql, limit);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            } catch (err: any) {
                return {
                    content: [{ type: 'text', text: `SQL Error: ${err.message}` }],
                    isError: true,
                };
            } finally {
                if (db.open) db.close();
            }
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

            await createServer().connect(transport);

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
        console.error(`ACMA RRL MCP Server v1.5.0 running on port ${port} at http://localhost:${port}/mcp`);
        console.error('Tools: search_licences, get_licence_details, search_sites, get_site_details, search_clients, sync_data, execute_sql, list_sample_queries');
    });
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
