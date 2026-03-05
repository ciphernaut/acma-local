import asyncio
import sys
import os

# Add project root to path
sys.path.append(os.getcwd())

from acma_mcp.tools.registry import ToolRegistry
from acma_mcp.database.connection import DatabaseManager
from acma_mcp.config import settings

async def test_validation():
    db_manager = DatabaseManager(settings.database_path)
    await db_manager.initialize()
    registry = ToolRegistry(db_manager)
    await registry.initialize()

    print("Test 1: Valid tool call")
    try:
        # Search for Telstra
        result = await registry.execute_tool("search_licences", {"licencee": "Telstra", "limit": 1})
        print("Success")
    except Exception as e:
        print(f"Failed: {e}")

    print("\nTest 2: Tool call with 'kwargs' wrapper (the failing case)")
    try:
        await registry.execute_tool("find_devices_by_location", {"kwargs": {"location": "4563", "radius": "10"}})
        print("Success (Unexpected)")
    except Exception as e:
        print(f"Verified expected failure: {e}")

    print("\nTest 3: Missing required arguments")
    try:
        await registry.execute_tool("find_devices_by_location", {"latitude": -33.86})
        print("Success (Unexpected)")
    except Exception as e:
        print(f"Verified expected failure: {e}")

    await db_manager.close()

if __name__ == "__main__":
    asyncio.run(test_validation())
