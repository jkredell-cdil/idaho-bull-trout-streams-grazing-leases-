# SHAPEFILES.md — Getting Shapefiles Working in CollectionBuilder-CSV

This documents how GIS shapefile data (allotment boundaries, stream lines) was integrated into this collection's map, why the naive approach doesn't work, and the process used to fix it. It's meant to save the next person — human or AI — from re-diagnosing the same problems.

## Why shapefiles don't just work

CollectionBuilder-CSV's map (`/map.html`, built on Leaflet.js) has one built-in mechanism: it plots a marker for every item in your metadata CSV that has `latitude`/`longitude` columns (see `docs/maps.md`). That's it — there's no CSV column or config file for "add a polygon layer" or "add a line layer." Two problems follow from that:

1. **Shapefiles aren't GeoJSON.** A `.shp` is a binary format, bundled with a `.dbf` (attribute table), `.shx` (index), and `.prj` (coordinate system) in a zip. Leaflet can only render GeoJSON directly in the browser — the shapefile has to be converted first.
2. **Shapefiles are almost never in the coordinate system a web map needs.** Web maps (Leaflet, Google Maps, etc.) expect **WGS84** — plain longitude/latitude in degrees (EPSG:4326). GIS shapefiles from agencies are usually exported in a local projected coordinate system, in meters, for accurate area/distance measurement. Here, all three source shapefiles (`Allotments_with_BullTrout`, `BLM_ID_Grazing_Allotments`, `Generalized_Fish_Distribution`) were in **NAD83 Idaho Transverse Mercator (EPSG:8826)**. Plotting those coordinates directly on Leaflet would put every feature in the middle of the Atlantic Ocean.

So the real task was never "add the shapefile to the map" — it was: **convert shapefile → GeoJSON, reproject to WGS84, then decide how to get that GeoJSON onto the Leaflet map**, since CollectionBuilder has no config-driven path for the last part.

## How to tell what you're dealing with, before converting

Before writing any conversion command, check two things in the shapefile's `.prj` file (plain text, safe to open directly):

- **Is it already WGS84?** Look for `GEOGCS["GCS_WGS_1984"...]` with no `PROJCS` wrapper — if so, no reprojection needed, only format conversion.
- **What's the source CRS?** If it says `PROJCS[...]` (this repo's files all said `NAD_1983_Idaho_TM`), it's projected and *must* be reprojected before the data is web-map-usable.

You can also peek at a shapefile's attribute field names and geometry type (Point/PolyLine/Polygon) without fully converting it, which is useful for figuring out how a shapefile's attributes might join to your metadata CSV. This project's `Allotments_with_BullTrout` shapefile turned out to have exactly 129 polygon features with an `ALLOT_NO` field — a perfect 1:1 match to the 129 rows in `_data/bull-trout-allotments.csv` and its `allot_no` column. Finding that join key first is what made the rest of the process straightforward.

## The conversion process used here

No GDAL, Node.js, or Python was installed on the machine this was done on, so the process was:

1. **Install Node.js portably**, without an admin-elevated system install — download the "win-x64" zip build from nodejs.org and extract it (avoid deeply nested paths; Windows' ~260 character path limit breaks npm's dependency tree if you extract too deep, e.g. inside a long scratch/temp directory — extract somewhere short like `C:\tools\node`).
2. **Install `mapshaper`** as a local npm dependency in a scratch working folder (`npm install mapshaper` — no need to install it globally or touch the project's own `package.json`, since this project doesn't otherwise use Node).
3. **Extract the shapefile zip** to a working folder (needs the `.shp`, `.dbf`, and `.prj` together — mapshaper reads the `.prj` automatically to detect the source CRS).
4. **Reproject and convert to GeoJSON:**
   ```
   mapshaper Allotments_with_BullTrout.shp -proj wgs84 -o allotments-with-bulltrout.geojson format=geojson precision=0.000001
   ```
5. **Compute one centroid point per polygon** (to get a single lat/long per allotment, for the standard CB item map), keeping the same attributes:
   ```
   mapshaper Allotments_with_BullTrout.shp -proj wgs84 -points centroid -o allotment-centroids.geojson format=geojson precision=0.000001
   ```
6. **Join the centroids back to the metadata CSV** by matching `allot_no` (CSV, integer) against the shapefile's `ALLOT_NO` (zero-padded string, e.g. `"00064"`), and add `latitude`/`longitude` columns to all 129 rows.

Once those two columns existed, CollectionBuilder's *existing* map, "View on Map" buttons, and mini-map feature all started working immediately — no template code needed for that part. That's the framework working as intended: geodata belongs in the CSV, not in a template.

## The two-hour gotcha: BOM breaks Jekyll's CSV reader

After adding the `latitude`/`longitude` columns, the Jekyll build failed with:
```
Error: Illegal quoting in line 1.
```
This error gets reported against whatever template happens to be rendering when the site data fails to load (in this case `_includes/js/map-js.html`), which is misleading — **the actual problem is almost always in a `_data/*.csv` file**, not the template named in the error.

The cause: the CSV was re-saved using PowerShell's `Export-Csv -Encoding UTF8`, which (on Windows PowerShell 5.1) writes a **UTF-8 byte-order-mark (BOM)** at the start of the file. Ruby's CSV library (which Jekyll uses to read `_data/*.csv`) doesn't strip a BOM by default, so it reads the BOM bytes as part of the first field, sees a stray `"` in the wrong position, and throws "illegal quoting."

**This is a very common failure mode any time a CSV has passed through Excel, PowerShell, or certain GIS export tools** — all three are known to silently add a BOM. If a `_data/*.csv` file suddenly breaks the build with an "illegal quoting" or similar cryptic CSV error after being edited/re-saved outside of a plain text editor, check for a BOM first:
```
xxd _data/your-file.csv | head -1
```
If the file starts with `efbb bf`, that's the BOM — strip it (re-save as "UTF-8 without BOM," or strip the 3 bytes programmatically) and the file will parse normally again.

## Where the map layers actually live now

Because CollectionBuilder has no config file for polygon/line overlays, that part *does* legitimately live in a template — `_includes/js/map-js.html`, which is the documented customization point for map behavior (see `docs/maps.md`). The pattern used:

- The GeoJSON files are **not** embedded into the page via Liquid (they're 0.1–1MB — too big to inline into every page load). Instead the page does a client-side `fetch()` for each one, after the base map and item markers are already set up.
- Each overlay is registered with Leaflet's layer control (`layersControl.addOverlay(...)`), so it can be toggled on/off in the browser, and gated behind a `_data/theme.yml` flag (`map-allotment-boundaries`, `map-stream-lines`) so it can be disabled without touching code.
- Popups cross-link the two layers: an allotment polygon's popup links to its item page; a stream line's popup links to the item page(s) of every allotment it passes through, via a small `title → objectid` lookup built once from `site.data[site.metadata]`.

This "fetch a static GeoJSON file client-side, render as a togglable Leaflet overlay, gate behind a theme.yml flag" pattern is reusable for *any* future geospatial layer in a CollectionBuilder-CSV site — it doesn't require editing anything beyond that one include and adding a flag.

## For next time: reusable tips

- **Always check the `.prj` before converting anything.** It's a 5-second text read that tells you immediately whether you need `-proj wgs84` or not.
- **Keep raw shapefile zips in the repo but out of the built site.** They're useful provenance/source data, but a 20MB zip doesn't need to be published — add them to `_config.yml`'s `exclude:` list rather than deleting them.
- **Look for a join key in the `.dbf` attributes before doing any manual matching.** Government/agency shapefiles (BLM, USGS, state GIS) very often share an ID scheme with any tabular data derived from the same source — check for it before assuming you need fuzzy name-matching.
- **Re-save CSVs from a plain-text-safe tool**, or explicitly strip a BOM after using PowerShell/Excel, any time you programmatically edit a `_data/*.csv`.
- **mapshaper over GDAL when you can't install anything system-wide.** `ogr2ogr` (GDAL) is the more "correct" tool for professional GIS work, but it's a heavier install and this environment couldn't get it installed non-interactively. `npx mapshaper` needed only a portable Node.js extraction and handled reprojection, format conversion, and centroid generation for this use case without issue.

## Possible future uses of this pattern in CollectionBuilder

A few directions this collection — or others built on CollectionBuilder-CSV — could take this further:

- **Bring in the other two shapefiles as opt-in layers.** `BLM_ID_Grazing_Allotments_shapefile.zip` (all 2,073 Idaho BLM allotments) and `Generalized_Fish_Distribution-shp.zip` (statewide fish distribution) were deliberately left out to keep the map focused, but both convert with the exact same `mapshaper -proj wgs84` command and could be added as additional togglable overlays later if the collection's scope grows.
- **Give allotments real boundary shapes instead of just centroid markers.** The allotment polygons are already being drawn as an overlay layer; a future enhancement could swap the item map's point markers for the actual polygon shapes (still linked to item pages), giving a more accurate picture than a single center-point per allotment.
- **A small conversion script/Rake task.** If more shapefiles get added over time, it'd be worth adding a `rakelib/` task (this project already has a `Rakefile` and `rakelib/` for other build steps) that wraps the extract → `mapshaper -proj wgs84` → copy-into-`assets/data/` steps, so future contributors don't have to rediscover this process.
- **Feed a `config-map.csv`-style file for overlay popups**, the way item map popups are already configured, if the number of overlay layers grows enough that hardcoding each popup template in `map-js.html` becomes unwieldy. Not needed for two layers, but worth revisiting if a third or fourth is added.
- **General principle for other CollectionBuilder-CSV collections:** any collection with an associated GIS dataset (a historic district's parcels, a trail system, a watershed) can use this same "reproject with mapshaper → static GeoJSON in `assets/data/` → client-side `fetch()` overlay in `map-js.html` → `theme.yml` toggle" pattern, even though it isn't part of the framework's built-in config system.
