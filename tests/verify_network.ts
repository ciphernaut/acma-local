import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function main() {
    const transport = new SSEClientTransport(new URL('http://localhost:8080/mcp'));
    const client = new Client({ name: 'verify-client', version: '1.0.0' }, { capabilities: {} });

    console.log('Connecting to server...');
    await client.connect(transport);
    console.log('Connected!');

    const tools = await client.listTools();
    console.log('Available tools:', tools.tools.map(t => t.name));

    await transport.close();
    process.exit(0);
}

main().catch(err => {
    console.error('Verification failed:', err);
    process.exit(1);
});
