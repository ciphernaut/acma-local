UPDATE device_details SET EFL_ID = NULL WHERE EFL_ID = '';
UPDATE device_details SET RELATED_EFL_ID = NULL WHERE RELATED_EFL_ID = '';
CREATE INDEX IF NOT EXISTS device_details_related_efl_idx ON device_details(RELATED_EFL_ID);
ANALYZE;
PRAGMA optimize;
