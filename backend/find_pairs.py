import json
import os
import random
import sys

os.environ.setdefault("QUOTA_TABLE", "unused")
os.environ.setdefault("ROUTE_CALCULATOR", "coolroute-calc")
os.environ.setdefault("GRID_BUCKET", "unused")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import app
import shade

GRID_FILE = "data/shade_grid.json"
N_PAIRS = int(sys.argv[1]) if len(sys.argv) > 1 else 10

grid = json.load(open(GRID_FILE))
app._grid = grid  # skip S3, use the local copy
(w, s), (e, n) = grid["bounds"]

nonzero = sum(1 for v in grid["values"] if v)
print(f"grid cells: {len(grid['values'])}, non-zero: {nonzero}")

random.seed(7)

def rand_pt():
    return [round(random.uniform(w + 0.002, e - 0.002), 6),
            round(random.uniform(s + 0.002, n - 0.002), 6)]

def pair_ok():
    # Keep pairs 1.5 to 3.5 km apart, so the 30% time rule is meaningful
    while True:
        o, d = rand_pt(), rand_pt()
        dist = shade.distance_m(o, d)
        if 1500 <= dist <= 3500:
            return o, d

wins = 0
for _ in range(N_PAIRS):
    o, d = pair_ok()
    direct = app.calc(o, d)
    dshade, _ = shade.score_line(grid, direct["coordinates"])
    print(f"\n{o} -> {d}  direct {direct['distance_m']:.0f} m, "
          f"{direct['duration_s']:.0f} s, shade {dshade:.3f}")

    cands = shade.candidate_waypoints(grid, direct["coordinates"], 3)
    if not cands:
        print("  no candidates generated")
        continue

    for wp in cands:
        try:
            alt = app.calc(o, d, [wp])
        except Exception as ex:
            print(f"  wp {wp}: routing error {ex}")
            continue
        bt = shade.has_backtrack(alt["coordinates"])
        ratio = alt["duration_s"] / direct["duration_s"]
        ashade, _ = shade.score_line(grid, alt["coordinates"])
        verdict = "PASS" if (not bt and ratio <= 1.3 and ashade > dshade) else "reject"
        if verdict == "PASS":
            wins += 1
        print(f"  wp {wp}: backtrack={bt} time_ratio={ratio:.2f} "
              f"shade={ashade:.3f} -> {verdict}")

print(f"\n{wins} candidate(s) passed across {N_PAIRS} pairs")

