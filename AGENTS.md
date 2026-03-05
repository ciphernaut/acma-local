# ACMA MCP Server - Agent Guidelines

## Build/Lint/Test Commands
- **Install**: `pip install -e .`
- **Run tests**: `pytest tests/ -v` (single test: `pytest tests/test_specific.py::test_function`)
- **Lint**: `ruff check .` and `ruff format .`
- **Type check**: `mypy .`
- **Run server**: `uvicorn acma_mcp.server:app --host 0.0.0.0 --port 8000`
- **Run ETL**: `python -m acma_mcp.etl.pipeline spectra data/acma_licences.db`

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

## Architecture Standards (Implemented)
- SQLite primary database with connection pooling and foreign key constraints
- WebSocket and HTTP/REST transports (gRPC planned)
- In-memory caching with async connection pooling
- ETL pipeline with batch processing and data validation
- Real ACMA data: 14,795 clients, 127,238 sites, 163,489 licences, 2,534,208 devices