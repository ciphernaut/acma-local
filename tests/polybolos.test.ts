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
        expect(p.entities[0].properties.row_count).toBe(3);
    });

    it('does not fabricate a device_count when no SDD_ID column is present', () => {
        const p = parse(COLS, [
            [7, 'Shared Tower', -27, 153, 150000000, 'Land Mobile'],
            [7, 'Shared Tower', -27, 153, 450000000, 'Land Mobile'],
        ]);
        expect(p.entities[0].properties.row_count).toBe(2);
        expect(p.entities[0].properties.device_count).toBeUndefined();
    });

    it('emits device_count as the distinct SDD_ID count when the column is present', () => {
        const cols = [...COLS, 'SDD_ID'];
        const p = parse(cols, [
            [7, 'Shared Tower', -27, 153, 150000000, 'Land Mobile', 901],
            [7, 'Shared Tower', -27, 153, 450000000, 'Land Mobile', 902],
            [7, 'Shared Tower', -27, 153, 900000000, 'Land Mobile', 902], // duplicate SDD_ID collapses
        ]);
        expect(p.entities[0].properties.row_count).toBe(3);
        expect(p.entities[0].properties.device_count).toBe(2);
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

    it('skips an out-of-range coordinate and counts it, rather than dropping silently', () => {
        const stats: ExportStats = { skipped: 0 };
        const p = parse(COLS, [
            [1, 'A', -27, 153, 150000000, 'Land Mobile'],
            [2, 'B', 999, 153, 150000000, 'Land Mobile'], // latitude 999 is out of range
        ], {}, stats);
        expect(p.entities).toHaveLength(1);
        expect(stats.skipped).toBe(1);
    });

    it('rolls up a uniform emission designator across a site group to one class', () => {
        const cols = [...COLS, 'EMISSION'];
        const p = parse(cols, [
            [7, 'Shared Tower', -27, 153, 150000000, 'Land Mobile', '16K0F3E'],
            [7, 'Shared Tower', -27, 153, 450000000, 'Land Mobile', '16K0F3E'],
        ]);
        // 16K0F3E -> F is frequency modulation, group 'angle'.
        expect(p.entities[0].properties.emission_class).toBe('angle');
    });

    it('rolls up a mixed emission designator across a site group to "mixed"', () => {
        const cols = [...COLS, 'EMISSION'];
        const p = parse(cols, [
            [7, 'Shared Tower', -27, 153, 150000000, 'Land Mobile', '16K0F3E'],  // angle
            [7, 'Shared Tower', -27, 153, 450000000, 'Land Mobile', '16K0A1A'],  // amplitude
        ]);
        expect(p.entities[0].properties.emission_class).toBe('mixed');
    });

    it('treats a NULL frequency as absent, not zero, in the site-level band flags', () => {
        const p = parse(COLS, [[1, 'A', -27, 153, null, 'Land Mobile']]);
        const props = p.entities[0].properties;
        expect(props.band_hf).toBe(false);
        expect(props.band_vhf).toBe(false);
        expect(props.band_uhf).toBe(false);
        expect(props.band_shf).toBe(false);
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

    it('treats a NULL frequency as absent, not a fabricated zero', () => {
        const rows = [[901, '1234567/1', 'Mt Coot-tha', -27.47, 152.95, null, '16K0F3E', 'Land Mobile']];
        const p = parse(ECOLS, rows, { granularity: 'emitter' });
        const props = p.entities[0].properties;
        expect(props.frequency_hz).toBeNull();
        expect(props.band_hf).toBe(false);
        expect(props.band_vhf).toBe(false);
        expect(props.band_uhf).toBe(false);
        expect(props.band_shf).toBe(false);
        expect(p.entities[0].name).not.toMatch(/MHz/);
    });

    it('passes an unrecognised column through as a flat scalar property', () => {
        const p = parse(ECOLS, one, { granularity: 'emitter' });
        expect(p.entities[0].properties.licence_no).toBe('1234567/1');
    });
});

describe('ceiling advice matches granularity', () => {
    const COLS2 = ['SITE_ID', 'SITE_NAME', 'LATITUDE', 'LONGITUDE', 'FREQUENCY', 'SV_NAME'];

    it('does not tell a site-level caller to switch to site level', () => {
        const rows = Array.from({ length: STREAM_CEILING + 1 }, (_, i) =>
            [i, `Site ${i}`, -27, 153, 150000000, 'Land Mobile']);
        expect(() => generatePolybolos(COLS2, rows)).toThrow(/already rolled up per site/);
    });

    it('does suggest site rollup to an emitter-level caller', () => {
        const cols = ['SDD_ID', 'LATITUDE', 'LONGITUDE', 'FREQUENCY'];
        const rows = Array.from({ length: STREAM_CEILING + 1 }, (_, i) => [i, -27, 153, 150000000]);
        expect(() => generatePolybolos(cols, rows, { granularity: 'emitter' }))
            .toThrow(/use granularity "site"/);
    });
});

describe('per-service booleans and frequency bounds', () => {
    const C = ['SITE_ID', 'SITE_NAME', 'LATITUDE', 'LONGITUDE', 'FREQUENCY', 'SV_NAME'];

    it('emits one boolean per service present at a site', () => {
        // A set encoded as an ordered string cannot be a category: "Fixed,Land Mobile"
        // and "Land Mobile,Fixed" are the same site but two different toggle rows.
        const p = parse(C, [
            [7, 'A', -27, 153, 150000000, 'Land Mobile'],
            [7, 'A', -27, 153, 450000000, 'Fixed'],
        ]);
        const props = p.entities[0].properties;
        expect(props.svc_land_mobile).toBe(true);
        expect(props.svc_fixed).toBe(true);
    });

    it('omits services not present rather than emitting false for all 28', () => {
        const p = parse(C, [[7, 'A', -27, 153, 150000000, 'Land Mobile']]);
        const keys = Object.keys(p.entities[0].properties).filter(k => k.startsWith('svc_'));
        expect(keys).toEqual(['svc_land_mobile']);
    });

    it('slugifies service names with punctuation and spaces', () => {
        const p = parse(C, [
            [7, 'A', -27, 153, 150000000, 'PTS 900 MHz'],
            [7, 'A', -27, 153, 150000000, 'Trade/Transfer'],
        ]);
        const props = p.entities[0].properties;
        expect(props.svc_pts_900_mhz).toBe(true);
        expect(props.svc_trade_transfer).toBe(true);
    });

    it('keeps the svc_ flags real booleans, never 1/0', () => {
        const p = parse(C, [[7, 'A', -27, 153, 150000000, 'Land Mobile']]);
        expect(typeof p.entities[0].properties.svc_land_mobile).toBe('boolean');
    });

    it('bounds the frequency range across the site group', () => {
        const p = parse(C, [
            [7, 'A', -27, 153, 150000000, 'Land Mobile'],
            [7, 'A', -27, 153, 450000000, 'Land Mobile'],
            [7, 'A', -27, 153, 900000000, 'Land Mobile'],
        ]);
        const props = p.entities[0].properties;
        expect(props.freq_min_hz).toBe(150000000);
        expect(props.freq_max_hz).toBe(900000000);
    });

    it('leaves frequency bounds null when no row carries a frequency', () => {
        const p = parse(C, [[7, 'A', -27, 153, null, 'Land Mobile']]);
        expect(p.entities[0].properties.freq_min_hz).toBeNull();
        expect(p.entities[0].properties.freq_max_hz).toBeNull();
    });

    it('emits svc_ flags at emitter granularity too, so filters are uniform', () => {
        const cols = ['SDD_ID', 'LATITUDE', 'LONGITUDE', 'FREQUENCY', 'SV_NAME'];
        const p = parse(cols, [[901, -27, 153, 150000000, 'Maritime Coast']], { granularity: 'emitter' });
        expect(p.entities[0].properties.svc_maritime_coast).toBe(true);
    });
});

describe('producer source', () => {
    const C = ['SITE_ID', 'SITE_NAME', 'LATITUDE', 'LONGITUDE', 'FREQUENCY', 'SV_NAME'];
    const row = [[1, 'A', -27, 153, 150000000, 'Land Mobile']];

    it('defaults to acma-rrl', () => {
        expect(parse(C, row).source).toBe('acma-rrl');
    });

    it('accepts an override, so a second producer can be retracted independently', () => {
        // OSIRIS namespaces stored ids as ext-{source}-{id} and its DELETE endpoint
        // is scoped by source, so sharing one source name makes one producer's
        // cleanup destroy the other's estate.
        expect(parse(C, row, { source: 'acma-rrl-test' }).source).toBe('acma-rrl-test');
    });

    it('rejects a source that would not round-trip through the id namespace', () => {
        expect(() => generatePolybolos(C, row, { source: 'has spaces' })).toThrow(/source/i);
    });
});

describe('emission information type', () => {
    const C = ['SITE_ID', 'SITE_NAME', 'LATITUDE', 'LONGITUDE', 'FREQUENCY', 'EMISSION'];

    it('emits what is being sent alongside how it is modulated', () => {
        // 16K0F3E: F = frequency modulation (group 'angle'), E = telephony.
        // The two axes are independent and an operator wants both.
        const p = parse(C, [[1, 'A', -27, 153, 150000000, '16K0F3E']]);
        expect(p.entities[0].properties.emission_class).toBe('angle');
        expect(p.entities[0].properties.emission_info).toBe('telephony');
    });

    it('distinguishes data from voice on the same modulation', () => {
        const voice = parse(C, [[1, 'A', -27, 153, 150000000, '16K0F3E']]);
        const data = parse(C, [[2, 'B', -27, 153, 150000000, '16K0F1D']]);
        expect(voice.entities[0].properties.emission_class)
            .toBe(data.entities[0].properties.emission_class);   // both 'angle'
        expect(voice.entities[0].properties.emission_info).toBe('telephony');
        expect(data.entities[0].properties.emission_info).toBe('data');
    });

    it('rolls up to mixed when a site disagrees', () => {
        const p = parse(C, [
            [7, 'A', -27, 153, 150000000, '16K0F3E'],
            [7, 'A', -27, 153, 150000000, '16K0F1D'],
        ]);
        expect(p.entities[0].properties.emission_info).toBe('mixed');
    });

    it('is null when no EMISSION column was selected', () => {
        const cols = ['SITE_ID', 'SITE_NAME', 'LATITUDE', 'LONGITUDE', 'FREQUENCY'];
        const p = parse(cols, [[1, 'A', -27, 153, 150000000]]);
        expect(p.entities[0].properties.emission_info).toBeNull();
    });

    it('tolerates an unparseable designator', () => {
        const p = parse(C, [[1, 'A', -27, 153, 150000000, 'rubbish']]);
        expect(p.entities[0].properties.emission_info).toBeNull();
    });

    it('emits it at emitter granularity too', () => {
        const cols = ['SDD_ID', 'LATITUDE', 'LONGITUDE', 'FREQUENCY', 'EMISSION'];
        const p = parse(cols, [[901, -27, 153, 150000000, '16K0F3E']], { granularity: 'emitter' });
        expect(p.entities[0].properties.emission_info).toBe('telephony');
    });
});

describe('per-emission booleans', () => {
    const C = ['SITE_ID', 'SITE_NAME', 'LATITUDE', 'LONGITUDE', 'FREQUENCY', 'EMISSION'];

    it('emits one boolean per information type present at a site', () => {
        // Same reasoning as svc_: a site hosting voice and data devices collapses
        // to emission_info 'mixed', which the operator cannot filter on at all.
        const p = parse(C, [
            [7, 'A', -27, 153, 150000000, '16K0F3E'],   // telephony
            [7, 'A', -27, 153, 450000000, '16K0F1D'],   // data
        ]);
        const props = p.entities[0].properties;
        expect(props.emission_info).toBe('mixed');       // scalar stays honest
        expect(props.emi_telephony).toBe(true);          // and is now filterable
        expect(props.emi_data).toBe(true);
    });

    it('omits information types not present', () => {
        const p = parse(C, [[7, 'A', -27, 153, 150000000, '16K0F3E']]);
        const keys = Object.keys(p.entities[0].properties).filter(k => k.startsWith('emi_'));
        expect(keys).toEqual(['emi_telephony']);
    });

    it('keeps them real booleans', () => {
        const p = parse(C, [[7, 'A', -27, 153, 150000000, '16K0F3E']]);
        expect(typeof p.entities[0].properties.emi_telephony).toBe('boolean');
    });

    it('emits none when no EMISSION column was selected', () => {
        const cols = ['SITE_ID', 'SITE_NAME', 'LATITUDE', 'LONGITUDE', 'FREQUENCY'];
        const p = parse(cols, [[1, 'A', -27, 153, 150000000]]);
        expect(Object.keys(p.entities[0].properties).filter(k => k.startsWith('emi_'))).toEqual([]);
    });

    it('emits them at emitter granularity too', () => {
        const cols = ['SDD_ID', 'LATITUDE', 'LONGITUDE', 'FREQUENCY', 'EMISSION'];
        const p = parse(cols, [[901, -27, 153, 150000000, '16K0F1D']], { granularity: 'emitter' });
        expect(p.entities[0].properties.emi_data).toBe(true);
    });

    it('ignores an unparseable designator rather than inventing a flag', () => {
        const p = parse(C, [[7, 'A', -27, 153, 150000000, 'rubbish']]);
        expect(Object.keys(p.entities[0].properties).filter(k => k.startsWith('emi_'))).toEqual([]);
    });
});
