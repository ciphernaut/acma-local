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
        for (const value of Object.values(p.entities[0].properties)) {
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

    it('passes an unrecognised column through as a flat property', () => {
        const cols = [...COLS, 'INDUSTRY_CAT_NAME'];
        const p = parse(cols, [
            [7, 'Shared Tower', -27, 153, 150000000, 'Land Mobile', 'Broadcasting'],
            [7, 'Shared Tower', -27, 153, 450000000, 'Land Mobile', 'Broadcasting'],
        ]);
        expect(p.entities[0].properties.industry_cat_name).toBe('Broadcasting');
    });

    it('marks a passed-through column "mixed" when the site group disagrees', () => {
        const cols = [...COLS, 'INDUSTRY_CAT_NAME'];
        const p = parse(cols, [
            [7, 'Shared Tower', -27, 153, 150000000, 'Land Mobile', 'Broadcasting'],
            [7, 'Shared Tower', -27, 153, 450000000, 'Land Mobile', 'Aviation'],
        ]);
        expect(p.entities[0].properties.industry_cat_name).toBe('mixed');
    });
});

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
