# MCP Client Configuration

The ACMA RRL MCP Server can be integrated with any MCP-compliant client (e.g., Claude Desktop, IDE extensions).

## Claude Desktop Configuration

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "acma-rrl": {
      "command": "node",
      "args": ["/absolute/path/to/acma-local-redux/dist/index.js"],
      "env": {
        "ACMA_DB_PATH": "/absolute/path/to/acma-local-redux/data/acma.db",
        "ACMA_DATA_DIR": "/absolute/path/to/acma-local-redux/data"
      }
    }
  }
}
```

### Parameters

- `command`: `node` is required to run the server.
- `args`: Path to the compiled server entry point (`dist/index.js`).
- `env`:
    - `ACMA_DB_PATH`: Optional. Absolute path to the SQLite database.
    - `ACMA_DATA_DIR`: Optional. Absolute path to the directory for temporary sync files.

## Initial Synchronization

The first time the server runs, it will attempt a **Full Synchronization**. This involves:
- Downloading the 100MB ZIP file from ACMA.
- Extracting and importing roughly 500MB of data.

Depending on your internet connection and disk speed, this may take **2-5 minutes**. Subsequent runs will use the local database and perform incremental updates which are very fast.

## Verification

Once configured, you can verify the server by asking Claude:
- "Search for radio sites in Sydney."
- "What are the details for licence 1100223?"
- "What is the database status?"
