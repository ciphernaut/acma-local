/**
 * KML Generation Utilities for ACMA RRL Data.
 * Supports POINT, LINESTRING, and POLYGON WKT, plus simple LATITUDE/LONGITUDE columns.
 */

import type { ExportStats } from './export_stats.js';

export type KmlFlavour = 'earth' | 'qgis';

/**
 * @param flavour 'earth' (default) keeps the HTML balloon that Google Earth shows
 *   on click. 'qgis' omits it: a GIS loads the attributes from ExtendedData, and
 *   the balloon markup just arrives as a large useless Description field in the
 *   attribute table — and is most of the file size.
 */
export function generateKml(
    columns: string[],
    rows: unknown[][],
    flavour: KmlFlavour = 'earth',
    stats?: ExportStats,
): string {
    const lCols = columns.map(c => c.toLowerCase());
    const latIdx = lCols.indexOf('latitude');
    const lngIdx = lCols.indexOf('longitude');
    const geomIdx = lCols.indexOf('geometry');
    const nameIdx = lCols.indexOf('name');

    // Columns carried as real attributes. The HTML <description> below is only a
    // Google Earth balloon: OGR — and so QGIS — reads Name and Description from it
    // and nothing else, so anything meant to be filtered, styled or joined has to
    // be repeated in <ExtendedData>.
    const attrIdx = columns
        .map((_, i) => i)
        .filter(i => i !== latIdx && i !== lngIdx && i !== geomIdx && i !== nameIdx);
    const schemaId = 'ACMA_schema';
    const schema = attrIdx.length === 0 ? '' : `
    <Schema name="${schemaId}" id="${schemaId}">
${attrIdx.map(i => `      <SimpleField type="${inferType(rows, i)}" name="${fieldName(columns[i]!)}"></SimpleField>`).join('\n')}
    </Schema>`;

    let placemarks = '';

    for (const row of rows) {
        let geometryKml = '';
        let name = 'ACMA Site';

        if (nameIdx >= 0 && row[nameIdx]) {
            name = String(row[nameIdx]);
        }

        // 1. Try WKT Geometry Column
        if (geomIdx >= 0 && row[geomIdx]) {
            geometryKml = wktToKml(String(row[geomIdx]));
        }

        // 2. Try Latitude/Longitude Columns if no WKT or as fallback
        if (!geometryKml && latIdx >= 0 && lngIdx >= 0) {
            const lat = Number(row[latIdx]);
            const lng = Number(row[lngIdx]);
            // Range-check rather than reject zeros: 0 is a real coordinate, and
            // discarding it silently drops rows. Out-of-range values are the junk
            // worth catching. Matches generateGeoJson — docs/geospatial-export.md.
            const usable = !isNaN(lat) && !isNaN(lng)
                && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
                && row[latIdx] !== null && row[latIdx] !== '' 
                && row[lngIdx] !== null && row[lngIdx] !== '';
            if (usable) {
                geometryKml = `<Point><coordinates>${lng},${lat}</coordinates></Point>`;
            }
        }

        if (geometryKml) {
            const description = flavour === 'qgis' ? '' : `
      <description><![CDATA[${generateDescription(columns, row)}]]></description>`;
            const extended = attrIdx.length === 0 ? '' : `
      <ExtendedData>
        <SchemaData schemaUrl="#${schemaId}">
${attrIdx.map(i => `          <SimpleData name="${fieldName(columns[i]!)}">${xmlEscape(row[i])}</SimpleData>`).join('\n')}
        </SchemaData>
      </ExtendedData>`;
            placemarks += `
    <Placemark>
      <name><![CDATA[${name}]]></name>${description}${extended}
      ${geometryKml}
      <styleUrl>#ACMA_style</styleUrl>
    </Placemark>`;
        } else if (stats) {
            stats.skipped++;   // no usable geometry: whole row abandoned
        }
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document id="ACMA_KML">${schema}
    <Style id="ACMA_style">
      <LabelStyle><scale>0.75</scale></LabelStyle>
      <IconStyle>
        <scale>0.75</scale>
        <color>ffffff00</color>
      </IconStyle>
      <LineStyle>
        <color>FF66FF00</color>
        <width>2</width>
      </LineStyle>
      <PolyStyle>
        <color>AA66FF00</color>
      </PolyStyle>
    </Style>
    <Folder>
      <name>ACMA KML Export</name>
      <description>Generated from ACMA RRL MCP Server</description>
      ${placemarks}
    </Folder>
  </Document>
</kml>`;
}

/** XML text-node escaping for ExtendedData values. */
function xmlEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Column name reduced to something valid as an XML attribute value / field name. */
function fieldName(column: string): string {
    return column.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Field type for a column, from the values actually present: int when every
 * non-empty value is a whole number, float when they are all numeric, else string.
 * QGIS will happily sort and range-filter a typed column and will not on a string.
 */
function inferType(rows: unknown[][], idx: number): 'int' | 'float' | 'string' {
    let seen = false;
    let allInt = true;
    for (const row of rows) {
        const v = row[idx];
        if (v === null || v === undefined || v === '') continue;
        seen = true;
        if (typeof v === 'number') {
            if (!Number.isInteger(v)) allInt = false;
            continue;
        }
        const s = String(v).trim();
        if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return 'string';
        if (!/^-?\d+$/.test(s)) allInt = false;
    }
    if (!seen) return 'string';
    return allInt ? 'int' : 'float';
}

/**
 * Simple WKT to KML converter.
 * Handles POINT, LINESTRING, and POLYGON.
 */
function wktToKml(wkt: string): string {
    const trimmed = wkt.trim().toUpperCase();

    // POINT(134 -29)
    if (trimmed.startsWith('POINT')) {
        const match = trimmed.match(/\(([^)]+)\)/);
        if (match && match[1]) {
            const parts = match[1].trim().split(/\s+/);
            if (parts.length >= 2) {
                return `<Point><coordinates>${parts[0]},${parts[1]}</coordinates></Point>`;
            }
        }
    }
    // LINESTRING(120 -35, 125 -25)
    else if (trimmed.startsWith('LINESTRING')) {
        const match = trimmed.match(/\(([^)]+)\)/);
        if (match && match[1]) {
            const pairs = match[1].split(',').map(p => {
                const parts = p.trim().split(/\s+/);
                return parts.length >= 2 ? `${parts[0]},${parts[1]}` : null;
            }).filter(Boolean);
            return `<LineString><coordinates>${pairs.join(' ')}</coordinates></LineString>`;
        }
    }
    // POLYGON((140 -35, 155 -35, 155 -25, 140 -25, 140 -35))
    else if (trimmed.startsWith('POLYGON')) {
        const match = trimmed.match(/\(\(([^)]+)\)\)/);
        if (match && match[1]) {
            const pairs = match[1].split(',').map(p => {
                const parts = p.trim().split(/\s+/);
                return parts.length >= 2 ? `${parts[0]},${parts[1]}` : null;
            }).filter(Boolean);
            return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${pairs.join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
        }
    }

    return '';
}

/**
 * Generates an HTML table for the KML Placemark description.
 */
function generateDescription(columns: string[], row: unknown[]): string {
    let html = '<table border="1" style="border-collapse: collapse; font-family: sans-serif; font-size: 11px;">';
    for (let i = 0; i < columns.length; i++) {
        const val = row[i];
        if (val !== null && val !== undefined && val !== '') {
            // No truncation: cutting values at 200 characters silently lost the
            // tail of long lists (licence numbers, channel plans) in the popup.
            const displayVal = String(val)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            html += `<tr><td style="padding: 2px; background: #eee;"><b>${columns[i]}</b></td><td style="padding: 2px;">${displayVal}</td></tr>`;
        }
    }
    html += '</table>';
    return html;
}
