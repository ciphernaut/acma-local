# Using ACMA MCP as a Running Service

The ACMA MCP server can be run as a standalone service, allowing multiple clients to connect over the network using either a custom WebSocket transport or a standard REST API.

## Starting the Server

To start the ACMA MCP server as a running service, use the following command:

```bash
# Using the CLI (recommended)
acma-mcp serve --host 0.0.0.0 --port 8000

# Or using uvicorn directly
uvicorn acma_mcp.server:app --host 0.0.0.0 --port 8000
```

The server will be available at `http://0.0.0.0:8000`.

## Connecting via WebSocket (MCP-Compatible)

The server provides a custom WebSocket transport that follows the Model Context Protocol (MCP) message format. This is the primary way to use ACMA MCP with clients that support custom WebSocket transports.

- **Endpoint**: `ws://<host>:<port>/ws`
- **Handshake**: Send an `initialize` message to start the session.

### Example Handshake (JSON)

```json
{
  "id": "1",
  "method": "initialize",
  "parameters": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {
      "name": "example-client",
      "version": "1.0.0"
    }
  }
}
```

### Listing Tools

```json
{
  "id": "2",
  "method": "tools/list",
  "parameters": {}
}
```

### Calling a Tool

```json
{
  "id": "3",
  "method": "tools/call",
  "parameters": {
    "name": "search_licences",
    "arguments": {
      "licencee": "Telstra",
      "limit": 5
    }
  }
}
```

## Connecting via REST API

For simpler integration, the server also exposes the MCP tools via standard HTTP endpoints.

### List Available Tools

`GET http://<host>:<port>/tools`

### Execute a Tool

`POST http://<host>:<port>/tools/{tool_name}`

**Request Body**:
```json
{
  "param1": "value1",
  "param2": "value2"
}
```

**Example (cURL)**:
```bash
curl -X POST http://localhost:8000/tools/search_licences \
  -H "Content-Type: application/json" \
  -d '{"licencee": "Telstra", "limit": 3}'
```

## Note on Transports

- **SSE (Server-Sent Events)**: Supported at `http://<host>:<port>/mcp/sse`. This is the recommended transport for LM Studio and other standard MCP clients.
- **gRPC**: A gRPC port (default 50051) is defined in settings but the service is not yet implemented.
- **Stdio**: The server is designed to run as a network service and does not natively support Stdio transport in the current version.
