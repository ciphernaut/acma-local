import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG, sync, getSyncStatus } from './sync.js';
import express from 'express';
import {
    searchSites,
} from './logic.js';

const dbPath = process.env.ACMA_DB_PATH || DEFAULT_CONFIG.dbPath;
const PORT = process.env.PORT || 3000;

export const server = new Server(
    {
        name: 'acma-rrl-server',
        version: '1.2.5',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

/**
 * List available tools with structured headers.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'search_sites',
                description: `
### [Site Search]
Search for radio transmission sites by name or postcode.`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'sync_data',
                description: `
### [Data Synchronization]
Trigger a synchronization with the ACMA RRL database.`,
                inputSchema: { type: 'object', properties: {} },
            },
        ],
    };
});

/**
 * Tool handlers.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const db = new Database(dbPath, { readonly: true });
    try {
        if (request.params.name === 'sync_data') {
            const status = getSyncStatus();
            if (status.isSyncing) {
                return { content: [{ type: 'text', text: `Sync in progress (${status.progress}%).` }] };
            }
            sync(DEFAULT_CONFIG).catch(err => console.error('BG Sync Error:', err));
            return { content: [{ type: 'text', text: 'Sync initiated.' }] };
        }
        if (request.params.name === 'search_sites') {
            const query = request.params.arguments?.query as string;
            const results = searchSites(db, query, 5);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        }
        return { content: [{ type: 'text', text: 'Tool not found' }] };
    } finally {
        if (db.open) db.close();
    }
});

async function main() {
    const transport = new StreamableHTTPServerTransport();
    await server.connect(transport);

    const app = express();
    app.get('/health', (req, res) => res.send('OK'));

    // Handle MCP requests
    app.all('/mcp', async (req, res) => {
        try {
            await transport.handleRequest(req, res);
        } catch (err: any) {
            console.error('[MCP] Transport Error:', err);
            if (!res.headersSent) {
                res.status(500).send(err.message);
            }
        }
    });

    const port = Number(PORT);
    app.listen(port, () => {
        console.error(`ACMA RRL MCP Server running on port ${port} (Streamable HTTP mode)`);
    });
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
