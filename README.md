# ACMA MCP Server

Model Context Protocol server for Australian Communications and Media Authority (ACMA) radio licensing data.

## Quick Start

```bash
# Install dependencies
pip install -e .

# Load ACMA data (requires spectra/ directory with CSV files)
python -m acma_mcp.etl.pipeline spectra data/acma_licences.db

# Start server
uvicorn acma_mcp.server:app --host 0.0.0.0 --port 8000
```

## API Endpoints

- `GET /health` - Health check
- `GET /tools` - List available MCP tools
- `POST /tools/{tool_name}` - Execute MCP tool

## Available Tools

1. **search_licences** - Search radio licenses by licensee, type, status
2. **get_client_licences** - Get all licenses for a specific client
3. **find_devices_by_location** - Find devices within geographic radius
4. **get_site_details** - Get detailed site information
5. **analyze_spectrum_usage** - Analyze frequency band utilization
6. **compliance_check** - Perform license compliance checks

## Data

The server provides access to real ACMA licensing data:
- **14,795** clients (Telstra, Optus, ABC, etc.)
- **127,238** sites with GPS coordinates
- **163,489** active radio licenses
- **2,534,208** device records with technical specifications
- **3,427** spectrum frequency allocations

## Example Usage

```bash
# Search Telstra licenses
curl -X POST http://localhost:8000/tools/search_licences \
  -H "Content-Type: application/json" \
  -d '{"licencee": "Telstra", "limit": 3}'

# Find devices near Sydney CBD
curl -X POST http://localhost:8000/tools/find_devices_by_location \
  -H "Content-Type: application/json" \
  -d '{"latitude": -33.8688, "longitude": 151.2093, "radius_km": 10}'

# Analyze 700-800 MHz spectrum
curl -X POST http://localhost:8000/tools/analyze_spectrum_usage \
  -H "Content-Type: application/json" \
  -d '{"frequency_start": 700, "frequency_end": 800}'
```

## Development

```bash
# Lint and format
ruff check .
ruff format .

# Run tests
pytest tests/ -v

# Type checking
mypy .
```

## Architecture

- **Python 3.11+** with async/await
- **FastAPI** + **Uvicorn** web server
- **SQLite** database with connection pooling
- **WebSocket** transport for MCP protocol
- **ETL pipeline** for data loading and validation

## License

Internal project - ACMA radio licensing data access tool.