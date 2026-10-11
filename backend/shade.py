import math

M_LAT = 110574.0        # metres per degree of latitude
M_LON_EQ = 111320.0     # metres per degree of longitude at the equator


def m_per_deg_lon(lat):
    return M_LON_EQ * math.cos(math.radians(lat))


def shade_at(grid, lon, lat):
    """Shade value for a point, or None if outside the grid or unmapped."""
    (w, s), (e, n) = grid["bounds"]
    if not (w <= lon < e and s <= lat < n):
        return None
    col = int((lon - w) / grid["dlon"])
    row = int((lat - s) / grid["dlat"])
    if col >= grid["nx"] or row >= grid["ny"]:
        return None
    return grid["values"][row * grid["nx"] + col]


def distance_m(a, b):
    dx = (a[0] - b[0]) * m_per_deg_lon((a[1] + b[1]) / 2)
    dy = (a[1] - b[1]) * M_LAT
    return math.hypot(dx, dy)


def sample_line(coords, step_m=10.0):
    """Points roughly every step_m metres along a [lon, lat] polyline."""
    points = []
    for (lon1, lat1), (lon2, lat2) in zip(coords, coords[1:]):
        dx = (lon2 - lon1) * m_per_deg_lon((lat1 + lat2) / 2)
        dy = (lat2 - lat1) * M_LAT
        n = max(1, int(math.hypot(dx, dy) / step_m))
        for k in range(n):
            t = k / n
            points.append((lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t))
    if coords:
        points.append(tuple(coords[-1]))
    return points


def score_line(grid, coords):
    """Return (shade_fraction, coverage).
    shade_fraction: mean shade over samples that have data.
    coverage: share of samples that had any data at all."""
    points = sample_line(coords)
    if not points:
        return 0.0, 0.0
    values = [v for v in (shade_at(grid, lon, lat) for lon, lat in points) if v is not None]
    if not values:
        return 0.0, 0.0
    return sum(values) / len(values), len(values) / len(points)


def has_backtrack(coords, decimals=6):
    """True if the route revisits a point, which usually means an out-and-back spur."""
    seen = set()
    for lon, lat in coords:
        key = (round(lon, decimals), round(lat, decimals))
        if key in seen:
            return True
        seen.add(key)
    return False

def candidate_waypoints(grid, direct_coords, k, step_m=200.0,
                        offsets_m=(60.0, 100.0, 140.0), min_sep_m=150.0):
    """Up to k detour points that sit beside the direct route, on either side,
    ranked by shade. Points stay close to the line so the time rule can pass."""
    samples = sample_line(direct_coords, step_m=10.0)
    every = max(1, int(step_m / 10))
    scored = []

    for i in range(every, len(samples) - every, every):
        lon1, lat1 = samples[i - every]
        lon2, lat2 = samples[i + every]
        dx = (lon2 - lon1) * m_per_deg_lon(lat1)
        dy = (lat2 - lat1) * M_LAT
        length = math.hypot(dx, dy)
        if length == 0:
            continue
        # unit normal (perpendicular to the route direction), in metres
        nx_, ny_ = -dy / length, dx / length
        lon0, lat0 = samples[i]

        for d in offsets_m:
            for sign in (1, -1):
                lon = lon0 + sign * d * nx_ / m_per_deg_lon(lat0)
                lat = lat0 + sign * d * ny_ / M_LAT
                v = shade_at(grid, lon, lat)
                if v is not None:
                    scored.append((v, [lon, lat]))

    scored.sort(key=lambda item: item[0], reverse=True)

    chosen = []
    for _, p in scored:
        if all(distance_m(p, q) >= min_sep_m for q in chosen):
            chosen.append(p)
            if len(chosen) == k:
                break
    return chosen

