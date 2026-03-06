import { executeSqlWithTimeout } from '../src/sql.js';

async function run() {
  const dbPath = './data/acma.db';
  const sql = "select 'POINT('||s3.longitude||' '||s3.latitude||')' as geometry, s3.name as Site, c3.licencee from site s3, licence l3, client c3, device_details d3 where c3.licencee like '%nbn%' and l3.client_no = c3.client_no and d3.licence_no = l3.licence_no and s3.site_id = d3.site_id limit 5";
  
  console.log('Executing heavy NBN query cross join with fixes...');
  const start = Date.now();
  try {
    const res = await executeSqlWithTimeout(dbPath, sql, 5, 20000);
    console.log('OK rows:', res.rowCount, 'Time taken:', Date.now() - start, 'ms');
  } catch (e) {
    console.error('TIMEOUT OR ERR:', e.message, 'Time elapsed:', Date.now() - start, 'ms');
  }
}

run().catch(console.error);
