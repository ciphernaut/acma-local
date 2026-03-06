select count(*) from (
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
);
