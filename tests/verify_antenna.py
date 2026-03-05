import asyncio
import os
import shutil
from pathlib import Path
from acma_mcp.database.connection import DatabaseManager
from acma_mcp.etl.pipeline import setup_database_from_acma_data
from acma_mcp.tools.device_tools import get_antenna_pattern

async def verify():
    base_dir = Path("/projects/acma-local/tests/temp_verify")
    db_path = base_dir / "test_antenna.db"
    data_path = base_dir / "acma_test_data"
    
    # Clean up previous runs
    if base_dir.exists():
        shutil.rmtree(base_dir)
    base_dir.mkdir(parents=True, exist_ok=True)
    data_path.mkdir(exist_ok=True)
    
    # Create dummy data files
    (data_path / "client.csv").write_text("CLIENT_NO,LICENCEE,TRADING_NAME,ABN,ACN,CAT_ID,CLIENT_TYPE_ID\n1,Test Client,Test Trading,,,,\n")
    (data_path / "site.csv").write_text("SITE_ID,LATITUDE,LONGITUDE,NAME,ELEVATION,POSTCODE,STATE\nS1,-33.0,151.0,Test Site,10,2000,NSW\n")
    (data_path / "licence.csv").write_text("LICENCE_NO,CLIENT_NO,LICENCE_TYPE_NAME,LICENCE_CATEGORY_NAME,STATUS_TEXT,STATUS,DATE_ISSUED,DATE_OF_EXPIRY\nL1,1,Fixed,Category,Current,C,2023-01-01,2024-01-01\n")
    (data_path / "device_details.csv").write_text("SDD_ID,LICENCE_NO,SITE_ID,FREQUENCY,BANDWIDTH,TRANSMITTER_POWER,DEVICE_TYPE,TRANSMITTER_POWER_UNIT,SV_ID,SS_ID,CLASS_OF_STATION_CODE,NATURE_OF_SERVICE_ID,SA_ID,TCS_ID,EQP_ID,RELATED_EFL_ID,AZIMUTH,HEIGHT,TILT\nD1,L1,S1,100000000,10000,10,Antenna,W,1,1,COS,NOS,1,1,1,1,0,10,0\n")
    (data_path / "auth_spectrum_freq.csv").write_text("LICENCE_NO,LW_FREQUENCY_START,LW_FREQUENCY_END\nL1,90000000,110000000\n")
    
    licence_dir = data_path / "licence"
    licence_dir.mkdir(exist_ok=True)
    (licence_dir / "LICENCE_.CSV").write_text("SDD_ID,DEVICE_REGISTRATION_IDENTIFIER,START_ANGLE,STOP_ANGLE,POWER\nD1,REG1,0.0,2.5,21.1\n")

    print("--- Test 1: Initialize without antenna patterns ---")
    await setup_database_from_acma_data(str(data_path), str(db_path), include_antenna_patterns=False)
    
    db_manager = DatabaseManager(str(db_path))
    await db_manager.initialize()
    
    result = await get_antenna_pattern(db_manager, "D1")
    print(f"Result without data: {result}")
    
    # Expecting error message about not being included
    assert "not included" in result.get("error", "").lower()
    await db_manager.close()

    print("\n--- Test 2: Initialize with antenna patterns ---")
    if db_path.exists():
        db_path.unlink()
    
    await setup_database_from_acma_data(str(data_path), str(db_path), include_antenna_patterns=True)
    await db_manager.initialize()
    
    result = await get_antenna_pattern(db_manager, "D1")
    print(f"Result with data: {result}")
    
    # Expecting data
    assert result.get("device_id") == "D1"
    assert result.get("total_points") == 1
    
    print("\n--- Test 3: Schema Discovery ---")
    from acma_mcp.tools.discovery_tools import get_schema_info, get_field_values
    
    schema_info = await get_schema_info(db_manager)
    print(f"Tables in schema: {list(schema_info['schema'].keys())}")
    assert "antenna_pattern" in schema_info["schema"]
    
    field_values = await get_field_values(db_manager, "antenna_pattern", "device_registration_id")
    print(f"Field values for antenna_pattern: {field_values}")
    assert "REG1" in field_values["values"]
    
    print("\nVerification successful!")
    await db_manager.close()
    
    # Final cleanup
    shutil.rmtree(base_dir)

if __name__ == "__main__":
    asyncio.run(verify())
