import { generateKml } from '../src/kml.js';

describe('KML Generation', () => {
    it('should generate KML for points', () => {
        const columns = ['NAME', 'LATITUDE', 'LONGITUDE'];
        const rows = [['Site A', -29, 134]];
        const kml = generateKml(columns, rows);
        expect(kml).toContain('<coordinates>134,-29,0</coordinates>');
        expect(kml).toContain('<![CDATA[Site A]]>');
    });

    it('should generate KML for WKT geometries', () => {
        const columns = ['NAME', 'GEOMETRY'];
        const rows = [['Line A', 'LINESTRING(120 -35, 125 -25)']];
        const kml = generateKml(columns, rows);
        expect(kml).toContain('<LineString><coordinates>120,-35,0 125,-25,0</coordinates></LineString>');
    });

    it('should handle polygons', () => {
        const columns = ['NAME', 'GEOMETRY'];
        const rows = [['Poly A', 'POLYGON((140 -35, 155 -35, 155 -25, 140 -25, 140 -35))']];
        const kml = generateKml(columns, rows);
        expect(kml).toContain('<Polygon><outerBoundaryIs><LinearRing><coordinates>140,-35,0 155,-35,0 155,-25,0 140,-25,0 140,-35,0</coordinates></LinearRing></outerBoundaryIs></Polygon>');
    });

    it('should generate descriptions with HTML tables', () => {
        const columns = ['ID', 'NAME', 'LATITUDE', 'LONGITUDE'];
        const rows = [[1, 'Test', -29, 134]];
        const kml = generateKml(columns, rows);
        expect(kml).toContain('<b>ID</b></td><td style="padding: 2px;">1</td>');
        expect(kml).toContain('<b>NAME</b></td><td style="padding: 2px;">Test</td>');
    });
});
