# MCP Client Configuration

The ACMA RRL MCP Server supports two transport modes: **Stdio** (local) and **Network (SSE/HTTP)**.

## 1. Stdio Configuration (Local)

Best for local use with Claude Desktop or LM Studio on the same machine.

### Claude Desktop / LM Studio (`mcp.json`)
```json
{
  "mcpServers": {
    "acma-rrl": {
      "command": "node",
      "args": ["/absolute/path/to/acma-local-redux/dist/index.js"],
      "env": {
        "ACMA_DB_PATH": "/absolute/path/to/acma-local-redux/data/acma.db"
      }
    }
  }
}
```

## 2. Network Mode (SSE)

The server hosts a robust **SSE (Server-Sent Events)** endpoint. This is the recommended mode for remote clients and tools like LM Studio that require a stable network connection.

### Server Setup
Run the server to host the network endpoint:
```bash
PORT=3000 npm run dev
```

### LM Studio / Claude Desktop (`mcp.json` / `config.json`)

To connect over the network, add this to your `mcpServers` object:

```json
{
  "mcpServers": {
    "acma-rrl-network": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

> [!IMPORTANT]
> 1. The server must be running (`npm run dev`) for this to work.
> 2. LM Studio version **0.3.17+** is required for native SSE support.
> 3. If your client does not support the `url` key (older versions), use the **Stdio Configuration** in Section 1 instead.

## 3. Sync Progress & Capabilities

When using either mode, the `sync_data` tool provides enhanced feedback:

- **Background Sync**: Triggering a sync returns an immediate "Sync initiated" message.
- **Progress Polling**: Subsequent calls to `sync_data` while a sync is active will return a progress percentage (e.g., `Synchronization in progress (45%)`).
- **Matterfront Discoverability**: Tool descriptions use structured headers (`### [Name]`) to make capabilities easier for AI models to parse.

## 4. Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Port for the HTTP/SSE server (Default: `3000`). |
| `ACMA_DB_PATH` | Absolute path to the SQLite database. |
| `DEBUG_NETWORK` | Set to `true` to log all network traffic. |
| `DEBUG_AUTH` | Set to `true` to log auth stub authorizations. |
