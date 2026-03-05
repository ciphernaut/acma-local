"""ETL pipeline for processing ACMA data from CSV files."""

import asyncio
import csv
from pathlib import Path
from typing import Any

import structlog

from ..database.connection import DatabaseManager

logger = structlog.get_logger()


class ACMETLPipeline:
    """ETL pipeline for ACMA radio licensing data."""

    def __init__(self, data_source_path: str, db_path: str, include_antenna_patterns: bool = False):
        """Initialize ETL pipeline.

        Args:
            data_source_path: Path to ACMA data directory
            db_path: Path to SQLite database
            include_antenna_patterns: Whether to process antenna pattern data
        """
        self.data_source_path = Path(data_source_path)
        self.db_path = Path(db_path)
        self.include_antenna_patterns = include_antenna_patterns
        self.db_manager = DatabaseManager(str(db_path))

    async def run_etl(self) -> None:
        """Execute the complete ETL process."""
        logger.info("Starting ACMA ETL pipeline")

        # Initialize database
        await self.db_manager.initialize()

        try:
            # Process each data file
            await self._process_clients()
            await self._process_sites()
            await self._process_licences()
            await self._process_device_details()
            await self._process_auth_spectrum_freq()

            # Process antenna patterns if requested
            if getattr(self, "include_antenna_patterns", False):
                await self._process_antenna_patterns()

            logger.info("ETL pipeline completed successfully")

        except Exception as e:
            logger.error("ETL pipeline failed", error=str(e))
            raise
        finally:
            await self.db_manager.close()

    async def _process_clients(self) -> None:
        """Process client.csv file."""
        logger.info("Processing clients")

        client_file = self.data_source_path / "client.csv"
        if not client_file.exists():
            logger.warning("Client file not found", path=str(client_file))
            return

        clients = []
        with open(client_file, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                clients.append(
                    {
                        "client_no": int(row["CLIENT_NO"])
                        if row["CLIENT_NO"]
                        else None,
                        "licencee": row["LICENCEE"] or "",
                        "trading_name": row["TRADING_NAME"] or "",
                        "address": self._format_address(row),
                        "abn": row.get("ABN") or "",
                        "acn": row.get("ACN") or "",
                        "cat_id": int(row["CAT_ID"]) if row.get("CAT_ID") else None,
                        "client_type_id": int(row["CLIENT_TYPE_ID"])
                        if row.get("CLIENT_TYPE_ID")
                        else None,
                    }
                )

        await self._bulk_insert("client", clients)
        logger.info("Processed clients", count=len(clients))

    async def _process_sites(self) -> None:
        """Process site.csv file."""
        logger.info("Processing sites")

        site_file = self.data_source_path / "site.csv"
        if not site_file.exists():
            logger.warning("Site file not found", path=str(site_file))
            return

        sites = []
        with open(site_file, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                sites.append(
                    {
                        "site_id": row["SITE_ID"] or "",
                        "latitude": float(row["LATITUDE"]) if row["LATITUDE"] else None,
                        "longitude": float(row["LONGITUDE"])
                        if row["LONGITUDE"]
                        else None,
                        "address": row["NAME"] or "",
                        "elevation": float(row["ELEVATION"])
                        if row.get("ELEVATION")
                        else None,
                        "postcode": row.get("POSTCODE") or "",
                        "state": row.get("STATE") or "",
                    }
                )

        await self._bulk_insert("site", sites)
        logger.info("Processed sites", count=len(sites))

    async def _process_licences(self) -> None:
        """Process licence.csv file."""
        logger.info("Processing licences")

        licence_file = self.data_source_path / "licence.csv"
        if not licence_file.exists():
            logger.warning("Licence file not found", path=str(licence_file))
            return

        # Get valid client numbers first
        async with self.db_manager.get_connection() as conn:
            valid_clients = await conn.execute("SELECT DISTINCT client_no FROM client")
            valid_client_set = {row[0] for row in await valid_clients.fetchall()}

        licences = []
        skipped_count = 0

        with open(licence_file, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                # Skip records with missing client_no
                if not row["CLIENT_NO"] or not row["CLIENT_NO"].strip():
                    skipped_count += 1
                    continue

                client_no = int(row["CLIENT_NO"])

                # Skip if client doesn't exist
                if client_no not in valid_client_set:
                    skipped_count += 1
                    continue

                licences.append(
                    {
                        "licence_no": row["LICENCE_NO"] or "",
                        "client_no": client_no,
                        "licence_type_name": row["LICENCE_TYPE_NAME"] or "",
                        "licence_category_name": row["LICENCE_CATEGORY_NAME"] or "",
                        "status": row["STATUS_TEXT"] or row["STATUS"] or "",
                        "date_issued": row["DATE_ISSUED"] or "",
                        "date_of_expiry": row["DATE_OF_EXPIRY"] or "",
                    }
                )

        await self._bulk_insert("licence", licences)
        logger.info("Processed licences", count=len(licences), skipped=skipped_count)

    async def _process_device_details(self) -> None:
        """Process device_details.csv file in batches."""
        logger.info("Processing device details")

        device_file = self.data_source_path / "device_details.csv"
        if not device_file.exists():
            logger.warning("Device details file not found", path=str(device_file))
            return

        # Get valid licence numbers and site IDs first
        async with self.db_manager.get_connection() as conn:
            valid_licences = await conn.execute(
                "SELECT DISTINCT licence_no FROM licence"
            )
            valid_licence_set = {row[0] for row in await valid_licences.fetchall()}

            valid_sites = await conn.execute("SELECT DISTINCT site_id FROM site")
            valid_site_set = {row[0] for row in await valid_sites.fetchall()}

        batch_size = 10000
        devices = []
        processed_count = 0
        skipped_count = 0

        with open(device_file, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                licence_no = row["LICENCE_NO"] or ""
                site_id = row["SITE_ID"] or ""

                # Skip if licence or site doesn't exist
                if licence_no not in valid_licence_set or site_id not in valid_site_set:
                    skipped_count += 1
                    continue

                # Convert frequency from Hz to MHz for consistency
                freq_mhz = None
                if row["FREQUENCY"]:
                    freq_mhz = float(row["FREQUENCY"]) / 1_000_000

                # Convert power to watts if needed
                power_watts = None
                if row["TRANSMITTER_POWER"]:
                    power_watts = float(row["TRANSMITTER_POWER"])
                    if row["TRANSMITTER_POWER_UNIT"] == "W":
                        power_watts = float(row["TRANSMITTER_POWER"])
                    elif row["TRANSMITTER_POWER_UNIT"] == "dBW":
                        power_watts = 10 ** (float(row["TRANSMITTER_POWER"]) / 10)
                    elif row["TRANSMITTER_POWER_UNIT"] == "dBm":
                        power_watts = 10 ** (
                            (float(row["TRANSMITTER_POWER"]) - 30) / 10
                        )

                devices.append(
                    {
                        "device_id": row["SDD_ID"] or "",
                        "licence_no": licence_no,
                        "site_id": site_id,
                        "frequency": freq_mhz,
                        "bandwidth": self._convert_bandwidth(row["BANDWIDTH"]),
                        "power": power_watts,
                        "antenna_type": row["DEVICE_TYPE"] or "",
                        "antenna_id": row.get("ANTENNA_ID") or "",
                        "sv_id": int(row["SV_ID"]) if row.get("SV_ID") else None,
                        "ss_id": int(row["SS_ID"]) if row.get("SS_ID") else None,
                        "class_of_station_code": row.get("CLASS_OF_STATION_CODE") or "",
                        "nature_of_service_id": row.get("NATURE_OF_SERVICE_ID") or "",
                        "sa_id": int(row["SA_ID"]) if row.get("SA_ID") else None,
                        "tcs_id": int(row["TCS_ID"]) if row.get("TCS_ID") else None,
                        "eqp_id": int(row["EQP_ID"]) if row.get("EQP_ID") else None,
                        "related_efl_id": int(row["RELATED_EFL_ID"])
                        if row.get("RELATED_EFL_ID")
                        else None,
                        "azimuth": float(row["AZIMUTH"]) if row.get("AZIMUTH") else None,
                        "height": float(row["HEIGHT"]) if row.get("HEIGHT") else None,
                        "tilt": float(row["TILT"]) if row.get("TILT") else None,
                    }
                )

                # Process in batches
                if len(devices) >= batch_size:
                    await self._bulk_insert("device_details", devices)
                    processed_count += len(devices)
                    devices = []
                    if processed_count % 50000 == 0:
                        logger.info("Processed device details", count=processed_count)

        # Process remaining records
        if devices:
            await self._bulk_insert("device_details", devices)
            processed_count += len(devices)

        logger.info(
            "Processed device details", count=processed_count, skipped=skipped_count
        )

    async def _process_auth_spectrum_freq(self) -> None:
        """Process auth_spectrum_freq.csv file."""
        logger.info("Processing authorized spectrum frequencies")

        spectrum_file = self.data_source_path / "auth_spectrum_freq.csv"
        if not spectrum_file.exists():
            logger.warning("Spectrum file not found", path=str(spectrum_file))
            return

        spectrum_records = []
        with open(spectrum_file, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                # Convert frequencies from Hz to MHz
                freq_start_mhz = None
                freq_end_mhz = None

                if row["LW_FREQUENCY_START"]:
                    freq_start_mhz = float(row["LW_FREQUENCY_START"]) / 1_000_000
                if row["LW_FREQUENCY_END"]:
                    freq_end_mhz = float(row["LW_FREQUENCY_END"]) / 1_000_000

                spectrum_records.append(
                    {
                        "licence_no": row["LICENCE_NO"] or "",
                        "frequency_start": freq_start_mhz,
                        "frequency_end": freq_end_mhz,
                    }
                )

        await self._bulk_insert("auth_spectrum_freq", spectrum_records)
        logger.info("Processed spectrum frequencies", count=len(spectrum_records))

    async def _process_antenna_patterns(self) -> None:
        """Process LICENCE_.CSV file for antenna patterns in batches."""
        logger.info("Processing antenna patterns (HRP data)")

        pattern_file = self.data_source_path / "licence" / "LICENCE_.CSV"
        if not pattern_file.exists():
            # Try flat structure if not in 'licence' subdir
            pattern_file = self.data_source_path / "LICENCE_.CSV"

        if not pattern_file.exists():
            logger.warning("Antenna pattern file not found", path=str(pattern_file))
            return

        # Get valid device IDs (SDD_IDs) first to ensure referential integrity
        async with self.db_manager.get_connection() as conn:
            valid_devices = await conn.execute("SELECT device_id FROM device_details")
            valid_device_set = {row[0] for row in await valid_devices.fetchall()}

        batch_size = 50000
        patterns = []
        processed_count = 0
        skipped_count = 0

        with open(pattern_file, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                device_id = row["SDD_ID"] or ""

                # Skip if device doesn't exist in device_details
                if device_id not in valid_device_set:
                    skipped_count += 1
                    continue

                patterns.append(
                    {
                        "device_id": device_id,
                        "device_registration_id": row.get("DEVICE_REGISTRATION_IDENTIFIER"),
                        "start_angle": float(row["START_ANGLE"])
                        if row.get("START_ANGLE")
                        else None,
                        "stop_angle": float(row["STOP_ANGLE"])
                        if row.get("STOP_ANGLE")
                        else None,
                        "power": float(row["POWER"]) if row.get("POWER") else None,
                    }
                )

                if len(patterns) >= batch_size:
                    await self._bulk_insert("antenna_pattern", patterns)
                    processed_count += len(patterns)
                    patterns = []
                    if processed_count % 500000 == 0:
                        logger.info("Processed antenna patterns", count=processed_count)

        if patterns:
            await self._bulk_insert("antenna_pattern", patterns)
            processed_count += len(patterns)

        logger.info(
            "Processed antenna patterns completed",
            count=processed_count,
            skipped=skipped_count,
        )

    async def _bulk_insert(self, table: str, data: list[dict[str, Any]]) -> None:
        """Bulk insert data into specified table."""
        if not data:
            return

        async with self.db_manager.get_connection() as conn:
            # Get column names from first record
            columns = list(data[0].keys())
            placeholders = ", ".join(["?" for _ in columns])
            columns_str = ", ".join(columns)

            query = f"INSERT OR REPLACE INTO {table} ({columns_str}) VALUES ({placeholders})"

            # Convert data to tuples
            values = []
            for record in data:
                values.append(tuple(record.get(col) for col in columns))

            await conn.executemany(query, values)
            await conn.commit()

    def _format_address(self, row: dict[str, str]) -> str:
        """Format address from CSV row."""
        parts = [
            row.get("POSTAL_STREET", ""),
            row.get("POSTAL_SUBURB", ""),
            row.get("POSTAL_STATE", ""),
            row.get("POSTAL_POSTCODE", ""),
        ]
        return ", ".join(filter(None, parts))

    def _convert_bandwidth(self, bandwidth: str) -> float | None:
        """Convert bandwidth to MHz."""
        if not bandwidth:
            return None

        try:
            # Assume bandwidth is in Hz, convert to MHz
            bw_hz = float(bandwidth)
            return bw_hz / 1_000_000
        except (ValueError, TypeError):
            return None


async def setup_database_from_acma_data(
    data_source_path: str, db_path: str, include_antenna_patterns: bool = False
) -> None:
    """Setup database from ACMA data sources.

    Args:
        data_source_path: Path to ACMA data directory
        db_path: Path to SQLite database
        include_antenna_patterns: Whether to process antenna pattern data
    """
    pipeline = ACMETLPipeline(data_source_path, db_path, include_antenna_patterns)
    await pipeline.run_etl()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="ACMA ETL Pipeline")
    parser.add_argument("data_path", help="Path to ACMA data directory")
    parser.add_argument("db_path", help="Path to SQLite database")
    parser.add_argument(
        "--include-antenna-patterns",
        action="store_true",
        help="Include antenna pattern data (warning: takes a long time and lots of space)",
    )

    args = parser.parse_args()

    asyncio.run(
        setup_database_from_acma_data(
            args.data_path, args.db_path, args.include_antenna_patterns
        )
    )
