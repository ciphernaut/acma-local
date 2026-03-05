import Database from 'better-sqlite3';

export const TABLE_METADATA: Record<string, { ddl: string; post_load_ddl?: string }> = {
    "client": {
        "ddl": `
      CREATE TABLE IF NOT EXISTS client(
        CLIENT_NO INTEGER, LICENCEE TEXT, TRADING_NAME TEXT,
        ACN TEXT, ABN TEXT, POSTAL_STREET TEXT,
        POSTAL_SUBURB TEXT, POSTAL_STATE TEXT,
        POSTAL_POSTCODE TEXT, CAT_ID INTEGER, 
        CLIENT_TYPE_ID INTEGER, FEE_STATUS_ID INTEGER
      );
    `,
        "post_load_ddl": `
      CREATE INDEX IF NOT EXISTS client_client_no ON client(CLIENT_NO);
      CREATE INDEX IF NOT EXISTS client_client_type_idx ON client(CLIENT_TYPE_ID);
      CREATE INDEX IF NOT EXISTS client_client_cat_idx ON client(CAT_ID);
      CREATE INDEX IF NOT EXISTS client_client_fee_idx ON client(FEE_STATUS_ID);
      CREATE INDEX IF NOT EXISTS client_client_licencee_comp_idx ON client(CLIENT_NO, LICENCEE);
    `
    },
    "licence": {
        "ddl": `
      CREATE TABLE IF NOT EXISTS licence(
        LICENCE_NO TEXT, CLIENT_NO INTEGER,
        SV_ID INTEGER, SS_ID INTEGER,
        LICENCE_TYPE_NAME TEXT, LICENCE_CATEGORY_NAME TEXT,
        DATE_ISSUED TEXT, DATE_OF_EFFECT TEXT,
        DATE_OF_EXPIRY TEXT, STATUS TEXT, 
        STATUS_TEXT TEXT, AP_ID INTEGER,
        AP_PRJ_IDENT TEXT, SHIP_NAME TEXT,
        BSL_NO TEXT, AWL_TYPE TEXT
      );
    `,
        "post_load_ddl": `
      CREATE INDEX IF NOT EXISTS licence_licence_no ON licence(LICENCE_NO);
      CREATE INDEX IF NOT EXISTS licence_client_no ON licence(CLIENT_NO);
      CREATE INDEX IF NOT EXISTS licence_sv_idx ON licence(SV_ID);
      CREATE INDEX IF NOT EXISTS licence_bsl_no_idx ON licence(BSL_NO);
      CREATE INDEX IF NOT EXISTS licence_comp1_idx ON licence(SV_ID, SS_ID);
      CREATE INDEX IF NOT EXISTS licence_stats_idx ON licence(STATUS);
    `
    },
    "site": {
        "ddl": `
      CREATE TABLE IF NOT EXISTS site(
        SITE_ID TEXT, LATITUDE REAL, LONGITUDE REAL,
        NAME TEXT, STATE TEXT, LICENSING_AREA_ID INTEGER,
        POSTCODE TEXT, SITE_PRECISION TEXT, ELEVATION INTEGER,
        HCIS_L2 TEXT
      );
    `,
        "post_load_ddl": `
      CREATE INDEX IF NOT EXISTS site_site_id ON site(SITE_ID);
      CREATE INDEX IF NOT EXISTS site_state_idx ON site(STATE);
      CREATE INDEX IF NOT EXISTS site_postcode_idx ON site(POSTCODE);
      CREATE INDEX IF NOT EXISTS site_lic_area_idx ON site(LICENSING_AREA_ID);
    `
    },
    "device_details": {
        "ddl": `
      CREATE TABLE IF NOT EXISTS device_details(
        SDD_ID INTEGER, LICENCE_NO TEXT, DEVICE_REGISTRATION_IDENTIFIER TEXT, 
        FORMER_DEVICE_IDENTIFIER TEXT, AUTHORISATION_DATE TEXT, 
        CERTIFICATION_METHOD TEXT, GROUP_FLAG TEXT, SITE_RADIUS INTEGER, 
        FREQUENCY INTEGER, BANDWIDTH INTEGER, CARRIER_FREQ INTEGER, 
        EMISSION TEXT, DEVICE_TYPE TEXT, TRANSMITTER_POWER REAL, 
        TRANSMITTER_POWER_UNIT TEXT, SITE_ID TEXT, ANTENNA_ID TEXT, 
        POLARISATION TEXT, AZIMUTH REAL, HEIGHT REAL, TILT REAL, 
        FEEDER_LOSS REAL, LEVEL_OF_PROTECTION REAL, EIRP TEXT, 
        EIRP_UNIT TEXT, SV_ID INTEGER, SS_ID INTEGER, EFL_ID INTEGER, 
        EFL_FREQ_IDENT TEXT, EFL_SYSTEM TEXT, LEQD_MODE TEXT, 
        RECEIVER_THRESHOLD REAL, AREA_AREA_ID INTEGER, CALL_SIGN TEXT, 
        AREA_DESCRIPTION TEXT, AP_ID INTEGER, CLASS_OF_STATION_CODE TEXT, 
        SUPPLIMENTAL_FLAG TEXT, EQ_FREQ_RANGE_MIN REAL, EQ_FREQ_RANGE_MAX REAL, 
        NATURE_OF_SERVICE_ID TEXT, HOURS_OF_OPERATION TEXT, SA_ID INTEGER, 
        RELATED_EFL_ID INTEGER, EQP_ID INTEGER, ANTENNA_MULTI_MODE TEXT, 
        POWER_IND TEXT, LPON_CENTER_LONGITUDE REAL, LPON_CENTER_LATITUDE REAL, 
        TCS_ID INTEGER, TECH_SPEC_ID TEXT, DROPTHROUGH_ID TEXT, 
        STATION_TYPE TEXT, STATION_NAME TEXT
      );
    `,
        "post_load_ddl": `
      CREATE INDEX IF NOT EXISTS device_details_sdd_idx ON device_details(SDD_ID);
      CREATE INDEX IF NOT EXISTS device_details_site_idx ON device_details(SITE_ID);
      CREATE INDEX IF NOT EXISTS device_details_antenna_idx ON device_details(ANTENNA_ID);
      CREATE INDEX IF NOT EXISTS device_details_licence_no_idx ON device_details(LICENCE_NO);
      CREATE INDEX IF NOT EXISTS device_details_efl_idx ON device_details(EFL_ID);
    `
    },
    "antenna": {
        "ddl": `
      CREATE TABLE IF NOT EXISTS antenna(
        ANTENNA_ID TEXT, GAIN TEXT, FRONT_TO_BACK TEXT,
        H_BEAMWIDTH TEXT, V_BEAMWIDTH TEXT, BAND_MIN_FREQ REAL,
        BAND_MIN_FREQ_UNIT TEXT, BAND_MAX_FREQ REAL,
        BAND_MAX_FREQ_UNIT TEXT, ANTENNA_SIZE REAL, 
        ANTENNA_TYPE TEXT, MODEL TEXT, MANUFACTURER TEXT
      );
    `,
        "post_load_ddl": `
      CREATE INDEX IF NOT EXISTS antenna_antenna_id ON antenna(ANTENNA_ID);
    `
    },
    "meta": {
        "ddl": `
      CREATE TABLE IF NOT EXISTS meta(
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `
    }
};

export function initializeDatabase(dbPath: string) {
    const db = new Database(dbPath);

    // Wrap in a transaction for performance/atomicity
    db.transaction(() => {
        for (const table of Object.values(TABLE_METADATA)) {
            db.exec(table.ddl);
            if (table.post_load_ddl) {
                db.exec(table.post_load_ddl);
            }
        }
    })();

    db.close();
}
