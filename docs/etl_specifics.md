# ETL Specifics

The ACMA RRL data flows from the public ACMA manifest API into a local SQLite database through a manifest-driven ETL process.

## Data Sources

- **Manifest endpoint**: `https://backend.acma.gov.au/rrl/v1/Extracts` — returns a JSON array of extract entries. The array always includes one full-extract entry and approximately three most-recent daily change-zip entries.
- **Full extract zip**: `spectra_rrl.zip` (~100 MB compressed, ~500 MB uncompressed). The download URL (`FileUrl`) is hosted on `https://cdn.acma.gov.au/rrl/...` and is read directly from the manifest entry.
- **Change zips**: `spectra_rrl-changes-YYYY-MM-DD.zip` (CSV-diff format). URLs also on `cdn.acma.gov.au`.

## Pipeline Flow

### 1. Full Synchronization

Triggered on initial bootstrap (no local DB) or when `sync_data` is called with `mode='full'`.

1. **Download**: `spectra_rrl.zip` is downloaded from `fullEntry.FileUrl` (or copied from `inputs/spectra_rrl.zip` if it is up to date).
2. **Extraction**: The ZIP archive is extracted, yielding approximately 32 CSV files.
3. **Schema Creation**: `initializeDatabase` initialises the SQLite schema derived from ACMA's table metadata.
4. **Batch Import**: Each relevant CSV is parsed and batch-imported via `better-sqlite3` transactions for high throughput.
5. **Metadata**: `meta.as_of` is set to `fullEntry.LastMdified`; `meta.last_sync` is set to the current UTC timestamp.

### 2. Incremental Synchronization

Default path (`mode='auto'`) when the local DB is 1–30 hours behind the remote.

1. **Select entries**: `decideSyncAction` identifies which change-zips to apply (those with `LastMdified` newer than the local `meta.as_of`), sorted oldest-first.
2. **Download & apply**: For each change-zip, the file is downloaded then processed by `applyCsvDiffZip`. Each CSV in the zip has a trailing `CHANGE` column (`Added`, `Updated`, or `Deleted`). Rows are applied as DELETE-then-INSERT (for `Added`/`Updated`) or DELETE-only (for `Deleted`) inside a per-CSV transaction.
3. **Metadata**: `meta.as_of` is advanced to `entries.at(-1).LastMdified`; `meta.last_sync` is updated.

> **ACMA naming quirk**: the change-zip uses `device_detail.csv` (singular) while the full extract uses `device_details.csv` (plural). This is an upstream inconsistency handled transparently by a `csvToTable` alias in `applyCsvDiffZip`.

## Decision Logic

`decideSyncAction` (pure function in `src/sync.ts`) routes each `sync()` invocation:

| Condition | Outcome |
|---|---|
| Last sync < 12 h ago | `noop/cooldown` |
| No local DB | `full/bootstrap` |
| `mode='full'` (no cooldown) | `full/forced` |
| `meta.as_of` ≥ remote full | `noop/current` |
| Gap ≤ 30 h and change-zips available | `incremental` |
| Gap > 30 h or no applicable change-zips | `gap-exceeded` |

When `gap-exceeded` is returned, the sync does **not** automatically pull the full extract — the caller must explicitly invoke `sync_data` with `mode='full'`.

## Observability

Three timestamps serve as the points of reference:

- `meta.as_of` — data freshness (ISO 8601 UTC); updated after each successful sync.
- `meta.last_sync` — when the ETL pipeline last completed successfully.
- `LastMdified` (manifest field) — ACMA's authoritative remote timestamp for each entry.

The `sync_data` MCP tool surfaces all three as `dataAsOf`, `lastSyncAt`, `remoteAsOf`, and the derived `behindByHours`.

## Compactness

The SQLite database is significantly more compact than the raw CSV files and allows for complex relational queries that are not possible with raw file access.
