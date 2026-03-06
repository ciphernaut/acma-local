/**
 * KML Generation Utilities for ACMA RRL Data.
 * Supports POINT, LINESTRING, and POLYGON WKT, plus simple LATITUDE/LONGITUDE columns.
 */

export function generateKml(columns: string[], rows: unknown[][]): string {
    const lCols = columns.map(c => c.toLowerCase());
    const latIdx = lCols.indexOf('latitude');
    const lngIdx = lCols.indexOf('longitude');
    const geomIdx = lCols.indexOf('geometry');
    const nameIdx = lCols.indexOf('name');

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
            if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
                geometryKml = `<Point><coordinates>${lng},${lat},0</coordinates></Point>`;
            }
        }

        if (geometryKml) {
            const description = generateDescription(columns, row);
            placemarks += `
    <Placemark>
      <name><![CDATA[${name}]]></name>
      <description><![CDATA[${description}]]></description>
      ${geometryKml}
      <styleUrl>#ACMA_style</styleUrl>
    </Placemark>`;
        }
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document id="ACMA_KML">
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
                return `<Point><coordinates>${parts[0]},${parts[1]},0</coordinates></Point>`;
            }
        }
    }
    // LINESTRING(120 -35, 125 -25)
    else if (trimmed.startsWith('LINESTRING')) {
        const match = trimmed.match(/\(([^)]+)\)/);
        if (match && match[1]) {
            const pairs = match[1].split(',').map(p => {
                const parts = p.trim().split(/\s+/);
                return parts.length >= 2 ? `${parts[0]},${parts[1]},0` : null;
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
                return parts.length >= 2 ? `${parts[0]},${parts[1]},0` : null;
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
            // Truncate long strings for description
            let displayVal = String(val);
            if (displayVal.length > 200) displayVal = displayVal.substring(0, 197) + '...';
            html += `<tr><td style="padding: 2px; background: #eee;"><b>${columns[i]}</b></td><td style="padding: 2px;">${displayVal}</td></tr>`;
        }
    }
    html += '</table>';
    return html;
}
