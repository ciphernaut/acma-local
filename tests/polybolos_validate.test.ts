import { validatePolybolosPayload, formatValidationReport, ENTITY_CEILING } from '../src/polybolos_validate.js';
import { generatePolybolos } from '../src/polybolos.js';

/**
 * Each case reproduces a defect measured in a live OSIRIS store. The live
 * payload itself is not used as a fixture: it carries real site and licensee
 * names, which do not belong in this repo.
 */
function payload(entities: unknown[], extra: Record<string, unknown> = {}) {
    return { source: 'acma-rrl', entities, ...extra };
}
const at = (props: Record<string, unknown>, id = 'S1') =>
    ({ id, name: 'Site', position: { lat: -27.4, lng: 153.0 }, properties: { query_label: 'q', as_of: 'z', ...props } });

describe('validatePolybolosPayload', () => {
    it('passes what this repo\'s own exporter produces', () => {
        const cols = ['SITE_ID', 'SITE_NAME', 'LATITUDE', 'LONGITUDE', 'FREQUENCY', 'SV_NAME'];
        const doc = generatePolybolos(cols, [
            [1, 'Alpha', -27.4, 153.0, 150000000, 'Land Mobile'],
            [1, 'Alpha', -27.4, 153.0, 450000000, 'Fixed'],
            [2, 'Bravo', -27.5, 153.1, 900000000, 'Fixed'],
        ], { queryLabel: 'q', asOf: '2026-08-29T11:08:00Z' });
        const r = validatePolybolosPayload(doc);
        expect(r.errors).toEqual([]);
        expect(r.ok).toBe(true);
    });

    it('catches flags arriving as 1/0 instead of booleans', () => {
        // Measured: band_hf/vhf/uhf were ints from SQL CASE/MAX for all 477 entities,
        // so ['==', ['get','band_vhf'], true] matched nothing and failed silently.
        const r = validatePolybolosPayload(payload([at({ band_vhf: 1, band_uhf: 0 })]));
        expect(r.ok).toBe(false);
        expect(r.errors.map(e => e.rule)).toContain('property/flag-type');
    });

    it('catches a flag whose type is inconsistent across the set', () => {
        const r = validatePolybolosPayload(payload([
            at({ band_shf: false }, 'S1'),
            at({ band_shf: 1 }, 'S2'),
        ]));
        expect(r.errors.map(e => e.rule)).toEqual(
            expect.arrayContaining(['property/flag-type', 'property/flag-type-mixed']));
    });

    it('catches a comma-joined set masquerading as a category', () => {
        // Measured: 44 distinct `service` values across 477 entities, including
        // "Fixed,Land Mobile" and "Land Mobile,Fixed" as separate toggle rows.
        const r = validatePolybolosPayload(payload([at({ service: 'Fixed,Land Mobile' })]));
        expect(r.ok).toBe(false);
        expect(r.errors.map(e => e.rule)).toContain('property/joined-set');
    });

    it('catches device_count exceeding row_count', () => {
        // Measured in 476 of 477 entities: row_count taken after GROUP BY, so always 1.
        const r = validatePolybolosPayload(payload([at({ row_count: 1, device_count: 34 })]));
        expect(r.ok).toBe(false);
        expect(r.errors.map(e => e.rule)).toContain('property/count-coherence');
    });

    it('accepts device_count equal to row_count', () => {
        const r = validatePolybolosPayload(payload([at({ row_count: 312, device_count: 312 })]));
        expect(r.ok).toBe(true);
    });

    it('catches a count that disagrees with the list it describes', () => {
        const r = validatePolybolosPayload(payload([at({ freq_list: '1,2,3', frequency_count: 10 })]));
        expect(r.ok).toBe(false);
        expect(r.errors.map(e => e.rule)).toContain('property/count-list');
    });

    it('does NOT flag a list whose count matches, even when device_count differs', () => {
        // 34 devices sharing 10 channels is honest: distinct devices and distinct
        // frequencies are different denominators. This was a false positive once.
        const r = validatePolybolosPayload(payload([
            at({ freq_list: '1,2,3,4,5,6,7,8,9,10', frequency_count: 10, row_count: 34, device_count: 34 }),
        ]));
        expect(r.ok).toBe(true);
    });

    it('catches nested property values', () => {
        const r = validatePolybolosPayload(payload([at({ bands: ['vhf', 'uhf'] })]));
        expect(r.errors.map(e => e.rule)).toContain('property/scalar');
    });

    it('refuses a payload carrying a secret', () => {
        const r = validatePolybolosPayload(payload([at({})], { apiKey: 'should-not-be-here' }));
        expect(r.ok).toBe(false);
        expect(r.errors.map(e => e.rule)).toContain('payload/no-secret');
    });

    it('refuses a payload over the entity ceiling', () => {
        const many = Array.from({ length: ENTITY_CEILING + 1 }, (_, i) => at({}, `S${i}`));
        const r = validatePolybolosPayload(payload(many));
        expect(r.errors.map(e => e.rule)).toContain('payload/ceiling');
    });

    it('warns, not errors, on missing provenance', () => {
        const r = validatePolybolosPayload(payload([
            { id: 'S1', position: { lat: -27, lng: 153 }, properties: {} },
        ]));
        expect(r.ok).toBe(true);
        expect(r.warnings.map(w => w.rule)).toContain('property/provenance');
    });

    it('warns on duplicate ids, since only the last survives the store', () => {
        const r = validatePolybolosPayload(payload([at({}, 'S1'), at({}, 'S1')]));
        expect(r.warnings.map(w => w.rule)).toContain('entity/duplicate-id');
    });

    it('keeps a zero coordinate valid', () => {
        const r = validatePolybolosPayload(payload([
            { id: 'S1', position: { lat: 0, lng: 0 }, properties: { query_label: 'q', as_of: 'z' } },
        ]));
        expect(r.ok).toBe(true);
    });

    it('reports invalid JSON rather than throwing', () => {
        const r = validatePolybolosPayload('{not json');
        expect(r.ok).toBe(false);
        expect(r.errors[0]!.rule).toBe('payload/json');
    });
});

describe('formatValidationReport', () => {
    it('groups by rule even when every message differs', () => {
        // Messages embed specifics, so collapsing on the message alone still
        // prints a line per distinct value. A real 477-entity payload produced
        // 713 errors across ~120 lines that way.
        const many = Array.from({ length: 200 }, (_, i) =>
            at({ row_count: 1, device_count: i + 2 }, `S${i}`));
        const text = formatValidationReport(validatePolybolosPayload(payload(many)));
        expect(text).toContain('FAIL');
        expect(text).toContain('[property/count-coherence] x200');
        // one header + one rule line + at most two examples
        expect(text.split('\n').length).toBeLessThanOrEqual(4);
    });
});
