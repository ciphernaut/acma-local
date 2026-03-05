import asyncio
import os
import sys

# Add project root to path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from acma_mcp.database.connection import DatabaseManager
from acma_mcp.config import settings
from acma_mcp.tools.discovery_tools import get_schema_info, get_field_values
from acma_mcp.tools.device_tools import find_devices_by_postcode, search_sites

async def verify():
    db_manager = DatabaseManager(settings.database_path)
    await db_manager.initialize()
    
    print("--- Verifying Discovery Tools ---")
    schema = await get_schema_info(db_manager)
    print(f"Schema tables: {list(schema['schema'].keys())}")
    
    field_values = await get_field_values(db_manager, "licence", "status", limit=5)
    print(f"Licence statuses: {field_values['values']}")
    
    print("\n--- Verifying Location Search Tools ---")
    postcode_results = await find_devices_by_postcode(db_manager, "4563", limit=5)
    print(f"Devices in 4563: {len(postcode_results['devices'])}")
    if postcode_results['devices']:
        print(f"First device address: {postcode_results['devices'][0]['address']}")
    
    site_results = await search_sites(db_manager, postcode="4563")
    print(f"Sites in 4563: {len(site_results['sites'])}")
    if site_results['sites']:
        print(f"First site: {site_results['sites'][0]['address']} (Lat: {site_results['sites'][0]['latitude']}, Lon: {site_results['sites'][0]['longitude']})")

    await db_manager.close()

if __name__ == "__main__":
    asyncio.run(verify())
