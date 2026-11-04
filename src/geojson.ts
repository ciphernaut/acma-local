/**
 * GeoJSON generation for ACMA RRL query results (RFC 7946).
 *
 * Shares its column conventions with kml.ts — see docs/geospatial-export.md. The
 * two exist side by side because they serve different destinations: GDAL's LIBKML
 * driver cannot declare a layer geometry type and injects eleven boilerplate
 * fields, so KML is a poor GIS target however well it is written. GeoJSON is the
 * one to hand to QGIS; KML is the one to hand to Google Earth.
 */

import type { ExportStats } from './export_stats.js';

type Position = [number, number];

interface Geometry {
    type: 'Point' | 'LineString' | 'Polygon';
    coordinates: Position | Position[] | Position[][];
}

export function generateGeoJson(columns: string[], rows: unknown[][], stats?: ExportStats): string {
    const lCols = columns.map(c => c.toLowerCase());
    const latIdx = lCols.indexOf('latitude');
    const lngIdx = lCols.indexOf('longitude');
    const geomIdx = lCols.indexOf('geometry');

    const propIdx = columns
        .map((_, i) => i)
        .filter(i => i !== latIdx && i !== lngIdx && i !== geomIdx);

    const features: Array<{ type: 'Feature'; geometry: Geometry; properties: Record<string, unknown> }> = [];
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;

    const track = (pos: Position): void => {
        if (pos[0] < west) west = pos[0];
        if (pos[0] > east) east = pos[0];
        if (pos[1] < south) south = pos[1];
        if (pos[1] > north) north = pos[1];
    };

    for (const row of rows) {
        let geometry: Geometry | null = null;

        if (geomIdx >= 0 && row[geomIdx]) {
            geometry = wktToGeoJson(String(row[geomIdx]));
        }
        if (!geometry && latIdx >= 0 && lngIdx >= 0) {
            const pos = toPosition(row[lngIdx], row[latIdx]);
            if (pos) geometry = { type: 'Point', coordinates: pos };
        }
        if (!geometry) {
            if (stats) stats.skipped++;
            continue;   // no usable geometry: skip, never emit null geometry
        }

        const properties: Record<string, unknown> = {};
        for (const i of propIdx) {
            // Property names are used verbatim; JSON keys have no character rules,
            // unlike the XML field names KML has to sanitise.
            properties[columns[i]!] = normalise(row[i]);
        }

        forEachPosition(geometry, track);
        features.push({ type: 'Feature', geometry, properties });
    }

    const collection: Record<string, unknown> = { type: 'FeatureCollection' };
    // bbox precedes features per the RFC's member ordering guidance, and lets QGIS
    // and web viewers zoom to the data rather than the whole world.
    if (features.length > 0) collection.bbox = [west, south, east, north];
    collection.features = features;

    // No `crs` member: RFC 7946 fixes the CRS as WGS 84, and emitting one is
    // non-conformant.
    return JSON.stringify(collection, null, 2) + '\n';
}

/** SQLite hands back numbers, strings, null and occasionally Buffers. */
function normalise(value: unknown): unknown {
    if (value === undefined) return null;
    if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    return String(value);
}

/**
 * A coordinate pair, or null when unusable.
 *
 * Zero is a legitimate coordinate and is kept — dropping zeros would silently
 * discard real rows. Range validation is what catches junk.
 */
function toPosition(lng: unknown, lat: unknown): Position | null {
    const x = Number(lng);
    const y = Number(lat);
    if (lng === null || lng === undefined || lng === '' || Number.isNaN(x)) return null;
    if (lat === null || lat === undefined || lat === '' || Number.isNaN(y)) return null;
    if (y < -90 || y > 90 || x < -180 || x > 180) return null;
    return [x, y];
}

function forEachPosition(geometry: Geometry, fn: (p: Position) => void): void {
    if (geometry.type === 'Point') {
        fn(geometry.coordinates as Position);
    } else if (geometry.type === 'LineString') {
        for (const p of geometry.coordinates as Position[]) fn(p);
    } else {
        for (const ring of geometry.coordinates as Position[][]) for (const p of ring) fn(p);
    }
}

/** WKT subset matching kml.ts: POINT, LINESTRING, POLYGON (outer ring only). */
function wktToGeoJson(wkt: string): Geometry | null {
    const trimmed = wkt.trim().toUpperCase();

    if (trimmed.startsWith('POINT')) {
        const m = trimmed.match(/\(([^)]+)\)/);
        const pos = m?.[1] ? parsePosition(m[1]) : null;
        return pos ? { type: 'Point', coordinates: pos } : null;
    }
    if (trimmed.startsWith('LINESTRING')) {
        const m = trimmed.match(/\(([^)]+)\)/);
        const line = m?.[1] ? parsePositions(m[1]) : [];
        return line.length >= 2 ? { type: 'LineString', coordinates: line } : null;
    }
    if (trimmed.startsWith('POLYGON')) {
        const m = trimmed.match(/\(\(([^)]+)\)\)/);
        const ring = m?.[1] ? parsePositions(m[1]) : [];
        if (ring.length < 4) return null;
        // RFC 7946 requires a closed ring.
        const first = ring[0]!, last = ring[ring.length - 1]!;
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
        return { type: 'Polygon', coordinates: [ring] };
    }
    return null;
}

function parsePosition(text: string): Position | null {
    const parts = text.trim().split(/\s+/);
    return parts.length >= 2 ? toPosition(parts[0], parts[1]) : null;
}

function parsePositions(text: string): Position[] {
    return text.split(',')
        .map(p => parsePosition(p))
        .filter((p): p is Position => p !== null);
}
