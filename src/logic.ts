import Database from 'better-sqlite3';

export function searchSites(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    SELECT s.*, la.DESCRIPTION AS LICENSING_AREA_NAME
    FROM site s
    LEFT JOIN licensing_area la ON la.LICENSING_AREA_ID = s.LICENSING_AREA_ID
    WHERE s.NAME LIKE ? OR s.POSTCODE LIKE ?
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, limit);
}

export function getSiteDetails(db: Database.Database, siteId: string) {
  const site = db.prepare(`
    SELECT s.*, la.DESCRIPTION AS LICENSING_AREA_NAME
    FROM site s
    LEFT JOIN licensing_area la ON la.LICENSING_AREA_ID = s.LICENSING_AREA_ID
    WHERE s.SITE_ID = ?
  `).get(siteId);
  if (!site) return null;

  const devices = db.prepare(`
    SELECT d.*,
           nos.DESCRIPTION AS NATURE_OF_SERVICE_NAME,
           cos.DESCRIPTION AS CLASS_OF_STATION_NAME,
           ap.POLARISATION_TEXT AS POLARISATION_NAME
    FROM device_details d
    LEFT JOIN nature_of_service nos ON nos.CODE = d.NATURE_OF_SERVICE_ID
    LEFT JOIN class_of_station   cos ON cos.CODE = d.CLASS_OF_STATION_CODE
    LEFT JOIN antenna_polarity   ap  ON ap.POLARISATION_CODE = d.POLARISATION
    WHERE d.SITE_ID = ?
    LIMIT 50
  `).all(siteId);
  return { site, devices };
}

// Note: l.* includes licence.STATUS_TEXT (denormalised, may be stale).
// STATUS_NAME is the authoritative value from the licence_status lookup.
const LICENCE_SELECT = `
  SELECT l.*,
         sv.SV_NAME     AS SERVICE_NAME,
         ss.SS_NAME     AS SUBSERVICE_NAME,
         ls.STATUS_TEXT AS STATUS_NAME
  FROM licence l
  LEFT JOIN licence_service     sv ON sv.SV_ID = l.SV_ID
  LEFT JOIN licence_subservice  ss ON ss.SS_ID = l.SS_ID AND ss.SV_SV_ID = l.SV_ID
  LEFT JOIN licence_status      ls ON ls.STATUS = l.STATUS
`;

export function searchLicences(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    ${LICENCE_SELECT}
    WHERE l.LICENCE_NO LIKE ?
    LIMIT ?
  `).all(`%${query}%`, limit);
}

export function searchLicencesWithSites(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    SELECT DISTINCT l.*,
           sv.SV_NAME     AS SERVICE_NAME,
           ss.SS_NAME     AS SUBSERVICE_NAME,
           ls.STATUS_TEXT AS STATUS_NAME,
           s.LATITUDE, s.LONGITUDE, s.NAME AS SITE_NAME
    FROM licence l
    LEFT JOIN licence_service    sv ON sv.SV_ID = l.SV_ID
    LEFT JOIN licence_subservice ss ON ss.SS_ID = l.SS_ID AND ss.SV_SV_ID = l.SV_ID
    LEFT JOIN licence_status     ls ON ls.STATUS = l.STATUS
    LEFT JOIN device_details d ON l.LICENCE_NO = d.LICENCE_NO
    LEFT JOIN site s ON d.SITE_ID = s.SITE_ID
    WHERE l.LICENCE_NO LIKE ?
    LIMIT ?
  `).all(`%${query}%`, limit);
}

export function searchClients(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    SELECT c.*,
           ct.NAME            AS CLIENT_TYPE_NAME,
           fs.FEE_STATUS_TEXT AS FEE_STATUS_NAME,
           ic.NAME            AS INDUSTRY_NAME
    FROM client c
    LEFT JOIN client_type  ct ON ct.TYPE_ID = c.CLIENT_TYPE_ID
    LEFT JOIN fee_status   fs ON fs.FEE_STATUS_ID = c.FEE_STATUS_ID
    LEFT JOIN industry_cat ic ON ic.CAT_ID = c.CAT_ID
    WHERE c.LICENCEE LIKE ? OR c.TRADING_NAME LIKE ?
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, limit);
}

export function searchBsl(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    SELECT b.*, a.AREA_NAME
    FROM bsl b
    LEFT JOIN bsl_area a ON a.AREA_CODE = b.AREA_CODE
    WHERE b.CALL_SIGN LIKE ?
       OR CAST(b.BSL_NO AS TEXT) LIKE ?
       OR b.ON_AIR_ID LIKE ?
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, `%${query}%`, limit);
}

export function searchSpectrumBand(
  db: Database.Database,
  freqMinHz: number,
  freqMaxHz: number,
  limit: number = 20
) {
  // Two sub-bands per row: LW (lower) and UP (upper). Either may be NULL.
  // A row matches if EITHER sub-band overlaps the query [min, max].
  // Standard interval-overlap form: range_end >= min AND range_start <= max.
  return db.prepare(`
    SELECT f.LICENCE_NO, f.AREA_CODE, f.AREA_NAME,
           f.LW_FREQUENCY_START, f.LW_FREQUENCY_END,
           f.UP_FREQUENCY_START, f.UP_FREQUENCY_END,
           a.AREA_DESCRIPTION,
           l.CLIENT_NO
    FROM auth_spectrum_freq f
    LEFT JOIN auth_spectrum_area a
           ON a.LICENCE_NO = f.LICENCE_NO AND a.AREA_CODE = f.AREA_CODE
    LEFT JOIN licence l ON l.LICENCE_NO = f.LICENCE_NO
    WHERE (f.LW_FREQUENCY_END   >= ? AND f.LW_FREQUENCY_START <= ?)
       OR (f.UP_FREQUENCY_END   >= ? AND f.UP_FREQUENCY_START <= ?)
    LIMIT ?
  `).all(freqMinHz, freqMaxHz, freqMinHz, freqMaxHz, limit);
}

export function getLicenceDetails(db: Database.Database, licenceNo: string) {
  const licence = db.prepare(`
    ${LICENCE_SELECT}
    WHERE l.LICENCE_NO = ?
  `).get(licenceNo) as any;
  if (!licence) return null;

  const client = db.prepare(`
    SELECT c.*,
           ct.NAME            AS CLIENT_TYPE_NAME,
           fs.FEE_STATUS_TEXT AS FEE_STATUS_NAME,
           ic.NAME            AS INDUSTRY_NAME
    FROM client c
    LEFT JOIN client_type  ct ON ct.TYPE_ID = c.CLIENT_TYPE_ID
    LEFT JOIN fee_status   fs ON fs.FEE_STATUS_ID = c.FEE_STATUS_ID
    LEFT JOIN industry_cat ic ON ic.CAT_ID = c.CAT_ID
    WHERE c.CLIENT_NO = ?
  `).get(licence.CLIENT_NO);

  const devices = db.prepare(`
    SELECT d.*,
           nos.DESCRIPTION       AS NATURE_OF_SERVICE_NAME,
           cos.DESCRIPTION       AS CLASS_OF_STATION_NAME,
           ap.POLARISATION_TEXT  AS POLARISATION_NAME,
           sat.SA_SAT_NAME       AS SATELLITE_NAME,
           s.LATITUDE, s.LONGITUDE, s.NAME AS SITE_NAME
    FROM device_details d
    LEFT JOIN nature_of_service nos ON nos.CODE = d.NATURE_OF_SERVICE_ID
    LEFT JOIN class_of_station   cos ON cos.CODE = d.CLASS_OF_STATION_CODE
    LEFT JOIN antenna_polarity   ap  ON ap.POLARISATION_CODE = d.POLARISATION
    LEFT JOIN satellite          sat ON sat.SA_ID = d.SA_ID
    LEFT JOIN site s ON d.SITE_ID = s.SITE_ID
    WHERE d.LICENCE_NO = ?
    LIMIT 50
  `).all(licenceNo);

  return { licence, client, devices };
}
