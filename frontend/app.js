"use strict";

// CoolRoute Delhi frontend logic.
// Contract: brief section 4. Coordinates are always [longitude, latitude].
// All API-derived text is rendered with textContent; never innerHTML.

const ROUTE_COLOR = "#0d8f70";

const EMPTY_FC = { type: "FeatureCollection", features: [] };

const state = {
  origin: null,
  destination: null,
  phase: "origin", // origin -> destination -> ready
  busy: false,
  requestToken: 0
};

let map;
let mapLoaded = false;
let originMarker = null;
let destMarker = null;
let tileErrorCount = 0;
let paintedOnce = false;
let renderWarned = false;
let cartoFallback = false;
let lastRoute = null;

const el = {
  stepHint: document.getElementById("step-hint"),
  compareBtn: document.getElementById("compare-btn"),
  resetBtn: document.getElementById("reset-btn"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  method: document.getElementById("method"),
  methodText: document.getElementById("method-text"),
  shadeDate: document.getElementById("shade-date"),
  mapFallback: document.getElementById("map-fallback")
};

const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

// ---- helpers ---------------------------------------------------------------

function setStatus(message, kind) {
  el.status.textContent = message || "";
  el.status.className = "status" + (kind ? " " + kind : "");
}

function setHint(message) {
  el.stepHint.textContent = message;
}

function showMapFallback(message) {
  el.mapFallback.textContent = message;
  el.mapFallback.hidden = false;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidCoord(coord) {
  return (
    Array.isArray(coord) &&
    coord.length === 2 &&
    isFiniteNumber(coord[0]) &&
    isFiniteNumber(coord[1])
  );
}

function inBounds(coord) {
  if (!isValidCoord(coord)) return false;
  const [[west, south], [east, north]] = CONFIG.DEMO_BOUNDS;
  const [lon, lat] = coord;
  return lon >= west && lon <= east && lat >= south && lat <= north;
}

function formatDistance(metres) {
  if (metres < 1000) return Math.round(metres) + " m";
  const km = metres / 1000;
  return (km < 10 ? km.toFixed(1) : Math.round(km)) + " km";
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  return hours + " h " + (minutes % 60) + " min";
}

function formatPercent(fraction) {
  return Math.round(fraction * 100) + "%";
}

// 4xx errors carry a user-facing message in `{ "error": "<string>" }`. Surface it
// only when it is a short string; 5xx (and anything unexpected) fall back to a
// generic message so we never expose internal detail.
function backendErrorMessage(status, data) {
  const fallback = "The route service returned an error. Please try again.";
  if (
    status >= 400 &&
    status < 500 &&
    data &&
    typeof data.error === "string"
  ) {
    const text = data.error.trim();
    if (text && text.length <= 200) return text;
  }
  return fallback;
}

// ---- map -------------------------------------------------------------------

function resolveStyleUrl() {
  const configured = CONFIG.MAP_STYLE_URL;
  const isPlaceholder =
    !configured || configured.indexOf("REPLACE_WITH") === 0;
  const fallback = typeof DEV_STYLE_URL !== "undefined" ? DEV_STYLE_URL : configured;

  // Manual override for a viewer whose browser/network cannot reach Amazon
  // Location tiles: localStorage item "coolroute.basemap"="carto", or a one-shot
  // ?basemap=carto query param. Default (no override) stays Amazon Location.
  let forced = null;
  if (typeof localStorage !== "undefined") {
    forced = localStorage.getItem("coolroute.basemap");
  }
  if (!forced && typeof location !== "undefined" && /\bbasemap=carto\b/.test(location.search)) {
    forced = "carto";
  }

  if (forced === "carto" || isPlaceholder) {
    if (isPlaceholder) {
      console.warn(
        "CoolRoute: MAP_STYLE_URL is still the placeholder; using a dev demo style."
      );
    } else {
      console.warn(
        "CoolRoute: basemap override is set (%s); using the keyless fallback basemap.",
        forced
      );
    }
    return fallback;
  }
  return configured;
}

function initMap() {
  if (typeof maplibregl === "undefined") {
    showMapFallback("The map library failed to load, so the map is unavailable.");
    return;
  }

  try {
    map = new maplibregl.Map({
      container: "map",
      style: resolveStyleUrl(),
      center: CONFIG.DEMO_CENTER,
      zoom: CONFIG.DEFAULT_ZOOM,
      minZoom: CONFIG.MIN_ZOOM,
      maxZoom: CONFIG.MAX_ZOOM,
      maxBounds: CONFIG.DEMO_BOUNDS,
      attributionControl: true
    });
  } catch (err) {
    console.error("CoolRoute: map init failed", err);
    showMapFallback(
      "The map could not start. WebGL is unavailable or blocked in this browser " +
        "(enable hardware acceleration or try Chrome/Edge/Firefox). Detail: " +
        (err && err.message ? err.message : String(err))
    );
    return;
  }

  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false }),
    "top-right"
  );

  map.on("click", onMapClick);
  map.on("load", onMapLoad);
  map.on("style.load", function () {
    if (mapLoaded) addRouteLayers();
  });
  map.on("error", function (event) {
    const errMsg =
      event && event.error && event.error.message
        ? event.error.message
        : String((event && event.error) || "unknown error");
    console.warn("CoolRoute: map error", event && event.error);
    if (/tile|failed to fetch|4\d\d|referer|insufficient/i.test(errMsg)) {
      tileErrorCount += 1;
    }
    if (!mapLoaded && !renderWarned && !fallbackToCarto()) {
      renderWarned = true;
      showMapFallback(
        "The map tiles could not load here, and the fallback basemap also failed. " +
          "A privacy extension may be stripping the Referer header, or WebGL is off. " +
          "Detail: " + errMsg
      );
    }
  });

  const checkPaint = function () {
    if (paintedOnce || cartoFallback) return true;
    let ok = false;
    try {
      // Detect real base-tile delivery, not just faint fill polygons in the
      // style. A source "loads" only when its tile requests actually return.
      const sources = map.getStyle().sources || {};
      for (const id of Object.keys(sources)) {
        const src = sources[id];
        if (
          !src ||
          (src.type !== "vector" &&
            src.type !== "raster" &&
            src.type !== "raster-dem")
        ) {
          continue;
        }
        if (map.isSourceLoaded(id)) {
          ok = true;
          break;
        }
      }
      if (!ok) ok = map.areTilesLoaded();
    } catch (e) {
      ok = false;
    }
    if (ok) {
      paintedOnce = true;
      return true;
    }
    if (!fallbackToCarto() && !renderWarned) {
      renderWarned = true;
      showMapFallback(
        "No base-map tiles loaded in this browser, and the fallback basemap also " +
          "failed. A privacy extension may be stripping the Referer header, or the " +
          "network is blocking map hosts."
      );
    }
    return false;
  };
  map.on("idle", checkPaint);
  setTimeout(checkPaint, 2500);
  setTimeout(checkPaint, 6000);
  setTimeout(function () {
    if (!paintedOnce && !cartoFallback && !fallbackToCarto() && !renderWarned) {
      renderWarned = true;
      showMapFallback(
        "Map tiles could not render after several attempts. Check your network or " +
          "try disabling privacy extensions for this page."
      );
    }
  }, 12000);
}

function addRouteLayers() {
  if (!map || typeof map.getSource !== "function" || map.getSource("routes")) {
    return;
  }
  map.addSource("routes", { type: "geojson", data: EMPTY_FC });

  map.addLayer({
    id: "route-casing",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#ffffff",
      "line-width": 9,
      "line-opacity": 0.95
    }
  });

  map.addLayer({
    id: "route-cooler",
    type: "line",
    source: "routes",
    filter: ["==", ["get", "name"], "cooler"],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ROUTE_COLOR,
      "line-width": 6
    }
  });

  if (lastRoute) {
    drawRoutes(lastRoute);
  }
}

// If the Amazon Location style/tiles are blocked for a viewer (referer-stripping
// privacy tools, restrictive networks, API-key issues), fall back to a keyless
// OSM basemap so the map is never blank. Amazon Location remains the primary
// style for normal visitors; this only triggers after tiles fail to paint.
function fallbackToCarto() {
  if (cartoFallback || !map || typeof DEV_STYLE_URL === "undefined") {
    return false;
  }
  cartoFallback = true;
  try {
    map.setStyle(DEV_STYLE_URL);
  } catch (err) {
    cartoFallback = false;
    console.error("CoolRoute: fallback style switch failed", err);
    return false;
  }
  console.warn(
    "CoolRoute: Amazon Location basemap did not render here; switched to a keyless fallback basemap."
  );
  setStatus(
    "Amazon basemap tiles were blocked in this browser; map switched to a fallback basemap."
  );
  return true;
}

function onMapLoad() {
  mapLoaded = true;
  el.mapFallback.hidden = true;
  addRouteLayers();
}

// ---- clicks and points -----------------------------------------------------

function onMapClick(event) {
  if (state.busy) return;

  const coord = [event.lngLat.lng, event.lngLat.lat];

  if (state.phase === "ready") {
    setStatus("Press Reset to choose a new start and destination.");
    return;
  }

  if (!inBounds(coord)) {
    setStatus("Choose points inside the Delhi demo area.", "error");
    return;
  }

  if (state.phase === "origin") {
    state.origin = coord;
    state.phase = "destination";
    placeMarker("origin", coord);
    setHint("Now click to set your destination.");
    setStatus("Start set.");
  } else {
    state.destination = coord;
    state.phase = "ready";
    placeMarker("destination", coord);
    setHint("Ready. Press the button below.");
    setStatus("Start and destination set.");
  }

  updateCompareEnabled();
}

function makeDot(kind) {
  const dot = document.createElement("div");
  dot.className = "map-dot " + kind;
  return dot;
}

function placeMarker(kind, coord) {
  if (kind === "origin") {
    if (originMarker) originMarker.remove();
    originMarker = new maplibregl.Marker({ element: makeDot("origin") })
      .setLngLat(coord)
      .addTo(map);
  } else {
    if (destMarker) destMarker.remove();
    destMarker = new maplibregl.Marker({ element: makeDot("destination") })
      .setLngLat(coord)
      .addTo(map);
  }
}

function clearMarkers() {
  if (originMarker) {
    originMarker.remove();
    originMarker = null;
  }
  if (destMarker) {
    destMarker.remove();
    destMarker = null;
  }
}

function updateCompareEnabled() {
  const hasBoth = Boolean(state.origin && state.destination);
  el.compareBtn.disabled = state.busy || !hasBoth;
}

// ---- compare and render ----------------------------------------------------

async function compareRoutes() {
  if (state.busy || !state.origin || !state.destination) return;

  state.busy = true;
  const token = ++state.requestToken;
  el.compareBtn.disabled = true;
  el.compareBtn.textContent = "Comparing...";
  setStatus("Finding routes...", "working");
  clearResults();

  const controller = new AbortController();
  const timeout = setTimeout(function () {
    controller.abort();
  }, 20000);

  try {
    const response = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: state.origin,
        destination: state.destination
      }),
      signal: controller.signal
    });

    if (token !== state.requestToken) return;

    if (response.status === 429) {
      setStatus("Daily route limit reached. Please try again tomorrow.", "error");
      return;
    }

    let data = null;
    try {
      data = await response.json();
    } catch (parseError) {
      data = null;
    }

    if (!response.ok) {
      setStatus(backendErrorMessage(response.status, data), "error");
      return;
    }

    if (data === null) {
      setStatus("The route service returned an unexpected response.", "error");
      return;
    }

    const parsed = validateResponse(data);
    if (!parsed.ok) {
      console.warn(
        "CoolRoute: response did not match the agreed contract:",
        parsed.reason,
        data
      );
      setStatus("The route service returned an unexpected response.", "error");
      return;
    }

    drawRoutes(parsed.cooler);
    renderResults(parsed.cooler, parsed.shadeDate);
    setStatus("Route ready.");
    setHint("Route found. Reset to try another pair.");
  } catch (error) {
    if (error && error.name === "AbortError") {
      setStatus("The route service took too long to respond.", "error");
    } else {
      console.warn("CoolRoute: network request failed", error);
      setStatus(
        "Could not reach the route service. Check your connection and try again.",
        "error"
      );
    }
  } finally {
    clearTimeout(timeout);
    if (token === state.requestToken) {
      state.busy = false;
      el.compareBtn.textContent = "Compare routes";
      updateCompareEnabled();
    }
  }
}

function validateResponse(data) {
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "response is not an object" };
  }
  if (!Array.isArray(data.routes)) {
    return { ok: false, reason: "routes is missing or not an array" };
  }

  // The backend may still send both a fastest and a cooler route. The UI only
  // ever uses the cooler route, so fastest is accepted and ignored.
  const coolers = data.routes.filter(function (r) {
    return r && r.name === "cooler";
  });
  if (coolers.length !== 1) {
    return { ok: false, reason: "need exactly one cooler route" };
  }
  const cooler = coolers[0];

  if (!isFiniteNumber(cooler.distance_m) || cooler.distance_m < 0) {
    return { ok: false, reason: "distance_m must be a nonnegative number" };
  }
  if (!isFiniteNumber(cooler.duration_s) || cooler.duration_s < 0) {
    return { ok: false, reason: "duration_s must be a nonnegative number" };
  }
  if (
    !isFiniteNumber(cooler.shade_fraction) ||
    cooler.shade_fraction < 0 ||
    cooler.shade_fraction > 1
  ) {
    return { ok: false, reason: "shade_fraction must be within [0, 1]" };
  }
  const geometry = cooler.geometry;
  if (
    !geometry ||
    geometry.type !== "LineString" ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length < 2
  ) {
    return { ok: false, reason: "geometry must be a nonempty LineString" };
  }
  for (const coord of geometry.coordinates) {
    if (!isValidCoord(coord)) {
      return { ok: false, reason: "LineString coordinate is not [lon, lat]" };
    }
  }

  let shadeDate = "";
  if (typeof data.shade_date === "string" && data.shade_date.length <= 200) {
    shadeDate = data.shade_date;
  }

  return { ok: true, cooler: cooler, shadeDate: shadeDate };
}

function drawRoutes(cooler) {
  lastRoute = cooler;
  const source = map.getSource("routes");
  if (!source) return;

  source.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "cooler" },
        geometry: cooler.geometry
      }
    ]
  });

  fitRoutes([cooler.geometry]);
}

function fitRoutes(geometries) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  geometries.forEach(function (geometry) {
    geometry.coordinates.forEach(function (coord) {
      minLon = Math.min(minLon, coord[0]);
      maxLon = Math.max(maxLon, coord[0]);
      minLat = Math.min(minLat, coord[1]);
      maxLat = Math.max(maxLat, coord[1]);
    });
  });

  if (!isFiniteNumber(minLon) || !isFiniteNumber(minLat)) return;

  const epsilon = 0.0005;
  const bounds = [
    [minLon - epsilon, minLat - epsilon],
    [maxLon + epsilon, maxLat + epsilon]
  ];

  map.fitBounds(bounds, {
    padding: 60,
    maxZoom: 17,
    duration: reduceMotion ? 0 : 600
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";

function routeGlyphDot(cx) {
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "route-glyph-dot");
  dot.setAttribute("cx", String(cx));
  dot.setAttribute("cy", "5");
  dot.setAttribute("r", "2.6");
  return dot;
}

function routeGlyph() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 30 10");
  svg.setAttribute("width", "30");
  svg.setAttribute("height", "10");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "route-glyph");
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("class", "route-glyph-line");
  line.setAttribute("x1", "3");
  line.setAttribute("y1", "5");
  line.setAttribute("x2", "27");
  line.setAttribute("y2", "5");
  svg.append(line, routeGlyphDot(3), routeGlyphDot(27));
  return svg;
}

function buildCard(route) {
  const card = document.createElement("article");
  card.className = "result-card";

  const head = document.createElement("div");
  head.className = "result-head";
  const name = document.createElement("span");
  name.className = "result-name";
  name.textContent = "Cooler route";
  head.append(routeGlyph(), name);

  const big = document.createElement("p");
  big.className = "shade-big";
  big.textContent = formatPercent(route.shade_fraction) + " shaded";

  const label = document.createElement("span");
  label.className = "shade-label";
  label.textContent = "estimated shade proxy";

  const meta = document.createElement("p");
  meta.className = "cooler-meta";
  meta.textContent =
    formatDistance(route.distance_m) + " \u00b7 " + formatDuration(route.duration_s);

  card.append(head, big, label, meta);
  return card;
}

function renderResults(cooler, shadeDate) {
  el.results.replaceChildren(buildCard(cooler));
  el.results.hidden = false;
  el.method.hidden = false;
  el.shadeDate.textContent = shadeDate ? "Shade data: " + shadeDate : "";
}

function clearResults() {
  el.results.replaceChildren();
  el.results.hidden = true;
  el.method.hidden = true;
  el.shadeDate.textContent = "";
}

// ---- reset and demo journeys ----------------------------------------------

function reset() {
  state.origin = null;
  state.destination = null;
  state.phase = "origin";
  state.busy = false;
  state.requestToken++;

  clearMarkers();
  const source = map && map.getSource("routes");
  if (source) source.setData(EMPTY_FC);
  lastRoute = null;
  clearResults();
  el.compareBtn.textContent = "Compare routes";
  setHint("Click the map to set your start.");
  setStatus("");
  updateCompareEnabled();

  if (map) {
    map.easeTo({
      center: CONFIG.DEMO_CENTER,
      zoom: CONFIG.DEFAULT_ZOOM,
      duration: reduceMotion ? 0 : 400
    });
  }
}

// ---- wire up ---------------------------------------------------------------

function init() {
  if (typeof CONFIG === "undefined") {
    showMapFallback("Configuration failed to load.");
    return;
  }

  el.methodText.textContent =
    "We compare walking routes between your two points and estimate how much " +
    "of each one is likely to be in shade. The route " +
    "with more estimated shade is shown here. This is an estimate based on a " +
    "shade proxy, not a measurement, so real conditions may differ.";

  el.compareBtn.addEventListener("click", compareRoutes);
  el.resetBtn.addEventListener("click", reset);

  initMap();
}

init();

// Diagnostic helper (classic script, console-accessible). Run __cr() in DevTools
// to dump map/WebGL/UI state in one line for debugging.
function __cr() {
  return {
    maplibregl: typeof maplibregl,
    config: typeof CONFIG,
    map: !!map,
    mapLoaded: mapLoaded,
    webgl:
      !!(document.createElement("canvas").getContext("webgl2") ||
        document.createElement("canvas").getContext("webgl")),
    tileErrorCount: tileErrorCount,
    paintedOnce: paintedOnce,
    renderWarned: renderWarned,
    fallback: el.mapFallback.textContent,
    fallbackHidden: el.mapFallback.hidden,
    status: el.status.textContent,
    hint: el.stepHint.textContent,
    hasRoute: !!lastRoute,
    demoSelectExists: !!document.getElementById("demo-select"),
    origin: location.origin,
    forcedBasemap:
      typeof localStorage !== "undefined"
        ? localStorage.getItem("coolroute.basemap") || "none"
        : "n/a"
  };
}
