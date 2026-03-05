import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import axios from 'axios';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('MCP Network & Sync Integration (Streamable HTTP)', () => {
    let serverProcess: any;
    const PORT = 3001;

    beforeAll(async () => {
        console.log(`Starting server on port ${PORT}...`);
        serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
            env: { ...process.env, PORT: String(PORT), ACMA_DB_PATH: path.join(__dirname, 'test_mcp.db') },
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

        const firstCall = client.callTool({ name: 'sync_data', arguments: {} });
        await new Promise(r => setTimeout(r, 1000));

        const secondCall = await client.callTool({ name: 'sync_data', arguments: {} }) as any;
        const responseText = secondCall.content[0].text;
        expect(responseText).toMatch(/Sync in progress/);

        await firstCall;
        await transport.close();
    }, 20000);
});
