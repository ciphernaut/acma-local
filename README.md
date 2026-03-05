# ACMA RRL MCP Server

A Model Context Protocol (MCP) server for searching and exploring the Australian Communications and Media Authority (ACMA) Register of Radiocommunications Licences (RRL).

This server implementation is based on the [ACMA Offline RRL](https://web.acma.gov.au/offline-rrl/index.html) web application, providing a compact SQLite-based local mirror of the RRL dataset with incremental daily updates.

## Features

- **Local Mirror**: Compact SQLite database storing the full RRL dataset.
- **Smart Synchronization**: Supports full initial download and incremental daily updates (`.rrl_update` files).
- **Comprehensive Search**: Tools for searching sites, licences, and clients.
- **Technical Details**: Detailed views for sites and licences, including associated device details and equipment specs.

## Tools

- `search_sites`: Search for radio transmission sites by name or postcode.
- `get_site_details`: Get full technical details for a specific site (transmitters, receivers).
- `search_licences`: Search for radio licences by licence number.
- `get_licence_details`: Get full technical details for a specific licence, including the holder and associated devices.
- `search_clients`: Search for license holders (clients) by name or trading name.
- `get_db_status`: Check the database "as-of" date and last synchronization timestamp.
- `sync_data`: Manually trigger a data synchronization (incremental or full).

## Installation

```bash
npm install
npm run build
```

## Configuration

The server can be configured via environment variables:

- `ACMA_DB_PATH`: Path to the SQLite database file (default: `./data/acma.db`).
- `ACMA_DATA_DIR`: Directory for storing downloaded/extracted data (default: `./data`).

### MCP Client Configuration

Example configuration for Claude Desktop:

```json
{
  "mcpServers": {
    "acma-rrl": {
      "command": "node",
      "args": ["/path/to/acma-local-redux/dist/index.js"],
      "env": {
        "ACMA_DB_PATH": "/path/to/acma-local-redux/data/acma.db"
      }
    }
  }
}
```

## Maintenance

The dataset is updated daily by ACMA. To keep your local mirror fresh, you can call the `sync_data` tool periodically.

## Development

- `npm run dev`: Start the server in development mode.
- `npm run test`: Run the test suite (Jest).

## License

Creative Commons Attribution 4.0 International (ACMA Data).
Implementation: MIT.
