# OSIRIS ⇄ ACMA bridge — design

**Date:** 2026-08-31
**Status:** approved design, not yet planned
**Scope:** phase 1 of three. Link analysis and emcomms rollup are deferred to their own documents.

## Problem

The ACMA RRL mirror answers spectrum questions in tables. OSIRIS — a self-hosted
OSINT platform running at `fpga-workstation.local:3001` — renders a live common
operating picture on a WebGL map. Neither knows the other exists. The goal is for
an agent to answer "who is transmitting near here" and have the answer appear on
that map alongside the other layers, without either system depending on the
other's internals.

## What OSIRIS actually provides

Established by reading the running instance and the MIT-licensed source
(`simplifaisoul/osiris`), not the documentation alone.

**The Polybolos SDK is the intended extension point.** `POST /api/sdk/ingest`
accepts entities from an external producer; `GET /api/sdk/stream` serves them
back as SSE. The wire contract is `{ source, apiKey, entities[] }` — the key
travels in the JSON body, not a header. Ids are namespaced on storage as
`ext-{source}-{id}`, so producers cannot collide.

**The ontology already has RF-shaped slots.** `src/lib/sdk/types.ts` defines
`Domain.EW` ("Electronic Warfare (GPS jamming, SIGINT)"), `EntityType.SIGNAL`
("Electronic emission") and `EntityType.FACILITY` ("Static installation"). No
taxonomy invention is required for the map. `entityType` is not validated against
the enum — `entity.entityType || 'TRACK'` — but we have no need of that latitude.

**Nothing renders ingested entities.** This is the finding that shapes the work.
No component imports `PolybolosClient` or `LatticeAdapter`; nothing opens an
`EventSource` against `/api/sdk/stream` outside that unused library. Every other
reference in the tree is documentation prose. The write path terminates in a
`Map` on `globalThis` that no layer consumes:

```
POST /api/sdk/ingest → globalThis.sdkEntityStore → GET /api/sdk/stream → (nobody)
                                                   OsirisMap.tsx never subscribes
```

A bridge alone therefore cannot put anything on the map. The missing consumer is
part of phase 1.

**Naming trap — do not be misled by the existing "SDK" layer.** `LayerPanel.tsx`
declares `{ key: 'sdk_sea', label: 'Maritime Lines', dataKey: 'sdk_entities' }`,
and `data.sdk_entities` *is* populated. It has nothing to do with the ingest
store. `page.tsx` (the `OSIRIS SDK — Intelligence Fusion Layer` effect) builds it
client-side by re-deriving points from feeds already loaded locally — flights,
ships, earthquakes, GDELT, news — for a network-mesh visual that is lines only,
and clears it when the toggle goes off. Same word, unrelated data path. Feeding
that bucket is not the integration point; a new layer module is.

**The store is memory-only and cannot forget.** No persistence (a restart clears
it), no TTL, no eviction, and no delete endpoint. The stream serves
`Array.from(store.values()).slice(0, 500)`, so once the store passes 500 entities
the overflow reaches no client, and which entities are lost is arbitrary.

## Constraints

These are decisions, not preferences. Each traces to something above.

1. **Result sets only, never the corpus.** The 893 MB mirror and the sync
   pipeline stay local permanently; OSIRIS receives only the features a query
   selected. This keeps a later pivot to hosted OSIRIS a config change rather
   than a data-gravity problem, and avoids implicitly redistributing the RRL.
2. **Natural-key ids, never per-query synthetics.** `ext-acma-rrl-<SITE_ID>`
   means re-querying an area overwrites in place and the store converges on
   distinct sites. Synthetic ids would accumulate without bound in a store that
   has no delete.
3. **Site-level is the default granularity; emitter-level is opt-in.** ACMA sites
   routinely host dozens to hundreds of devices at identical coordinates, so an
   unqualified emitter-level projection of a metropolitan radius query would both
   produce a pin-pile and exhaust the 500-entity ceiling in one call. Emitter
   granularity therefore requires a tighter agent-side pre-filter, and the tool
   refuses the projection rather than truncating when the result would breach the
   ceiling.
4. **No invented threat labels.** `threat` stays `NONE` for civil licensees.
5. **The OSIRIS-side change contains no ACMA-specific code.** That is what makes
   it a contribution rather than a private patch.

## Architecture

Two halves, decoupled by the wire format. Neither imports the other.

```
execute_sql ──▶ result_id  (30-min cache, existing)
                   │
                   ├─ export_polybolos(result_id, granularity)   NEW — pure
                   │     └─▶ IngestPayload JSON
                   └─ push_to_osiris(result_id)                  NEW — egress
                         └─▶ POST /api/sdk/ingest
                                   │
                         globalThis.sdkEntityStore
                                   │  GET /api/sdk/stream (SSE)
                                   ▼
                         polybolos-layer.ts   NEW — in the OSIRIS fork
                                   └─▶ MapLibre source + layer
```

### acma-local side

`export_polybolos` is a fourth exporter beside `export_geojson`, `export_kml`
and `export_qml`, with the same shape: a pure function over a cached result's
`(columns, rows)`, reached by `result_id`. It reuses the existing lat/lon column
convention from `geojson.ts` — `latitude` / `longitude` matched
case-insensitively.

`push_to_osiris` is the only new outbound network call in the codebase. It reads
`OSIRIS_URL` and `OSIRIS_INGEST_KEY` from the environment. The key is never a
tool argument and never appears in a tool response.

### Projection

| | site-level (default) | emitter-level |
|---|---|---|
| `id` | `SITE_ID` | `LICENCE_NO:DEVICE_ID` |
| `entityType` | `FACILITY` | `SIGNAL` |
| `domain` | `LAND` | `EW` |
| `name` | site name | frequency + service |

`confidence` is `1.0`: the RRL is the authoritative register. Staleness lives in
`properties.as_of`, where it is visible, rather than being smuggled into a field
that means source reliability.

Both granularities ship in phase 1. See "Operator controls" for why the frequency
slider forces emitter-level to arrive now rather than later.

#### Properties must be flat scalars

`properties` carries **flat scalar values only** — no nested objects, no arrays.
This is not stylistic. MapLibre filter expressions and OSIRIS's
`data.category_counts` mechanism both operate on flat feature properties, and
every operator control in the next section is built on one or the other. An array
of "bands present" would be unfilterable and uncountable.

| Property | Both granularities |
|---|---|
| `service` | licence service name — drives the service toggle group |
| `licence_type` | Apparatus / Spectrum / Class |
| `status` | Granted / Expired / … |
| `emission_class` | coarse class derived from the emission designator |
| `query_label` | what query produced this entity |
| `as_of` | freshness of the mirror when projected |

| Property | site-level only | emitter-level only |
|---|---|---|
| count | `device_count` | — |
| frequency | `band_vhf`, `band_uhf`, `band_shf` (flat booleans) | `frequency_hz` (exact) |
| power | — | `eirp_dbw` |

**Provenance is mandatory, not decoration.** Without `query_label` and `as_of` in
a click popup, a screen of pins cannot tell the operator whether it shows sites
within 25 km of a point or a nationwide band sweep, nor how stale the mirror was.
The layer is misleading without them.

### OSIRIS side

`src/lib/polybolos-layer.ts` plus a vitest test, following `satellite-layer.ts`
— the repo's established pattern of an extracted, pure, unit-tested layer
module. It subscribes to `/api/sdk/stream`, maps entities to a MapLibre source
and layer, and takes colour, icon and scale from each entity's `display` field so
producers control their own rendering. `OsirisMap.tsx` (2876 lines) gets only the
wiring; `LayerPanel.tsx` gets the control group below.

## Operator controls

### Which axes matter

Derived from the predicates in `ALL_SAMPLE_QUERIES` (`src/sql.ts`), which are
inherited from the original ACMA offline RRL app and so record what people
actually did with this data:

| Axis | Evidence |
|---|---|
| Licence status | `where l.status = '1'` — in six queries; the most repeated predicate |
| Frequency range | `d.frequency between 450000000 and 500000000`; `between 850000000 and 960000000` |
| Licence type | "Total and Granted Licences by Type" |
| Subservice / category | "Licences by Subservice (Category)" |
| Service | CTE example over `licence_service.sv_name` |
| Client type | "Granted Licences by Client Type" |
| Client industry | "Granted Licences by Client Industry" |
| State / postcode | "Total Sites by State"; `postcode between '2600' and '2699'` |
| Licensee name | `c.licencee like '%…%'` |
| Expiry window | "Licences Expiring Next Year by Month" |
| Emission / modulation | `SUBSTR(TRIM(EMISSION), 5, 3) = 'F3E'` |
| Power / EIRP | selected in every geospatial query, filtered in none |
| Link topology | `having count(distinct s.site_id) = 2` — point-to-point |

### Where each axis lives

The 500-entity ceiling forces the split, and it is a clean one:

- **Agent-side (SQL)** — anything that changes *which rows are selected* from a
  multi-million-row mirror: state, postcode, licensee, expiry, broad frequency
  sweeps. The nation cannot be pushed and then filtered in a browser.
- **Panel-side (MapLibre)** — anything that narrows *an already-pushed working
  set*: status, service, licence type, client type, emission class, topology.

**The panel explores what is on the map; the agent changes what is on the map.**

A corollary worth stating, since it is what makes the missing delete endpoint
survivable: the agent pushes a superset and the operator narrows it
presentation-side. **Agent proposes, operator disposes.**

### The control group

```
RF SPECTRUM                                    ⌄
 ── Service ───────────────────────────
   ☑ Land Mobile   412    ☑ Fixed        188
   ☐ Broadcasting   23    ☑ Amateur       31
 ── Licence type ──────────────────────
   ☑ Apparatus  ☐ Spectrum  ☐ Class
 ── Status ────────────────────────────
   ☑ Granted    ☐ Expired   ☐ Pending
 ── Emission ──────────────────────────
   ☑ Analogue FM  ☑ Digital  ☐ Data
 ── Frequency ─────────────────────────   (emitter granularity only)
   [AUTO]  ├──●━━━━━━━━━●──┤
           148.0 MHz   520.0 MHz
 ── EIRP ──────────────────────────────   (emitter granularity only)
   [AUTO]  ├─●━━━━━━━━━━━━━┤  ≥ 10 dBW
```

Toggle groups reuse the panel's existing `catKey` / `data.category_counts`
mechanism, so live counts come free — the same machinery the satellites layer
uses for mission type. The `Radio` icon is already imported in `LayerPanel.tsx`.

The two sliders follow `StyleStudio`'s established range-with-AUTO pattern, where
AUTO means "emit no rule". Both are bounded to the **pushed set's** actual
min/max rather than 0–∞, so the handles address the data on screen.

### Why frequency forces emitter granularity into phase 1

A site collapses many devices across many frequencies into one pin, so a
frequency filter at site granularity can only mean *"this site has at least one
device in range"*. Narrow the range and the `device_count` badge becomes wrong —
it still counts devices now filtered out — and flat scalar properties cannot
carry a per-site frequency list to recompute from.

The resolution is to serve both:

- **Site level** gets coarse `band_*` booleans. Filterable, cheap, and no lying
  counts.
- **Emitter level** gets the continuous frequency and EIRP sliders, which are
  exact because one entity is one device.

The sliders are therefore shown only when the layer holds emitter-level
entities. This is why emitter granularity moved from a deferred phase into phase
1: a continuous frequency control is a headline requirement, and site rollup
cannot answer it honestly.

## Error handling

**Every row that cannot be projected is counted and reported** in the tool's
`_hints`. Silent drops are this project's recurring bug class, and the existing
exporters have the flaw: `geojson.ts` does `if (!geometry) continue;` with no
count surfaced anywhere. Fixing those three is a prerequisite commit (below), not
part of the feature.

`push_to_osiris` refuses a payload that would take the store past the 500-entity
stream ceiling and says so, rather than pushing entities that `slice(0, 500)`
would silently truncate. A `503` (`SDK_INGEST_KEY` unset), `401` (key mismatch)
or an unreachable host surfaces as a clear tool error with the cause named.

## Testing

The projection is pure `(columns, rows) → payload` and unit-tests like the other
exporters. Required negative tests:

- a zero coordinate survives projection (it is a legitimate coordinate);
- an out-of-range coordinate is skipped **and counted**, with the count asserted;
- duplicate site ids collapse to exactly one entity;
- a payload over the ceiling is refused rather than truncated;
- **every emitted `properties` value is a scalar** — a sweep asserting no value
  is an object or array, since one nested field silently breaks every panel
  control that depends on it;
- `query_label` and `as_of` are present on every entity.

The push path uses `jest.spyOn(axios, 'post')` — `jest.mock` does not work under
this repo's ts-jest ESM preset.

On the OSIRIS side, the layer module is pure enough to test the way
`satellite-layer.test.ts` and `map-palette.test.ts` already do under vitest:
entity list in, MapLibre filter expression out. The filter-building is where the
control semantics live, so it is the part worth testing rather than the wiring.

## Commit sequencing

1. **Silent-skip fix, contained and separate.** Report skipped rows from
   `geojson.ts`, `kml.ts` and `qml.ts`. No new feature code in this commit.
2. `export_polybolos` — site-level projection, flat scalar properties, tests.
3. `export_polybolos` — emitter-level granularity plus the ceiling refusal.
4. `push_to_osiris` — egress, config, error paths. `.gitleaks.toml` reviewed for
   the new secret.
5. OSIRIS fork: `polybolos-layer.ts` plus test, then map wiring.
6. OSIRIS fork: the RF control group — toggle groups via `category_counts`, then
   the granularity-gated frequency and EIRP sliders.
7. Offer the OSIRIS half upstream as a PR once proven locally.

## Deferred

- **Link analysis** (`entity/expand`). Its allowed types are `aircraft, vessel,
  company, person, ip, country` — extending them to licence/site/client is a
  separate spec, gated on what the entity model looks like in practice.
- **Emcomms rollup.** Aggregation and possible coverage geometry; the rollup
  semantics are a domain judgement best made against a working map.
- **Upstream fixes worth their own PR.** The store has no delete or TTL; the
  stream's `slice(0, 500)` drops arbitrarily; and `!entity.position?.lat` rejects
  a latitude of exactly `0` as falsy. The last is a real bug — this repo's own
  `toPosition()` documents the same lesson: "Zero is a legitimate coordinate and
  is kept — dropping zeros would silently discard real rows."

## Open risks

- The OSIRIS repo is active; the fork carries a merge burden until the consumer
  lands upstream, if it does.
- The 500-entity ceiling is a hard limit on how much of the picture can be held
  at once. Site-level rollup buys headroom but does not remove the ceiling.
- Entities cannot be removed, only overwritten. Constraint 2 makes this
  tolerable; it does not make it good.
