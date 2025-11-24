# ACMA MCP Server - Agent Guidelines

## Build/Lint/Test Commands
- **Install**: `pip install -e .` (when package structure exists)
- **Run tests**: `pytest tests/ -v` (single test: `pytest tests/test_specific.py::test_function`)
- **Lint**: `ruff check .` and `ruff format .`
- **Type check**: `mypy .`
- **Run server**: `uvicorn acma_mcp.server:app --host 0.0.0.0 --port 8000`

## Code Style Guidelines
- **Python**: 3.11+ with async/await patterns
- **Imports**: Group stdlib, third-party, local imports; use `isort` formatting
- **Formatting**: 88 character line limit, use `ruff format`
- **Types**: Full type hints with `pydantic` models for data validation
- **Naming**: snake_case for functions/variables, PascalCase for classes
- **Error handling**: Use MCP error codes, raise custom exceptions, log with structlog
- **Async**: All database operations and I/O must be async
- **Database**: Use `aiosqlite` with connection pooling, parameterized queries only

## MCP Protocol Compliance
- Implement official MCP JSON-RPC 2.0 specification
- Use standard tool registration and discovery patterns
- Follow MCP error handling and response formats
- Support MCP capabilities negotiation

## Architecture Standards
- SQLite primary database with FTS5 and spatial extensions
- WebSocket and gRPC transports (NO stdio)
- Multi-level caching: memory → Redis (optional)
- Weekly ETL pipeline with data validation