"""Device-related MCP tools."""

import math
from typing import Any

import structlog

logger = structlog.get_logger()


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance between two points using Haversine formula."""
    R = 6371  # Earth's radius in kilometers

    lat1_rad = math.radians(lat1)
    lon1_rad = math.radians(lon1)
    lat2_rad = math.radians(lat2)
    lon2_rad = math.radians(lon2)

    dlat = lat2_rad - lat1_rad
    dlon = lon2_rad - lon1_rad

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.asin(math.sqrt(a))

    return R * c


async def find_devices_by_location(
    db_manager,
    latitude: float,
    longitude: float,
    radius_km: float,
    device_type: str | None = None,
) -> dict[str, Any]:
    """Find devices within geographic area."""

    # First get all sites within the bounding box for efficiency
    lat_delta = radius_km / 111.0  # Approximate km per degree latitude
    lon_delta = radius_km / (111.0 * math.cos(math.radians(latitude)))

    conditions = [
        "s.latitude BETWEEN ? AND ?",
        "s.longitude BETWEEN ? AND ?",
        "d.licence_no IS NOT NULL",
    ]
    params = [
        latitude - lat_delta,
        latitude + lat_delta,
        longitude - lon_delta,
        longitude + lon_delta,
    ]

    if device_type:
        conditions.append("d.antenna_type LIKE ?")
        params.append(f"%{device_type}%")

    where_clause = "WHERE " + " AND ".join(conditions)

    query = f"""
        SELECT
            d.device_id,
            d.licence_no,
            d.frequency,
            d.bandwidth,
            d.power,
            d.antenna_type,
            d.site_id,
            s.latitude,
            s.longitude,
            s.address,
            l.licence_type_name,
            c.licencee
        FROM device_details d
        LEFT JOIN site s ON d.site_id = s.site_id
        LEFT JOIN licence l ON d.licence_no = l.licence_no
        LEFT JOIN client c ON l.client_no = c.client_no
        {where_clause}
    """

    results = await db_manager.execute_query(query, tuple(params))

    # Filter by exact distance using Haversine formula
    devices_within_radius = []
    for device in results:
        if device["latitude"] and device["longitude"]:
            distance = haversine_distance(
                latitude, longitude, device["latitude"], device["longitude"]
            )
            if distance <= radius_km:
                device["distance_km"] = round(distance, 2)
                devices_within_radius.append(device)

    # Sort by distance
    devices_within_radius.sort(key=lambda x: x["distance_km"])

    return {
        "devices": devices_within_radius,
        "total_found": len(devices_within_radius),
        "search_center": {"latitude": latitude, "longitude": longitude},
        "radius_km": radius_km,
    }


async def find_devices_by_postcode(
    db_manager, postcode: str, limit: int = 100
) -> dict[str, Any]:
    """Find devices at sites matching a specific postcode.
    
    Args:
        postcode: Australian postcode (e.g., '4563')
        limit: Maximum results to return
    """
    query = """
        SELECT
            d.device_id,
            d.licence_no,
            d.frequency,
            d.bandwidth,
            d.power,
            d.antenna_type,
            d.site_id,
            s.latitude,
            s.longitude,
            s.address,
            l.licence_type_name,
            c.licencee
        FROM device_details d
        LEFT JOIN site s ON d.site_id = s.site_id
        LEFT JOIN licence l ON d.licence_no = l.licence_no
        LEFT JOIN client c ON l.client_no = c.client_no
        WHERE s.address LIKE ?
        LIMIT ?
    """
    params = (f"%{postcode}%", limit)
    results = await db_manager.execute_query(query, params)
    
    return {
        "postcode": postcode,
        "devices": results,
        "total_found": len(results),
        "limit": limit
    }


async def search_sites(
    db_manager, 
    query: str | None = None, 
    postcode: str | None = None, 
    suburb: str | None = None, 
    limit: int = 100
) -> dict[str, Any]:
    """Search for sites by address, postcode, or suburb.
    
    Args:
        query: Generic address search string
        postcode: Specific postcode to filter by
        suburb: Specific suburb to filter by
        limit: Maximum results to return
    """
    conditions = []
    params = []
    
    if postcode:
        conditions.append("address LIKE ?")
        params.append(f"%{postcode}%")
    if suburb:
        conditions.append("address LIKE ?")
        params.append(f"%{suburb}%")
    if query:
        conditions.append("address LIKE ?")
        params.append(f"%{query}%")
        
    where_clause = "WHERE " + " AND ".join(conditions) if conditions else ""
    
    sql = f"""
        SELECT site_id, latitude, longitude, address 
        FROM site 
        {where_clause} 
        LIMIT ?
    """
    params.append(limit)
    
    results = await db_manager.execute_query(sql, tuple(params))
    
    return {
        "sites": results,
        "total_found": len(results),
        "limit": limit
    }


async def get_site_details(
    db_manager, site_id: str, include_devices: bool = True
) -> dict[str, Any]:
    """Get detailed information about a specific site."""

    # Get site information
    site_query = "SELECT * FROM site WHERE site_id = ?"
    site_result = await db_manager.execute_query(site_query, (site_id,))
    site_info = site_result[0] if site_result else None

    if not site_info:
        return {"error": "Site not found"}

    result = {"site": site_info}

    if include_devices:
        # Get devices at this site
        devices_query = """
            SELECT
                d.*,
                l.licence_type_name,
                l.status as licence_status,
                c.licencee
            FROM device_details d
            LEFT JOIN licence l ON d.licence_no = l.licence_no
            LEFT JOIN client c ON l.client_no = c.client_no
            WHERE d.site_id = ?
        """
        devices = await db_manager.execute_query(devices_query, (site_id,))
        result["devices"] = devices
        result["device_count"] = len(devices)

    return result


def register_device_tools(registry):
    """Register device tools with the registry."""
    registry.register_tool(
        "find_devices_by_location",
        find_devices_by_location,
        {
            "description": "Find devices within specified radius of a location (REQUIRES coordinates). Use search_sites first if you only have a postcode or suburb.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "latitude": {"type": "number", "description": "Center latitude"},
                    "longitude": {"type": "number", "description": "Center longitude"},
                    "radius_km": {
                        "type": "number",
                        "description": "Search radius in kilometers",
                    },
                    "device_type": {
                        "type": "string",
                        "description": "Filter by device type (optional)",
                    },
                },
                "required": ["latitude", "longitude", "radius_km"],
            },
        },
    )

    registry.register_tool(
        "find_devices_by_postcode",
        find_devices_by_postcode,
        {
            "description": "Find devices at sites matching a specific Australian postcode.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "postcode": {"type": "string", "description": "Postcode (e.g., '4563')"},
                    "limit": {"type": "integer", "default": 100, "description": "Maximum results"},
                },
                "required": ["postcode"],
            },
        },
    )

    registry.register_tool(
        "search_sites",
        search_sites,
        {
            "description": "Search for radio sites by address, postcode, or suburb. Useful for finding coordinates of a location.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Generic search string (e.g., street name)"},
                    "postcode": {"type": "string", "description": "Postcode (e.g., '4563')"},
                    "suburb": {"type": "string", "description": "Suburb name"},
                    "limit": {"type": "integer", "default": 100, "description": "Maximum results"},
                },
            },
        },
    )

    registry.register_tool(
        "get_site_details",
        get_site_details,
        {
            "description": "Get detailed information about a specific site",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "site_id": {"type": "string", "description": "Site ID"},
                    "include_devices": {
                        "type": "boolean",
                        "default": True,
                        "description": "Include devices at site",
                    },
                },
                "required": ["site_id"],
            },
        },
    )
