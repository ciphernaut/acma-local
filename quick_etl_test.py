"""Quick ETL test with sample data."""

import asyncio
import csv

from acma_mcp.database.connection import DatabaseManager


async def quick_etl_test():
    """Load a small sample of real ACMA data."""
    db_manager = DatabaseManager("./data/acma_sample_licences.db")
    await db_manager.initialize()

    async with db_manager.get_connection() as conn:
        # Load sample clients (first 100)
        clients = []
        with open("spectra/client.csv", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for i, row in enumerate(reader):
                if i >= 100:  # Only first 100 clients
                    break
                if row["CLIENT_NO"]:
                    clients.append(
                        {
                            "client_no": int(row["CLIENT_NO"]),
                            "licencee": row["LICENCEE"] or "",
                            "trading_name": row["TRADING_NAME"] or "",
                            "address": f"{row.get('POSTAL_STREET', '')} {row.get('POSTAL_SUBURB', '')} {row.get('POSTAL_STATE', '')}",
                        }
                    )

        await conn.executemany(
            """
            INSERT OR REPLACE INTO client (client_no, licencee, trading_name, address)
            VALUES (?, ?, ?, ?)
        """,
            [
                (c["client_no"], c["licencee"], c["trading_name"], c["address"])
                for c in clients
            ],
        )

        # Load sample sites (first 100)
        sites = []
        with open("spectra/site.csv", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for i, row in enumerate(reader):
                if i >= 100:  # Only first 100 sites
                    break
                if row["SITE_ID"] and row["LATITUDE"] and row["LONGITUDE"]:
                    sites.append(
                        {
                            "site_id": row["SITE_ID"],
                            "latitude": float(row["LATITUDE"]),
                            "longitude": float(row["LONGITUDE"]),
                            "address": row["NAME"] or "",
                        }
                    )

        await conn.executemany(
            """
            INSERT OR REPLACE INTO site (site_id, latitude, longitude, address)
            VALUES (?, ?, ?, ?)
        """,
            [
                (s["site_id"], s["latitude"], s["longitude"], s["address"])
                for s in sites
            ],
        )

        # Load sample licences (first 100)
        licences = []
        client_set = {c["client_no"] for c in clients}

        with open("spectra/licence.csv", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for i, row in enumerate(reader):
                if i >= 100:  # Only first 100 licences
                    break
                if row["CLIENT_NO"] and int(row["CLIENT_NO"]) in client_set:
                    licences.append(
                        {
                            "licence_no": row["LICENCE_NO"] or "",
                            "client_no": int(row["CLIENT_NO"]),
                            "licence_type_name": row["LICENCE_TYPE_NAME"] or "",
                            "licence_category_name": row["LICENCE_CATEGORY_NAME"] or "",
                            "status": row["STATUS_TEXT"] or row["STATUS"] or "",
                            "date_issued": row["DATE_ISSUED"] or "",
                            "date_of_expiry": row["DATE_OF_EXPIRY"] or "",
                        }
                    )

        await conn.executemany(
            """
            INSERT OR REPLACE INTO licence
            (licence_no, client_no, licence_type_name, licence_category_name, status, date_issued, date_of_expiry)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
            [
                (
                    licence["licence_no"],
                    licence["client_no"],
                    licence["licence_type_name"],
                    licence["licence_category_name"],
                    licence["status"],
                    licence["date_issued"],
                    licence["date_of_expiry"],
                )
                for licence in licences
            ],
        )

        # Load sample devices (first 100)
        devices = []
        licence_set = {licence["licence_no"] for licence in licences}
        site_set = {s["site_id"] for s in sites}

        with open("spectra/device_details.csv", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for i, row in enumerate(reader):
                if i >= 100:  # Only first 100 devices
                    break
                if (
                    row["LICENCE_NO"] in licence_set
                    and row["SITE_ID"] in site_set
                    and row["FREQUENCY"]
                ):
                    devices.append(
                        {
                            "device_id": row["SDD_ID"] or "",
                            "licence_no": row["LICENCE_NO"] or "",
                            "site_id": row["SITE_ID"] or "",
                            "frequency": float(row["FREQUENCY"])
                            / 1_000_000,  # Convert Hz to MHz
                            "bandwidth": None,  # Skip for now
                            "power": float(row["TRANSMITTER_POWER"])
                            if row["TRANSMITTER_POWER_UNIT"] == "W"
                            else None,
                            "antenna_type": row["DEVICE_TYPE"] or "",
                        }
                    )

        await conn.executemany(
            """
            INSERT OR REPLACE INTO device_details
            (device_id, licence_no, site_id, frequency, bandwidth, power, antenna_type)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
            [
                (
                    d["device_id"],
                    d["licence_no"],
                    d["site_id"],
                    d["frequency"],
                    d["bandwidth"],
                    d["power"],
                    d["antenna_type"],
                )
                for d in devices
            ],
        )

        await conn.commit()

    print(
        f"Loaded {len(clients)} clients, {len(sites)} sites, {len(licences)} licences, {len(devices)} devices"
    )

    # Test a query
    results = await db_manager.execute_query("SELECT COUNT(*) as count FROM licence")
    print(f"Total licences in database: {results[0]['count']}")

    await db_manager.close()


if __name__ == "__main__":
    asyncio.run(quick_etl_test())
