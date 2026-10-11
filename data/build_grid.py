import json
import math

from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
BUILT_AT = datetime.now(IST).strftime("%Y-%m-%d %H:%M IST")

# Set this to the date of the Geofabrik file you downloaded, not today's date
OSM_EXTRACT_DATE = "2026-10-10"

SHADE_DATE = f"Built {BUILT_AT} from OSM data as of {OSM_EXTRACT_DATE}"
SOURCE = "OSM (Geofabrik India extract, clipped): trees and green areas only"

# Keep these identical to clip.sh and docs/definitions.md.
BOUNDS = [[77.1990, 28.6100], [77.2330, 28.6300]]
CELL_M = 50.0

TREE_RADIUS_M = 6.0
TREE_VALUE = 0.6
GREEN_VALUE = 0.8

TREES_FILE = "data/trees.geojson"
GREEN_FILE = "data/green.geojson"
OUT_FILE = "data/shade_grid.json"


def load_features(path):
    with open(path) as f:
        return json.load(f)["features"]


def tree_points(features):
    return [f["geometry"]["coordinates"] for f in features
            if f["geometry"] and f["geometry"]["type"] == "Point"]


def green_rings(features):
    """Outer rings of all polygons, each paired with its bounding box for a quick reject."""
    rings = []
    for f in features:
        g = f["geometry"]
        if not g:
            continue
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else (
            [g["coordinates"]] if g["type"] == "Polygon" else [])
        for poly in polys:
            ring = poly[0]
            lons = [p[0] for p in ring]
            lats = [p[1] for p in ring]
            bbox = (min(lons), min(lats), max(lons), max(lats))
            rings.append((bbox, ring))
    return rings


def point_in_ring(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def main():
    (w, s), (e, n) = BOUNDS
    lat_mid = (s + n) / 2
    dlat = CELL_M / 110574.0
    dlon = CELL_M / (111320.0 * math.cos(math.radians(lat_mid)))
    nx = math.ceil((e - w) / dlon)
    ny = math.ceil((n - s) / dlat)

    trees = tree_points(load_features(TREES_FILE))
    rings = green_rings(load_features(GREEN_FILE))
    r_deg_lat = TREE_RADIUS_M / 110574.0
    r_deg_lon = TREE_RADIUS_M / (111320.0 * math.cos(math.radians(lat_mid)))

    values = []
    for row in range(ny):
        lat = s + (row + 0.5) * dlat
        for col in range(nx):
            lon = w + (col + 0.5) * dlon
            v = 0.0

            for tlon, tlat in trees:
                if abs(tlon - lon) <= r_deg_lon and abs(tlat - lat) <= r_deg_lat:
                    v = TREE_VALUE
                    break

            for (x0, y0, x1, y1), ring in rings:
                if x0 <= lon <= x1 and y0 <= lat <= y1 and point_in_ring(lon, lat, ring):
                    v = max(v, GREEN_VALUE)
                    break

            values.append(round(v, 2))

    grid = {
        "meta": {"shade_date": SHADE_DATE, "source": SOURCE, "cell_m": CELL_M},
        "bounds": BOUNDS,
        "dlon": dlon,
        "dlat": dlat,
        "nx": nx,
        "ny": ny,
        "values": values,
    }
    with open(OUT_FILE, "w") as f:
        json.dump(grid, f, separators=(",", ":"))

    print(f"wrote {OUT_FILE}: {nx} x {ny} cells, {len(trees)} trees, {len(rings)} green rings")


if __name__ == "__main__":
    main()

