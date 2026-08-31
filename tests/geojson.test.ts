import { generateGeoJson } from '../src/geojson.js';

/** Parse and return the object, so tests assert on structure rather than text. */
function parse(columns: string[], rows: unknown[][]): any {
    return JSON.parse(generateGeoJson(columns, rows));
}

describe('generateGeoJson', () => {
    it('emits an RFC 7946 FeatureCollection with no crs member', () => {
        const fc = parse(['NAME', 'LATITUDE', 'LONGITUDE'], [['Site A', -29, 134]]);
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].type).toBe('Feature');
        // WGS 84 is implied by the spec; emitting crs is non-conformant.
        expect(fc.crs).toBeUndefined();
    });

    it('emits 2D point geometry in lon,lat order', () => {
        const fc = parse(['NAME', 'LATITUDE', 'LONGITUDE'], [['Site A', -29.5, 134.25]]);
        expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [134.25, -29.5] });
    });

    it('keeps native JSON types for properties', () => {
        const fc = parse(
            ['NAME', 'LATITUDE', 'LONGITUDE', 'CHANNELS', 'POWER', 'NOTE', 'EMPTY'],
            [['A', -29, 134, 20, 12.5, 'text', null]],
        );
        const p = fc.features[0].properties;
        expect(p.CHANNELS).toBe(20);          // number, not "20"
        expect(p.POWER).toBe(12.5);
        expect(p.NOTE).toBe('text');
        expect(p.EMPTY).toBeNull();
        expect(p.NAME).toBe('A');             // no special title role in GeoJSON
    });

    it('excludes geometry columns from properties', () => {
        const fc = parse(['NAME', 'LATITUDE', 'LONGITUDE'], [['A', -29, 134]]);
        expect(Object.keys(fc.features[0].properties)).toEqual(['NAME']);
    });

    it('computes a bbox over the features', () => {
        const fc = parse(['NAME', 'LATITUDE', 'LONGITUDE'],
                         [['A', -29, 134], ['B', -35, 150], ['C', -10, 120]]);
        // [west, south, east, north]
        expect(fc.bbox).toEqual([120, -35, 150, -10]);
    });

    it('reads WKT from a GEOMETRY column, in preference to lat/lon', () => {
        const line = parse(['NAME', 'GEOMETRY'], [['L', 'LINESTRING(120 -35, 125 -25)']]);
        expect(line.features[0].geometry).toEqual({
            type: 'LineString', coordinates: [[120, -35], [125, -25]],
        });
        const poly = parse(['NAME', 'GEOMETRY'],
                           [['P', 'POLYGON((140 -35, 155 -35, 155 -25, 140 -35))']]);
        expect(poly.features[0].geometry.type).toBe('Polygon');
        expect(poly.features[0].geometry.coordinates[0]).toHaveLength(4);
    });

    it('keeps a legitimate zero coordinate', () => {
        // Discarding zeros would silently drop real rows. Range validation is what
        // catches junk.
        const fc = parse(['NAME', 'LATITUDE', 'LONGITUDE'], [['Null Island', 0, 0]]);
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0].geometry.coordinates).toEqual([0, 0]);
    });

    it('skips rows whose coordinates are missing, unparsable or out of range', () => {
        const fc = parse(['NAME', 'LATITUDE', 'LONGITUDE'], [
            ['ok', -29, 134],
            ['null', null, 134],
            ['text', 'abc', 134],
            ['lat too big', 91, 134],
            ['lon too big', -29, 181],
        ]);
        expect(fc.features.map((f: any) => f.properties.NAME)).toEqual(['ok']);
    });

    it('returns a valid empty collection for no rows', () => {
        const fc = parse(['NAME', 'LATITUDE', 'LONGITUDE'], []);
        expect(fc).toEqual({ type: 'FeatureCollection', features: [] });
    });

    it('is case-insensitive about the geometry column names', () => {
        const fc = parse(['name', 'latitude', 'longitude'], [['A', -29, 134]]);
        expect(fc.features[0].geometry.coordinates).toEqual([134, -29]);
    });

    it('does not round coordinates', () => {
        const fc = parse(['NAME', 'LATITUDE', 'LONGITUDE'], [['A', -26.794294, 153.119523]]);
        expect(fc.features[0].geometry.coordinates).toEqual([153.119523, -26.794294]);
    });
});
