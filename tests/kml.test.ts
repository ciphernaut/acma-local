import { generateKml } from '../src/kml.js';

describe('KML Generation', () => {
    it('should generate KML for points', () => {
        const columns = ['NAME', 'LATITUDE', 'LONGITUDE'];
        const rows = [['Site A', -29, 134]];
        const kml = generateKml(columns, rows);
        expect(kml).toContain('<coordinates>134,-29</coordinates>');
        expect(kml).toContain('<![CDATA[Site A]]>');
    });

    it('should generate KML for WKT geometries', () => {
        const columns = ['NAME', 'GEOMETRY'];
        const rows = [['Line A', 'LINESTRING(120 -35, 125 -25)']];
        const kml = generateKml(columns, rows);
        expect(kml).toContain('<LineString><coordinates>120,-35 125,-25</coordinates></LineString>');
    });

    it('should handle polygons', () => {
        const columns = ['NAME', 'GEOMETRY'];
        const rows = [['Poly A', 'POLYGON((140 -35, 155 -35, 155 -25, 140 -25, 140 -35))']];
        const kml = generateKml(columns, rows);
        expect(kml).toContain('<Polygon><outerBoundaryIs><LinearRing><coordinates>140,-35 155,-35 155,-25 140,-25 140,-35</coordinates></LinearRing></outerBoundaryIs></Polygon>');
    });

    it('should generate descriptions with HTML tables', () => {
        const columns = ['ID', 'NAME', 'LATITUDE', 'LONGITUDE'];
        const rows = [[1, 'Test', -29, 134]];
        const kml = generateKml(columns, rows);
        expect(kml).toContain('<b>ID</b></td><td style="padding: 2px;">1</td>');
        expect(kml).toContain('<b>NAME</b></td><td style="padding: 2px;">Test</td>');
    });
});

describe('KML is usable as a GIS layer', () => {
    // The HTML <description> is for Google Earth balloons. OGR — and therefore
    // QGIS — exposes only Name and Description from it, so every attribute has to
    // be repeated in <ExtendedData> to be filterable, styleable or joinable.
    const columns = ['NAME', 'LATITUDE', 'LONGITUDE', 'CHANNELS', 'TX_POWER_W', 'EMISSIONS'];
    const rows = [['Site A', -29, 134, 20, 12.5, '3K00J3E, 3K00J2D']];

    it('declares a typed schema for the attribute columns', () => {
        const kml = generateKml(columns, rows);
        expect(kml).toContain('<Schema name=');
        // Non-geometry, non-name columns become fields; ints and floats keep their type.
        expect(kml).toMatch(/<SimpleField type="int" name="CHANNELS">/);
        expect(kml).toMatch(/<SimpleField type="float" name="TX_POWER_W">/);
        expect(kml).toMatch(/<SimpleField type="string" name="EMISSIONS">/);
    });

    it('types a whole-number column as int (JS cannot tell 100.0 from 100)', () => {
        const kml = generateKml(['NAME', 'LATITUDE', 'LONGITUDE', 'W'], [['A', -29, 134, 100.0]]);
        expect(kml).toMatch(/<SimpleField type="int" name="W">/);
    });

    it('falls back to string when a column mixes numbers and text', () => {
        const kml = generateKml(['NAME', 'LATITUDE', 'LONGITUDE', 'W'],
                                [['A', -29, 134, 100], ['B', -30, 135, '50 / 100']]);
        expect(kml).toMatch(/<SimpleField type="string" name="W">/);
    });

    it('emits every attribute as SchemaData on each placemark', () => {
        const kml = generateKml(columns, rows);
        expect(kml).toContain('<ExtendedData>');
        expect(kml).toContain('<SimpleData name="CHANNELS">20</SimpleData>');
        expect(kml).toContain('<SimpleData name="TX_POWER_W">12.5</SimpleData>');
        expect(kml).toContain('<SimpleData name="EMISSIONS">3K00J3E, 3K00J2D</SimpleData>');
    });

    it('does not truncate attribute values', () => {
        // The HTML popup used to cut every value at 200 chars, losing the tail of
        // long lists (licence numbers, channel plans) with no warning.
        const long = Array.from({ length: 40 }, (_, i) => `1005716${i}/1`).join(',');
        const kml = generateKml(['NAME', 'LATITUDE', 'LONGITUDE', 'LICENCES'],
                                [['Site A', -29, 134, long]]);
        expect(long.length).toBeGreaterThan(200);
        expect(kml).toContain(`<SimpleData name="LICENCES">${long}</SimpleData>`);
        expect(kml).not.toContain('...</td>');
    });

    it('escapes XML metacharacters in attribute values', () => {
        const kml = generateKml(['NAME', 'LATITUDE', 'LONGITUDE', 'NOTE'],
                                [['A & B', -29, 134, 'x < y & "z"']]);
        expect(kml).toContain('<SimpleData name="NOTE">x &lt; y &amp; &quot;z&quot;</SimpleData>');
    });

    it('omits geometry columns from the attributes', () => {
        const kml = generateKml(['NAME', 'LATITUDE', 'LONGITUDE'], [['Site A', -29, 134]]);
        expect(kml).not.toContain('name="LATITUDE"');
    });
});

describe('KML flavours', () => {
    const columns = ['NAME', 'LATITUDE', 'LONGITUDE', 'CHANNELS'];
    const rows = [['Site A', -29, 134, 20]];

    it("defaults to 'earth': keeps the popup balloon AND the attributes", () => {
        const kml = generateKml(columns, rows);
        expect(kml).toContain('<description><![CDATA[<table');
        expect(kml).toContain('<SimpleData name="CHANNELS">20</SimpleData>');
    });

    it("'qgis' drops the balloon but keeps every attribute", () => {
        const kml = generateKml(columns, rows, 'qgis');
        expect(kml).not.toContain('<table');
        expect(kml).toContain('<SimpleData name="CHANNELS">20</SimpleData>');
        expect(kml).toContain('<SimpleField type="int" name="CHANNELS">');
        // The placemark still has a name and geometry.
        expect(kml).toContain('<![CDATA[Site A]]>');
        expect(kml).toContain('<coordinates>134,-29</coordinates>');
    });

    it('emits 2D coordinates, not a meaningless zero elevation', () => {
        // ",0" made every feature POINT Z in OGR; QGIS then carries the phantom Z
        // through joins, exports and geometry algorithms.
        const kml = generateKml(['NAME', 'LATITUDE', 'LONGITUDE'], [['A', -29, 134]]);
        expect(kml).toContain('<coordinates>134,-29</coordinates>');
        expect(kml).not.toContain(',0</coordinates>');
    });

    it("'qgis' output is materially smaller", () => {
        const wide = ['NAME', 'LATITUDE', 'LONGITUDE', ...Array.from({ length: 12 }, (_, i) => `F${i}`)];
        const wideRows = [['A', -29, 134, ...Array.from({ length: 12 }, () => 'some value here')]];
        const earth = generateKml(wide, wideRows);
        const qgis = generateKml(wide, wideRows, 'qgis');
        expect(qgis.length).toBeLessThan(earth.length * 0.7);
    });
});
