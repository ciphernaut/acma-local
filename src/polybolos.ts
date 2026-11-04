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
    /**
     * Producer tag. OSIRIS namespaces stored ids as ext-{source}-{id} and scopes
     * its DELETE endpoint by source, so two producers sharing a name means
     * one producer's cleanup destroys the other's estate. Override when pushing a test set
     * alongside a live one.
     */
    source?: string;
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

/** `null`/`undefined`/`''` are absent, not zero — `Number(null)` and `Number('')` are both `0`. */
function toNumberOrNull(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
}

/** A coordinate pair, or null when unusable. Zero is legitimate and is kept. */
function toLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
    const y = toNumberOrNull(lat);
    const x = toNumberOrNull(lng);
    if (y === null || x === null) return null;
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
/**
 * What the emission carries, from the designator's third character, e.g.
 * '16K0F3E' -> 'telephony'.
 *
 * Deliberately an explicit map rather than a slug derived from the ITU
 * descriptions: derivation turns "Combination of the above" and "Cases not
 * otherwise covered" into nothing usable, and "Data transmission, telemetry,
 * telecommand" into data_transmission — worse names for an operator-facing
 * filter. CODE_TABLES in src/emissions.ts remains the source of truth for the
 * CODES; tests/polybolos.test.ts asserts this map covers every one of them, so
 * a code added there fails the suite rather than silently degrading to a letter.
 *
 * Independent of the modulation group: '16K0F3E' (voice) and '16K0F1D' (data)
 * are both angle-modulated, so "is this voice or data" is a different question
 * from "is this FM or AM". Both are cheap, so both are emitted.
 */
export const INFO_SLUG: Record<string, string> = {
    A: 'telegraphy_aural',
    B: 'telegraphy_automatic',
    C: 'facsimile',
    D: 'data',
    E: 'telephony',
    F: 'television',
    N: 'none',
    W: 'combination',
    X: 'other',
};

/**
 * Both emission axes from ONE decode.
 *
 * They were derived separately, so projectSites decoded every designator three
 * times — once for the class rollup, once for the info rollup, once for the
 * flags. At the 50000-row ceiling that is 150k decodes inside a single request.
 */
function decodeEmission(raw: unknown): { klass: string | null; info: string | null } {
    if (typeof raw !== 'string' || raw.trim() === '') return { klass: null, info: null };
    const d = decodeEmissionDesignator(raw);
    const code = d.info_type?.code;
    return { klass: d.modulation?.group ?? null, info: code ? (INFO_SLUG[code] ?? code.toLowerCase()) : null };
}

/** Coarse modulation group, e.g. '16K0F3E' -> 'angle'. */
function emissionClass(raw: unknown): string | null {
    return decodeEmission(raw).klass;
}

/** What the emission carries, e.g. '16K0F3E' -> 'telephony'. */
function emissionInfo(raw: unknown): string | null {
    return decodeEmission(raw).info;
}

/**
 * A service name as a property key: 'PTS 900 MHz' -> 'svc_pts_900_mhz'.
 *
 * One boolean per service, rather than a joined list. A set encoded as an
 * ordered string cannot act as a category — 'Fixed,Land Mobile' and
 * 'Land Mobile,Fixed' describe the same site but count as two, and the
 * category count grows combinatorially with the number of services present.
 */
function serviceKey(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return `svc_${slug}`;
}

/**
 * One boolean per distinct value present in a group, absent meaning false.
 *
 * Used wherever an attribute is set-valued at a site. A scalar rollup of such an
 * attribute can only say 'mixed', which the operator cannot filter on — measured
 * over one region, 43% of sites were 'mixed' on emission type alone.
 */
function presenceFlags(values: unknown[], key: (v: string) => string | null): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const v of values) {
        const k = typeof v === 'string' && v.trim() !== '' ? key(v.trim()) : null;
        if (k) out[k] = true;
    }
    return out;
}

/** svc_* flags for the services present in a group. Absent means false. */
function serviceFlags(values: unknown[]): Record<string, boolean> {
    return presenceFlags(values, v => serviceKey(v));
}

/** emi_* flags for the emission information types present in a group. */
function emissionFlags(values: unknown[]): Record<string, boolean> {
    return presenceFlags(values, v => {
        const info = emissionInfo(v);
        return info ? `emi_${info}` : null;
    });
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
    columns: string[]; lower: string[]; rows: unknown[][]; latI: number; lngI: number; siteI: number; nameI: number;
    freqI: number; emisI: number; svcI: number; typeI: number; statI: number; sddI: number; stats?: ExportStats;
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
            const f = a.freqI >= 0 ? toNumberOrNull(row[a.freqI]) : null;
            const flags = bandFlags(f);
            for (const k of Object.keys(bands) as Array<keyof typeof bands>) {
                if (flags[k]) bands[k] = true;
            }
        }

        const pick = (i: number) => i >= 0 ? agree(group.map(r => scalar(r[i]))) : null;

        const freqs = a.freqI >= 0
            ? group.map(r => toNumberOrNull(r[a.freqI])).filter((n): n is number => n !== null)
            : [];
        const svcFlags = a.svcI >= 0 ? serviceFlags(group.map(r => r[a.svcI])) : {};
        const emiFlags = a.emisI >= 0 ? emissionFlags(group.map(r => r[a.emisI])) : {};

        // device_count is only substantiated when the group actually carries SDD_ID
        // rows to count distinct devices from; row_count is always a true statement
        // regardless of what a join fanned the result set out to.
        let deviceCount: number | undefined;
        if (a.sddI >= 0) {
            const ids = new Set<string>();
            for (const row of group) {
                const v = row[a.sddI];
                if (v !== null && v !== undefined && v !== '') ids.add(String(v));
            }
            deviceCount = ids.size;
        }

        const properties: Record<string, string | number | boolean | null> = {
            site_id: siteId,
            row_count: group.length,
            ...(deviceCount !== undefined ? { device_count: deviceCount } : {}),
            service: pick(a.svcI),
            freq_min_hz: freqs.length ? Math.min(...freqs) : null,
            freq_max_hz: freqs.length ? Math.max(...freqs) : null,
            ...svcFlags,
            ...emiFlags,
            licence_type: pick(a.typeI),
            status: pick(a.statI),
            emission_class: a.emisI >= 0 ? agree(group.map(r => emissionClass(r[a.emisI]))) : null,
            emission_info: a.emisI >= 0 ? agree(group.map(r => emissionInfo(r[a.emisI]))) : null,
            ...bands,
        };

        // Columns the exporter doesn't recognise ride along, aggregated with the same
        // unanimous-value-or-'mixed' rule used for the first-class fields above — silently
        // dropping a column the caller explicitly selected is not acceptable.
        const claimed = new Set([a.latI, a.lngI, a.siteI, a.freqI, a.emisI, a.svcI, a.typeI, a.statI, a.sddI]);
        for (let i = 0; i < a.columns.length; i++) {
            if (claimed.has(i)) continue;
            properties[a.lower[i]!] = pick(i);
        }

        out.push({
            id: siteId,
            name: a.nameI >= 0 ? String(first[a.nameI] ?? `SITE-${siteId}`) : `SITE-${siteId}`,
            domain: 'LAND',
            entityType: 'FACILITY',
            position: pos,
            threat: 'NONE',              // never invent risk labels for civil licensees
            classification: 'UNCLASSIFIED',
            confidence: 1.0,             // the RRL is the authoritative register
            properties,
        });
    }
    return out;
}

interface EmitterArgs {
    columns: string[]; rows: unknown[][]; lower: string[];
    latI: number; lngI: number; sddI: number; freqI: number;
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

        const freqHz = a.freqI >= 0 ? toNumberOrNull(row[a.freqI]) : null;

        const properties: Record<string, string | number | boolean | null> = {
            sdd_id: scalar(sddId),
            frequency_hz: freqHz,
            emission_class: a.emisI >= 0 ? emissionClass(row[a.emisI]) : null,
            emission_info: a.emisI >= 0 ? emissionInfo(row[a.emisI]) : null,
            service: a.svcI >= 0 ? scalar(row[a.svcI]) : null,
            licence_type: a.typeI >= 0 ? scalar(row[a.typeI]) : null,
            status: a.statI >= 0 ? scalar(row[a.statI]) : null,
            ...bandFlags(freqHz),
            ...(a.svcI >= 0 ? serviceFlags([row[a.svcI]]) : {}),
            ...(a.emisI >= 0 ? emissionFlags([row[a.emisI]]) : {}),
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

export function generatePolybolos(
    columns: string[],
    rows: unknown[][],
    opts: PolybolosOptions = {},
    stats?: ExportStats,
): string {
    const granularity = opts.granularity ?? 'site';
    const source = opts.source ?? SOURCE;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source)) {
        throw new Error(
            `Invalid source "${source}". It becomes part of the stored id (ext-{source}-{id}), so it must be alphanumeric with dots, dashes or underscores.`,
        );
    }
    const lower = columns.map(c => c.toLowerCase());

    const latI  = idx(lower, 'latitude');
    const lngI  = idx(lower, 'longitude');
    const siteI = idx(lower, 'site_id');
    const sddI  = idx(lower, 'sdd_id');
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
    if (granularity === 'emitter' && sddI < 0) {
        throw new Error('Emitter-level projection needs an SDD_ID column (the device_details primary key). Select d.sdd_id.');
    }

    const entities = granularity === 'site'
        ? projectSites({ columns, lower, rows, latI, lngI, siteI, nameI, freqI, emisI, svcI, typeI, statI, sddI, ...(stats !== undefined ? { stats } : {}) })
        : projectEmitters({ columns, rows, lower, latI, lngI, sddI, freqI, emisI, svcI, typeI, statI, ...(stats !== undefined ? { stats } : {}) });

    if (entities.length > STREAM_CEILING) {
        // The advice must match the granularity actually in use: telling a caller
        // already at site level to "use granularity site" sends them in a circle.
        const advice = granularity === 'emitter'
            ? 'Narrow the query, or use granularity "site" to roll devices up into one entity per site.'
            : 'Narrow the query — this is already rolled up per site, so there are simply more sites than the ceiling allows.';
        throw new Error(
            `Projection produced ${entities.length} entities, over the OSIRIS stream ceiling of ${STREAM_CEILING}. ` +
            `Beyond that, OSIRIS drops entities arbitrarily. ${advice}`,
        );
    }

    const provenance = {
        ...(opts.queryLabel !== undefined ? { query_label: opts.queryLabel } : {}),
        ...(opts.asOf !== undefined ? { as_of: opts.asOf } : {}),
    };
    for (const e of entities) Object.assign(e.properties, provenance);

    return JSON.stringify({ source, entities }, null, 2) + '\n';
}
