select count(*) from (
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
);
