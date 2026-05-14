import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initializeDatabase } from '../src/db.js';
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

        console.log(`Starting server on port ${PORT}...`);
        serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
            env: { ...process.env, PORT: String(PORT), ACMA_DB_PATH: testDbPath },
            stdio: 'pipe'
        });

        serverProcess.stderr.on('data', (data: Buffer) => console.error(`[SERVER ERR] ${data}`));

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Server timeout')), 20000);
            serverProcess.stderr.on('data', (data: Buffer) => {
                if (data.toString().includes(`running on port ${PORT}`)) {
                    clearTimeout(timeout);
                    resolve(true);
                }
            });
        });

        await axios.get(`http://localhost:${PORT}/health`);
    }, 30000);

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

    test('tools/list includes describe_tool as the 14th tool', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const tools = await client.listTools();
        expect(tools.tools.some(t => t.name === 'describe_tool')).toBe(true);
        expect(tools.tools.length).toBe(14);

        await transport.close();
    }, 15000);

    test('every advertised tool has a TOOL_DOCS entry', async () => {
        // Read TOOL_DOCS via dynamic import to avoid module side-effects at file load time.
        const { TOOL_DOCS } = await import('../src/index');
        const advertised = [
            'search_licences', 'get_licence_details', 'search_sites', 'get_site_details',
            'search_clients', 'search_bsl', 'search_spectrum_band', 'search_application_text',
            'sync_data', 'list_sample_queries', 'execute_sql', 'export_kml',
            'describe_schema', 'describe_tool',
        ];
        for (const name of advertised) {
            expect(TOOL_DOCS[name]).toBeDefined();
            expect(TOOL_DOCS[name]!.summary.length).toBeLessThan(200);
            expect(TOOL_DOCS[name]!.tags.length).toBeGreaterThan(0);
            expect(TOOL_DOCS[name]!.fullDescription.length).toBeGreaterThan(50);
        }
    });
});
