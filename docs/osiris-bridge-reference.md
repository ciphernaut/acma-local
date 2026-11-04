# OSIRIS ⇄ ACMA bridge — architecture and outstanding work

**Date:** 2026-09-01
**Status:** phase 1 (acma-local half) built and reviewed on `feat/osiris-polybolos-bridge`.
**Related:** `docs/osiris-acma-bridge.md` (design), `docs/osiris-acma-bridge-plan.md` (Plan A).

This is the reference sheet: the whole system in one picture, then every
outstanding item with the repo and file it belongs to.

---

## 1. Complete architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│ UPSTREAM                                                                │
│                                                                         │
│   ACMA RRL           backend.acma.gov.au/rrl/v1/Extracts                │
│   (the register)     full extract ~70 MB + ~3 daily change-zips         │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ manifest poll, 12 h cooldown
                                │ decideSyncAction() → noop|full|incremental
                                ▼
╔═════════════════════════════════════════════════════════════════════════╗
║ acma-local            THIS REPO — the ACMA half                         ║
║                                                                         ║
║   src/sync.ts ──────▶ data/acma.db   893 MB SQLite, 32 tables + FTS5    ║
║                       meta.as_of / last_sync                            ║
║                            │                                            ║
║                            │  NEVER leaves this box (spec Constraint 1) ║
║                            ▼                                            ║
║   ┌──────────────────────────────────────────────────────────────┐      ║
║   │ src/index.ts   MCP server — 22 tools                          │      ║
║   │   transports: stdio (Claude Desktop / LM Studio)              │      ║
║   │               Streamable HTTP + SSE on :3000                  │      ║
║   │                                                                │     ║
║   │   execute_sql ──▶ result cache (30 min, keyed by result_id)   │      ║
║   │                        │                                       │     ║
║   │        resolveResultEntry(id)  ◀── shared by all 5 below       │     ║
║   │                        │                                       │     ║
║   │        ┌───────────────┼───────────────┬──────────┐            │     ║
║   │        ▼               ▼               ▼          ▼            │     ║
║   │   export_geojson  export_kml     export_qml   export_polybolos │     ║
║   │      (QGIS)      (Google Earth)   (style)          │           │     ║
║   │                                                     ▼           │     ║
║   │                                              push_to_osiris     │     ║
║   └──────────────────────────────────────────────────┬─────────────┘     ║
║                                                       │                  ║
║   src/polybolos.ts   PURE  (columns, rows) → entities │                  ║
║     granularity 'site'    → FACILITY / LAND           │                  ║
║     granularity 'emitter' → SIGNAL   / EW             │                  ║
║     natural-key ids · flat scalar props · ≤500 or throw                  ║
║                                                       │                  ║
║   src/osiris.ts      the ONLY egress in the codebase  │                  ║
║     OSIRIS_URL + OSIRIS_INGEST_KEY (env only)         │                  ║
║     maxRedirects 0 · 15 s timeout · 10 MB caps        │                  ║
╚═══════════════════════════════════════════════════════╪══════════════════╝
                                                        │
                        POST { source, apiKey, entities[] }
                        key injected HERE, never in the document
                                                        │
╔═══════════════════════════════════════════════════════▼══════════════════╗
║ OSIRIS                fpga-workstation.local:3001 — Next.js, MIT         ║
║                                                                          ║
║   /api/sdk/ingest ──▶ globalThis.sdkEntityStore                          ║
║     fails closed on SDK_INGEST_KEY        Map, in memory                 ║
║     ids namespaced ext-{source}-{id}      NO persistence                 ║
║                            │              NO delete / TTL                ║
║                            ▼                                             ║
║   /api/sdk/stream    SSE, slice(0, 500)  ◀── hard ceiling, drops         ║
║                            │                  arbitrarily beyond it      ║
║                            ▼                                             ║
║   ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐         ║
║     src/lib/polybolos-layer.ts          PLAN B — DOES NOT EXIST          ║
║   │   EventSource → MapLibre source + layer                    │         ║
║       LayerPanel RF control group                                        ║
║   └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘         ║
║                            ╎                                             ║
║                            ▼                                             ║
║   OsirisMap.tsx  MapLibre WebGL globe  ── alongside 20+ other feeds      ║
╚══════════════════════════════════════════════════════════════════════════╝

     ⚠ TRAP: LayerPanel already has an "OSIRIS SDK" group whose dataKey is
       `sdk_entities`. That bucket is filled client-side by page.tsx from
       LOCAL feeds (flights, ships, quakes) for a lines-only mesh visual.
       It has nothing to do with the ingest store. Do not feed it.
```

### Control flow — who decides what appears

```
   AGENT (Claude / LM Studio)              OPERATOR (at the OSIRIS map)
   ────────────────────────────            ────────────────────────────
   picks WHICH ROWS EXIST                  picks WHAT IS DRAWN
     state, postcode, licensee,              service, licence type,
     expiry, broad freq sweeps               status, emission class
     → SQL, because you cannot               → MapLibre filters over
       push the nation                         flat scalar properties

            agent proposes  ──────────────▶  operator disposes
                   (this is what makes the absent delete endpoint survivable)
```

---

## 2. Where each outstanding item lands

Four destinations. Nothing below is a blocker for what already shipped.

### A. `acma-local` — this repo

| # | Item | File | Why it matters |
|---|---|---|---|
| **I7** | `eirp_dbw` never implemented | `src/polybolos.ts` | Spec lists it (`osiris-acma-bridge.md:152`) and the EIRP slider needs it. **`EIRP` is TEXT with a separate `EIRP_UNIT` column**, so this needs a unit-normalisation decision — that is why it was deferred, not forgotten. **Constraint 5 consequence: it MUST land here, not in the OSIRIS layer.** Coercing ACMA units on the OSIRIS side would put ACMA-specific code in the generic consumer and make it unmergeable upstream. |
| **M8** | QML drops columns unreported | `src/qml.ts:51,53` | `isExpressionSafe` silently drops a column containing `"` or `%`; `fields.filter(...)` silently discards a requested field that is not an attribute (a typo or case mismatch). Row-level skip reporting shipped; column-level did not. Either count them or stop describing QML as fixed. |
| **M9** | Pass-through key collision | `src/polybolos.ts:169,221` | A result column named `device_count`, `band_vhf`, `as_of` etc. overwrites a first-class property silently. Realistic case: `SELECT s.NAME, c.name` — distinct upstream, both lowercase to `name` here, one is lost. Guard: skip-and-count a key that already exists. |
| **M10** | Whitespace coordinate becomes 0 | `src/polybolos.ts` `toNumberOrNull`, and `src/geojson.ts` `toPosition` | `toNumberOrNull` short-circuits `null`/`undefined`/`''` — but `'   '` is none of those, and `Number('   ')` is `0`. Null Island passes the range check. Pre-existing in `geojson.ts`; the two should be fixed together so they cannot diverge. |
| **M11** | URL userinfo echoed in errors | `src/osiris.ts:52` | `OSIRIS_URL=http://admin:pw@host` → an unreachable host throws a message containing the password, which reaches the model and the transcript. Strip userinfo before interpolating. Hardening, not a live bug — documented usage has no userinfo. |
| **M12** | Ceiling doc is misleading | `src/index.ts` `push_to_osiris` `fullDescription` | The check is **per-payload**; the spec's promise is **per-store**. Two 400-entity pushes put 800 in a store with no delete. Nothing here can know the store's contents, so the code is the best available — but the doc should say the ceiling is cumulative and that OSIRIS must be restarted to clear it. |
| **—** | Tool-count trap undocumented | `CLAUDE.md` | `tests/network.test.ts` hard-asserts the tool count, and `npm test` **excludes that file**. That is exactly how it went stale at 20 while the catalog reached 22. Document that adding a tool means updating that test, and that `npm run test:all` is the honest command. |

### B. OSIRIS fork — Plan B, needs its own spec and plan

| Item | File | Note |
|---|---|---|
| SSE consumer + map layer | `src/lib/polybolos-layer.ts` (new) + vitest test | The unlock. Follow `satellite-layer.ts` — extracted, pure, unit-tested. **Generic: no ACMA-specific code**, which is what makes it mergeable. |
| Map wiring | `src/components/OsirisMap.tsx` | Keep to ~10 lines; logic lives in the lib module. The file is already 2876 lines. |
| RF control group | `src/components/LayerPanel.tsx` | Toggle groups via the existing `catKey` / `category_counts` mechanism (free live counts). Frequency + EIRP sliders via `StyleStudio`'s range-with-AUTO pattern, shown only at emitter granularity. `Radio` icon is already imported. |
| Popup / provenance | with the layer | Must surface `query_label` and `as_of`, or a screen of pins cannot say what produced it or how stale it is. |

**Before starting Plan B:** re-clone the reference — `git clone --depth 1 https://github.com/simplifaisoul/osiris.git` into a scratch dir. The previous clone was wiped mid-run. Keep it out of `tests/`; jest is now scoped to `roots: ['<rootDir>/tests']` so a stray clone no longer breaks the suite.

### C. OSIRIS upstream — separate PRs, independent of everything else

| Item | Where | Note |
|---|---|---|
| Falsy-zero latitude bug | `src/app/api/sdk/ingest/route.ts` | `!entity.position?.lat` rejects a latitude of exactly `0`. Harmless for Australia (−10 to −44), wrong everywhere. This repo's own `toPosition()` documents the same lesson — good evidence to cite. |
| ~~No delete / TTL endpoint~~ **DONE** | ingest route + store | Shipped in OSIRIS v1.1.0: source-scoped `DELETE /api/sdk/ingest`, 24 h TTL, and `total`/`sent`/`truncated` accounting on the stream. Natural-key ids still matter, but a bad push is now retractable. |
| `slice(0, 500)` drops arbitrarily | `src/app/api/sdk/stream/route.ts` | A hard ceiling on how much picture can be held at once. Site rollup buys headroom; it does not remove the ceiling. |

### D. Config and operations — no code anywhere

| Item | Where | Note |
|---|---|---|
| Enable ingest | OSIRIS `.env` → `SDK_INGEST_KEY` | Fails closed today: unset means `503`. Generate with `openssl rand -hex 32`. |
| Point the bridge at it | this repo's environment | `OSIRIS_URL=http://fpga-workstation.local:3001`, `OSIRIS_INGEST_KEY=<same value>`. Env only — never a tool argument. |
| **Close the verification gap** | one manual push | The **401** (key mismatch) and **503** (ingest disabled) paths are unit-tested with axios spied, but were never exercised against the live instance — an attempt to POST a key there was blocked as credential-guessing and not routed around. One real push closes it. |

---

## 3. Invariants — do not break these

These are load-bearing. Each traces to a specific mechanism, not to taste.

1. **Natural-key ids.** `ext-acma-rrl-<SITE_ID>`. The store has no delete, so a natural key is what makes a repeated query overwrite instead of accumulating forever.
2. **Flat scalar properties.** MapLibre filters and `category_counts` both only read flat values. One nested field silently disables every operator control built on it.
3. **Result sets only, never the corpus.** The 893 MB mirror stays local. Keeps a hosted pivot a config change rather than a data-gravity problem.
4. **The key never leaves `src/osiris.ts`.** Read from env, injected once at the POST body. Every error path throws a **fresh** `Error` with a literal message and **discards** the axios error — whose `config.data` carries the key. Do not wrap, re-throw or `cause`-chain it.
5. **No ACMA-specific code on the OSIRIS side.** The whole reason the consumer is contributable upstream.
6. **Report every skip.** Silently discarding data is this project's worst bug class.
