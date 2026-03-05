"""Setup test data for Noosa area."""

import asyncio

from acma_mcp.database.connection import DatabaseManager

# Noosa coordinates
NOOSA_LAT = -26.4167
NOOSA_LON = 153.0833


async def setup_test_data():
    """Insert test data for Noosa area."""
    db_manager = DatabaseManager("./data/acma_licences.db")
    await db_manager.initialize()

    async with db_manager.get_connection() as conn:
        # Insert test clients
        await conn.executemany(
            """
            INSERT OR REPLACE INTO client (client_no, licencee, trading_name, address)
            VALUES (?, ?, ?, ?)
        """,
            [
                (1001, "Noosa Radio Services", "Noosa Radio", "Noosa Heads QLD"),
                (1002, "Sunshine Coast Broadcasting", "SunCoast FM", "Noosaville QLD"),
                (1003, "Coastal Communications", "CoastCom", "Peregian Beach QLD"),
            ],
        )

        # Insert test sites around Noosa
        await conn.executemany(
            """
            INSERT OR REPLACE INTO site (site_id, latitude, longitude, address)
            VALUES (?, ?, ?, ?)
        """,
            [
                ("NOOSA_001", NOOSA_LAT, NOOSA_LON, "Noosa Main Tower"),
                ("NOOSA_002", -26.4500, 153.1000, "Noosa Junction"),
                ("NOOSA_003", -26.3800, 153.0500, "Sunshine Beach"),
                ("NOOSA_004", -26.5000, 153.1200, "Peregian Springs"),
            ],
        )

        # Insert test licences
        await conn.executemany(
            """
            INSERT OR REPLACE INTO licence
            (licence_no, client_no, licence_type_name, licence_category_name, status, date_issued, date_of_expiry)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
            [
                (
                    "L2024/001",
                    1001,
                    "Broadcasting Licence",
                    "Radio Broadcasting",
                    "Current",
                    "2024-01-15",
                    "2025-01-14",
                ),
                (
                    "L2024/002",
                    1002,
                    "Broadcasting Licence",
                    "Radio Broadcasting",
                    "Current",
                    "2024-02-01",
                    "2025-01-31",
                ),
                (
                    "L2024/003",
                    1003,
                    "Apparatus Licence",
                    "Mobile Communications",
                    "Current",
                    "2024-03-10",
                    "2025-03-09",
                ),
                (
                    "L2024/004",
                    1001,
                    "Apparatus Licence",
                    "Fixed Communications",
                    "Expired",
                    "2023-01-01",
                    "2024-01-01",
                ),
            ],
        )

        # Insert test devices
        await conn.executemany(
            """
            INSERT OR REPLACE INTO device_details
            (device_id, licence_no, site_id, frequency, bandwidth, power, antenna_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
            [
                ("DEV001", "L2024/001", "NOOSA_001", 101.7, 0.2, 50.0, "Directional"),
                ("DEV002", "L2024/001", "NOOSA_002", 101.7, 0.2, 25.0, "Omni"),
                ("DEV003", "L2024/002", "NOOSA_003", 91.9, 0.2, 100.0, "Directional"),
                ("DEV004", "L2024/003", "NOOSA_004", 450.0, 5.0, 10.0, "Yagi"),
                ("DEV005", "L2024/003", "NOOSA_001", 460.0, 5.0, 10.0, "Omni"),
            ],
        )

        # Insert spectrum authorizations
        await conn.executemany(
            """
            INSERT OR REPLACE INTO auth_spectrum_freq
            (licence_no, frequency_start, frequency_end)
            VALUES (?, ?, ?)
        """,
            [
                ("L2024/001", 101.6, 101.8),
                ("L2024/002", 91.8, 92.0),
                ("L2024/003", 440.0, 470.0),
                ("L2024/004", 100.0, 110.0),
            ],
        )

        await conn.commit()

    print("Test data setup complete!")

    # Verify data
    licences = await db_manager.execute_query("SELECT COUNT(*) as count FROM licence")
    devices = await db_manager.execute_query(
        "SELECT COUNT(*) as count FROM device_details"
    )
    sites = await db_manager.execute_query("SELECT COUNT(*) as count FROM site")

    print(f"Licences: {licences[0]['count']}")
    print(f"Devices: {devices[0]['count']}")
    print(f"Sites: {sites[0]['count']}")

    await db_manager.close()


if __name__ == "__main__":
    asyncio.run(setup_test_data())
