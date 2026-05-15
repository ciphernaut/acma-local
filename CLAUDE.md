# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server that exposes the ACMA Register of Radiocommunications Licences (RRL) as a local SQLite mirror, with a manifest-driven sync against ACMA's REST API. The server speaks two transports: **stdio** (Claude Desktop / LM Studio local) and **Streamable HTTP/SSE** on `:3000` (LM Studio 0.3.17+, network MCP hosts). Both modes share the same tool catalog.

## Commands

```bash
npm install                    # initial setup; needs Node >= 18
npm run dev                    # tsx src/index.ts — Streamable HTTP server on $PORT (default 3000)
npm run sync                   # tsx src/sync.ts — one-shot CLI sync
npm run build                  # tsc → dist/ (ESM)
npm test                       # fast Jest suite — excludes tests/network.test.ts
npm run test:integration       # network end-to-end suite (spawns a real dev server)
npm run test:all               # both

# Run a single test file:
npm test -- tests/sync.test.ts
# Or by name pattern. `npm test` now sets NODE_OPTIONS='--experimental-vm-modules'
# (required by ts-jest's ESM preset); direct jest invocations need it explicitly:
NODE_OPTIONS='--experimental-vm-modules' npx jest tests/sync.test.ts -t 'decideSyncAction'
```

## Architecture

### Sync pipeline (the part that requires multi-file reading)

The local SQLite database is kept in step with ACMA via the manifest at `https://backend.acma.gov.au/rrl/v1/Extracts`. The manifest returns a JSON array: one full-extract entry plus the ~3 most recent daily change-zip entries.

**Three timestamps are the points of truth — keep them straight:**
- `meta.as_of` (in SQLite) — how fresh the data we hold is. ISO 8601 from manifest `LastMdified` of the last applied entry.
- `meta.last_sync` — when our pipeline last successfully ran.
- Manifest `full.LastMdified` (never persisted) — what's available upstream. The MCP surfaces the delta as `behindByHours`.

**Routing core** is the pure function `decideSyncAction(asOf, manifest, mode, lastSync, now)` in `src/sync.ts`. It returns a discriminated `SyncAction` — `noop | full | incremental | gap-exceeded`. Rules apply in order: cooldown (12 h) → bootstrap (no DB) → forced (`mode='full'`) → current → applicable filter → gap-exceeded if oldest applicable change-zip is >30 h ahead of `as_of`. `sync()` dispatches; never auto-pulls the 70 MB full extract on `mode='auto'` (mobile-friendly policy — operator must request `mode='full'` to recover from `gap-exceeded`).

**Change-zip format quirks:**
- Each CSV in a change-zip has the table columns + a trailing `CHANGE` column (`Added` / `Updated` / `Deleted`).
- `Added`/`Updated` rows are applied as DELETE-then-INSERT (idempotent without schema PK constraints). PK columns live in the private `PK_BY_TABLE` map in `src/sync.ts`.
- ACMA names device data `device_detail.csv` (singular) in change-zips but `device_details.csv` (plural) in the full extract. `csvToTable` handles the alias.
- `LastMdified` (sic) — ACMA's typo on the JSON field. Preserved verbatim throughout; do not "fix" it on parse.

**Note `docs/etl_specifics.md`** has a longer write-up of the full vs incremental flow and the decision table.

### MCP server

`src/index.ts` is the entry point. It spins up an Express app exposing `POST /mcp` (initialization + RPC) and `GET /mcp` (SSE notification stream), with `Mcp-Session-Id` correlating both. Each session gets its own `StreamableHTTPServerTransport`. A 30-minute in-memory **result cache** ties `execute_sql` outputs to subsequent `export_kml` calls via `result_id`.

**Tool catalog (18 tools, registered in `index.ts`):** `search_sites`, `get_site_details`, `search_licences`, `get_licence_details`, `search_clients`, `search_bsl`, `search_spectrum_band`, `search_application_text`, `get_frequency_allocation`, `decode_emission_designator`, `search_devices_by_emission`, `sync_data`, `list_sample_queries`, `execute_sql`, `explain_query`, `export_kml`, `describe_schema`, `describe_tool`.

Each tool's `tools/list` entry is a one-line summary + capability tag; the full markdown documentation lives in the `TOOL_DOCS` map and is fetched on demand via `describe_tool(name)`. Search-style tools return `{rows, _hints?}` envelopes — `_hints` carries follow-up tool suggestions (e.g. `search_licences` → `get_licence_details`; geospatial results → `export_kml`).

### SQL execute path

`execute_sql` queries run in a **worker thread** (`src/sql_worker.cjs` → `src/sql_worker.ts`) — better-sqlite3 connections cannot cross thread boundaries, so the worker opens its own connection. The query is wrapped in a `BEGIN TRANSACTION; ... ROLLBACK;` sandbox so no statement can mutate the DB even if the SELECT-only validator misses something. The worker file uses inlined logic (not imported from `sql.ts`) to dodge ESM resolution differences between `tsx` and the compiled `dist/`.

### Database

`src/db.ts` declares `TABLE_METADATA` — DDL + post-load indexes for every materialised table. There are 32 tables + `meta` + the FTS5 virtual table `applic_text_block_fts`:

- **Core 5:** `client`, `licence`, `site`, `device_details`, `antenna`.
- **Broadcasting + spectrum:** `bsl`, `bsl_area`, `auth_spectrum_freq` (4-col composite PK), `auth_spectrum_area` (2-col composite PK).
- **Satellite:** `satellite`.
- **Spectrum plan (lookup-only):** `spectrum_allocations` (composite PK `freq_start_hz`+`freq_end_hz`, columns `unit`, `page`, `services_json`, `footnotes_json`, `raw`), `spectrum_region_allocations` (ITU R1/R2/R3 allocations keyed independently of AU sub-ranges), `spectrum_australian_footnotes`, `spectrum_international_footnotes`, `spectrum_plan_meta`. Canonical source is `seed/spectrum_plan_source.yaml` (extracted from the 2021 ACMA Spectrum Plan PDF by `tools/extract-rrsp/extract.py`); `seed/spectrum_plan.sql` is generated from the YAML + any overlays in `seed/patches/` by `scripts/generate-spectrum-seed.ts`. Auto-bootstrapped at the tail of `performFullSync` when empty. Not part of the RRL sync; upgrade an existing DB with `npm run import-spectrum-plan -- --reseed`.
- **Emission designator decoder (lookup-only):** `emission_modulation` (18 rows), `emission_signal_nature` (8), `emission_info_type` (9), `emission_signal_detail` (15), `emission_multiplex` (6). Populated from `seed/emissions.sql` (committed); regenerate via `npm run dump-emissions` after editing `CODE_TABLES` in `src/emissions.ts`. Auto-bootstrapped at the tail of `performFullSync` when empty. To seed an existing database without a full sync, run `npm run import-emissions`.
- **Narrative:** `applic_text_block` (~168 MB CSV), `reports_text_block`; FTS5 virtual table over `applic_text_block.APTB_TEXT` rebuilt during full sync.
- **10 lookups:** `client_type`, `fee_status`, `industry_cat`, `licence_service`, `licence_subservice` (composite PK), `licence_status`, `nature_of_service`, `class_of_station`, `licensing_area`, `antenna_polarity`. JOINed by `src/logic.ts` to surface human-readable names.

Schema does NOT declare primary keys — incremental application relies on `PK_BY_TABLE: Record<string, string | string[]>` in `src/sync.ts` for the DELETE step (string for single-column PKs; array for composites). The change-zip CSVs may use slightly different table names than the full extract (e.g. `device_detail` singular vs `device_details` plural) — `csvToTable` in `src/sync.ts` handles aliasing.

Runtime introspection: call the `describe_schema` MCP tool (or `describeSchema()` from `src/sql.ts`) to get columns + indexes + row counts for any table — the catalog is no longer hard-coded in `execute_sql`'s description.

## Project-specific gotchas

- **ts-jest ESM preset.** `jest.mock('axios')` does **not** work here. Use `jest.spyOn(axios, 'get')` with `import { jest } from '@jest/globals'` (see existing tests in `tests/sync.test.ts`). `downloadFile` was specifically written as `axios.get(url, { responseType: 'stream' })` so it can be spied on the same way.
- **TypeScript flags are strict.** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules` are all on. Optional fields must be *absent* (`{}`) not present-with-undefined (`{ x: undefined }`) — this matters in `SyncStatus` mutation; see `recordDecision` in `src/sync.ts` for the destructure-and-respread pattern.
- **No `console.log` in production code.** stdio transport reserves stdout for JSON-RPC frames. Use `console.error` for diagnostics (`grep -nE 'console\.(log|warn)' src/sync.ts` should return nothing).
- **`inputs/spectra_rrl.zip`** is a dev shortcut: if it exists and its mtime is newer than the manifest's `LastMdified`, `performFullSync` copies it instead of downloading. Useful for offline iteration. Don't push this file — it's gitignored via `*.zip`.
- **Spectrum plan pipeline.** `seed/spectrum_plan_source.yaml` is the canonical source for `spectrum_*` tables, extracted from the 2021 ACMA Spectrum Plan PDF by `tools/extract-rrsp/extract.py` (PDF is gitignored; its SHA-256 is pinned in the YAML `meta` block). `seed/spectrum_plan.sql` is generated from the YAML plus any overlays in `seed/patches/*.yaml` by running `npx tsx scripts/generate-spectrum-seed.ts`. Patches in `seed/patches/` record post-baseline ACMA amendments; add a new `YYYY-MM-DD-<topic>.yaml` overlay, regenerate the SQL, then run `npm run import-spectrum-plan -- --reseed` to apply to an existing DB. Do not hand-edit `spectrum_plan.sql` — regenerate it from YAML.
- **`CODE_TABLES` is the source of truth.** The seed file `seed/emissions.sql` is generated from `src/emissions.ts`'s `CODE_TABLES` constant. Don't hand-edit the seed; edit the constant and regenerate via `npm run dump-emissions`.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP server port (default 3000). |
| `ACMA_DB_PATH` | Absolute path to the SQLite DB. Defaults to `./data/acma.db`. |
| `LOG_LEVEL` | `error` / `warn` / `info` (default) / `debug`. Routed via `src/logger.ts`. |
| `DEBUG_NETWORK` | Legacy alias — when set, promotes `LOG_LEVEL` to `debug`. Kept working for backwards compatibility. |

For network-exposure hardening (bearer auth, TLS, rate limiting, container packaging), see `docs/AUTH-REWORK.md`.
