import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initializeDatabase } from '../src/db.js';
import Database from 'better-sqlite3';
import axios from 'axios';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('MCP Network & Sync Integration (Streamable HTTP)', () => {
    let serverProcess: any;
    const PORT = 3001;
    const testDbPath = path.join(__dirname, 'test_mcp.db');

    beforeAll(async () => {
        // Ensure a valid (empty) database exists before the server starts
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
        initializeDatabase(testDbPath);

        // Seed emission lookup tables so search_devices_by_emission can resolve descriptions.
        {
            const seedPath = path.resolve(__dirname, '..', 'seed', 'emissions.sql');
            const db = new Database(testDbPath);
            try {
                const { applyEmissionReseed } = await import('../src/emissions.js');
                applyEmissionReseed(db, seedPath);
            } finally { db.close(); }
        }

        console.log(`Starting server on port ${PORT}...`);
        serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
            env: { ...process.env, PORT: String(PORT), ACMA_DB_PATH: testDbPath },
            stdio: 'pipe'
        });

        serverProcess.stderr.on('data', (data: Buffer) => console.error(`[SERVER ERR] ${data}`));

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Server timeout (60s)')), 60000);
            serverProcess.stderr.on('data', (data: Buffer) => {
                if (data.toString().includes(`running on port ${PORT}`)) {
                    clearTimeout(timeout);
                    resolve(true);
                }
            });
        });

        await axios.get(`http://localhost:${PORT}/health`);
    }, 90000);

    afterAll(() => {
        if (serverProcess) serverProcess.kill();
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    });

    test('should connect via Streamable HTTP and list tools', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

        await client.connect(transport);
        const tools = await client.listTools();

        expect(tools.tools).toBeDefined();
        expect(tools.tools.some(t => t.name === 'search_sites')).toBe(true);

        await transport.close();
    }, 15000);

    test('should report sync progress', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        // Kick off sync (non-awaited) — sync will fail (no network in test) but should start
        client.callTool({ name: 'sync_data', arguments: {} }).catch(() => { });
        // Give it a moment to register as in-progress
        await new Promise(r => setTimeout(r, 2000));

        const secondCall = await client.callTool({ name: 'sync_data', arguments: {} }) as any;
        const responseText = secondCall.content[0].text;
        // Either still in progress, triggered, completed, or returned freshness/decision info — all valid
        expect(responseText).toMatch(/Sync (in progress|triggered|already in progress|failed)|Last decision:|dataAsOf:|lastSyncAt:/i);

        await transport.close();
    }, 25000);

    test('sync_data accepts mode="full" argument', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({ name: 'sync_data', arguments: { mode: 'full' } }) as any;
        // Tool must return a content block with non-empty text; no error thrown.
        expect(result.content).toBeDefined();
        expect(result.content.length).toBeGreaterThan(0);
        expect(typeof result.content[0].text).toBe('string');
        expect(result.content[0].text.length).toBeGreaterThan(0);

        await transport.close();
    }, 25000);

    test('list_sample_queries bare call returns a category summary with >=45 total entries', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({ name: 'list_sample_queries', arguments: {} }) as any;
        const summary = JSON.parse(result.content[0].text);
        expect(Array.isArray(summary)).toBe(false);
        expect(Array.isArray(summary.categories)).toBe(true);
        expect(summary.categories.length).toBeGreaterThan(0);
        const total = summary.categories.reduce((s: number, c: any) => s + c.count, 0);
        expect(total).toBeGreaterThanOrEqual(45);

        await transport.close();
    }, 15000);

    test('list_sample_queries filtered by category returns SampleQuery[]', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({ name: 'list_sample_queries', arguments: { category: 'lookup' } }) as any;
        const queries = JSON.parse(result.content[0].text);
        expect(Array.isArray(queries)).toBe(true);
        expect(queries.length).toBeGreaterThan(0);
        expect(queries[0]).toHaveProperty('description');
        expect(queries[0]).toHaveProperty('query');
        expect(queries[0]).toHaveProperty('category', 'lookup');

        await transport.close();
    }, 15000);

    test('execute_sql runs a valid SELECT and returns structured results', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({
            name: 'execute_sql',
            arguments: { sql: "select 1 as num, 'hello' as word" }
        }) as any;
        const data = JSON.parse(result.content[0].text);
        expect(data.columns).toEqual(['num', 'word']);
        expect(data.rows).toEqual([[1, 'hello']]);
        expect(data.truncated).toBe(false);

        await transport.close();
    }, 45000);

    test('execute_sql rejects non-SELECT statements', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({
            name: 'execute_sql',
            arguments: { sql: "INSERT INTO client (CLIENT_NO) VALUES (999)" }
        }) as any;
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toMatch(/SELECT/i);

        await transport.close();
    }, 45000);

    test('describe_tool returns the full markdown for a registered tool', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({ name: 'describe_tool', arguments: { name: 'search_licences' } }) as any;
        const response = result.content[0].text as string;
        // The full description must contain section headers absent from the slim catalog summary
        expect(response).toMatch(/PRIMARY SEARCH TOOL/);
        expect(response).toMatch(/## Usage/);

        await transport.close();
    }, 15000);

    test('describe_tool returns error for unknown tool', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({ name: 'describe_tool', arguments: { name: 'nonexistent_tool' } }) as any;
        const response = (result.content[0].text as string).toLowerCase();
        expect(response).toMatch(/unknown|not found/);

        await transport.close();
    }, 15000);

    test('tools/list catalog descriptions are slim summaries (under 200 chars)', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const tools = await client.listTools();
        for (const tool of tools.tools) {
            expect(tool.description!.length).toBeLessThan(200);
        }

        await transport.close();
    }, 15000);

    test('tools/list advertises the full 18-tool catalog', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const tools = await client.listTools();
        expect(tools.tools.some(t => t.name === 'describe_tool')).toBe(true);
        expect(tools.tools.some(t => t.name === 'explain_query')).toBe(true);
        expect(tools.tools.some(t => t.name === 'get_frequency_allocation')).toBe(true);
        expect(tools.tools.some(t => t.name === 'decode_emission_designator')).toBe(true);
        expect(tools.tools.some(t => t.name === 'search_devices_by_emission')).toBe(true);
        expect(tools.tools.length).toBe(18);

        await transport.close();
    }, 15000);

    // ─── _hints tests ─────────────────────────────────────────────────────────

    async function callMcpTool(toolName: string, toolArgs: Record<string, unknown>): Promise<string> {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const result = await client.callTool({ name: toolName, arguments: toolArgs }) as any;
        await transport.close();
        return result.content[0].text as string;
    }

    test('search_licences result includes _hints pointing at get_licence_details', async () => {
        const response = await callMcpTool('search_licences', { query: '1', limit: 1 });
        const parsed = JSON.parse(response);
        // Response is now an envelope: { rows, _hints? }
        expect(Array.isArray(parsed.rows)).toBe(true);
        if (parsed.rows.length > 0) {
            expect(parsed._hints).toBeDefined();
            expect(parsed._hints[0].tool).toBe('get_licence_details');
            expect(parsed._hints[0].args).toHaveProperty('licence_no');
        }
    }, 15000);

    test('search_sites result includes _hints pointing at get_site_details', async () => {
        const response = await callMcpTool('search_sites', { query: '2000', limit: 1 });
        const parsed = JSON.parse(response);
        expect(Array.isArray(parsed.rows)).toBe(true);
        if (parsed.rows.length > 0) {
            expect(parsed._hints).toBeDefined();
            expect(parsed._hints[0].tool).toBe('get_site_details');
        }
    }, 15000);

    test('search_clients result has no _hints (no follow-up tool)', async () => {
        const response = await callMcpTool('search_clients', { query: 'Test', limit: 1 });
        const parsed = JSON.parse(response);
        // search_clients still returns a flat array OR an envelope without _hints.
        // Either acceptable — but no _hints field should be present.
        if (parsed._hints !== undefined) {
            throw new Error('search_clients should not emit _hints');
        }
    }, 15000);

    // ─── End _hints tests ──────────────────────────────────────────────────────

    // ─── get_frequency_allocation integration tests ───────────────────────────

    test('get_frequency_allocation returns "data not loaded" error when spectrum tables are empty', async () => {
        // The test DB is initialised but the spectrum_* tables have no rows yet
        // (the spectrum-plan seed is only auto-applied at the tail of performFullSync,
        // which doesn't run in this integration setup). The tool should detect this
        // and return a structured _error envelope rather than an empty array.
        const response = await callMcpTool('get_frequency_allocation', { freq_hz: 87100000 });
        const parsed = JSON.parse(response);
        expect(parsed._error).toBeDefined();
        expect(parsed._error).toMatch(/spectrum plan data not loaded/i);
    }, 15000);

    test('get_frequency_allocation returns matching allocation + footnotes after seeding', async () => {
        // Seed the spectrum tables directly via applyReseed so the next call to
        // the MCP tool has data to return. We use a tiny fixture rather than
        // the full seed/spectrum_plan.sql so the test stays fast and offline-safe.
        const Database = (await import('better-sqlite3')).default;
        const { applyReseed } = await import('../src/spectrum_plan.js');
        const fixture = path.join(__dirname, 'fixtures', 'spectrum_plan_smoke.sql');
        if (!fs.existsSync(path.dirname(fixture))) fs.mkdirSync(path.dirname(fixture), { recursive: true });
        fs.writeFileSync(fixture, `BEGIN TRANSACTION;
INSERT INTO spectrum_allocations VALUES(87000000, 108000000, '87-108', 'MHz', '', '', 'BROADCASTING', 'BROADCASTING', 'FM broadcast band', '5.87 AUS37');
INSERT INTO spectrum_australian_footnotes VALUES('AUS37', 'AUS37 body.');
INSERT INTO spectrum_international_footnotes VALUES('5.87', '5.87 ITU body.');
INSERT INTO spectrum_plan_meta VALUES('source_description', 'Smoke fixture');
INSERT INTO spectrum_plan_meta VALUES('published_date', '2018-01-01');
COMMIT;
`);
        const seedDb = new Database(testDbPath);
        try {
            applyReseed(seedDb, fixture);
        } finally { seedDb.close(); }

        const response = await callMcpTool('get_frequency_allocation', { freq_hz: 87100000 });
        const parsed = JSON.parse(response);
        expect(parsed.match_count).toBe(1);
        expect(parsed.allocations[0].australian_table_of_allocations).toBe('BROADCASTING');
        expect(parsed.allocations[0].footnotes.australian[0].ref).toBe('AUS37');
        expect(parsed._warning).toMatch(/8 years old|published 2018/);  // staleness warning fires for 2018-01-01
        expect(parsed._hints).toBeDefined();
        expect(parsed._hints.some((h: any) => h.tool === 'search_licences')).toBe(true);

        fs.unlinkSync(fixture);
    }, 15000);

    // ─── End get_frequency_allocation tests ───────────────────────────────────

    // ─── decode_emission_designator + search_devices_by_emission tests ────────

    test('decode_emission_designator: happy path', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'decode_emission_designator', arguments: { code: '16K0F3E' } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload.valid).toBe(true);
        expect(payload.bandwidth.value_hz).toBe(16000);
        expect(payload.modulation.code).toBe('F');
        expect(payload.info_type.code).toBe('E');
        expect(payload._hints.some((h: any) => h.tool === 'search_devices_by_emission' && h.args?.modulation === 'F')).toBe(true);
        await transport.close();
    }, 15000);

    test('decode_emission_designator: empty input', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'decode_emission_designator', arguments: { code: '' } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload.valid).toBe(false);
        expect(payload.warnings.length).toBeGreaterThan(0);
        // No _hints key emitted on invalid path.
        expect(payload._hints).toBeUndefined();
        await transport.close();
    }, 15000);

    test('search_devices_by_emission: happy path with seeded fixture', async () => {
        // The test DB starts empty for device_details; insert two rows so the search has something to find.
        const fixtureDb = new Database(testDbPath);
        try {
            fixtureDb.prepare(`INSERT INTO device_details(SDD_ID, LICENCE_NO, EMISSION, FREQUENCY, SITE_ID) VALUES
                (9001, 'TEST-L1', '16K0F3E', 150000000, NULL),
                (9002, 'TEST-L2', '10M0W7D', 2400000000, NULL)`).run();
        } finally { fixtureDb.close(); }

        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'search_devices_by_emission', arguments: { modulation: 'F', info_type: 'E' } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload._error).toBeUndefined();
        expect(payload.rows.length).toBeGreaterThanOrEqual(1);
        expect(payload.rows[0].decoded.modulation_code).toBe('F');
        expect(payload.rows[0].decoded.info_type_description).toContain('Telephony');
        expect(payload.resolved_filters.modulation.code).toBe('F');
        expect(payload._hints?.length).toBeGreaterThan(0);
        expect(payload._hints.some((h: any) => h.tool === 'decode_emission_designator' && h.args?.code)).toBe(true);
        await transport.close();
    }, 20000);

    test('search_devices_by_emission: description-resolution path', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'search_devices_by_emission', arguments: { modulation: 'frequency modulation', info_type: 'telephony' } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload._error).toBeUndefined();
        expect(payload.resolved_filters.modulation.code).toBe('F');
        expect(payload.resolved_filters.info_type.code).toBe('E');
        await transport.close();
    }, 15000);

    test('search_devices_by_emission: ambiguous description returns candidate list', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'search_devices_by_emission', arguments: { modulation: 'sideband' } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload._error).toBeDefined();
        expect(payload._error).toContain('ambiguous');
        await transport.close();
    }, 15000);

    test('search_devices_by_emission: no filters returns error', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'search_devices_by_emission', arguments: {} });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload._error).toBe('At least one filter is required.');
        await transport.close();
    }, 15000);

    test('search_devices_by_emission: unknown code letter returns error', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const res = await client.callTool({ name: 'search_devices_by_emission', arguments: { modulation: 'Z' } });
        const payload = JSON.parse((res.content as any)[0].text);
        expect(payload._error).toContain('Z');
        await transport.close();
    }, 15000);

    // ─── End emission tests ───────────────────────────────────────────────────

    test('every advertised tool has a TOOL_DOCS entry', async () => {
        // Read TOOL_DOCS via dynamic import to avoid module side-effects at file load time.
        const { TOOL_DOCS } = await import('../src/index');
        const advertised = [
            'search_licences', 'get_licence_details', 'search_sites', 'get_site_details',
            'search_clients', 'search_bsl', 'search_spectrum_band', 'search_application_text',
            'get_frequency_allocation', 'sync_data', 'list_sample_queries', 'execute_sql',
            'export_kml', 'describe_schema', 'describe_tool', 'explain_query',
            'decode_emission_designator', 'search_devices_by_emission',
        ];
        for (const name of advertised) {
            expect(TOOL_DOCS[name]).toBeDefined();
            expect(TOOL_DOCS[name]!.summary.length).toBeLessThan(200);
            expect(TOOL_DOCS[name]!.tags.length).toBeGreaterThan(0);
            expect(TOOL_DOCS[name]!.fullDescription.length).toBeGreaterThan(50);
        }
    });
});
