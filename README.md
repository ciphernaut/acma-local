# ACMA RRL MCP Server

A Model Context Protocol (MCP) server that exposes the Australian Communications and Media Authority (ACMA) [Register of Radiocommunications Licences (RRL)](https://www.acma.gov.au/radiocomms-licence-data) and the [Australian Radiofrequency Spectrum Plan (ARSP)](https://www.acma.gov.au/australian-radiofrequency-spectrum-plan) as a local SQLite mirror, with manifest-driven sync against ACMA's REST API.

The server speaks two transports: **stdio** (Claude Desktop, LM Studio local) and **Streamable HTTP/SSE** on `:3000` (LM Studio 0.3.17+, networked MCP hosts). Both modes share the same 16-tool catalog.

## Features

- **Local mirror** of the full RRL dataset (26 materialised tables + FTS5 narrative index), kept fresh by ACMA's `/v1/Extracts` manifest API — mobile-friendly by default (no automatic 70 MB downloads).
- **Full-text search** (SQLite FTS5) over application narrative — answers "which licences mention 'remote operation'?" in milliseconds.
- **Geospatial export** — site/device results carry coordinates and can be rendered as KML via `export_kml`.
- **Spectrum plan lookup** — embeddable ARSP allocation table seeded from `seed/spectrum_plan.sql`; tells you what service category any frequency in Hz belongs to (FIXED, MOBILE, BROADCASTING, etc.) and surfaces relevant footnotes.
- **Power-user SQL** — `execute_sql` runs sandboxed SELECT/WITH queries in a worker thread; `explain_query`, `describe_schema`, and `list_sample_queries` make the schema discoverable.
- **Progressive disclosure** — `tools/list` returns terse one-liners; `describe_tool(<name>)` fetches the full markdown when needed (matterfront pattern).

## Tools (16)

| Group | Tools |
|---|---|
| **Search** (find records by name/ID) | `search_licences`, `search_sites`, `search_clients`, `search_bsl` |
| **Detail lookups** | `get_licence_details`, `get_site_details` |
| **Spectrum & narrative** | `search_spectrum_band`, `search_application_text`, `get_frequency_allocation` |
| **SQL backend** | `execute_sql`, `list_sample_queries`, `explain_query` |
| **Output** | `export_kml` (geospatial render of cached results) |
| **Meta / orchestration** | `sync_data`, `describe_schema`, `describe_tool` |

Search-style results return an `_hints` array suggesting plausible follow-up tools (e.g. `search_licences` → `get_licence_details`; geospatial results → `export_kml`).

## Installation

Requires Node ≥ 18.

```bash
git clone https://github.com/ciphernaut/acma-local.git
cd acma-local
npm install
```

First-time data bootstrap (downloads ~70 MB; one-time). On a fresh DB the bootstrap path runs automatically — no `mode=full` needed:

```bash
npm run sync
```

After the first install you can also trigger syncs through the MCP `sync_data` tool with `mode=auto` (default, incremental) or `mode=full` (force-redownload, e.g. to recover from `gap-exceeded`).

The spectrum-plan tables auto-populate from `seed/spectrum_plan.sql` at the tail of the full sync.

## Running

```bash
npm run dev                    # tsx src/index.ts — development mode, live reload
npm run build && npm start     # production (compiled to dist/, then node dist/index.js)
```

The server listens on `$PORT` (default `3000`) and exposes the MCP endpoint at `http://localhost:$PORT/mcp` plus a liveness probe at `/health`. It handles `SIGTERM` and `SIGINT` gracefully — closes MCP transports, finishes in-flight requests, exits cleanly within 30 seconds.

For stdio mode (Claude Desktop), point the client at the compiled entry point — see [MCP client configuration](#mcp-client-configuration).

## Spectrum plan

The Australian Radiofrequency Spectrum Plan is stored in four `spectrum_*` tables alongside the RRL data. The canonical source is `seed/spectrum_plan.sql` (text, committed to git, ~430 KB / 1100 lines). On a fresh DB, the seed is auto-applied at the tail of `performFullSync`.

To refresh after an ACMA legislative amendment:

```bash
# 1. Write a hand-curated patch from the published amendment
$EDITOR seed/patches/$(date +%Y-%m-%d)-anqf-update.sql

# 2. Apply it (idempotent: skip if the patch defines its own conditions)
npm run import-spectrum-plan -- --patch seed/patches/2027-08-12-anqf-update.sql

# 3. Regenerate the canonical snapshot
npm run dump-spectrum-plan

# 4. Commit both the patch and the new seed
git add seed/
git commit -m "data(spectrum): apply amendment 2027-08-12"
```

To reseed from scratch (or load a different source):

```bash
npm run import-spectrum-plan -- --reseed                                  # from seed/spectrum_plan.sql
npm run import-spectrum-plan -- --reseed --source path/to/other.sql
npm run import-spectrum-plan -- --reseed --source path/to/source.db       # legacy schema; range parser normalises
```

## Configuration

Environment variables:

| Variable | Purpose |
|----------|---------|
| `ACMA_DB_PATH` | Absolute path to the SQLite DB. Default `./data/acma.db`. |
| `PORT` | HTTP server port for the Streamable HTTP transport. Default `3000`. |
| `LOG_LEVEL` | One of `error` / `warn` / `info` (default) / `debug`. Lower levels are emitted; everything else is suppressed. |
| `DEBUG_NETWORK` | Legacy alias for `LOG_LEVEL=debug` (kept for backwards compatibility). Promotes per-request `[NETWORK]` logging when set. |

The server's `/health` endpoint returns JSON with sync provenance (`dataAsOf`, `lastSyncAt`, `remoteAsOf`, `behindByHours`, `isSyncing`). Pass `?deep=1` to additionally probe the DB read-only — returns `500` with `status: degraded` if the DB is unreachable.

### MCP client configuration

**Claude Desktop / LM Studio (stdio):**

```json
{
  "mcpServers": {
    "acma-rrl": {
      "command": "node",
      "args": ["/path/to/acma-local-redux/dist/index.js"],
      "env": {
        "ACMA_DB_PATH": "/path/to/acma-local-redux/data/acma.db"
      }
    }
  }
}
```

**LM Studio 0.3.17+ (networked, Streamable HTTP):**

```json
{
  "mcpServers": {
    "acma-rrl": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Data sync

The local SQLite mirror is kept in step with ACMA's `https://backend.acma.gov.au/rrl/v1/Extracts` manifest. The manifest exposes one full-extract entry plus the most recent ~3 daily change-zip entries.

Three timestamps drive the state machine — kept in the `meta` table:

- `as_of` — how fresh the data we hold is (from the manifest's `LastMdified` of the last applied entry).
- `last_sync` — when our pipeline last successfully ran.
- Manifest `full.LastMdified` (never persisted) — the upstream state. The MCP surfaces the delta as `behindByHours`.

Sync modes (exposed via the MCP `sync_data` tool):

- **`auto`** (default): fetches the manifest and applies any daily CSV-diff change-zips strictly newer than `meta.as_of`. Never auto-pulls the 70 MB full extract — safe to call from mobile or metered networks.
- **`full`**: force-downloads and reimports `spectra_rrl.zip`. Use on first install or when `sync_data` reports `gap-exceeded` (local DB older than the manifest's ~3-day incremental window).

## Development

```bash
npm test                          # full Jest suite (ts-jest ESM preset)
npm test -- tests/sync.test.ts    # single file
npm run build                     # tsc → dist/ (ESM)
```

See `CLAUDE.md` for architecture notes, project-specific gotchas, and the sync pipeline's invariants.

## Attribution

This project provides a local mirror of ACMA-published data. The legacy [`offline-rrl`](https://web.acma.gov.au/offline-rrl/index.html) JavaScript implementation was used to reverse-engineer the data structures and SQL query patterns; the manifest API replaces its 3-URL pipeline (`spectra_rrl.zip` + `datetime-of-extract.txt` + `.rrl_update` SQL diff).

## License

This software and the associated RRL/ARSP data are licensed under the [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) license.

- **ACMA Data**: © Commonwealth of Australia (Australian Communications and Media Authority).
- **Implementation**: Creative Commons Attribution 4.0 International.
