"""Spectrum analysis MCP tools."""

from typing import Any

import structlog

logger = structlog.get_logger()


async def analyze_spectrum_usage(
    db_manager,
    frequency_start: float,
    frequency_end: float,
    area_code: str | None = None,
) -> dict[str, Any]:
    """Analyze spectrum usage in frequency range."""

    conditions = ["af.frequency_start <= ?", "af.frequency_end >= ?"]
    params = [frequency_end, frequency_start]

    if area_code:
        conditions.append("la.area_code = ?")
        params.append(area_code)

    where_clause = "WHERE " + " AND ".join(conditions)

    # Get spectrum usage data
    spectrum_query = f"""
        SELECT
            af.licence_no,
            af.frequency_start,
            af.frequency_end,
            l.licence_type_name,
            l.status,
            c.licencee,
            COUNT(DISTINCT d.device_id) as device_count
        FROM auth_spectrum_freq af
        LEFT JOIN licence l ON af.licence_no = l.licence_no
        LEFT JOIN client c ON l.client_no = c.client_no
        LEFT JOIN device_details d ON af.licence_no = d.licence_no
        {where_clause}
        GROUP BY af.licence_no, af.frequency_start, af.frequency_end
        ORDER BY af.frequency_start
    """

    spectrum_data = await db_manager.execute_query(spectrum_query, tuple(params))

    # Analyze for conflicts and utilization
    total_licenses = len(spectrum_data)
    conflict_count = 0
    utilization_percentage = 0.0

    if total_licenses > 0:
        # Simple conflict detection (overlapping frequencies)
        for i, record1 in enumerate(spectrum_data):
            for record2 in spectrum_data[i + 1 :]:
                if (
                    record1["frequency_start"] <= record2["frequency_end"]
                    and record1["frequency_end"] >= record2["frequency_start"]
                ):
                    conflict_count += 1
                    break

        # Calculate utilization (simplified)
        total_bandwidth = frequency_end - frequency_start
        used_bandwidth = 0.0

        for record in spectrum_data:
            overlap_start = max(record["frequency_start"], frequency_start)
            overlap_end = min(record["frequency_end"], frequency_end)
            if overlap_end > overlap_start:
                used_bandwidth += overlap_end - overlap_start

        utilization_percentage = min((used_bandwidth / total_bandwidth) * 100, 100.0)

    # Generate recommendations
    recommendations = []
    if conflict_count > 0:
        recommendations.append(f"Found {conflict_count} potential frequency conflicts")
    if utilization_percentage > 80:
        recommendations.append(
            "High spectrum utilization - consider frequency re-allocation"
        )
    elif utilization_percentage < 20:
        recommendations.append(
            "Low spectrum utilization - potential for new assignments"
        )

    return {
        "frequency_range": {
            "start": frequency_start,
            "end": frequency_end,
            "bandwidth_mhz": frequency_end - frequency_start,
        },
        "total_licenses": total_licenses,
        "conflict_count": conflict_count,
        "utilization_percentage": round(utilization_percentage, 2),
        "licenses": spectrum_data,
        "recommendations": recommendations,
    }


async def compliance_check(
    db_manager, licence_no: str, check_types: list[str] = None
) -> dict[str, Any]:
    """Perform compliance checks on a license."""

    if check_types is None:
        check_types = ["frequency", "power", "location"]

    # Get license details
    licence_query = """
        SELECT l.*, c.licencee, c.trading_name
        FROM licence l
        LEFT JOIN client c ON l.client_no = c.client_no
        WHERE l.licence_no = ?
    """
    licence_result = await db_manager.execute_query(licence_query, (licence_no,))

    if not licence_result:
        return {"error": "License not found"}

    licence_info = licence_result[0]
    compliance_results = {}

    # Frequency compliance check
    if "frequency" in check_types:
        freq_query = """
            SELECT af.*, d.frequency as device_freq, d.power, d.antenna_type
            FROM auth_spectrum_freq af
            LEFT JOIN device_details d ON af.licence_no = d.licence_no
            WHERE af.licence_no = ?
        """
        freq_data = await db_manager.execute_query(freq_query, (licence_no,))

        freq_issues = []
        for record in freq_data:
            if record["device_freq"]:
                if (
                    record["device_freq"] < record["frequency_start"]
                    or record["device_freq"] > record["frequency_end"]
                ):
                    freq_issues.append(
                        {
                            "device_id": record["device_id"],
                            "issue": "Device frequency outside authorized range",
                            "device_freq": record["device_freq"],
                            "authorized_range": f"{record['frequency_start']}-{record['frequency_end']}",
                        }
                    )

        compliance_results["frequency"] = {
            "compliant": len(freq_issues) == 0,
            "issues": freq_issues,
            "devices_checked": len(freq_data),
        }

    # Power compliance check
    if "power" in check_types:
        power_query = """
            SELECT device_id, power, antenna_type
            FROM device_details
            WHERE licence_no = ? AND power IS NOT NULL
        """
        power_data = await db_manager.execute_query(power_query, (licence_no,))

        power_issues = []
        for record in power_data:
            # Simple power check (would need actual limits based on service type)
            if record["power"] and record["power"] > 1000:  # 1W limit as example
                power_issues.append(
                    {
                        "device_id": record["device_id"],
                        "issue": "Power exceeds typical limits",
                        "power_watts": record["power"],
                    }
                )

        compliance_results["power"] = {
            "compliant": len(power_issues) == 0,
            "issues": power_issues,
            "devices_checked": len(power_data),
        }

    # Location compliance check
    if "location" in check_types:
        location_query = """
            SELECT d.device_id, d.site_id, s.latitude, s.longitude, s.address
            FROM device_details d
            LEFT JOIN site s ON d.site_id = s.site_id
            WHERE d.licence_no = ?
        """
        location_data = await db_manager.execute_query(location_query, (licence_no,))

        location_issues = []
        for record in location_data:
            if not record["latitude"] or not record["longitude"]:
                location_issues.append(
                    {
                        "device_id": record["device_id"],
                        "site_id": record["site_id"],
                        "issue": "Missing location coordinates",
                    }
                )

        compliance_results["location"] = {
            "compliant": len(location_issues) == 0,
            "issues": location_issues,
            "devices_checked": len(location_data),
        }

    # Overall compliance
    all_compliant = all(result["compliant"] for result in compliance_results.values())

    return {
        "licence_no": licence_no,
        "licence_info": licence_info,
        "overall_compliant": all_compliant,
        "checks_performed": list(compliance_results.keys()),
        "compliance_results": compliance_results,
        "total_issues": sum(
            len(result["issues"]) for result in compliance_results.values()
        ),
    }


def register_spectrum_tools(registry):
    """Register spectrum tools with the registry."""
    registry.register_tool(
        "analyze_spectrum_usage",
        analyze_spectrum_usage,
        {
            "description": "Analyze spectrum usage in frequency range",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "frequency_start": {
                        "type": "number",
                        "description": "Start frequency in MHz",
                    },
                    "frequency_end": {
                        "type": "number",
                        "description": "End frequency in MHz",
                    },
                    "area_code": {
                        "type": "string",
                        "description": "Filter by area code (optional)",
                    },
                },
                "required": ["frequency_start", "frequency_end"],
            },
        },
    )

    registry.register_tool(
        "compliance_check",
        compliance_check,
        {
            "description": "Perform compliance checks on a license",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "licence_no": {"type": "string", "description": "License number"},
                    "check_types": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Types of checks to perform",
                        "default": ["frequency", "power", "location"],
                    },
                },
                "required": ["licence_no"],
            },
        },
    )
