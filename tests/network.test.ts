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
        // Either still in progress or has completed/failed — either is valid
        expect(responseText).toMatch(/Sync (in progress|started|failed)/i);

        await transport.close();
    }, 25000);

    test('list_sample_queries returns 44 entries', async () => {
        const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);

        const result = await client.callTool({ name: 'list_sample_queries', arguments: {} }) as any;
        const queries = JSON.parse(result.content[0].text);
        expect(Array.isArray(queries)).toBe(true);
        expect(queries).toHaveLength(44);
        expect(queries[0]).toHaveProperty('description');
        expect(queries[0]).toHaveProperty('query');

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
});
