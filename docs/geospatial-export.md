# Geospatial export contract

`export_kml` and `export_geojson` render a cached query result as a map layer;
`export_qml` renders the matching QGIS *style*. All three read the same
`result_id`, so one query gives you data and presentation that agree.

The data exporters share the column conventions below, so the same query works with
either.

Pick by destination: **GeoJSON for QGIS and web maps, KML for Google Earth.**

> **The KML `flavour: "qgis"` option is deprecated.** It still works and is still
> tested — nothing calling it will break — but it is no longer advertised in
> `tools/list` or offered as a route to a GIS, and using it logs a warning. The
> table below is why: the things that make KML a poor GIS layer live in GDAL's
> driver, not in the file, so writing better KML cannot fix them. There is no
> removal date; it stays hidden until someone decides otherwise.

## Choosing a format

| | KML (`flavour: "qgis"`) | GeoJSON |
|---|---|---|
| Layer geometry type in OGR | `Unknown (any)` | `Point` / `LineString` / `Polygon` |
| Fields exposed | 11 driver boilerplate + yours | yours only |
| Typing | via `<Schema>`, int/float/string | native JSON types |
| Size, 189-site export | 240 KB | 112 KB |
| Popup balloon | `flavour: "earth"` | none (GeoJSON has no such concept) |

The boilerplate fields (`id`, `description`, `timestamp`, `begin`, `end`,
`altitudeMode`, `tessellate`, `extrude`, `visibility`, `drawOrder`, `icon`) are
injected by GDAL's LIBKML driver, not by us — the file cannot suppress them, which
is the main reason GeoJSON is the better QGIS target.

## Shared column conventions

Geometry, in precedence order:

1. a `GEOMETRY` column holding WKT — `POINT`, `LINESTRING` or `POLYGON`
2. `LATITUDE` + `LONGITUDE` columns

Column matching is case-insensitive. Rows with no usable geometry are **skipped**,
not emitted with a null geometry.

A coordinate is usable when it parses as a number and falls in range — latitude
−90..90, longitude −180..180. `0` is a legitimate value and is kept; junk and nulls
are dropped. (Range validation is what catches bad data; discarding zeros would
silently drop real rows, which is the failure mode this project keeps running into.)

Every remaining column becomes an attribute. `NAME` additionally becomes the KML
placemark title; GeoJSON has no title concept, so there it is an ordinary property.

## GeoJSON specifics

- **RFC 7946.** WGS 84 is implied, so no `crs` member is emitted.
- **`FeatureCollection`** with a **`bbox`** covering the features, so QGIS and web
  viewers zoom to the data instead of the whole world. Omitted when empty.
- **Native JSON types.** Numbers stay numbers, `NULL` stays `null`. No stringly
  typed columns, and no schema declaration is needed.
- **Coordinates are passed through unrounded.** RFC 7946 suggests trimming
  precision, but the register's values are already 6 decimal places (~10 cm) and
  rounding would alter published data for no practical gain.
- **Property names are used verbatim**, including spaces or punctuation, since JSON
  keys are unrestricted. KML sanitises them to `[A-Za-z0-9_]` for XML.
- An empty result is a valid empty `FeatureCollection`, not an error.

## Styling a QGIS layer

`export_qml` generates a `.qml` for the same cached result. Save it beside the data
file with the **same basename** and QGIS applies it on load:

    stations.geojson  +  stations.qml

It sets a point symbol, labels (from `NAME`, else the first column holding text) and
a **map tip** listing every attribute — the piece people miss, because QGIS shows
nothing on click by default; attributes otherwise live in the attribute table (F6)
or behind the Identify tool.

One step it cannot do for you: map tips are a QGIS-wide toggle, not a layer setting.
Turn them on once with **View > Show Map Tips**.

The same style works over a KML layer too, since KML `ExtendedData` keeps the field
names.

**What is and is not verified.** The generator is tested for well-formed XML,
correct escaping, field names that cannot break expression syntax, and a map tip
that references exactly the result's columns. Nothing tests how it *renders* —
there is no QGIS in CI — and the file is written against the QGIS 3.28 schema, so
schema drift in a future major is a real residual risk. If a style ever looks wrong,
delete the `.qml`; the data is untouched.

## Row limits

Both exporters render exactly the rows in the cached result, so a query that
reported `truncated: true` produces a layer that is silently short. Check that flag
before exporting — see the `execute_sql` docs.
