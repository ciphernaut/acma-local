/**
 * Search device_details by decoded emission descriptor.
 *
 * Resolves human-friendly inputs (code letters or description substrings) to
 * concrete code letters via resolveEmissionCode, builds a SUBSTR-based WHERE
 * against device_details.EMISSION, and joins through licence + site for the
 * supporting columns.
 */
import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import {
    CODE_TABLES,
    resolveEmissionCode,
    parseEmissionBandwidth,
    type EmissionField,
    type ResolveResult,
} from './emissions.js';

export interface EmissionFilters {
    modulation?: string;
    signal_nature?: string;
    info_type?: string;
    signal_detail?: string;
    multiplex?: string;
    min_bandwidth_hz?: number;
    max_bandwidth_hz?: number;
    licence_no?: string;
    state?: string;
    limit?: number;
}

export interface EmissionSearchRow {
    LICENCE_NO: string;
    CLIENT_NO: number | null;
    FREQUENCY: number | null;
    EMISSION: string;
    decoded: {
        bandwidth_hz: number | null;
        bandwidth_display: string | null;
        modulation_code: string;
        modulation_description: string;
        info_type_code: string;
        info_type_description: string;
    };
    SITE_ID: string | null;
    STATE: string | null;
    TRANSMITTER_POWER: number | null;
    TRANSMITTER_POWER_UNIT: string | null;
}

export interface EmissionSearchResult {
    rows: EmissionSearchRow[];
    truncated: boolean;
    resolved_filters: Partial<Record<EmissionField, { code: string; description: string }>>;
    _error?: string;
}

// 1-based SUBSTR positions within the 7–9 character emission designator.
const FILTER_POSITION: Record<EmissionField, number> = {
    modulation:    5,
    signal_nature: 6,
    info_type:     7,
    signal_detail: 8,
    multiplex:     9,
};

function describeResolveError(field: EmissionField, input: string, r: ResolveResult): string {
    if (r.kind === 'unknown')   return `Unknown ${field} code letter: "${input}".`;
    if (r.kind === 'not_found') return `No ${field} description matches "${input}".`;
    if (r.kind === 'ambiguous') {
        const list = r.candidates.map(c => `${c.code} (${c.description})`).join(', ');
        return `${field} "${input}" is ambiguous: ${list}. Use a more specific term or pass the code letter directly.`;
    }
    return `Unhandled ${field} resolution outcome.`;
}

export function searchDevicesByEmission(
    db: BetterSqlite3Database,
    filters: EmissionFilters,
): EmissionSearchResult {
    const resolved: Partial<Record<EmissionField, { code: string; description: string }>> = {};

    const fields: EmissionField[] = ['modulation', 'signal_nature', 'info_type', 'signal_detail', 'multiplex'];
    for (const f of fields) {
        const input = filters[f];
        if (input === undefined || input === '') continue;
        const r = resolveEmissionCode(db, f, input);
        if (r.kind !== 'ok') {
            return {
                rows: [],
                truncated: false,
                resolved_filters: resolved,
                _error: describeResolveError(f, input, r),
            };
        }
        resolved[f] = { code: r.code, description: r.description };
    }

    const hasResolved = Object.keys(resolved).length > 0;
    const hasBandwidthBounds =
        filters.min_bandwidth_hz !== undefined || filters.max_bandwidth_hz !== undefined;
    const hasDirectFilters = filters.licence_no !== undefined || filters.state !== undefined;

    if (!hasResolved && !hasBandwidthBounds && !hasDirectFilters) {
        return {
            rows: [],
            truncated: false,
            resolved_filters: resolved,
            _error: 'At least one filter is required.',
        };
    }

    const where: string[] = ['LENGTH(TRIM(d.EMISSION)) >= 7'];
    const params: unknown[] = [];

    for (const f of fields) {
        const got = resolved[f];
        if (!got) continue;
        where.push(`SUBSTR(TRIM(d.EMISSION), ${FILTER_POSITION[f]}, 1) = ?`);
        params.push(got.code);
    }

    if (filters.licence_no !== undefined) {
        where.push('d.LICENCE_NO = ?');
        params.push(filters.licence_no);
    }

    if (filters.state !== undefined) {
        where.push('s.STATE = ?');
        params.push(filters.state);
    }

    const cap = Math.min(Math.max(1, filters.limit ?? 100), 500);

    const sql = `
        SELECT
            d.LICENCE_NO,
            l.CLIENT_NO AS CLIENT_NO,
            d.FREQUENCY,
            d.EMISSION,
            d.SITE_ID,
            s.STATE AS STATE,
            d.TRANSMITTER_POWER,
            d.TRANSMITTER_POWER_UNIT
        FROM device_details d
        LEFT JOIN licence l ON l.LICENCE_NO = d.LICENCE_NO
        LEFT JOIN site s ON s.SITE_ID = d.SITE_ID
        WHERE ${where.join(' AND ')}
        ORDER BY d.LICENCE_NO, d.SDD_ID
        LIMIT ?
    `;

    const rawRows = db.prepare(sql).all(...params, cap + 1) as Array<Record<string, unknown>>;
    const rawTruncated = rawRows.length > cap;
    const sliced = rawTruncated ? rawRows.slice(0, cap) : rawRows;

    // Decorate each row with decoded fields, and apply bandwidth bounds post-query
    // (cheaper than a SQL expression and lets us skip unparseable rows gracefully).
    const enriched: EmissionSearchRow[] = [];
    for (const row of sliced) {
        const emission = String(row['EMISSION'] ?? '').trim();
        const modCode  = emission.slice(4, 5);
        const infoCode = emission.slice(6, 7);

        const modEntry  = (CODE_TABLES.modulation as Record<string, { description: string }>)[modCode];
        const infoEntry = (CODE_TABLES.info_type   as Record<string, { description: string }>)[infoCode];

        let bandwidth_hz: number | null = null;
        let bandwidth_display: string | null = null;
        try {
            const parsed = parseEmissionBandwidth(emission.slice(0, 4));
            bandwidth_hz      = parsed.value_hz;
            bandwidth_display = parsed.display;
        } catch { /* unparseable; keep nulls */ }

        if (
            filters.min_bandwidth_hz !== undefined &&
            (bandwidth_hz === null || bandwidth_hz < filters.min_bandwidth_hz)
        ) continue;
        if (
            filters.max_bandwidth_hz !== undefined &&
            (bandwidth_hz === null || bandwidth_hz > filters.max_bandwidth_hz)
        ) continue;

        enriched.push({
            LICENCE_NO:              String(row['LICENCE_NO'] ?? ''),
            CLIENT_NO:               (row['CLIENT_NO'] as number | null) ?? null,
            FREQUENCY:               (row['FREQUENCY']  as number | null) ?? null,
            EMISSION:                String(row['EMISSION'] ?? ''),
            decoded: {
                bandwidth_hz,
                bandwidth_display,
                modulation_code:        modCode,
                modulation_description: modEntry?.description ?? '',
                info_type_code:         infoCode,
                info_type_description:  infoEntry?.description ?? '',
            },
            SITE_ID:                 (row['SITE_ID']                as string | null) ?? null,
            STATE:                   (row['STATE']                  as string | null) ?? null,
            TRANSMITTER_POWER:       (row['TRANSMITTER_POWER']      as number | null) ?? null,
            TRANSMITTER_POWER_UNIT:  (row['TRANSMITTER_POWER_UNIT'] as string | null) ?? null,
        });
    }

    // Truncation semantics: if the raw SQL hit the cap+1 sentinel, we know
    // there are more matching rows than fit. When bandwidth filtering is
    // active, JS-side rejection may reduce enriched.length below cap, but
    // we still can't claim the result is complete — there may be matching
    // rows beyond the fetch window. Err on the side of over-reporting.
    const hasBandwidthFilter = filters.min_bandwidth_hz !== undefined || filters.max_bandwidth_hz !== undefined;
    const truncated = rawTruncated && (enriched.length >= cap || hasBandwidthFilter);

    return { rows: enriched, truncated, resolved_filters: resolved };
}
