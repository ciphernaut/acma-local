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
3. **Site-level is the default granularity.** ACMA sites routinely host dozens to
   hundreds of devices at identical coordinates. Emitter-level projection of a
   metropolitan radius query would both produce a pin-pile and exhaust the
   500-entity ceiling in one call.
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

| | site-level (default) | emitter-level (frequency phase) |
|---|---|---|
| `id` | `SITE_ID` | `LICENCE_NO:DEVICE_ID` |
| `entityType` | `FACILITY` | `SIGNAL` |
| `domain` | `LAND` | `EW` |
| `name` | site name | frequency + service |
| `properties` | device count, bands present, services, `as_of` | frequency, emission designator, EIRP, polarity, licensee, `as_of` |

`confidence` is `1.0`: the RRL is the authoritative register. Staleness lives in
`properties.as_of`, where it is visible, rather than being smuggled into a field
that means source reliability.

Phase 1 ships the `granularity` parameter with `site` implemented; `emitter`
returns a clear "not implemented in this phase" error rather than being absent
from the schema. The parameter is named now because the frequency axis is a
committed follow-on and is precisely the case where site rollup gives the wrong
answer — it is a reserved slot, not speculative generality.

### OSIRIS side

`src/lib/polybolos-layer.ts` plus a vitest test, following `satellite-layer.ts`
— the repo's established pattern of an extracted, pure, unit-tested layer
module. It subscribes to `/api/sdk/stream`, maps entities to a MapLibre source
and layer, and takes colour, icon and scale from each entity's `display` field so
producers control their own rendering. `OsirisMap.tsx` (2876 lines) gets only the
wiring; `LayerPanel.tsx` gets one toggle.

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
- a payload over the ceiling is refused rather than truncated.

The push path uses `jest.spyOn(axios, 'post')` — `jest.mock` does not work under
this repo's ts-jest ESM preset.

## Commit sequencing

1. **Silent-skip fix, contained and separate.** Report skipped rows from
   `geojson.ts`, `kml.ts` and `qml.ts`. No new feature code in this commit.
2. `export_polybolos` — pure projection plus tests.
3. `push_to_osiris` — egress, config, error paths. `.gitleaks.toml` reviewed for
   the new secret.
4. OSIRIS fork: `polybolos-layer.ts` plus test, then wiring.
5. Offer the OSIRIS half upstream as a PR once proven locally.

## Deferred

- **The frequency axis and emitter-level projection.** "Who is on this band"
  needs the `emitter` granularity and frequency-range querying. It is the next
  phase after this one.
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
