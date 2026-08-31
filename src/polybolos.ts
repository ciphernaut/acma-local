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

/** Coarse modulation group from an emission designator, e.g. '16K0F3E' -> 'angle'. */
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

/** Unanimous value across a group, or 'mixed'. Null when the column is absent or all values are blank. */
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

/** Task 3 replaces this stub with emitter-level projection. */
function projectEmitters(_a: unknown): Entity[] {
    throw new Error('not implemented');
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
        ? projectSites({ rows, latI, lngI, siteI, nameI, freqI, svcI, typeI, statI, ...(stats !== undefined ? { stats } : {}) })
        : projectEmitters({ columns, rows, lower, latI, lngI, nameI, freqI, emisI, svcI, typeI, statI, ...(stats !== undefined ? { stats } : {}) });

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
