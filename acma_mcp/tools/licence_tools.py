"""Licence-related MCP tools."""

from typing import Any

import structlog

logger = structlog.get_logger()


async def search_licences(
    db_manager,
    licence_no: str | None = None,
    licencee: str | None = None,
    licence_type: str | None = None,
    status: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """Search radio licenses with various filters."""

    # Build query conditions
    conditions = []
    params = []

    if licence_no:
        conditions.append("l.licence_no LIKE ?")
        params.append(f"%{licence_no}%")

    if licencee:
        conditions.append("c.licencee LIKE ?")
        params.append(f"%{licencee}%")

    if licence_type:
        conditions.append("l.licence_type_name LIKE ?")
        params.append(f"%{licence_type}%")

    if status:
        conditions.append("l.status = ?")
        params.append(status)

    if date_from:
        conditions.append("l.date_issued >= ?")
        params.append(date_from)

    if date_to:
        conditions.append("l.date_issued <= ?")
        params.append(date_to)

    where_clause = "WHERE " + " AND ".join(conditions) if conditions else ""

    query = f"""
        SELECT
            l.licence_no,
            l.client_no,
            c.licencee,
            c.trading_name,
            c.abn,
            c.acn,
            l.licence_type_name,
            l.licence_category_name,
            l.status,
            l.date_issued,
            l.date_of_expiry,
            COUNT(DISTINCT d.device_id) as device_count
        FROM licence l
        LEFT JOIN client c ON l.client_no = c.client_no
        LEFT JOIN device_details d ON l.licence_no = d.licence_no
        {where_clause}
        GROUP BY l.licence_no
        ORDER BY l.licence_no
        LIMIT ? OFFSET ?
    """

    params.extend([limit, offset])

    results = await db_manager.execute_query(query, tuple(params))

    # Get total count
    count_query = f"""
        SELECT COUNT(DISTINCT l.licence_no) as total
        FROM licence l
        LEFT JOIN client c ON l.client_no = c.client_no
        {where_clause}
    """

    count_params = params[:-2]  # Remove limit and offset
    count_result = await db_manager.execute_query(count_query, tuple(count_params))
    total = count_result[0]["total"] if count_result else 0

    return {"licences": results, "total": total, "limit": limit, "offset": offset}


def register_licence_tools(registry):
    """Register licence tools with the registry."""
    registry.register_tool(
        "search_licences",
        search_licences,
        {
            "description": "Search radio licenses with various filters",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "licence_no": {
                        "type": "string",
                        "description": "License number (partial match)",
                    },
                    "licencee": {
                        "type": "string",
                        "description": "Licensee name (partial match)",
                    },
                    "licence_type": {
                        "type": "string",
                        "description": "License type (partial match)",
                    },
                    "status": {"type": "string", "description": "License status"},
                    "date_from": {
                        "type": "string",
                        "description": "Start date (YYYY-MM-DD)",
                    },
                    "date_to": {
                        "type": "string",
                        "description": "End date (YYYY-MM-DD)",
                    },
                    "limit": {
                        "type": "integer",
                        "default": 100,
                        "description": "Maximum results",
                    },
                    "offset": {
                        "type": "integer",
                        "default": 0,
                        "description": "Results offset",
                    },
                },
            },
        },
    )
