import { describe, expect, test } from '@jest/globals';
import { generateSeedSql, applyOverlay, patchDateOf } from '../scripts/generate-spectrum-seed.js';

const baseDoc = {
    meta: {
        generation: 2,
        source: { title: 'X', pdf_sha256: 'abc', pdf_published: '2021-07', url: 'http://x' },
        extracted_at: '2026-05-15T00:00:00Z',
        extractor_version: '1.0.0',
    },
    au_allocations: [
        {
            freq_start_hz: 8300, freq_end_hz: 9000, unit: 'kHz', page: 25,
            services: [{ name: 'METEOROLOGICAL AIDS', primary: true, inline_footnotes: ['54A'] }],
            footnotes: [],
            raw: 'METEOROLOGICAL AIDS  54A',
        },
    ],
    region_allocations: [],
    au_footnotes: [{ ref: 'AUS1A', text: 'Example.', page: 107 }],
    intl_footnotes: [{ ref: '54A', text: 'Example intl.', page: 120 }],
};

describe('generateSeedSql', () => {
    test('produces deterministic SQL with BEGIN/COMMIT and meta rows', () => {
        const sql = generateSeedSql(baseDoc);
        expect(sql).toContain('BEGIN TRANSACTION;');
        expect(sql).toMatch(/COMMIT;\s*$/);
        expect(sql).toContain("INSERT INTO spectrum_allocations");
        expect(sql).toMatch(/INSERT( OR REPLACE)? INTO spectrum_australian_footnotes/);
        expect(sql).toContain("'pdf_sha256'");
        expect(sql).toContain("'abc'");
    });

    test('row_counts meta reflects post-overlay state', () => {
        const sql = generateSeedSql(baseDoc);
        expect(sql).toContain('"au_allocations":1');
    });
});

describe('applyOverlay', () => {
    test('replace_footnote updates AU footnote text', () => {
        const patched = applyOverlay(baseDoc, {
            meta: { patch_id: '2026-a', applied_to: 2, description: 't', source: {} },
            operations: [
                { op: 'replace_footnote', table: 'au_footnotes', ref: 'AUS1A', text: 'Updated.' },
            ],
        });
        expect(patched.au_footnotes.find((f: any) => f.ref === 'AUS1A')?.text).toBe('Updated.');
    });

    test('replace_allocation swaps an existing au row', () => {
        const patched = applyOverlay(baseDoc, {
            meta: { patch_id: '2026-b', applied_to: 2, description: 't', source: {} },
            operations: [
                {
                    op: 'replace_allocation',
                    freq_start_hz: 8300,
                    freq_end_hz: 9000,
                    new: {
                        freq_start_hz: 8300, freq_end_hz: 9000, unit: 'kHz', page: 25,
                        services: [{ name: 'NEW', primary: true, inline_footnotes: [] }],
                        footnotes: [], raw: 'NEW',
                    },
                },
            ],
        });
        expect(patched.au_allocations[0].services[0].name).toBe('NEW');
    });

    test('insert_allocation rejects duplicate key', () => {
        expect(() =>
            applyOverlay(baseDoc, {
                meta: { patch_id: '2026-c', applied_to: 2, description: 't', source: {} },
                operations: [
                    {
                        op: 'insert_allocation',
                        new: {
                            freq_start_hz: 8300, freq_end_hz: 9000, unit: 'kHz', page: 25,
                            services: [], footnotes: [], raw: '',
                        },
                    },
                ],
            }),
        ).toThrow(/already exists/);
    });

    test('delete_allocation removes the matching row', () => {
        const patched = applyOverlay(baseDoc, {
            meta: { patch_id: '2026-d', applied_to: 2, description: 't', source: {} },
            operations: [{ op: 'delete_allocation', freq_start_hz: 8300, freq_end_hz: 9000 }],
        });
        expect(patched.au_allocations.length).toBe(0);
    });
});

describe('region-scoped overlays (#4)', () => {
    const regionDoc = {
        ...baseDoc,
        region_allocations: [
            {
                region: 3, freq_start_hz: 5000000000, freq_end_hz: 5150000000, unit: 'MHz', page: 75,
                services: [{ name: 'FIXED', primary: true, inline_footnotes: [] }],
                footnotes: [], raw: 'FIXED',
            },
        ],
    };

    /** The op-level `region` form documented in seed/patches/README.md. */
    const replaceOp = {
        op: 'replace_allocation',
        freq_start_hz: 5000000000,
        freq_end_hz: 5150000000,
        region: 3,
        new: {
            freq_start_hz: 5000000000, freq_end_hz: 5150000000, unit: 'MHz', page: 75,
            services: [{ name: 'MOBILE', primary: true, inline_footnotes: [] }],
            footnotes: [], raw: 'MOBILE',
        },
    };

    test('replace_allocation with region at op level keeps the row in region 3', () => {
        const patched = applyOverlay(regionDoc, {
            meta: { patch_id: 'r1', applied_to: 2, description: 't', source: {} },
            operations: [replaceOp],
        } as any);
        expect(patched.region_allocations).toHaveLength(1);
        expect(patched.region_allocations[0].region).toBe(3);
        expect(patched.region_allocations[0].services[0].name).toBe('MOBILE');
        expect(patched.au_allocations).toHaveLength(1);
    });

    test('the emitted SQL carries the region, never the literal undefined', () => {
        const patched = applyOverlay(regionDoc, {
            meta: { patch_id: 'r1', applied_to: 2, description: 't', source: {} },
            operations: [replaceOp],
        } as any);
        const sql = generateSeedSql(patched);
        expect(sql).not.toContain('undefined');
        expect(sql).toContain('INSERT INTO spectrum_region_allocations(region, freq_start_hz');
        expect(sql).toContain('VALUES(3, 5000000000, 5150000000');
    });

    test('insert_allocation accepts region at op level', () => {
        const patched = applyOverlay(regionDoc, {
            meta: { patch_id: 'r2', applied_to: 2, description: 't', source: {} },
            operations: [{
                op: 'insert_allocation', region: 2,
                new: {
                    freq_start_hz: 1, freq_end_hz: 2, unit: 'kHz', page: 9,
                    services: [], footnotes: [], raw: 'x',
                },
            }],
        } as any);
        expect(patched.region_allocations.find((a: any) => a.region === 2)).toBeDefined();
        expect(generateSeedSql(patched)).not.toContain('undefined');
    });

    test('delete_allocation with region removes only the region row', () => {
        const patched = applyOverlay(regionDoc, {
            meta: { patch_id: 'r3', applied_to: 2, description: 't', source: {} },
            operations: [{ op: 'delete_allocation', freq_start_hz: 5000000000, freq_end_hz: 5150000000, region: 3 }],
        } as any);
        expect(patched.region_allocations).toHaveLength(0);
        expect(patched.au_allocations).toHaveLength(1);
    });
});

describe('overlay validation (#4)', () => {
    const overlay = (ops: unknown[]) => ({
        meta: { patch_id: 'v', applied_to: 2, description: 't', source: {} },
        operations: ops,
    }) as any;

    test('rejects an allocation missing a required field', () => {
        expect(() => applyOverlay(baseDoc, overlay([{
            op: 'insert_allocation',
            new: { freq_start_hz: 1, freq_end_hz: 2, unit: 'kHz', services: [], footnotes: [], raw: 'x' },
        }]))).toThrow(/page must be an integer/);
    });

    test('rejects an inverted range', () => {
        expect(() => applyOverlay(baseDoc, overlay([{
            op: 'insert_allocation',
            new: { freq_start_hz: 9, freq_end_hz: 2, unit: 'kHz', page: 1, services: [], footnotes: [], raw: 'x' },
        }]))).toThrow(/must be greater than/);
    });

    test('rejects a region outside 1-3', () => {
        expect(() => applyOverlay(baseDoc, overlay([{
            op: 'insert_allocation', region: 7,
            new: { freq_start_hz: 1, freq_end_hz: 2, unit: 'kHz', page: 1, services: [], footnotes: [], raw: 'x' },
        }]))).toThrow(/region must be 1, 2 or 3/);
    });

    test('generateSeedSql refuses a region row with no region rather than emitting undefined', () => {
        const broken = {
            ...baseDoc,
            region_allocations: [{
                freq_start_hz: 1, freq_end_hz: 2, unit: 'kHz', page: 1, services: [], footnotes: [], raw: 'x',
            }],
        };
        expect(() => generateSeedSql(broken as any)).toThrow(/region must be an integer/);
    });
});

describe('last_patch_date (#6)', () => {
    test('omitted when no overlay was applied', () => {
        expect(generateSeedSql(baseDoc)).not.toContain('last_patch_date');
    });

    test('emitted when supplied', () => {
        const sql = generateSeedSql(baseDoc, { lastPatchDate: '2026-08-01' });
        expect(sql).toContain("INSERT INTO spectrum_plan_meta(key, value) VALUES('last_patch_date', '2026-08-01');");
    });

    test('patchDateOf prefers the amendment published_date', () => {
        expect(patchDateOf({ meta: { patch_id: 'p', applied_to: 2, description: '', source: { published_date: '2026-07-15' } }, operations: [] }, '2026-01-01-topic.yaml'))
            .toBe('2026-07-15');
    });

    test('patchDateOf falls back to the filename prefix', () => {
        expect(patchDateOf({ meta: { patch_id: 'p', applied_to: 2, description: '', source: {} }, operations: [] }, '2026-01-01-topic.yaml'))
            .toBe('2026-01-01');
    });

    test('patchDateOf returns undefined when neither is available', () => {
        expect(patchDateOf({ meta: { patch_id: 'p', applied_to: 2, description: '', source: {} }, operations: [] }, 'topic.yaml'))
            .toBeUndefined();
    });
});
