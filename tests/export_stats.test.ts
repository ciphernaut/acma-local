import { generateGeoJson } from '../src/geojson.js';
import { generateKml } from '../src/kml.js';
import { generateQml } from '../src/qml.js';
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

    it('kml: counts rows dropped for unusable geometry', () => {
        const stats: ExportStats = { skipped: 0 };
        const columns = ['NAME', 'LATITUDE', 'LONGITUDE'];
        const rows = [
            ['Good', -27.47, 153.02],
            ['No coords', null, null],
            ['Out of range', -999, 153.02],
        ];
        const kml = generateKml(columns, rows, 'earth', stats);
        expect((kml.match(/<Placemark>/g) ?? []).length).toBe(1);
        expect(stats.skipped).toBe(2);
    });

    it('kml: leaves skipped at zero when every row projects', () => {
        const stats: ExportStats = { skipped: 0 };
        generateKml(['NAME', 'LATITUDE', 'LONGITUDE'], [['A', 0, 0]], 'earth', stats);
        // Zero is a legitimate coordinate — this row must NOT be skipped.
        expect(stats.skipped).toBe(0);
    });

    it('kml: is optional — omitting stats does not throw', () => {
        expect(() => generateKml(['NAME', 'LATITUDE', 'LONGITUDE'], [['A', 1, 2]])).not.toThrow();
    });

    it('qml: accepts a stats collector without throwing, and leaves it untouched', () => {
        // generateQml has no per-row geometry projection to skip — it is a style
        // document keyed on columns, not rows — so stats stays at zero.
        const stats: ExportStats = { skipped: 0 };
        const columns = ['NAME', 'LATITUDE', 'LONGITUDE'];
        const rows = [['A', -27.47, 153.02]];
        expect(() => generateQml(columns, rows, {}, stats)).not.toThrow();
        expect(stats.skipped).toBe(0);
    });
});
