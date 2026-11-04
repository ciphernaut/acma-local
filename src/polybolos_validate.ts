/**
 * Contract checks for a Polybolos ingest payload.
 *
 * This exists because two producers now emit `acma-rrl` entities — this repo's
 * exporter and a separate bridging service — and they drifted. Every rule below
 * was written against a defect measured in a live OSIRIS store, not imagined:
 *
 *   - band flags arriving as 1/0 from SQL rather than JSON booleans, so a
 *     MapLibre filter comparing against `true` silently matched nothing;
 *   - `service` joined into an ordered string, turning ~6 real categories into
 *     44 toggle rows, two of which were the same pair in different orders;
 *   - `device_count` exceeding `row_count` in 476 of 477 entities, because the
 *     rollup happened in SQL and the row count was taken after GROUP BY;
 *   - a band flag computed from a column the query never selected, so it read
 *     false for all 477 entities while 83 of them held channels above 3 GHz.
 *
 * Run it before pushing. A payload that fails here will render wrongly or
 * filter to nothing. OSIRIS gained a source-scoped DELETE and a TTL in v1.1.0,
 * so a bad push is now retractable — but only if the producer used its own source.
 */

export interface ValidationIssue {
    severity: 'error' | 'warning';
    rule: string;
    message: string;
    /** Entity id, where the issue belongs to one. */
    entityId?: string;
    /** How many entities show this issue, when it is aggregated. */
    count?: number;
}

export interface ValidationReport {
    ok: boolean;
    entityCount: number;
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
}

/** OSIRIS serves Array.from(store.values()).slice(0, 500) — beyond this, entities vanish arbitrarily. */
export const ENTITY_CEILING = 500;

type Props = Record<string, unknown>;

/**
 * Property prefixes whose values must be real JSON booleans.
 *
 * Listed once: this rule was added for band_ and svc_, then a third family
 * (emi_) shipped without extending the check, so integer emi_ flags passed a
 * gate that integer band_ flags failed. Adding a family means adding it here.
 */
export const BOOLEAN_FLAG_PREFIXES = ['band_', 'svc_', 'emi_'] as const;

function isFlagProperty(key: string): boolean {
    return BOOLEAN_FLAG_PREFIXES.some(prefix => key.startsWith(prefix));
}

function isScalar(v: unknown): boolean {
    return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

export function validatePolybolosPayload(input: string | unknown): ValidationReport {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];
    const err = (rule: string, message: string, extra: Partial<ValidationIssue> = {}) =>
        errors.push({ severity: 'error', rule, message, ...extra });
    const warn = (rule: string, message: string, extra: Partial<ValidationIssue> = {}) =>
        warnings.push({ severity: 'warning', rule, message, ...extra });

    let payload: unknown = input;
    if (typeof input === 'string') {
        try {
            payload = JSON.parse(input);
        } catch (e) {
            return {
                ok: false, entityCount: 0,
                errors: [{ severity: 'error', rule: 'payload/json', message: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` }],
                warnings: [],
            };
        }
    }

    // A payload that parses to a primitive (a truncated file, a bare number) must
    // come back as a report, not a TypeError from the `in` operator below.
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return {
            ok: false, entityCount: 0,
            errors: [{ severity: 'error', rule: 'payload/shape', message: `Payload must be a JSON object with source and entities, received ${Array.isArray(payload) ? 'an array' : payload === null ? 'null' : typeof payload}.` }],
            warnings: [],
        };
    }

    const p = payload as { source?: unknown; apiKey?: unknown; entities?: unknown };
    if (typeof p?.source !== 'string' || p.source === '') {
        err('payload/source', 'Payload needs a non-empty string `source` — OSIRIS namespaces stored ids as ext-{source}-{id}.');
    }
    if ('apiKey' in (p ?? {})) {
        err('payload/no-secret', 'Payload carries an apiKey. The key belongs at send time, never in a document that may be written to disk or logged.');
    }
    if (!Array.isArray(p?.entities)) {
        err('payload/entities', 'Payload needs an `entities` array.');
        return { ok: false, entityCount: 0, errors, warnings };
    }

    const entities = p.entities as Array<{ id?: unknown; position?: unknown; properties?: unknown }>;
    if (entities.length > ENTITY_CEILING) {
        err('payload/ceiling',
            `${entities.length} entities exceeds the ${ENTITY_CEILING}-entity stream ceiling. Beyond it OSIRIS serves only the first 500 and drops the rest arbitrarily.`);
    }

    const seenIds = new Map<string, number>();
    const flagTypes = new Map<string, Set<string>>();
    let missingProvenance = 0;

    for (const e of entities) {
        const id = typeof e?.id === 'string' || typeof e?.id === 'number' ? String(e.id) : '';
        if (id === '') {
            err('entity/id', 'Entity has no id. Ids must be natural keys so a re-push overwrites in place — the store cannot forget.');
            continue;
        }
        seenIds.set(id, (seenIds.get(id) ?? 0) + 1);

        const pos = e?.position as { lat?: unknown; lng?: unknown } | undefined;
        const lat = pos?.lat, lng = pos?.lng;
        if (typeof lat !== 'number' || typeof lng !== 'number' || Number.isNaN(lat) || Number.isNaN(lng)) {
            err('entity/position', 'Entity has no usable position.lat / position.lng.', { entityId: id });
        } else if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            err('entity/position-range', `Position out of range (${lat}, ${lng}).`, { entityId: id });
        }

        const props = (e?.properties ?? {}) as Props;

        for (const [k, v] of Object.entries(props)) {
            if (!isScalar(v)) {
                err('property/scalar',
                    `Property "${k}" is ${Array.isArray(v) ? 'an array' : 'an object'}. MapLibre filters and category counts only read flat values; a nested one disables every control built on it.`,
                    { entityId: id });
            }
            // Track the type each flag-shaped property arrives as, across the whole set.
            if (isFlagProperty(k)) {
                if (!flagTypes.has(k)) flagTypes.set(k, new Set());
                flagTypes.get(k)!.add(typeof v);
            }
        }

        if (props.query_label === undefined || props.as_of === undefined) missingProvenance++;

        // A joined set cannot be a category: ordering is not guaranteed, so the same
        // set arrives under several distinct values and the toggle list fragments.
        for (const key of ['service', 'licence_type', 'status']) {
            const v = props[key];
            if (typeof v === 'string' && v.includes(',')) {
                err('property/joined-set',
                    `Property "${key}" is a comma-joined list ("${v}"). Emit one boolean per member instead — a set encoded as an ordered string cannot act as a category.`,
                    { entityId: id });
            }
        }

        // A count must not outrun the list it describes, and a rollup count must
        // not outrun the rows it was rolled up from.
        const rc = props.row_count, dc = props.device_count;
        if (typeof rc === 'number' && typeof dc === 'number' && dc > rc) {
            err('property/count-coherence',
                `device_count (${dc}) exceeds row_count (${rc}). A rollup cannot yield more devices than the rows it read — row_count is probably being taken after a GROUP BY.`,
                { entityId: id });
        }
        for (const [listKey, countKey] of [['freq_list', 'frequency_count']] as const) {
            const list = props[listKey], n = props[countKey];
            if (typeof list === 'string' && typeof n === 'number') {
                const items = list.split(',').filter(x => x.trim() !== '').length;
                if (items !== n) {
                    err('property/count-list',
                        `${countKey} is ${n} but ${listKey} holds ${items} items. If the list was cut, say so explicitly — a reader cannot otherwise tell a complete list from a truncated one.`,
                        { entityId: id });
                }
            }
        }
    }

    for (const [id, n] of seenIds) {
        if (n > 1) warn('entity/duplicate-id', `id "${id}" appears ${n} times; only the last survives the store.`, { entityId: id, count: n });
    }

    for (const [key, types] of flagTypes) {
        if (types.has('number')) {
            err('property/flag-type',
                `Flag "${key}" arrives as a number. SQLite has no boolean type, so CASE/MAX expressions yield 1/0 — a filter comparing against true then matches nothing, silently. Emit real JSON booleans.`);
        }
        if (types.size > 1) {
            err('property/flag-type-mixed',
                `Flag "${key}" arrives as more than one type (${[...types].join(', ')}) across the set.`);
        }
    }

    if (missingProvenance > 0) {
        warn('property/provenance',
            `${missingProvenance} entities lack query_label or as_of. Without them a screen of pins cannot say what produced it or how stale the data is.`,
            { count: missingProvenance });
    }

    return { ok: errors.length === 0, entityCount: entities.length, errors, warnings };
}

/**
 * Rendering grouped by RULE, not by message.
 *
 * Messages embed specifics ("device_count (34) exceeds row_count (1)"), so
 * collapsing on the message alone still prints a line per distinct value —
 * a real 477-entity payload produced 713 errors across ~120 lines, which is
 * no more readable than the raw list. The rule is what a producer fixes.
 */
export function formatValidationReport(r: ValidationReport): string {
    const lines = [`${r.ok ? 'PASS' : 'FAIL'} — ${r.entityCount} entities, ${r.errors.length} error(s), ${r.warnings.length} warning(s)`];
    const groups = new Map<string, { severity: string; rule: string; n: number; examples: string[] }>();
    for (const i of [...r.errors, ...r.warnings]) {
        const key = `${i.severity}:${i.rule}`;
        let g = groups.get(key);
        if (!g) { g = { severity: i.severity, rule: i.rule, n: 0, examples: [] }; groups.set(key, g); }
        g.n++;
        if (g.examples.length < 2 && !g.examples.includes(i.message)) g.examples.push(i.message);
    }
    for (const g of groups.values()) {
        lines.push(`  ${g.severity.toUpperCase()} [${g.rule}] x${g.n}`);
        for (const ex of g.examples) lines.push(`    e.g. ${ex}`);
    }
    return lines.join('\n');
}
