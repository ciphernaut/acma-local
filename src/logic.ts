import Database from 'better-sqlite3';

export function searchSites(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    SELECT * FROM site 
    WHERE NAME LIKE ? OR POSTCODE LIKE ?
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, limit);
}

export function getSiteDetails(db: Database.Database, siteId: string) {
  const site = db.prepare('SELECT * FROM site WHERE SITE_ID = ?').get(siteId);
  if (!site) return null;

  const devices = db.prepare('SELECT * FROM device_details WHERE SITE_ID = ? LIMIT 50').all(siteId);
  return { site, devices };
}

export function searchLicences(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    SELECT * FROM licence 
    WHERE LICENCE_NO LIKE ?
    LIMIT ?
  `).all(`%${query}%`, limit);
}

export function searchLicencesWithSites(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    SELECT DISTINCT l.*, s.LATITUDE, s.LONGITUDE, s.NAME as SITE_NAME
    FROM licence l
    LEFT JOIN device_details d ON l.LICENCE_NO = d.LICENCE_NO
    LEFT JOIN site s ON d.SITE_ID = s.SITE_ID
    WHERE l.LICENCE_NO LIKE ?
    LIMIT ?
  `).all(`%${query}%`, limit);
}

export function searchClients(db: Database.Database, query: string, limit: number = 20) {
  return db.prepare(`
    SELECT * FROM client 
    WHERE LICENCEE LIKE ? OR TRADING_NAME LIKE ?
    LIMIT ?
  `).all(`%${query}%`, `%${query}%`, limit);
}

export function getLicenceDetails(db: Database.Database, licenceNo: string) {
  const licence = db.prepare('SELECT * FROM licence WHERE LICENCE_NO = ?').get(licenceNo) as any;
  if (!licence) return null;

  const client = db.prepare('SELECT * FROM client WHERE CLIENT_NO = ?').get(licence.CLIENT_NO);
  const devices = db.prepare(`
        SELECT d.*, s.LATITUDE, s.LONGITUDE, s.NAME as SITE_NAME 
        FROM device_details d
        LEFT JOIN site s ON d.SITE_ID = s.SITE_ID
        WHERE d.LICENCE_NO = ? 
        LIMIT 50
    `).all(licenceNo);

  return { licence, client, devices };
}
