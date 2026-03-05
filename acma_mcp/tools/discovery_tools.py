"""Discovery and schema-related MCP tools."""

from typing import Any
import structlog

logger = structlog.get_logger()

async def get_schema_info(db_manager) -> dict[str, Any]:
    """Get schema information for core tables to understand searchable columns.
    
    Returns:
        Dictionary mapping table names to their column definitions.
    """
    tables = ["licence", "client", "site", "device_details", "auth_spectrum_freq"]
    schema_info = {}
    
    for table in tables:
        query = f"PRAGMA table_info({table})"
        columns = await db_manager.execute_query(query)
        schema_info[table] = [
            {
                "name": col["name"],
                "type": col["type"],
                "notnull": bool(col["notnull"]),
                "pk": bool(col["pk"])
            }
            for col in columns
        ]
    
    return {"schema": schema_info}

async def get_field_values(
    db_manager, table: str, field: str, limit: int = 20
) -> dict[str, Any]:
    """Get unique values for a specific field in a table.
    
    Args:
        table: Table name (e.g., 'licence')
        field: Field name (e.g., 'licence_type_name')
        limit: Maximum number of values to return
    """
    # Validation to prevent SQL injection for table/field names
    valid_tables = ["licence", "client", "site", "device_details"]
    if table not in valid_tables:
        return {"error": f"Invalid table: {table}. Must be one of {valid_tables}"}
    
    # We can't easily validate fields without fetching schema first, 
    # but we can at least check if it's alphanumeric and underscore
    if not all(c.isalnum() or c == '_' for c in field):
         return {"error": f"Invalid field name: {field}"}

    query = f"SELECT DISTINCT {field} FROM {table} WHERE {field} IS NOT NULL LIMIT ?"
    try:
        results = await db_manager.execute_query(query, (limit,))
        values = [row[field] for row in results]
        return {
            "table": table,
            "field": field,
            "values": values,
            "count": len(values)
        }
    except Exception as e:
        logger.error("Failed to get field values", table=table, field=field, error=str(e))
        return {"error": f"Failed to retrieve values: {str(e)}"}

def register_discovery_tools(registry):
    """Register discovery tools with the registry."""
    registry.register_tool(
        "get_schema_info",
        get_schema_info,
        {
            "description": "Returns the database schema for core tables (licence, client, site, device_details) to help identify searchable columns.",
            "inputSchema": {
                "type": "object",
                "properties": {},
            },
        },
    )

    registry.register_tool(
        "get_field_values",
        get_field_values,
        {
            "description": "Returns unique values for a specific field in a table. Useful for discovering valid filter values (e.g., license types, statuses).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "table": {
                        "type": "string", 
                        "description": "Table name (licence, client, site, device_details)",
                        "enum": ["licence", "client", "site", "device_details"]
                    },
                    "field": {
                        "type": "string", 
                        "description": "Field name to get unique values for"
                    },
                    "limit": {
                        "type": "integer", 
                        "default": 20,
                        "description": "Maximum number of values to return"
                    },
                },
                "required": ["table", "field"],
            },
        },
    )
