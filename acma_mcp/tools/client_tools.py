"""Client-related MCP tools."""

from typing import Any

import structlog

logger = structlog.get_logger()


async def get_client_licences(
    db_manager, client_no: int, include_expired: bool = False
) -> dict[str, Any]:
    """Get all licenses for a specific client."""

    conditions = ["l.client_no = ?"]
    params = [client_no]

    if not include_expired:
        conditions.append(
            "(l.date_of_expiry > date('now') OR l.date_of_expiry IS NULL)"
        )

    where_clause = "WHERE " + " AND ".join(conditions)

    query = f"""
        SELECT
            l.licence_no,
            l.licence_type_name,
            l.licence_category_name,
            l.status,
            l.date_issued,
            l.date_of_expiry,
            COUNT(DISTINCT d.device_id) as device_count,
            COUNT(DISTINCT d.site_id) as site_count
        FROM licence l
        LEFT JOIN device_details d ON l.licence_no = d.licence_no
        {where_clause}
        GROUP BY l.licence_no
        ORDER BY l.date_issued DESC
    """

    licences = await db_manager.execute_query(query, tuple(params))

    # Get client details
    client_query = "SELECT * FROM client WHERE client_no = ?"
    client_result = await db_manager.execute_query(client_query, (client_no,))
    client_info = client_result[0] if client_result else None

    return {
        "client": client_info,
        "licences": licences,
        "total_licences": len(licences),
    }


def register_client_tools(registry):
    """Register client tools with the registry."""
    registry.register_tool(
        "get_client_licences",
        get_client_licences,
        {
            "description": "Get all licenses for a specific client",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "client_no": {"type": "integer", "description": "Client number"},
                    "include_expired": {
                        "type": "boolean",
                        "default": False,
                        "description": "Include expired licenses",
                    },
                },
                "required": ["client_no"],
            },
        },
    )
