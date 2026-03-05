# ETL Specifics

The ACMA RRL data flows from the public ACMA updates server into a local SQLite database through a multi-stage ETL process.

## Data Sources

- **Full Dataset**: `https://web.acma.gov.au/rrl-updates/spectra_rrl.zip` (~100MB compressed, ~500MB uncompressed).
- **Dataset Timestamp**: `https://web.acma.gov.au/rrl-updates/datetime-of-extract.txt`.
- **Incremental Update**: `https://web.acma.gov.au/rrl/spectra_incremental.rrl_update`.

## Pipeline Flow

### 1. Full Synchronization (Initial)

1.  **Download**: The `spectra_rrl.zip` is downloaded to the local `data` directory.
2.  **Extraction**: The ZIP archive is extracted. It contains approximately 40 CSV files.
3.  **Schema Creation**: A SQLite database is initialized with the schema derived from the ACMA web app's `gTABLE_METADATA`.
4.  **Batch Import**: Each relevant CSV file (e.g., `client.csv`, `licence.csv`, `site.csv`) is parsed and imported into the database using `better-sqlite3` transactions for high performance.
5.  **Indexing**: Post-load DDL statements are executed to create indexes on foreign keys and commonly searched columns.
6.  **Metadata**: The `meta` table is updated with the `as_of` date from `datetime-of-extract.txt`.

### 2. Incremental Synchronization (Daily)

ACMA provides a daily `.rrl_update` file containing SQL `INSERT`, `UPDATE`, and `DELETE` statements aimed at synchronizing a local mirror that is less than 24 hours old.

1.  **Fetch Update**: The `.rrl_update` file is downloaded.
2.  **Validation**: The file header is checked for `STATUS: SUCCESS`.
3.  **Execution**: The SQL statements are executed within a transaction.
4.  **Metadata Update**: The `meta` table is updated with the new `as_of` timestamp extracted from the `-- TO:` comment in the update file.

## Observability & Progress

The ETL pipeline is instrumented to report real-time progress, which is exposed via the `sync_data` tool.

### Progress Stages
1.  **Download**: Percentage of the ZIP file retrieved from the ACMA server.
2.  **Extraction**: Status of file decompression.
3.  **Table Import**: For each CSV file, progress is calculated based on bytes processed relative to the file size on disk.
4.  **Completion**: The `as_of` date is verified and stored in the `meta` table.

This reporting allows clients to provide feedback to users during the initial 2-5 minute bulk import, reducing perceived latency.

## Compactness

The SQLite database is significantly more compact than the raw CSV files and allows for complex relational queries that are not possible with raw file access.
