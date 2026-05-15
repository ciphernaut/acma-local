# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`LOG_LEVEL` env var** (`error` / `warn` / `info` (default) / `debug`). All in-source logging goes through `src/logger.ts`; lower levels suppress noisier ones. `DEBUG_NETWORK` kept as a legacy alias.
- **Richer `/health` endpoint** — now returns JSON with `status`, `version`, `dataAsOf`, `lastSyncAt`, `remoteAsOf`, `behindByHours`, `isSyncing`. Optional `?deep=1` parameter opens the DB read-only and runs a probe SELECT; responds 500 / `status: degraded` if the DB is unreachable.
- Logger has its own test suite (`tests/logger.test.ts`, 4 cases).

### Changed
- ~40 `console.error('[X] ...')` call sites across `src/sync.ts`, `src/spectrum_plan.ts`, `src/index.ts`, and `src/import_spectrum_plan.ts` rewritten to `log.info` / `log.warn` / `log.error`. Message text and `[CHANNEL]` prefixes preserved so existing `grep` muscle memory still works.
- `DEBUG_NETWORK=true` no longer needs a special check at the call site — it now flows through the logger's level threshold.

## [1.10.0] - 2026-05-15

### Changed
- Rebuilt the `spectrum_*` data from the 2021 ACMA Radiofrequency Spectrum Plan PDF. The canonical source is `seed/spectrum_plan_source.yaml`, extracted from the PDF via `tools/extract-rrsp/extract.py`. `seed/spectrum_plan.sql` is generated from the YAML by `scripts/generate-spectrum-seed.ts`.
- `spectrum_allocations` schema: `freq_start_hz` + `freq_end_hz` (composite PK), `unit`, `page`, `services_json`, `footnotes_json`, `raw`. Legacy columns dropped (`frequency_range`, `region1`, `region2`, `region3`, `common`, `australian_table_of_allocations`, `footnote_ref`).
- New table `spectrum_region_allocations` stores ITU Region 1/2/3 allocations independently of AU sub-range boundaries.
- `get_frequency_allocation` response shape: `allocation` (AU primary, nullable) + `regions` (R1/R2/R3 contrast, each nullable) + `resolved_footnotes` (flat AU+intl text map). `source` carries `published_date` + `last_patch_date`.

### Added
- Patch overlay format under `seed/patches/*.yaml`. See `seed/patches/README.md` for the operation set.
- `scripts/generate-spectrum-seed.ts` composes YAML + overlays into SQL.
- `tools/extract-rrsp/` — Python extractor for the 2021 ACMA Spectrum Plan PDF.

### Upgrade notes
Existing databases need a re-bootstrap of the spectrum tables:

```
npm run import-spectrum-plan -- --reseed
```

## [1.9.0] - 2026-05-15

### Added
- `decode_emission_designator` MCP tool — parse the ITU/ACA emission designator stored in `device_details.EMISSION` into structured fields (bandwidth, modulation, signal nature, info type, optional signal-detail + multiplex).
- `search_devices_by_emission` MCP tool — find devices/licences by decoded descriptor (modulation, info type, signal nature, etc.). Accepts code letters or description substrings; ambiguous matches return an explicit candidate list.
- Five lookup tables (`emission_modulation`, `emission_signal_nature`, `emission_info_type`, `emission_signal_detail`, `emission_multiplex`) with the full code alphabet from the ACA "Emission characteristics of radio transmissions" booklet (ITU worldwide standard, 1982). Auto-bootstrapped on full sync from `seed/emissions.sql`.
- `npm run import-emissions` / `npm run dump-emissions` scripts for reseeding and regeneration from `CODE_TABLES`.
- Two sample queries (`list_sample_queries`) demonstrating SUBSTR joins against `emission_modulation`.

### Changed
- Tool count 16 → 18; table count 26 → 31.

### Upgrade notes
- The new `emission_*` tables are auto-populated by the next full sync. To seed them immediately on an existing database without triggering a sync, run `npm run import-emissions`.

## [1.8.0] - 2026-05-14

### Added
- **Spectrum-plan integration.** Embedded the Australian Radiofrequency Spectrum Plan (ARSP) as a lookup-only dataset alongside the RRL mirror:
  - 4 new tables: `spectrum_allocations` (with `freq_start_hz`/`freq_end_hz` range index), `spectrum_australian_footnotes`, `spectrum_international_footnotes`, `spectrum_plan_meta`.
  - Canonical seed file `seed/spectrum_plan.sql` committed to git (548 allocations, 52 AU footnotes, 498 international footnotes from the ARSP 2018 baseline). Auto-applied at the tail of `performFullSync` when spectrum tables are empty.
  - New MCP tool **`get_frequency_allocation(freq_hz)`** returning matching allocations, joined AU + international footnotes, source provenance, and a staleness warning when the base data is ≥ 3 years old.
  - New CLI: `npm run import-spectrum-plan -- --reseed [--source <path>]`, `-- --patch <path>`, and `npm run dump-spectrum-plan`. Supports `.sql` dumps and legacy `.db` source schemas with automatic frequency-range normalisation.
- **CI workflow** at `.github/workflows/test.yml` — matrix-tests on Node 18/20/22 with `npm ci`, `npm run build`, and `npm test` on every push and PR to `main`.
- **`engines.node >= 18`** declared in `package.json`.
- **Graceful shutdown** on `SIGTERM` / `SIGINT`: closes MCP transports, finishes in-flight HTTP requests, hard-exits via 30s watchdog if stuck.
- **`npm run test:integration`** for the network end-to-end suite; **`npm run test:all`** for both.

### Changed
- **`npm test`** now runs the fast 153-test suite by default (was: the whole suite including the flaky network integration tests). `NODE_OPTIONS='--experimental-vm-modules'` is now set in the script — bare `npm test` used to error out on ESM imports.
- **`initializeDatabase()`** is now called at the start of both the MCP server (`src/index.ts`) and the spectrum-plan CLI (`src/import_spectrum_plan.ts`). Existing DBs synced under older releases automatically gain newer tables without manual intervention.
- **README** refreshed to cover all 16 MCP tools, both transports (stdio + Streamable HTTP/SSE on `:3000`), the spectrum-plan workflow, and the patch-amendment loop.

### Fixed
- **`parseFrequencyRange`** open-ended branch — `'1-' GHz` now correctly returns `freq_start_hz = 1_000_000_000` (was: always the 3 THz sentinel).
- **`applyReseed`** is now atomic (savepoint-wrapped) so a mid-load failure rolls back to the prior state. NULL `unit` source rows are skipped with a warning instead of silently defaulting to MHz.
- **Source DB schema mismatch** — the legacy ARSP `.db` uses uppercase unit tokens (`KHZ`, `MHZ`, `GHZ`) and `ref` / `text` footnote columns. `parseFrequencyRange` is now case-insensitive on units; `copyFromSourceDb` reads the real column names.
- **`sql_worker.cjs`** — CTE/`WITH` queries now accepted by the worker thread (was silently rejected; the matching fix to `src/sql.ts` shipped in 1.7.0 but the CJS mirror was missed).

### Security
- **`npm audit fix`** resolved 11 vulnerabilities: 1 critical (`handlebars`, transitive), 5 high (including direct `axios` — multiple SSRF / prototype-pollution / DoS CVEs), 5 moderate. All non-breaking lockfile updates within existing semver ranges; no direct dependency changes.

## [1.7.0] - 2026-05-14

### Added
- **Sync migration to ACMA's `/v1/Extracts` manifest API** (replacing the legacy `web.acma.gov.au` 3-URL pipeline of `spectra_rrl.zip` + `datetime-of-extract.txt` + `.rrl_update`).
  - Pure decision function `decideSyncAction(asOf, manifest, mode, lastSync, now)` returning a discriminated `SyncAction` (`noop` | `full` | `incremental` | `gap-exceeded`). 12-hour cooldown; never auto-pulls the 70 MB full extract on `mode='auto'`.
  - Per-mode meta timestamps: `last_full_sync`, `last_incremental_sync`, surfaced through `sync_data`'s response.
- **Schema expansion (T1–T4) — 17 new tables.**
  - **T1 — 10 ACMA lookup tables:** `client_type`, `fee_status`, `industry_cat`, `licence_service`, `licence_subservice` (composite PK), `licence_status`, `nature_of_service`, `class_of_station`, `licensing_area`, `antenna_polarity`. JOINed by `src/logic.ts` for human-readable names in search results.
  - **T2 — Broadcasting:** `bsl` + `bsl_area`, with the `search_bsl` MCP tool.
  - **T3 — Spectrum auth:** `auth_spectrum_freq` (4-col composite PK), `auth_spectrum_area` (2-col composite PK), and the `search_spectrum_band(freq_hz)` tool with NULL-safe overlap.
  - **T3 — Satellite:** `satellite` table; surfaced in `get_licence_details`.
  - **T4 — Application narrative:** `applic_text_block` (~168 MB), `reports_text_block`, and an **FTS5 virtual table** `applic_text_block_fts` over `APTB_TEXT`. Rebuilt during full sync; incrementally maintained.
  - **T4 — `search_application_text(query)`** MCP tool backed by FTS5.
- **SQL backend hardening (matterfront hydration pattern).**
  - `execute_sql` accepts CTEs (`WITH ... SELECT`); runs in a worker thread inside a `BEGIN…ROLLBACK` sandbox.
  - **`describe_schema(tables?)`** introspects columns + indexes + row counts.
  - **`describe_tool(name)`** returns full markdown documentation; `tools/list` now carries lean one-line summaries (matterfront pattern).
  - `list_sample_queries` categorised (6 categories) and paginated.
  - Contextual **`_hints`** in every search/detail result, pointing at the natural next tool to call.
  - **`explain_query(sql)`** wrapper over `EXPLAIN QUERY PLAN`.
  - `ANALYZE` runs at the tail of full sync to refresh query-planner statistics.
- **Schema drift tolerance** — `importCsv` and `applyCsvDiff` now filter unknown CSV columns via `PRAGMA table_info`; logs `[SYNC] foo: skipping N unknown CSV column(s)` instead of failing.
- **`BslAreaId` column** added to the `licence` table (ACMA pushed it mid-sprint).
- **`DATE_ISSUED` / `DATE_OF_EFFECT` / `DATE_OF_EXPIRY`** columns added to `auth_spectrum_freq`.

### Changed
- `device_details` change-zips arrive as `device_detail.csv` (singular); the full extract uses `device_details.csv` (plural). `csvToTable` handles the alias.
- Author rewritten on the migration commit range from in-session OS identity to `Sage Grigull <ciphernaut@proton.me>`; all `Co-Authored-By: Claude` trailers removed.

### Documentation
- New `CLAUDE.md` covering the architecture, three-timestamp model, decision-table semantics, project gotchas, and environment variables.
- Process / planning artefacts moved out of `docs/` and into `docs/superpowers/` (gitignored).

## [1.6.x and earlier]

Pre-manifest pipeline against `https://web.acma.gov.au/offline-rrl/...`. Core schema of 5 tables (`client`, `licence`, `site`, `device_details`, `antenna`) and the original MCP tool surface (`search_*`, `get_*_details`, `sync_data`).
