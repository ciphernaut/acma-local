# ACMA MCP Server

A Model Context Protocol (MCP) server that provides access to Australian Communications and Media Authority (ACMA) radio licensing data.

## Features

- **MCP Protocol Compliance**: Full JSON-RPC 2.0 implementation
- **Multiple Transports**: WebSocket, gRPC, and HTTP/REST support
- **High Performance**: SQLite with FTS5, spatial indexing, and multi-level caching
- **Data Validation**: Comprehensive input validation with Pydantic models
- **ETL Pipeline**: Automated weekly data updates from ACMA

## Quick Start

### Installation

```bash
pip install -e .
```

### Development Setup

```bash
# Install development dependencies
pip install -e ".[dev]"

# Set up pre-commit hooks
pre-commit install
```

### Running the Server

```bash
# Development server
uvicorn acma_mcp.server:app --host 0.0.0.0 --port 8000 --reload

# Production server
acma-mcp serve --host 0.0.0.0 --port 8000
```

## Development

### Code Quality

```bash
# Lint and format
ruff check .
ruff format .

# Type checking
mypy .

# Run tests
pytest tests/ -v

# Single test
pytest tests/test_specific.py::test_function
```

### Project Structure

```
acma_mcp/
├── __init__.py
├── server.py          # FastAPI application
├── config.py          # Configuration management
├── database/          # Database layer
├── models/            # Pydantic models
├── tools/             # MCP tools implementation
├── transports/        # WebSocket/gRPC transports
├── etl/               # Data processing pipeline
└── utils/             # Utility functions
```

## Configuration

The server can be configured via environment variables or a `.env` file:

```bash
DATABASE_PATH=./data/acma_licences.db
REDIS_URL=redis://localhost:6379
LOG_LEVEL=INFO
MAX_MEMORY_MB=1024
```

## License

MIT License - see LICENSE file for details.