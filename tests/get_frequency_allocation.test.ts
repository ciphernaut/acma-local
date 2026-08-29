import { describe, expect, test, beforeAll } from '@jest/globals';
import Database from 'better-sqlite3';
import { TABLE_METADATA } from '../src/db.js';
import { lookupFrequencyAllocation } from '../src/spectrum_plan.js';

let db: Database.Database;

beforeAll(() => {
    db = new Database(':memory:');
    for (const name of [
        'spectrum_allocations',
        'spectrum_region_allocations',
        'spectrum_australian_footnotes',
        'spectrum_international_footnotes',
        'spectrum_plan_meta',
    ] as const) {
        const meta = TABLE_METADATA[name]!;
        db.exec(meta.ddl);
        // post_load_ddl is a string, not an array — the previous
        // `for (const idx of (meta as any).indexes ?? [])` iterated a property
        // that does not exist, so the range indexes were never created here.
        if (meta.post_load_ddl) db.exec(meta.post_load_ddl);
    }

    // Seed: one AU row + one R3 row covering the same FM broadcast band, two footnotes.
    db.exec(`
        INSERT INTO spectrum_allocations(freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw) VALUES
          (87000000, 88000000, 'MHz', 55, '[{"name":"BROADCASTING","primary":true,"inline_footnotes":[]}]', '["AUS37"]', 'BROADCASTING\nAUS37');
        INSERT INTO spectrum_region_allocations(region, freq_start_hz, freq_end_hz, unit, page, services_json, footnotes_json, raw) VALUES
          (3, 87000000, 88000000, 'MHz', 55, '[{"name":"BROADCASTING","primary":true,"inline_footnotes":[]}]', '["5.87"]', 'BROADCASTING\n5.87');
        INSERT INTO spectrum_australian_footnotes(footnote_ref, footnote_text, page) VALUES ('AUS37', 'AU footnote text.', 109);
        INSERT INTO spectrum_international_footnotes(footnote_ref, footnote_text, page) VALUES ('5.87', 'Intl footnote text.', 125);
        INSERT INTO spectrum_plan_meta(key, value) VALUES ('published_date', '2021-07');
    `);
});

describe('lookupFrequencyAllocation', () => {
    test('returns AU as primary surface', () => {
        const r = lookupFrequencyAllocation(db, 87_500_000, true);
        expect(r.match_count).toBe(1);
        expect(r.allocation).not.toBeNull();
        expect(r.allocation!.services[0]!.name).toBe('BROADCASTING');
    });

    test('region contrast is populated when present', () => {
        const r = lookupFrequencyAllocation(db, 87_500_000, true);
        expect(r.regions[3]).not.toBeNull();
        expect(r.regions[3]!.services[0]!.name).toBe('BROADCASTING');
    });

    test('resolved_footnotes includes both AU and intl', () => {
        const r = lookupFrequencyAllocation(db, 87_500_000, true);
        expect(r.resolved_footnotes).toBeDefined();
        expect(r.resolved_footnotes!['AUS37']).toBe('AU footnote text.');
        expect(r.resolved_footnotes!['5.87']).toBe('Intl footnote text.');
    });

    test('include_footnotes=false omits resolved_footnotes', () => {
        const r = lookupFrequencyAllocation(db, 87_500_000, false);
        expect(r.resolved_footnotes).toBeUndefined();
    });

    test('no matching AU row reports match_count 0', () => {
        const r = lookupFrequencyAllocation(db, 50_000, true);
        expect(r.match_count).toBe(0);
        expect(r.allocation).toBeNull();
    });

    test('source.published_date is read from meta', () => {
        const r = lookupFrequencyAllocation(db, 87_500_000, true);
        expect(r.source.published_date).toBe('2021-07');
    });
});
