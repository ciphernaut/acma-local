# OSIRIS Polybolos Bridge — Implementation Plan (Plan A: acma-local)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project cached ACMA query results into Polybolos entities and push them to a self-hosted OSIRIS instance, so spectrum queries land on its common operating picture.

**Architecture:** A fourth exporter (`src/polybolos.ts`) beside the existing GeoJSON/KML/QML exporters — a pure function over a cached result's `(columns, rows)` — plus one outbound tool that POSTs the payload to `/api/sdk/ingest`. Site-level projection aggregates devices per site; emitter-level projects one entity per device. Nothing in this plan touches OSIRIS.

**Tech Stack:** TypeScript (ESM, strict), better-sqlite3, MCP SDK, axios, Jest via ts-jest ESM preset.

**Spec:** `docs/osiris-acma-bridge.md` — read it before Task 1. This plan implements its acma-local half only.

**Scope note:** The OSIRIS-side work (the `polybolos-layer.ts` consumer and the RF control group) is **Plan B**, written separately once this plan produces real payloads to render against. It lives in a different repo with a different test runner and cannot be tested without output from Task 4.

## Global Constraints

- **Node >= 18.** ESM throughout.
- **No `console.log` in production code** — stdio transport reserves stdout for JSON-RPC frames. Use `console.error`, or `src/logger.ts`. `grep -nE 'console\.(log|warn)' src/` must stay clean.
- **Strict TypeScript:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules` are all on. Optional fields must be *absent* (`{}`), never present-with-undefined (`{ x: undefined }`).
- **`jest.mock('axios')` does not work** under this repo's ts-jest ESM preset. Use `jest.spyOn(axios, 'post')` with `import { jest } from '@jest/globals'`.
- **Never emit a secret.** `OSIRIS_INGEST_KEY` is read from the environment only. It must never appear in a tool argument, a tool response, an exported document, or a log line.
- **Report every skip.** Rows that cannot be projected are counted and surfaced. Silent drops are this project's recurring bug class.
- **Agency-neutral.** No real licensee names in tests, fixtures or docs. Use `'Example Communications Pty Ltd'` and similar.
- **`TOOL_DOCS` values are backtick template literals** — `fullDescription` cannot contain a backtick. Use plain quotes or capitals for identifiers.
- Run `npm test` before every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/export_stats.ts` | CREATE — the shared `ExportStats` out-parameter type used by all four exporters. |
| `src/geojson.ts` | MODIFY — count skipped rows. |
| `src/kml.ts` | MODIFY — count skipped rows. |
| `src/qml.ts` | MODIFY — count skipped rows. |
| `src/polybolos.ts` | CREATE — the projection. Pure: `(columns, rows, opts) → payload JSON`. |
| `src/osiris.ts` | CREATE — the push. The only outbound network call; holds the config read. |
| `src/index.ts` | MODIFY — register two tools, wire skip reporting into the three existing exporters. |
| `tests/polybolos.test.ts` | CREATE — projection tests. |
| `tests/osiris.test.ts` | CREATE — push tests, axios spied. |
| `tests/export_stats.test.ts` | CREATE — skip-reporting tests for the three existing exporters. |

---

## Task 1: Skip reporting for the existing exporters

This is the spec's prerequisite commit. **No bridge code lands here.**

`src/geojson.ts:48` does `if (!geometry) continue;` and no caller ever learns a row was dropped. `kml.ts` and `qml.ts` share the flaw.

**Design decision — why an out-parameter.** Changing the return type to `{ document, skipped }` would touch 34 call sites, 30 of them test assertions. An optional out-parameter leaves every existing caller and test untouched and keeps the exporters' primary contract `(columns, rows) → document text`. Ugly in the abstract; correct here.

**Files:**
- Create: `src/export_stats.ts`
- Create: `tests/export_stats.test.ts`
- Modify: `src/geojson.ts`, `src/kml.ts`, `src/qml.ts`
- Modify: `src/index.ts` (the three exporter handlers)

**Interfaces:**
- Produces: `ExportStats` — `{ skipped: number }`. Tasks 2 and 3 reuse it.
- Produces: `generateGeoJson(columns, rows, stats?)`, `generateKml(columns, rows, opts, stats?)`, `generateQml(columns, rows, opts, stats?)`.

- [ ] **Step 1: Write the failing test**

Create `tests/export_stats.test.ts`:

```typescript
import { generateGeoJson } from '../src/geojson.js';
import type { ExportStats } from '../src/export_stats.js';

describe('skip reporting', () => {
    it('counts rows dropped for unusable geometry', () => {
        const stats: ExportStats = { skipped: 0 };
        const columns = ['NAME', 'LATITUDE', 'LONGITUDE'];
        const rows = [
            ['Good', -27.47, 153.02],
            ['No coords', null, null],
            ['Out of range', -999, 153.02],
        ];
        const fc = JSON.parse(generateGeoJson(columns, rows, stats));
        expect(fc.features).toHaveLength(1);
        expect(stats.skipped).toBe(2);
    });

    it('leaves skipped at zero when every row projects', () => {
        const stats: ExportStats = { skipped: 0 };
        generateGeoJson(['NAME', 'LATITUDE', 'LONGITUDE'], [['A', 0, 0]], stats);
        // Zero is a legitimate coordinate — this row must NOT be skipped.
        expect(stats.skipped).toBe(0);
    });

    it('is optional — omitting stats does not throw', () => {
        expect(() => generateGeoJson(['NAME', 'LATITUDE', 'LONGITUDE'], [['A', 1, 2]])).not.toThrow();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/export_stats.test.ts`
Expected: FAIL — cannot find module `../src/export_stats.js`.

- [ ] **Step 3: Create the shared type**

Create `src/export_stats.ts`:

```typescript
/**
 * Out-parameter for exporters to report rows they could not project.
 *
 * Silently dropping rows is this project's recurring bug class. Exporters take
 * this optional collector rather than changing their return type, which would
 * churn every existing call site for no gain.
 */
export interface ExportStats {
    /** Rows the exporter could not project, for any reason. */
    skipped: number;
}
```

- [ ] **Step 4: Thread it through geojson.ts**

In `src/geojson.ts`, add the import and widen the signature:

```typescript
import type { ExportStats } from './export_stats.js';

export function generateGeoJson(columns: string[], rows: unknown[][], stats?: ExportStats): string {
```

Then change the skip site (was `if (!geometry) continue;`):

```typescript
        if (!geometry) {
            if (stats) stats.skipped++;
            continue;   // no usable geometry: skip, never emit null geometry
        }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/export_stats.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Do the same for kml.ts and qml.ts**

Apply the identical pattern. In `src/kml.ts` the signature becomes:

```typescript
export function generateKml(
    columns: string[],
    rows: unknown[][],
    opts: KmlOptions = {},
    stats?: ExportStats,
): string {
```

and in `src/qml.ts`:

```typescript
export function generateQml(
    columns: string[],
    rows: unknown[][],
    opts: QmlOptions = {},
    stats?: ExportStats,
): string {
```

Find each site where a row is abandoned and increment `stats.skipped` there. **Read the surrounding code before editing** — `kml.ts:138` and `kml.ts:142` are `continue` statements inside a *field* loop, not a row loop. Incrementing there would count fields, not rows. Only the row-level abandonment counts.

Add a test for each to `tests/export_stats.test.ts`, mirroring the GeoJSON ones.

- [ ] **Step 7: Surface the count in the MCP responses**

In `src/index.ts`, each of the three exporter handlers currently ends:

```typescript
            return {
                content: [{ type: 'text', text: generateGeoJson(entry.columns, entry.rows) }]
            };
```

Change to:

```typescript
            const stats: ExportStats = { skipped: 0 };
            const doc = generateGeoJson(entry.columns, entry.rows, stats);
            const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: doc }];
            if (stats.skipped > 0) {
                content.push({
                    type: 'text',
                    text: `Note: ${stats.skipped} row(s) had no usable coordinates and were omitted from the export.`,
                });
            }
            return { content };
```

The document stays `content[0]`, so consumers reading it are unaffected; the note is additive. **Do not append the note into the document text** — it would make the GeoJSON unparseable.

Apply to all three handlers. Add the `import type { ExportStats } from './export_stats.js';` at the top of `src/index.ts`.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS. All 287 pre-existing tests still pass — the out-parameter is optional, so no existing call site changed behaviour.

- [ ] **Step 9: Commit**

```bash
git add src/export_stats.ts src/geojson.ts src/kml.ts src/qml.ts src/index.ts tests/export_stats.test.ts
git commit -m "fix(export): report rows dropped for unusable geometry

The three exporters silently skipped rows with no usable coordinates.
Silent drops are this project's recurring bug class, so each now takes an
optional ExportStats collector and the MCP handlers surface the count as
a second content block, leaving the document itself untouched."
```

---

## Task 2: Site-level Polybolos projection

**Files:**
- Create: `src/polybolos.ts`
- Create: `tests/polybolos.test.ts`

**Interfaces:**
- Consumes: `ExportStats` from Task 1.
- Produces:
  - `export type Granularity = 'site' | 'emitter';`
  - `export const STREAM_CEILING = 500;`
  - `export interface PolybolosOptions { granularity?: Granularity; queryLabel?: string; asOf?: string; }`
  - `export function generatePolybolos(columns: string[], rows: unknown[][], opts?: PolybolosOptions, stats?: ExportStats): string`
  - Returns the ingest payload as JSON **without** `apiKey`. Task 5 injects the secret at send time.

**Column conventions** (matched case-insensitively, mirroring `geojson.ts`): `site_id`, `latitude`, `longitude`, `name` or `site_name`, `frequency`, `emission`, `sdd_id`, `licence_no`, `licence_type_name`, `status`, `sv_name`. Any column not recognised passes through as a flat property — SQLite already returns scalars, so the flat-scalar rule holds naturally.

- [ ] **Step 1: Write the failing test**

Create `tests/polybolos.test.ts`:

```typescript
import { generatePolybolos, STREAM_CEILING } from '../src/polybolos.js';
import type { ExportStats } from '../src/export_stats.js';

function parse(columns: string[], rows: unknown[][], opts = {}, stats?: ExportStats): any {
    return JSON.parse(generatePolybolos(columns, rows, opts, stats));
}

const COLS = ['SITE_ID', 'SITE_NAME', 'LATITUDE', 'LONGITUDE', 'FREQUENCY', 'SV_NAME'];

describe('generatePolybolos — site level', () => {
    it('emits an ingest payload with a source and no apiKey', () => {
        const p = parse(COLS, [[1, 'Mt Coot-tha', -27.47, 152.95, 150000000, 'Land Mobile']]);
        expect(p.source).toBe('acma-rrl');
        // The secret is injected at send time; an exported document must never carry it.
        expect(p.apiKey).toBeUndefined();
        expect(p.entities).toHaveLength(1);
    });

    it('uses SITE_ID as the natural key so re-queries converge', () => {
        const p = parse(COLS, [[42, 'A', -27, 153, 150000000, 'Land Mobile']]);
        expect(p.entities[0].id).toBe('42');
    });

    it('collapses many devices at one site into a single entity', () => {
        const p = parse(COLS, [
            [7, 'Shared Tower', -27, 153, 150000000, 'Land Mobile'],
            [7, 'Shared Tower', -27, 153, 450000000, 'Land Mobile'],
            [7, 'Shared Tower', -27, 153, 900000000, 'Land Mobile'],
        ]);
        expect(p.entities).toHaveLength(1);
        expect(p.entities[0].properties.device_count).toBe(3);
    });

    it('uses the FACILITY/LAND ontology slots at site level', () => {
        const p = parse(COLS, [[1, 'A', -27, 153, 150000000, 'Land Mobile']]);
        expect(p.entities[0].entityType).toBe('FACILITY');
        expect(p.entities[0].domain).toBe('LAND');
    });

    it('derives flat band booleans across the site group', () => {
        const p = parse(COLS, [
            [7, 'A', -27, 153, 150000000, 'Land Mobile'],   // VHF
            [7, 'A', -27, 153, 900000000, 'Land Mobile'],   // UHF
        ]);
        const props = p.entities[0].properties;
        expect(props.band_vhf).toBe(true);
        expect(props.band_uhf).toBe(true);
        expect(props.band_shf).toBe(false);
    });

    it('marks a property "mixed" when a site group disagrees', () => {
        const p = parse(COLS, [
            [7, 'A', -27, 153, 150000000, 'Land Mobile'],
            [7, 'A', -27, 153, 150000000, 'Fixed'],
        ]);
        expect(p.entities[0].properties.service).toBe('mixed');
    });

    it('stamps provenance on every entity', () => {
        const p = parse(COLS, [[1, 'A', -27, 153, 150000000, 'Land Mobile']],
            { queryLabel: 'sites within 25 km of Brisbane', asOf: '2026-08-30T00:00:00Z' });
        expect(p.entities[0].properties.query_label).toBe('sites within 25 km of Brisbane');
        expect(p.entities[0].properties.as_of).toBe('2026-08-30T00:00:00Z');
    });

    it('emits only scalar properties', () => {
        const p = parse(COLS, [[1, 'A', -27, 153, 150000000, 'Land Mobile']]);
        for (const [key, value] of Object.entries(p.entities[0].properties)) {
            expect(typeof value === 'object' && value !== null)
                .toBe(false);   // one nested field breaks every OSIRIS panel control
        }
    });

    it('counts rows with unusable coordinates instead of dropping them silently', () => {
        const stats: ExportStats = { skipped: 0 };
        const p = parse(COLS, [
            [1, 'A', -27, 153, 150000000, 'Land Mobile'],
            [2, 'B', null, null, 150000000, 'Land Mobile'],
        ], {}, stats);
        expect(p.entities).toHaveLength(1);
        expect(stats.skipped).toBe(1);
    });

    it('keeps a zero coordinate — it is legitimate', () => {
        const stats: ExportStats = { skipped: 0 };
        const p = parse(COLS, [[1, 'A', 0, 0, 150000000, 'Land Mobile']], {}, stats);
        expect(p.entities).toHaveLength(1);
        expect(stats.skipped).toBe(0);
    });

    it('refuses a payload that would breach the stream ceiling', () => {
        const rows = Array.from({ length: STREAM_CEILING + 1 }, (_, i) =>
            [i, `Site ${i}`, -27, 153, 150000000, 'Land Mobile']);
        expect(() => generatePolybolos(COLS, rows))
            .toThrow(/ceiling/i);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/polybolos.test.ts`
Expected: FAIL — cannot find module `../src/polybolos.js`.

- [ ] **Step 3: Implement the projection**

Create `src/polybolos.ts`:

```typescript
/**
 * Polybolos entity projection for ACMA RRL query results.
 *
 * Targets the Polybolos SDK ingest contract used by OSIRIS — see
 * docs/osiris-acma-bridge.md. Shares its lat/lon column conventions with
 * geojson.ts.
 *
 * Two rules here are load-bearing rather than stylistic:
 *
 *   - Ids are natural keys. OSIRIS stores entities as `ext-{source}-{id}` in a
 *     map with no delete endpoint, so a natural key makes a repeated query
 *     converge on the same entity instead of accumulating garbage forever.
 *   - Properties are flat scalars. MapLibre filter expressions and OSIRIS's
 *     category_counts mechanism both operate on flat feature properties; a
 *     nested value silently disables every operator control built on it.
 */
import type { ExportStats } from './export_stats.js';
import { decodeEmissionDesignator } from './emissions.js';

/** OSIRIS serves `Array.from(store.values()).slice(0, 500)` — beyond this, entities are dropped arbitrarily. */
export const STREAM_CEILING = 500;

/** The producer tag OSIRIS records against every ingested entity. */
export const SOURCE = 'acma-rrl';

export type Granularity = 'site' | 'emitter';

export interface PolybolosOptions {
    granularity?: Granularity;
    /** What produced this set, shown to the operator. Without it a map of pins cannot explain itself. */
    queryLabel?: string;
    /** Freshness of the mirror at projection time (meta.as_of). */
    asOf?: string;
}

interface Entity {
    id: string;
    name: string;
    domain: string;
    entityType: string;
    position: { lat: number; lng: number };
    threat: string;
    classification: string;
    confidence: number;
    properties: Record<string, string | number | boolean | null>;
}

function idx(lower: string[], ...names: string[]): number {
    for (const n of names) {
        const i = lower.indexOf(n);
        if (i >= 0) return i;
    }
    return -1;
}

/** A coordinate pair, or null when unusable. Zero is legitimate and is kept. */
function toLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
    const y = Number(lat);
    const x = Number(lng);
    if (lat === null || lat === undefined || lat === '' || Number.isNaN(y)) return null;
    if (lng === null || lng === undefined || lng === '' || Number.isNaN(x)) return null;
    if (y < -90 || y > 90 || x < -180 || x > 180) return null;
    return { lat: y, lng: x };
}

function bandFlags(freqHz: number | null): Record<string, boolean> {
    const f = freqHz ?? -1;
    return {
        band_hf:  f >= 3e6  && f < 30e6,
        band_vhf: f >= 30e6 && f < 300e6,
        band_uhf: f >= 300e6 && f < 3e9,
        band_shf: f >= 3e9  && f < 30e9,
    };
}

/** Coarse modulation group from an emission designator, e.g. '16K0F3E' → 'angle'. */
function emissionClass(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const decoded = decodeEmissionDesignator(raw);
    return decoded.modulation?.group ?? null;
}

function scalar(v: unknown): string | number | boolean | null {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    return String(v);
}

export function generatePolybolos(
    columns: string[],
    rows: unknown[][],
    opts: PolybolosOptions = {},
    stats?: ExportStats,
): string {
    const granularity = opts.granularity ?? 'site';
    const lower = columns.map(c => c.toLowerCase());

    const latI  = idx(lower, 'latitude');
    const lngI  = idx(lower, 'longitude');
    const siteI = idx(lower, 'site_id');
    const nameI = idx(lower, 'site_name', 'name');
    const freqI = idx(lower, 'frequency');
    const emisI = idx(lower, 'emission');
    const svcI  = idx(lower, 'sv_name', 'service');
    const typeI = idx(lower, 'licence_type_name');
    const statI = idx(lower, 'status');

    if (latI < 0 || lngI < 0) {
        throw new Error(
            'Result set has no LATITUDE and LONGITUDE columns. Re-run the query joining site to get coordinates.',
        );
    }
    if (granularity === 'site' && siteI < 0) {
        throw new Error('Site-level projection needs a SITE_ID column. Select s.site_id, or use granularity "emitter".');
    }

    const entities = granularity === 'site'
        ? projectSites({ rows, latI, lngI, siteI, nameI, freqI, svcI, typeI, statI, stats })
        : projectEmitters({ columns, rows, lower, latI, lngI, nameI, freqI, emisI, svcI, typeI, statI, stats });

    if (entities.length > STREAM_CEILING) {
        throw new Error(
            `Projection produced ${entities.length} entities, over the OSIRIS stream ceiling of ${STREAM_CEILING}. ` +
            `Beyond that, OSIRIS drops entities arbitrarily. Narrow the query, or use granularity "site" to roll devices up.`,
        );
    }

    const provenance = {
        ...(opts.queryLabel !== undefined ? { query_label: opts.queryLabel } : {}),
        ...(opts.asOf !== undefined ? { as_of: opts.asOf } : {}),
    };
    for (const e of entities) Object.assign(e.properties, provenance);

    return JSON.stringify({ source: SOURCE, entities }, null, 2) + '\n';
}
```

Then the two projectors in the same file:

```typescript
/** Unanimous value across a group, or 'mixed'. Null when the column is absent. */
function agree(values: Array<string | number | boolean | null>): string | number | boolean | null {
    const present = values.filter(v => v !== null && v !== '');
    if (present.length === 0) return null;
    const first = present[0]!;
    return present.every(v => v === first) ? first : 'mixed';
}

interface SiteArgs {
    rows: unknown[][]; latI: number; lngI: number; siteI: number; nameI: number;
    freqI: number; svcI: number; typeI: number; statI: number; stats?: ExportStats;
}

function projectSites(a: SiteArgs): Entity[] {
    const groups = new Map<string, unknown[][]>();

    for (const row of a.rows) {
        const pos = toLatLng(row[a.latI], row[a.lngI]);
        const siteId = row[a.siteI];
        if (!pos || siteId === null || siteId === undefined || siteId === '') {
            if (a.stats) a.stats.skipped++;
            continue;
        }
        const key = String(siteId);
        const bucket = groups.get(key);
        if (bucket) bucket.push(row); else groups.set(key, [row]);
    }

    const out: Entity[] = [];
    for (const [siteId, group] of groups) {
        const first = group[0]!;
        const pos = toLatLng(first[a.latI], first[a.lngI])!;

        const bands = { band_hf: false, band_vhf: false, band_uhf: false, band_shf: false };
        for (const row of group) {
            const f = a.freqI >= 0 ? Number(row[a.freqI]) : NaN;
            const flags = bandFlags(Number.isNaN(f) ? null : f);
            for (const k of Object.keys(bands) as Array<keyof typeof bands>) {
                if (flags[k]) bands[k] = true;
            }
        }

        const pick = (i: number) => i >= 0 ? agree(group.map(r => scalar(r[i]))) : null;

        out.push({
            id: siteId,
            name: a.nameI >= 0 ? String(first[a.nameI] ?? `SITE-${siteId}`) : `SITE-${siteId}`,
            domain: 'LAND',
            entityType: 'FACILITY',
            position: pos,
            threat: 'NONE',              // never invent risk labels for civil licensees
            classification: 'UNCLASSIFIED',
            confidence: 1.0,             // the RRL is the authoritative register
            properties: {
                site_id: siteId,
                device_count: group.length,
                service: pick(a.svcI),
                licence_type: pick(a.typeI),
                status: pick(a.statI),
                ...bands,
            },
        });
    }
    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/polybolos.test.ts`
Expected: PASS for every site-level test. The emitter tests do not exist yet.

Note: `projectEmitters` is referenced but not yet written — stub it as `function projectEmitters(_a: unknown): Entity[] { throw new Error('not implemented'); }` so the file compiles. Task 3 replaces the stub.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. If `exactOptionalPropertyTypes` complains, the offender is an optional field set to `undefined` — make it absent instead (see the `provenance` spread).

- [ ] **Step 6: Commit**

```bash
git add src/polybolos.ts tests/polybolos.test.ts
git commit -m "feat(polybolos): site-level entity projection

Projects a cached result into Polybolos entities for the OSIRIS ingest
API, one entity per site with devices rolled up. Natural-key ids so
re-queries converge in a store with no delete; flat scalar properties so
MapLibre filters and category_counts can drive the operator controls."
```

---

## Task 3: Emitter-level granularity

**Files:**
- Modify: `src/polybolos.ts` (replace the `projectEmitters` stub)
- Modify: `tests/polybolos.test.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `granularity: 'emitter'` — one entity per device row, keyed on `SDD_ID` (the `device_details` primary key per `PK_BY_TABLE` in `src/sync.ts`).

- [ ] **Step 1: Write the failing test**

Append to `tests/polybolos.test.ts`:

```typescript
const ECOLS = ['SDD_ID', 'LICENCE_NO', 'SITE_NAME', 'LATITUDE', 'LONGITUDE', 'FREQUENCY', 'EMISSION', 'SV_NAME'];

describe('generatePolybolos — emitter level', () => {
    const one = [[901, '1234567/1', 'Mt Coot-tha', -27.47, 152.95, 150000000, '16K0F3E', 'Land Mobile']];

    it('uses the SIGNAL/EW ontology slots', () => {
        const p = parse(ECOLS, one, { granularity: 'emitter' });
        expect(p.entities[0].entityType).toBe('SIGNAL');
        expect(p.entities[0].domain).toBe('EW');
    });

    it('keys on SDD_ID, the device_details primary key', () => {
        const p = parse(ECOLS, one, { granularity: 'emitter' });
        expect(p.entities[0].id).toBe('901');
    });

    it('does NOT collapse devices — one row is one entity', () => {
        const rows = [
            [901, '1234567/1', 'Shared', -27, 153, 150000000, '16K0F3E', 'Land Mobile'],
            [902, '1234567/1', 'Shared', -27, 153, 450000000, '16K0F3E', 'Land Mobile'],
        ];
        const p = parse(ECOLS, rows, { granularity: 'emitter' });
        expect(p.entities).toHaveLength(2);
    });

    it('carries the exact frequency, not a band bucket', () => {
        const p = parse(ECOLS, one, { granularity: 'emitter' });
        expect(p.entities[0].properties.frequency_hz).toBe(150000000);
    });

    it('derives a coarse emission class from the designator', () => {
        const p = parse(ECOLS, one, { granularity: 'emitter' });
        // 16K0F3E → F is frequency modulation, whose group is 'angle'.
        expect(p.entities[0].properties.emission_class).toBe('angle');
    });

    it('tolerates a missing or malformed emission designator', () => {
        const rows = [[901, '1234567/1', 'A', -27, 153, 150000000, '', 'Land Mobile']];
        const p = parse(ECOLS, rows, { granularity: 'emitter' });
        expect(p.entities[0].properties.emission_class).toBeNull();
    });

    it('requires SDD_ID so ids stay stable across pushes', () => {
        const cols = ['LATITUDE', 'LONGITUDE', 'FREQUENCY'];
        expect(() => generatePolybolos(cols, [[-27, 153, 150000000]], { granularity: 'emitter' }))
            .toThrow(/SDD_ID/i);
    });

    it('emits only scalar properties', () => {
        const p = parse(ECOLS, one, { granularity: 'emitter' });
        for (const value of Object.values(p.entities[0].properties)) {
            expect(typeof value === 'object' && value !== null).toBe(false);
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/polybolos.test.ts -t 'emitter level'`
Expected: FAIL — `not implemented`.

- [ ] **Step 3: Replace the stub**

In `src/polybolos.ts`, add `const sddI = idx(lower, 'sdd_id');` alongside the other index lookups, add the guard beside the site-level one:

```typescript
    if (granularity === 'emitter' && sddI < 0) {
        throw new Error('Emitter-level projection needs an SDD_ID column (the device_details primary key). Select d.sdd_id.');
    }
```

Pass `sddI` through, and replace the stub with:

```typescript
interface EmitterArgs {
    columns: string[]; rows: unknown[][]; lower: string[];
    latI: number; lngI: number; sddI: number; nameI: number; freqI: number;
    emisI: number; svcI: number; typeI: number; statI: number; stats?: ExportStats;
}

function projectEmitters(a: EmitterArgs): Entity[] {
    // Columns already represented as first-class properties are not repeated in the passthrough.
    const claimed = new Set([a.latI, a.lngI, a.sddI, a.freqI, a.emisI, a.svcI, a.typeI, a.statI]);

    const out: Entity[] = [];
    for (const row of a.rows) {
        const pos = toLatLng(row[a.latI], row[a.lngI]);
        const sddId = row[a.sddI];
        if (!pos || sddId === null || sddId === undefined || sddId === '') {
            if (a.stats) a.stats.skipped++;
            continue;
        }

        const freq = a.freqI >= 0 ? Number(row[a.freqI]) : NaN;
        const freqHz = Number.isNaN(freq) ? null : freq;

        const properties: Record<string, string | number | boolean | null> = {
            sdd_id: scalar(sddId),
            frequency_hz: freqHz,
            emission_class: a.emisI >= 0 ? emissionClass(row[a.emisI]) : null,
            service: a.svcI >= 0 ? scalar(row[a.svcI]) : null,
            licence_type: a.typeI >= 0 ? scalar(row[a.typeI]) : null,
            status: a.statI >= 0 ? scalar(row[a.statI]) : null,
            ...bandFlags(freqHz),
        };

        // Anything else the query selected rides along as a flat scalar.
        for (let i = 0; i < a.columns.length; i++) {
            if (claimed.has(i)) continue;
            properties[a.lower[i]!] = scalar(row[i]);
        }

        out.push({
            id: String(sddId),
            name: freqHz !== null
                ? `${(freqHz / 1e6).toFixed(4)} MHz${a.svcI >= 0 ? ` ${String(row[a.svcI] ?? '')}`.trimEnd() : ''}`
                : `DEVICE-${String(sddId)}`,
            domain: 'EW',
            entityType: 'SIGNAL',
            position: pos,
            threat: 'NONE',
            classification: 'UNCLASSIFIED',
            confidence: 1.0,
            properties,
        });
    }
    return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/polybolos.test.ts`
Expected: PASS, both describe blocks.

- [ ] **Step 5: Typecheck and full suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean, all green.

- [ ] **Step 6: Commit**

```bash
git add src/polybolos.ts tests/polybolos.test.ts
git commit -m "feat(polybolos): emitter-level granularity

One entity per device keyed on SDD_ID, using the SIGNAL/EW ontology slots
and carrying exact frequency. Site rollup cannot answer a continuous
frequency filter honestly — its device counts go wrong the moment the
range narrows — so the exact granularity ships alongside it."
```

---

## Task 4: Register `export_polybolos` as an MCP tool

**Files:**
- Modify: `src/index.ts` — `TOOL_DOCS`, `TOOL_CATALOG`, one handler, and the `_hints` chain.

**Interfaces:**
- Consumes: `generatePolybolos`, `STREAM_CEILING` from Tasks 2–3.
- Produces: the `export_polybolos` tool. Task 5 adds `push_to_osiris` beside it.

**Note on the catalog:** `TOOL_CATALOG` is a module-level const in `src/index.ts`, served verbatim by `tools/list` and used to build the startup banner. Adding an entry updates both — do not hand-edit the banner.

- [ ] **Step 0: Add the imports**

At the top of `src/index.ts`, beside the other exporter imports:

```typescript
import { generatePolybolos, type PolybolosOptions } from './polybolos.js';
```

`ExportStats` was already imported in Task 1.

- [ ] **Step 1: Add the TOOL_DOCS entry**

In `src/index.ts`, beside the other exporters. **`fullDescription` must not contain a backtick** — a markdown code span silently terminates the template literal and produces TS1005 errors far from the edit.

```typescript
    export_polybolos: {
        summary: 'Project a cached result into Polybolos entities for an OSIRIS common operating picture. [geospatial]',
        tags: ['geospatial', 'export'],
        fullDescription: `
### [Polybolos Export]
Projects a cached query result into Polybolos entities for the OSIRIS ingest API.

## Usage
- Run a query first; pass its result_id here.
- granularity 'site' (default) emits one entity per site with devices rolled up.
  Use it for "who is transmitting near here" — it keeps pin counts low.
- granularity 'emitter' emits one entity per device, carrying exact frequency.
  Use it when frequency is the axis of interest.
- The result must carry LATITUDE and LONGITUDE columns. Site level also needs
  SITE_ID; emitter level needs SDD_ID.
- Output is the ingest payload as JSON, WITHOUT the API key. Use push_to_osiris
  to send it, or save it and post it yourself.

## Input
- result_id: from a previous query response
- granularity: 'site' or 'emitter'
- query_label: short description of what this set represents, shown to the map operator
`,
    },
```

- [ ] **Step 2: Add the TOOL_CATALOG entry**

Beside the `export_qml` entry:

```typescript
    {
        name: 'export_polybolos',
        description: TOOL_DOCS.export_polybolos!.summary,
        inputSchema: {
            type: 'object',
            properties: {
                result_id: { type: 'string', description: 'The result_id from a previous query response' },
                granularity: { type: 'string', enum: ['site', 'emitter'], description: "'site' (default) rolls devices up per site; 'emitter' is one entity per device" },
                query_label: { type: 'string', description: 'Short description of what this set represents, shown to the map operator' },
            },
            required: ['result_id'],
        },
    },
```

- [ ] **Step 3: Add the handler**

Beside the `export_qml` handler. Read the freshness stamp from `meta.as_of` so the operator can see it:

```typescript
        if (name === 'export_polybolos') {
            const id = args?.result_id as string | undefined;
            if (!id) {
                return { content: [{ type: 'text', text: 'Missing required parameter: result_id' }], isError: true };
            }
            const entry = resultCache.get(id);
            if (!entry) {
                return {
                    content: [{ type: 'text', text: `Result not found or expired (result_id: ${id}). Please re-run the original query to get a fresh result_id.` }],
                    isError: true,
                };
            }
            const opts: PolybolosOptions = {};
            if (args?.granularity === 'site' || args?.granularity === 'emitter') opts.granularity = args.granularity;
            if (typeof args?.query_label === 'string') opts.queryLabel = args.query_label;
            const asOf = readAsOf();
            if (asOf) opts.asOf = asOf;

            const stats: ExportStats = { skipped: 0 };
            try {
                const doc = generatePolybolos(entry.columns, entry.rows, opts, stats);
                const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: doc }];
                if (stats.skipped > 0) {
                    content.push({ type: 'text', text: `Note: ${stats.skipped} row(s) could not be projected and were omitted.` });
                }
                return { content };
            } catch (e) {
                return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
            }
        }
```

Add a small helper near the other DB access, reusing the existing `openDb()`:

```typescript
/** meta.as_of — how fresh the mirror is. Null when the table is absent or empty. */
function readAsOf(): string | null {
    try {
        const db = openDb();
        try {
            const row = db.prepare("SELECT value FROM meta WHERE key = 'as_of'").get() as { value?: string } | undefined;
            return row?.value ?? null;
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}
```

**Verify the `meta` key name before trusting this** — run `sqlite3 data/acma.db "SELECT * FROM meta;"` and adjust if the schema differs. Do not guess.

- [ ] **Step 4: Add the follow-up hint**

Find where geospatial results build `_hints` (search `export_geojson` in the hints arrays — there are three such sites). Add beside the existing entries:

```typescript
                        { tool: 'export_polybolos', args: { result_id: resultId }, why: 'OSIRIS map layer: push this set to the common operating picture' },
```

- [ ] **Step 5: Verify the tool is served and the banner updated**

```bash
npm run dev > scratch/dev.log 2>&1 &
sleep 8
grep '^Tools (' scratch/dev.log
```
Expected: `Tools (21):` including `export_polybolos`.

Then confirm over the wire:

```bash
SID=$(curl -si -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"p","version":"1"}}}' \
  | grep -i '^mcp-session-id' | tr -d '\r' | cut -d' ' -f2)
curl -s -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null
curl -s -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -c export_polybolos
```
Expected: `1`. Then `pkill -f "tsx src/index.ts"`.

- [ ] **Step 6: Full suite and commit**

Run: `npx tsc --noEmit && npm test`

```bash
git add src/index.ts
git commit -m "feat(polybolos): expose export_polybolos as an MCP tool

Registers the projection in TOOL_CATALOG and TOOL_DOCS, stamps entities
with meta.as_of, and adds the follow-up hint from geospatial results."
```

---

## Task 5: `push_to_osiris`

**Files:**
- Create: `src/osiris.ts`
- Create: `tests/osiris.test.ts`
- Modify: `src/index.ts` (tool registration + handler)
- Modify: `README.md` (the environment variable table)

**Interfaces:**
- Consumes: `generatePolybolos` from Tasks 2–3.
- Produces: `export async function pushToOsiris(payloadJson: string): Promise<IngestResult>` where `IngestResult` is `{ accepted: number; rejected: number; errors: string[] }`.

**Config:** `OSIRIS_URL` (base origin, no path — e.g. `http://fpga-workstation.local:3001`) and `OSIRIS_INGEST_KEY` (must equal the far side's `SDK_INGEST_KEY`).

- [ ] **Step 1: Write the failing test**

Create `tests/osiris.test.ts`:

```typescript
import { jest } from '@jest/globals';
import axios from 'axios';
import { pushToOsiris } from '../src/osiris.js';

const PAYLOAD = JSON.stringify({ source: 'acma-rrl', entities: [{ id: '1' }] });

describe('pushToOsiris', () => {
    const env = process.env;
    beforeEach(() => {
        process.env = { ...env, OSIRIS_URL: 'http://osiris.test:3001', OSIRIS_INGEST_KEY: 'test-key' };
    });
    afterEach(() => { process.env = env; jest.restoreAllMocks(); });

    it('posts to /api/sdk/ingest with the key injected into the body', async () => {
        const spy = jest.spyOn(axios, 'post').mockResolvedValue({
            status: 200, data: { accepted: 1, rejected: 0, errors: [] },
        } as never);

        await pushToOsiris(PAYLOAD);

        expect(spy).toHaveBeenCalledTimes(1);
        const [url, body] = spy.mock.calls[0]!;
        expect(url).toBe('http://osiris.test:3001/api/sdk/ingest');
        expect((body as any).apiKey).toBe('test-key');
        expect((body as any).source).toBe('acma-rrl');
    });

    it('fails clearly when the key is not configured', async () => {
        delete process.env.OSIRIS_INGEST_KEY;
        await expect(pushToOsiris(PAYLOAD)).rejects.toThrow(/OSIRIS_INGEST_KEY/);
    });

    it('fails clearly when the URL is not configured', async () => {
        delete process.env.OSIRIS_URL;
        await expect(pushToOsiris(PAYLOAD)).rejects.toThrow(/OSIRIS_URL/);
    });

    it('explains a 503 as ingestion being disabled on the OSIRIS side', async () => {
        jest.spyOn(axios, 'post').mockRejectedValue({
            response: { status: 503, data: { errors: ['Ingest endpoint disabled — SDK_INGEST_KEY not configured'] } },
        } as never);
        await expect(pushToOsiris(PAYLOAD)).rejects.toThrow(/SDK_INGEST_KEY/);
    });

    it('explains a 401 as a key mismatch', async () => {
        jest.spyOn(axios, 'post').mockRejectedValue({
            response: { status: 401, data: { errors: ['Invalid API key'] } },
        } as never);
        await expect(pushToOsiris(PAYLOAD)).rejects.toThrow(/does not match/i);
    });

    it('never puts the key in the thrown message', async () => {
        jest.spyOn(axios, 'post').mockRejectedValue({ response: { status: 401, data: {} } } as never);
        await expect(pushToOsiris(PAYLOAD)).rejects.not.toThrow(/test-key/);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/osiris.test.ts`
Expected: FAIL — cannot find module `../src/osiris.js`.

- [ ] **Step 3: Implement**

Create `src/osiris.ts`:

```typescript
/**
 * Outbound push to an OSIRIS instance's Polybolos ingest endpoint.
 *
 * The only egress in this codebase. The ingest key travels in the JSON body —
 * not a header — because that is what OSIRIS validates; see
 * docs/osiris-acma-bridge.md. It is read from the environment and must never
 * reach a tool argument, a tool response, or a log line.
 */
import axios from 'axios';

export interface IngestResult {
    accepted: number;
    rejected: number;
    errors: string[];
}

export async function pushToOsiris(payloadJson: string): Promise<IngestResult> {
    const base = process.env.OSIRIS_URL;
    const key = process.env.OSIRIS_INGEST_KEY;
    if (!base) throw new Error('OSIRIS_URL is not set. Set it to the OSIRIS origin, e.g. http://host:3001');
    if (!key) throw new Error('OSIRIS_INGEST_KEY is not set. It must equal the SDK_INGEST_KEY configured on the OSIRIS side.');

    const payload = JSON.parse(payloadJson) as { source: string; entities: unknown[] };
    const url = `${base.replace(/\/+$/, '')}/api/sdk/ingest`;

    try {
        const res = await axios.post(url, { ...payload, apiKey: key }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
        });
        return res.data as IngestResult;
    } catch (e) {
        const status = (e as { response?: { status?: number } }).response?.status;
        if (status === 503) {
            throw new Error(
                'OSIRIS refused the push: ingestion is disabled there. Set SDK_INGEST_KEY in the OSIRIS environment and restart it.',
            );
        }
        if (status === 401) {
            throw new Error('OSIRIS rejected the key: OSIRIS_INGEST_KEY does not match the SDK_INGEST_KEY configured there.');
        }
        if (status === 400) {
            throw new Error('OSIRIS rejected the payload structure. It requires source, apiKey and an entities array.');
        }
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(`Could not reach OSIRIS at ${url}: ${reason}`);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/osiris.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Register the tool**

Add the import at the top of `src/index.ts`:

```typescript
import { pushToOsiris } from './osiris.js';
```

Add to `TOOL_DOCS` (no backticks inside `fullDescription`):

```typescript
    push_to_osiris: {
        summary: 'Push a cached result to an OSIRIS common operating picture as Polybolos entities. [geospatial]',
        tags: ['geospatial', 'export'],
        fullDescription: `
### [Push to OSIRIS]
Projects a cached result and pushes it to an OSIRIS instance's Polybolos ingest
endpoint, so the rows appear on its map.

## Usage
- Requires OSIRIS_URL and OSIRIS_INGEST_KEY in the server environment. The key
  must equal the SDK_INGEST_KEY configured on the OSIRIS side.
- Entity ids are natural keys, so pushing the same area twice updates the
  existing entities rather than duplicating them.
- OSIRIS has no delete endpoint and its stream serves at most 500 entities, so
  the projection refuses a set larger than that. Narrow the query instead.
- Returns how many entities OSIRIS accepted and rejected.

## Input
- result_id: from a previous query response
- granularity: 'site' (default) or 'emitter'
- query_label: short description of what this set represents, shown to the map operator
`,
    },
```

Add to `TOOL_CATALOG`:

```typescript
    {
        name: 'push_to_osiris',
        description: TOOL_DOCS.push_to_osiris!.summary,
        inputSchema: {
            type: 'object',
            properties: {
                result_id: { type: 'string', description: 'The result_id from a previous query response' },
                granularity: { type: 'string', enum: ['site', 'emitter'], description: "'site' (default) rolls devices up per site; 'emitter' is one entity per device" },
                query_label: { type: 'string', description: 'Short description of what this set represents, shown to the map operator' },
            },
            required: ['result_id'],
        },
    },
```

Add the handler beside `export_polybolos`:

```typescript
        if (name === 'push_to_osiris') {
            const id = args?.result_id as string | undefined;
            if (!id) {
                return { content: [{ type: 'text', text: 'Missing required parameter: result_id' }], isError: true };
            }
            const entry = resultCache.get(id);
            if (!entry) {
                return {
                    content: [{ type: 'text', text: `Result not found or expired (result_id: ${id}). Please re-run the original query to get a fresh result_id.` }],
                    isError: true,
                };
            }
            const opts: PolybolosOptions = {};
            if (args?.granularity === 'site' || args?.granularity === 'emitter') opts.granularity = args.granularity;
            if (typeof args?.query_label === 'string') opts.queryLabel = args.query_label;
            const asOf = readAsOf();
            if (asOf) opts.asOf = asOf;

            const stats: ExportStats = { skipped: 0 };
            try {
                const doc = generatePolybolos(entry.columns, entry.rows, opts, stats);
                const result = await pushToOsiris(doc);
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ ...result, skipped: stats.skipped }, null, 2),
                    }],
                };
            } catch (e) {
                return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
            }
        }
```

- [ ] **Step 6: Document the config**

Add to the environment-variable table in `README.md` and `CLAUDE.md`:

| Variable | Purpose |
|----------|---------|
| `OSIRIS_URL` | Base origin of an OSIRIS instance for `push_to_osiris`, e.g. `http://host:3001`. Unset disables the tool. |
| `OSIRIS_INGEST_KEY` | Shared secret for the OSIRIS Polybolos ingest endpoint. Must equal `SDK_INGEST_KEY` on that instance. |

- [ ] **Step 7: Check the secret scanner**

Run: `npm run scan:secrets:tree && npm run scan:secrets:selftest`
Expected: no leaks, and the self-test passes both its positive and negative cases. If a test fixture key trips a rule, add a narrow allowlist entry to `.gitleaks.toml` rather than loosening a rule — then re-run the self-test, because a malformed config makes gitleaks report "no leaks found" and exit 0.

- [ ] **Step 8: Full suite and commit**

Run: `npx tsc --noEmit && npm test`
Expected: 22 tools served; all tests green.

```bash
git add src/osiris.ts tests/osiris.test.ts src/index.ts README.md CLAUDE.md
git commit -m "feat(polybolos): add push_to_osiris

Posts a projected result to an OSIRIS instance's Polybolos ingest
endpoint. Config is env-only; the key travels in the request body as
OSIRIS requires and never appears in a tool argument, response or error."
```

---

## Done when

- `npm test` green; `npx tsc --noEmit` clean.
- `tools/list` serves 22 tools; the startup banner agrees with it.
- The three pre-existing exporters report skipped rows; the new one does too.
- A real query against the live DB projects to a payload that `jq` parses, with `apiKey` absent.
- No secret appears in any committed file, tool response, or log line.

## Not in this plan

- The OSIRIS-side consumer and RF control group — **Plan B**, blocked on this plan's output.
- Link analysis and emcomms rollup — separate specs entirely.
- Upstream OSIRIS bug fixes (no delete/TTL, the `slice(0, 500)`, the falsy-zero latitude).
