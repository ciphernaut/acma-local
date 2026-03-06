import Database from 'better-sqlite3';

export interface SqlResult {
    columns: string[];
    rows: unknown[][];
    truncated: boolean;
    rowCount: number;
}

/**
 * Execute a read-only SELECT query against the ACMA RRL database.
 * Enforces SELECT-only: any other statement type throws an error.
 * Applies a row limit (default 100, max 500).
 */
export function executeSql(
    db: Database.Database,
    sql: string,
    limit: number = 100
): SqlResult {
    const trimmed = sql.trim();
    if (!trimmed) {
        throw new Error('SQL query cannot be empty.');
    }

    const firstWord = (trimmed.split(/\s+/)[0] ?? '').toUpperCase();
    if (firstWord !== 'SELECT') {
        throw new Error(
            `Only SELECT statements are allowed. Received: ${firstWord}. ` +
            `Use execute_sql for querying data only.`
        );
    }

    const cap = Math.min(Math.max(1, limit), 500);

    // Wrap the query to enforce the row limit without altering user's SQL
    const wrapped = `SELECT * FROM (${trimmed}) LIMIT ${cap + 1}`;

    const stmt = db.prepare(wrapped);
    const rawRows = stmt.all() as Record<string, unknown>[];

    const truncated = rawRows.length > cap;
    const resultRows = truncated ? rawRows.slice(0, cap) : rawRows;

    const firstRow = resultRows[0];
    const columns = firstRow ? Object.keys(firstRow) : [];
    const rows = resultRows.map(row => columns.map(col => row[col]));

    return { columns, rows, truncated, rowCount: rows.length };
}

export interface SampleQuery {
    description: string;
    query: string;
}

/**
 * Returns all 44 sample queries from the original ACMA offline RRL web app.
 * These are curated starting points for SQL exploration.
 */
export function listSampleQueries(): SampleQuery[] {
    return [
        {
            description: "All access_area",
            query: "select * from access_area order by area_id"
        },
        {
            description: "All antenna",
            query: "select * from antenna order by antenna_id"
        },
        {
            description: "All antenna_pattern",
            query: "select * from antenna_pattern order by antenna_id, az_type, angle"
        },
        {
            description: "All antenna_polarity",
            query: "select * from antenna_polarity order by polarisation_code"
        },
        {
            description: "All applic_text_block",
            query: "select * from applic_text_block order by aptb_id"
        },
        {
            description: "All auth_spectrum_area",
            query: "select * from auth_spectrum_area order by licence_no, area_code"
        },
        {
            description: "All auth_spectrum_freq",
            query: "select * from auth_spectrum_freq order by licence_no, area_code"
        },
        {
            description: "All class_of_station",
            query: "select * from class_of_station order by code"
        },
        {
            description: "All client",
            query: "select * from client order by client_no"
        },
        {
            description: "All client_type",
            query: "select * from client_type order by type_id"
        },
        {
            description: "All device_details",
            query: "select * from device_details"
        },
        {
            description: "All industry_cat",
            query: "select * from industry_cat order by cat_id"
        },
        {
            description: "All licence",
            query: "select * from licence order by licence_no"
        },
        {
            description: "All licence_service",
            query: "select * from licence_service order by sv_id"
        },
        {
            description: "All licence_status",
            query: "select * from licence_status order by status"
        },
        {
            description: "All licence_subservice",
            query: "select * from licence_subservice order by sv_sv_id, ss_id"
        },
        {
            description: "All licensing_area",
            query: "select * from licensing_area order by licensing_area_id"
        },
        {
            description: "All nature_of_service",
            query: "select * from nature_of_service order by code"
        },
        {
            description: "All reports_text_block",
            query: "select * from reports_text_block order by rtb_item"
        },
        {
            description: "All satellite",
            query: "select * from satellite order by sa_id"
        },
        {
            description: "All site",
            query: "select * from site order by site_id"
        },
        {
            description: "All client fee status",
            query: "select * from fee_status"
        },
        {
            description: "All BSLs",
            query: "select * from bsl"
        },
        {
            description: "All BSL Areas",
            query: "select * from bsl_area"
        },
        {
            description: "Data Dictionary",
            query: "select * from sqlite_master"
        },
        {
            description: "All Data Dictionary tables",
            query: "select * from sqlite_master where type='table' order by name"
        },
        {
            description: "Count summary",
            query: `select
 (select count(*) from client) as Clients,
 (select count(*) from licence) as Licences,
 (select count(*) from site) as Sites,
 (select count(*) from device_details
  where device_registration_identifier is not null or
        efl_id is not null) as Assignments,
 (select count(*) from applic_text_block) as "Total Special Conditions/Advisory Notes"`
        },
        {
            description: "All Licence Special Conditions/Advisory Notes",
            query: "select * from applic_text_block where aptb_table_prefix='LI'"
        },
        {
            description: "Total Granted licences held by Licencee",
            query: `select
 (select licencee from client where client_no = l.client_no) as "Licencee",
 count(*) "Granted Licences"
from licence l
where status_text='Granted'
group by "Licencee"
order by count(*) desc`
        },
        {
            description: "Total and Granted Licences by Type",
            query: `select distinct licence_type_name "Licence Type",
 (select count(*)
  from licence
 where licence_type_name=l.licence_type_name) "Total Licences",
 (select count(*) from licence
  where licence_type_name=l.licence_type_name and
  status_text = 'Granted') "Granted Licences"
from licence l
group by licence_type_name
order by licence_type_name`
        },
        {
            description: "Granted Licences by Client Industry",
            query: `select i.name "Client Industry", count(*) "Granted Licences"
from client c,
     industry_cat i,
     licence l
where l.status_text = 'Granted' and
      l.client_no = c.client_no and
      c.cat_id = i.cat_id
group by "Client Industry"
order by count(*) desc`
        },
        {
            description: "Granted Licences by Client Type",
            query: `select t.name "Client Type", count(*) "Granted Licences"
from client c,
     client_type t,
     licence l
where l.status_text = 'Granted' and
      l.client_no = c.client_no and
      c.client_type_id = t.type_id
group by "Client Type"`
        },
        {
            description: "Licences Expiring Next Year by Month",
            query: `select strftime('%m', date_of_expiry) "Month Expires",
       count(*) "Licences Expiring"
from licence
where cast(strftime('%Y',date_of_expiry) as integer) =
      cast(strftime('%Y', 'now') as integer) + 1
group by "Month Expires"
order by "Month Expires"`
        },
        {
            description: "Licences by Subservice (Category)",
            query: `select licence_type_name, licence_category_name, count(*) "Total Licences"
from licence l
where status_text = 'Granted'
group by licence_type_name, licence_category_name
order by licence_type_name, licence_category_name`
        },
        {
            description: "Assignments by PostCode/Frequency Range (2600-2699, 450-500MHz)",
            query: `select d.frequency,
       d.bandwidth,
       d.device_type,
       d.emission,
       s.name "Site Name",
       s.postcode,
       d.licence_no,
       l.licence_type_name,
       l.licence_category_name,
       c.licencee
from device_details d,
     site s,
     licence l,
     client c
where s.postcode >= '2600' and
      s.postcode <= '2699' and
      d.frequency - d.bandwidth/2 <= 500000000 and
      d.frequency + d.bandwidth/2 >= 450000000 and
      d.site_id = s.site_id and
      d.licence_no = l.licence_no and
      c.client_no = l.client_no`
        },
        {
            description: "Map Test (longitude/latitude)",
            query: `select 134 as longitude,
       -29 as latitude,
       'A point' as name`
        },
        {
            description: "Map Test (geometries)",
            query: `select 'POINT(134 -29)' as geometry,
       'A point' as name
union all
select 'LINESTRING(120 -35, 125 -25, 130 -20)' as geometry,
       'A linestring' as name
union all
select 'POLYGON((140 -35, 155 -35, 155 -25, 140 -25, 140 -35))' as geometry,
       'A polygon' as name`
        },
        {
            description: "Total Sites by State",
            query: `select state, count(*) as "Total Sites"
from site
where state is not null
group by state
order by state`
        },
        {
            description: "Vodafone sited assignments (850-960MHz)",
            query: `select s.latitude,
       s.longitude,
       s.name "Site",
       c.licencee,
       d.frequency,
       d.bandwidth,
       d.emission,
       d.device_type "T/R"
from site s,
     device_details d,
     licence l,
     client c
where s.site_id = d.site_id and
      d.licence_no = l.licence_no and
      l.client_no = c.client_no and
      c.licencee like '%vodafone%' and
      d.frequency + d.bandwidth/2 >= 850000000 and
      d.frequency - d.bandwidth/2 <= 960000000
order by s.latitude, s.longitude, d.frequency`
        },
        {
            description: "NBN sited assignments and Point to Point links",
            query: `select distinct 'LINESTRING('||
       s1.longitude||' '|| s1.latitude||' , ' ||
       s2.longitude||' '||s2.latitude||')'
        as geometry,
       null as 'Site',
       null as licencee,
       null as frequency,
       null as bandwidth,
       null as emission,
       null as 'T/R'
from site s1,
     site s2,
     device_details d1,
     device_details d2,
     licence l1,
     client c1
where c1.licencee like '%nbn%' and
      l1.client_no = c1.client_no and
      d1.licence_no = l1.licence_no and
      d2.efl_id = d1.related_efl_id and
      s1.site_id = d1.site_id and
      s2.site_id = d2.site_id
union all
select 'POINT('||s3.longitude||' '||s3.latitude||')'
        as geometry,
       s3.name as 'Site',
       c3.licencee,
       d3.frequency,
       d3.bandwidth,
       d3.emission,
       d3.device_type as 'T/R'
from site s3,
     licence l3,
     client c3,
     device_details d3
where c3.licencee like '%nbn%' and
      l3.client_no = c3.client_no and
      d3.licence_no = l3.licence_no and
      s3.site_id = d3.site_id
order by Site, frequency`
        },
        {
            description: "Client Relational Text search",
            query: `select *
from client
where licencee like '%telstra%'`
        },
        {
            description: "Site Relational Text Search (Sydney)",
            query: `select s.*
from site s
where name like '%Sydney%'`
        },
        {
            description: "Site Search Relational",
            query: `select s.*
from site s
where s.state in ('ACT','NSW')`
        },
        {
            description: "Fetching beyond the 100 row display limit",
            query: `select s.*
from site s
where s.state = 'WA'
order by site_id
limit 50 offset 100`
        }
    ];
}
