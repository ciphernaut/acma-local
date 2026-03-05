import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG, sync } from './sync.js';
import * as fs from 'fs';
import {
    searchSites,
    getSiteDetails,
    searchLicences,
    searchClients,
    getLicenceDetails,
} from './logic.js';

const dbPath = process.env.ACMA_DB_PATH || DEFAULT_CONFIG.dbPath;

export const server = new Server(
    {
        name: 'acma-rrl-server',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

/**
 * List available tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'search_sites',
                description: 'Search for radio transmission sites by name or postcode.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search term for site name or postcode.',
                        },
                        limit: {
                            type: 'number',
                            description: 'Maximum number of results to return (default 20).',
                        },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'get_site_details',
                description: 'Get full technical details for a specific site.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        siteId: {
                            type: 'string',
                            description: 'The unique SITE_ID.',
                        },
                    },
                    required: ['siteId'],
                },
            },
            {
                name: 'search_licences',
                description: 'Search for radio licences by licence number.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search term for licence number.',
                        },
                        limit: {
                            type: 'number',
                            description: 'Maximum number of results to return (default 20).',
                        },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'search_clients',
                description: 'Search for license holders (clients) by name.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search term for client name (licencee or trading name).',
                        },
                        limit: {
                            type: 'number',
                            description: 'Maximum number of results to return (default 20).',
                        },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'get_licence_details',
                description: 'Get full technical details for a specific licence.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        licenceNo: {
                            type: 'string',
                            description: 'The unique LICENCE_NO.',
                        },
                    },
                    required: ['licenceNo'],
                },
            },
            {
                name: 'get_db_status',
                description: 'Get the current status of the database, including the last synchronization date and the "as-of" timestamp.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                },
            },
            {
                name: 'sync_data',
                description: 'Trigger a synchronization with the ACMA RRL database.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        fullSync: {
                            type: 'boolean',
                            description: 'Force a full synchronization instead of incremental.',
                        }
                    }
                },
            },
        ],
    };
});

/**
 * Handle tool calls.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const db = new Database(dbPath, { readonly: true });

    try {
        switch (request.params.name) {
            case 'search_sites': {
                const query = request.params.arguments?.query as string;
                const limit = (request.params.arguments?.limit as number) || 20;
                const results = searchSites(db, query, limit);
                return {
                    content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
                };
            }

            case 'get_site_details': {
                const siteId = request.params.arguments?.siteId as string;
                const results = getSiteDetails(db, siteId);
                if (!results) {
                    return {
                        content: [{ type: 'text', text: `Site with ID ${siteId} not found.` }],
                        isError: true,
                    };
                }
                return {
                    content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
                };
            }

            case 'search_licences': {
                const query = request.params.arguments?.query as string;
                const limit = (request.params.arguments?.limit as number) || 20;
                const results = searchLicences(db, query, limit);
                return {
                    content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
                };
            }

            case 'search_clients': {
                const query = request.params.arguments?.query as string;
                const limit = (request.params.arguments?.limit as number) || 20;
                const results = searchClients(db, query, limit);
                return {
                    content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
                };
            }

            case 'get_licence_details': {
                const licenceNo = request.params.arguments?.licenceNo as string;
                const results = getLicenceDetails(db, licenceNo);
                if (!results) {
                    return {
                        content: [{ type: 'text', text: `Licence ${licenceNo} not found.` }],
                        isError: true,
                    };
                }
                return {
                    content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
                };
            }

            case 'get_db_status': {
                const meta = db.prepare('SELECT * FROM meta').all();
                const status = meta.reduce((acc: any, row: any) => {
                    acc[row.key] = row.value;
                    return acc;
                }, {});

                return {
                    content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
                };
            }

            case 'sync_data': {
                // We need to allow writing for sync
                db.close();
                const fullSync = !!request.params.arguments?.fullSync;

                // Sync is async, we return a message but the actual sync happens in the background
                // or we await it. Let's await for simplicity in first impl.
                await sync(DEFAULT_CONFIG);

                return {
                    content: [{ type: 'text', text: 'Synchronization completed successfully.' }],
                };
            }

            default:
                throw new Error('Unknown tool');
        }
    } catch (error: any) {
        return {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true,
        };
    } finally {
        if (db.open) db.close();
    }
});

/**
 * Start the server.
 */
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('ACMA RRL MCP Server running on stdio');
}

main().catch((error) => {
    console.error('Fatal error in main():', error);
    process.exit(1);
});
