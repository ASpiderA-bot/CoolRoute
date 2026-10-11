import json
import boto3

client = boto3.client("location", region_name="ap-south-1")
CALC = "coolroute-calc"

ORIGIN = [77.2090, 28.6139]       # [lon, lat]
DEST = [77.2300, 28.6200]
DETOUR = [77.2200, 28.6250]       # any point inside the demo box, for testing


def route(waypoints=None):
    kwargs = {
        "CalculatorName": CALC,
        "DeparturePosition": ORIGIN,
        "DestinationPosition": DEST,
        "TravelMode": "Walking",
        "IncludeLegGeometry": True,
    }
    if waypoints:
        kwargs["WaypointPositions"] = waypoints
    return client.calculate_route(**kwargs)


def summarize(label, resp):
    s = resp["Summary"]
    coords = [p for leg in resp["Legs"] for p in leg["Geometry"]["LineString"]]
    print(f"{label}: {s['Distance']:.0f} m, {s['DurationSeconds']:.0f} s, {len(coords)} points")
    print(f"  first point: {coords[0]}  last point: {coords[-1]}")


if __name__ == "__main__":
    direct = route()
    summarize("direct", direct)

    detour = route(waypoints=[DETOUR])
    summarize("via detour", detour)

    # Save one raw response for the docs
    with open("route_sample.json", "w") as f:
        json.dump(detour, f, default=str, indent=2)
    print("Saved route_sample.json")

