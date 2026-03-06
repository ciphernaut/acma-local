select distinct 'LINESTRING('||
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
order by Site, frequency;
