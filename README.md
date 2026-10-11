# CoolRoute Delhi

**Explore a walking route with shade in mind.**

CoolRoute Delhi is a hackathon prototype that lets a user select two points in a small demo area of central Delhi and returns one walking route with an estimated shade score, distance, and walking time.

**Live demo:** <https://d213cehqsofz1g.cloudfront.net/index.html>

> Shade is an estimate derived from mapped data—not a measurement of shade or temperature, and not a guarantee of real-world conditions.

## Try the demo

1. Open the [live demo](https://d213cehqsofz1g.cloudfront.net/index.html).
2. Click the map to choose a start point.
3. Click again to choose a destination.
4. Select **Find coolest route**.
5. Review the Cooler route, estimated shade score, distance, walking time, and shade-data label.

The demo is limited to a bounded area of central Delhi. The interface displays a single Cooler route; it does not present a user-facing fastest-versus-cooler comparison.

## How it works

1. The browser sends the selected coordinates to an AWS Lambda Function URL.
2. Lambda validates the points and requests walking-route data from Amazon Location Service.
3. The backend scores route geometry against a precomputed shade grid and returns a Cooler route.
4. The browser draws the route on an Amazon Location map.

The checked-in grid has approximately 50 m cells. The checked-in implementation assigns proxy values using mapped OpenStreetMap tree points and green areas. The backend samples route geometry at roughly 10 m intervals and averages available grid values to produce the route score.

The checked-in grid metadata is **“Built 2026-10-11 11:33 IST from OSM data as of 2026-10-10.”** This is the grid build timestamp and source-data date—not a forecast for shade at a future hour. The live service may use a rebuilt grid; use the date displayed by the app for a current demo.

## AWS services

- **Amazon Location Service** — map tiles and walking-route data.
- **AWS Lambda** — request validation, route scoring, and API response.
- **Lambda Function URL** — HTTPS endpoint called by the browser.
- **Amazon DynamoDB** — daily route-call quota.
- **Amazon S3** — precomputed shade grid and static-site assets.
- **Amazon CloudFront** — HTTPS delivery of the static frontend.

## Limitations

- This is a prototype for a small area of central Delhi, not a city-wide navigation service.
- The shade score is a proxy based on mapped data; it does not measure street-level shade or temperature.
- The checked-in grid-generation code uses mapped trees and green areas. It does not model building shadows or sun position.
- OpenStreetMap coverage can be incomplete or uneven.
- The route score does not assess pedestrian safety, footpaths, crossings, lighting, or accessibility.
- Tested origin/destination pairs have sometimes returned the same path for the Cooler route as for the direct route. The app shows the backend result and does not guarantee a distinct or demonstrably shadier detour.

## Run the frontend locally

The repository intentionally does not include `frontend/config.js`; this file is ignored by Git. Create it locally with the public Amazon Location map style URL and Lambda Function URL for your deployment. Do not place AWS credentials or private secrets in browser code. The map key is a public client key and should be least-privilege, referrer-restricted, and expiring.

Serve the frontend from an origin allowed by the Lambda Function URL's CORS configuration. The current local setup uses `http://localhost:8080`:

```bash
python3 -m http.server 8080 --directory frontend
```

Then open <http://localhost:8080/>.

The page loads MapLibre GL JS and CSS from unpkg. Amazon Location is the primary map; the app can fall back to a CARTO basemap if the primary map tiles cannot be displayed.

## Repository layout

- `frontend/` — static HTML, CSS, and JavaScript application.
- `backend/` — Lambda handler, route scoring, and quota logic.
- `data/` — shade-grid generation code and checked-in source/grid data.
- `local-only/` — local notes and drafts; not part of the public project deliverables.
- `shared/` — shared handoff artifacts, if present.

## Data and attribution

Shade inputs are derived from OpenStreetMap data distributed through Geofabrik. OpenStreetMap data is available under the Open Database License (ODbL); see [OpenStreetMap copyright and attribution](https://www.openstreetmap.org/copyright).

Map and walking-route data are provided through Amazon Location Service. Follow the applicable provider attribution displayed in the app.

## Team and contributions

Shivashish created this repository to consolidate and publish the project after receiving the frontend files from Arnab. The Git history therefore records the final repository assembly, not the full development history or each person's contributions.

- **Arnab Acharya** — frontend implementation and integration.
- **Shivashish Das** — backend, routing, and shade-scoring implementation.
