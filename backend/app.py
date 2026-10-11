import json
import os

import boto3

import quota
import shade

ROUTE_CALC = os.environ["ROUTE_CALCULATOR"]
GRID_BUCKET = os.environ["GRID_BUCKET"]
GRID_KEY = os.environ.get("GRID_KEY", "shade_grid.json")
K = int(os.environ.get("DETOUR_CANDIDATES", "3"))
MAX_RATIO = float(os.environ.get("MAX_DURATION_RATIO", "1.3"))

location = boto3.client("location")
s3 = boto3.client("s3")
_grid = None  # cached across warm invocations


def get_grid():
    global _grid
    if _grid is None:
        obj = s3.get_object(Bucket=GRID_BUCKET, Key=GRID_KEY)
        _grid = json.loads(obj["Body"].read())
    return _grid


def inside_bounds(grid, p):
    (w, s), (e, n) = grid["bounds"]
    return w <= p[0] <= e and s <= p[1] <= n


def calc(origin, dest, waypoints=None):
    kwargs = {
        "CalculatorName": ROUTE_CALC,
        "DeparturePosition": origin,
        "DestinationPosition": dest,
        "TravelMode": "Walking",
        "DistanceUnit": "Kilometers",
        "IncludeLegGeometry": True,
    }
    if waypoints:
        kwargs["WaypointPositions"] = waypoints
    resp = location.calculate_route(**kwargs)

    coords = []
    for i, leg in enumerate(resp["Legs"]):
        pts = leg["Geometry"]["LineString"]
        coords.extend(pts if i == 0 else pts[1:])  # legs share a join point

    return {
        "distance_m": resp["Summary"]["Distance"] * 1000,
        "duration_s": resp["Summary"]["DurationSeconds"],
        "coordinates": coords,
    }


def reply(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def route_out(name, r, shade_frac, cov):
    return {
        "name": name,
        "distance_m": round(r["distance_m"]),
        "duration_s": round(r["duration_s"]),
        "shade_fraction": round(shade_frac, 3),
        "coverage": round(cov, 3),
        "geometry": {"type": "LineString", "coordinates": r["coordinates"]},
    }


def _handle(event, context):
    try:
        body = json.loads(event.get("body") or "{}")
        origin = [float(v) for v in body["origin"]]
        dest = [float(v) for v in body["destination"]]
    except (KeyError, ValueError, TypeError):
        return reply(400, {"error": "Send origin and destination as [lon, lat]."})

    grid = get_grid()
    if not (inside_bounds(grid, origin) and inside_bounds(grid, dest)):
        return reply(400, {"error": "Both points must be inside the demo area."})

    # Reserve 1 call for the direct route first
    if not quota.reserve(1):
        return reply(429, {"error": "Daily route quota reached. Try again tomorrow."})

    try:
        direct = calc(origin, dest)
    except Exception as e:
        print("direct route failed:", e)
        return reply(502, {"error": "Routing service unavailable."})

    direct_shade, direct_cov = shade.score_line(grid, direct["coordinates"])

    # Candidates depend on the direct route, so reserve their calls after it
    best = None  # (shade, coverage, route)
    candidates = shade.candidate_waypoints(grid, direct["coordinates"], K)
    if candidates and quota.reserve(len(candidates)):
        for wp in candidates:
            try:
                alt = calc(origin, dest, waypoints=[wp])
            except Exception as e:
                print("detour failed:", e)
                continue

            if shade.has_backtrack(alt['coordinates']):
                continue

            if alt["duration_s"] > direct["duration_s"] * MAX_RATIO:
                continue
            sh, cov = shade.score_line(grid, alt["coordinates"])
            if sh > direct_shade and (best is None or sh > best[0]):
                best = (sh, cov, alt)

    if best:
        cooler = route_out("cooler", best[2], best[0], best[1])
        rule = f"cooler = highest-shade nearby detour within {MAX_RATIO}x the fastest time"
    else:
        cooler = route_out("cooler", direct, direct_shade, direct_cov)
        rule = ("no nearby detour beat the fastest route's shade within the time limit "
                "(or quota was short); cooler equals fastest")

    return reply(200, {
        "shade_date": grid["meta"]["shade_date"],
        "routes": [route_out("fastest", direct, direct_shade, direct_cov), cooler],
        "rule": rule,
    })

def handler(event, context):
    try:
        return _handle(event, context)
    except Exception as e:
        print("unhandled error:", repr(e))
        return reply(500, {"error" : "Internal error. Try again later."})
