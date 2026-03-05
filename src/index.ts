import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
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

/**
 * Global session map to track multiple SSE connections.
 */
const sessions = new Map<string, SSEServerTransport>();

export const server = new Server(
    {
        name: 'acma-rrl-server',
        version: '1.2.6',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

/**
 * List available tools with structured headers for optimal discoverability.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'search_sites',
                description: `
### [Site Search]
Search for radio transmission sites by name or postcode.
Details: Provides location and license information for transmitters.`,
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Site name or postcode' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'sync_data',
                description: `
### [Data Synchronization]
Trigger or check the status of a synchronization with the ACMA RRL database.
Details: Sync runs in background. Polling this tool returns progress percentage.`,
                inputSchema: { type: 'object', properties: {} },
            },
        ],
    };
});

/**
 * Combined tool handlers.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'sync_data') {
        const status = getSyncStatus();
        if (status.isSyncing) {
            return { content: [{ type: 'text', text: `Synchronization is currently in progress (${status.progress}%). Please try again soon. Current step: ${status.currentTable ?? 'Initializing'}.` }] };
        }
        // Start sync in background
        sync(DEFAULT_CONFIG).catch(err => console.error('[SYNC] Background Error:', err));
        return { content: [{ type: 'text', text: 'Synchronization started. You can poll this tool again to see progress.' }] };
    }

    if (request.params.name === 'search_sites') {
        const query = request.params.arguments?.query as string;
        const db = new Database(dbPath, { readonly: true });
        try {
            const results = searchSites(db, query, 5);
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        } finally {
            if (db.open) db.close();
        }
    }

    return { content: [{ type: 'text', text: `Tool not found: ${request.params.name}` }], isError: true };
});

async function main() {
    const app = express();

    // Body parsing middleware (required for POST handlePostMessage)
    app.use(express.json());

    app.get('/health', (req, res) => res.send('OK'));

    /**
     * SSE endpoint: Establish the persistent connection.
     */
    app.get('/mcp', async (req, res) => {
        if (process.env.DEBUG_NETWORK) {
            console.error(`[NETWORK] New SSE Connection: ${req.url}`);
        }

        // SSEServerTransport handles the initial GET to /mcp
        const transport = new SSEServerTransport('/mcp', res);

        // Track the session
        const sessionId = transport.sessionId;
        sessions.set(sessionId, transport);

        transport.onclose = () => {
            if (process.env.DEBUG_NETWORK) {
                console.error(`[NETWORK] SSE Session ${sessionId} closed.`);
            }
            sessions.delete(sessionId);
        };

        // connect() automatically calls transport.start()
        await server.connect(transport);
    });

    /**
     * POST endpoint: Receive messages for an existing SSE session.
     */
    app.post('/mcp', async (req, res) => {
        const sessionId = req.query.sessionId as string;
        const transport = sessions.get(sessionId);

        if (!transport) {
            console.error(`[NETWORK] Session not found: ${sessionId}`);
            res.status(404).send('Session not found');
            return;
        }

        try {
            await transport.handlePostMessage(req, res);
        } catch (err: any) {
            console.error(`[NETWORK] POST error for session ${sessionId}:`, err);
            if (!res.headersSent) {
                res.status(500).send(err.message);
            }
        }
    });

    const port = Number(PORT);
    app.listen(port, '0.0.0.0', () => {
        console.error(`ACMA RRL MCP Server running on http://0.0.0.0:${port}/mcp (Robust SSE mode)`);
    });
}

main().catch(error => {
    console.error('Fatal initialization error:', error);
    process.exit(1);
});
