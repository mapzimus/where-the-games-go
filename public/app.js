const fmt = new Intl.NumberFormat("en-US");
if (new URLSearchParams(window.location.search).has("preview")) document.documentElement.classList.add("preview-mode");
const DEFAULT_VIEW = { center: [-97, 38], zoom: 1.55, pitch: 0, bearing: 0 };
const emptyCollection = () => ({ type: "FeatureCollection", features: [] });

const map = new maplibregl.Map({
  container: "map",
  center: DEFAULT_VIEW.center,
  zoom: DEFAULT_VIEW.zoom,
  minZoom: 0.5,
  maxZoom: 16,
  style: "https://tiles.openfreemap.org/styles/dark"
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

let dataset;
let timelineTimer = null;
let timelineMonths = [];
let timelineIndex = -1;
let timelineCumulative = false;
let regionViewMode = "highlight";
let visibleGroups = new Map();
let visibleHubGroups = new Map();
let visibleInternational = [];
let internationalFocusIndex = -1;
let activePopup = null;
const routeGeometryCache = new Map();
const INTERNATIONAL_HUB_KEYS = new Set(["glendale heights|il|united states"]);

const el = id => document.getElementById(id);
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const stateNames = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia", PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands", AS: "American Samoa", MP: "Northern Mariana Islands"
};

function topGroup(items, keyFor) {
  const groups = new Map();
  items.forEach(item => {
    const { key, label } = keyFor(item);
    const current = groups.get(key) || { label, count: 0 };
    current.count += 1;
    groups.set(key, current);
  });
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0];
}

function formatMonth(month) {
  if (!month) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
}

function titleCase(value) {
  return value.toLocaleLowerCase().replace(/\b\w/g, character => character.toUpperCase());
}

function cityKey(pkg) {
  return locationKey(pkg);
}

function regionKey(pkg) {
  return `${pkg.country}|${pkg.region}`;
}

function locationKey(location) {
  return `${location.city.toLocaleLowerCase()}|${location.region.toLocaleLowerCase()}|${location.country.toLocaleLowerCase()}`;
}

function isHubOnly(pkg) {
  return !pkg.via && INTERNATIONAL_HUB_KEYS.has(cityKey(pkg));
}

function isInternationalDestination(pkg) {
  return Boolean(pkg.via) || !["United States", "Puerto Rico"].includes(pkg.country);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function packageLabel(count) {
  return `${fmt.format(count)} package${count === 1 ? "" : "s"}`;
}

function renderRecords(packages) {
  const biggestMonth = topGroup(packages, pkg => ({ key: pkg.month, label: pkg.month }));
  const biggestYear = topGroup(packages, pkg => ({ key: pkg.month.slice(0, 4), label: pkg.month.slice(0, 4) }));
  const topState = topGroup(packages.filter(pkg => pkg.country === "United States"), pkg => ({ key: pkg.region.toUpperCase(), label: stateNames[pkg.region.toUpperCase()] || pkg.region }));
  const topCity = topGroup(packages, pkg => ({ key: cityKey(pkg), label: `${titleCase(pkg.city)}, ${pkg.region}` }));
  const averageMiles = packages.length ? Math.round(packages.reduce((total, pkg) => total + pkg.distanceMiles, 0) / packages.length) : null;
  const medianMiles = median(packages.map(pkg => pkg.distanceMiles));
  const cityCounts = new Map();
  packages.forEach(pkg => cityCounts.set(cityKey(pkg), (cityCounts.get(cityKey(pkg)) || 0) + 1));
  const repeatDestinations = [...cityCounts.values()].filter(count => count > 1).length;
  const longHaulTrips = packages.filter(pkg => pkg.distanceMiles >= 2000).length;

  el("record-month").textContent = biggestMonth ? formatMonth(biggestMonth.label) : "—";
  el("record-month-detail").textContent = biggestMonth ? packageLabel(biggestMonth.count) : "No matching packages";
  el("record-year").textContent = biggestYear?.label || "—";
  el("record-year-detail").textContent = biggestYear ? packageLabel(biggestYear.count) : "No matching packages";
  el("record-state").textContent = topState?.label || "—";
  el("record-state-detail").textContent = topState ? packageLabel(topState.count) : "No matching U.S. packages";
  el("record-city").textContent = topCity?.label || "—";
  el("record-city-detail").textContent = topCity ? packageLabel(topCity.count) : "No matching packages";
  el("record-average").textContent = averageMiles === null ? "—" : `${fmt.format(averageMiles)} mi`;
  el("record-median").textContent = medianMiles === null ? "—" : `${fmt.format(medianMiles)} mi`;
  el("record-repeat").textContent = fmt.format(repeatDestinations);
  el("record-longhaul").textContent = fmt.format(longHaulTrips);

  const financial = dataset.financialHighlights || {};
  el("record-spend-state").textContent = financial.topSpendingState?.label || "—";
  el("record-spend-state-detail").textContent = financial.topSpendingState
    ? `${financial.topSpendingState.sharePct}% of U.S. gross sales`
    : "aggregate rank unavailable";
  el("record-profit-month").textContent = financial.bestEstimatedMarginMonth
    ? formatMonth(financial.bestEstimatedMarginMonth)
    : "—";
  el("record-intl-market").textContent = financial.topInternationalMarket || "—";
}

function toVector([lng, lat]) {
  const phi = lat * Math.PI / 180;
  const lambda = lng * Math.PI / 180;
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

function toLngLat([x, y, z]) {
  return [Math.atan2(y, x) * 180 / Math.PI, Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI];
}

function splitAntimeridian(coordinates) {
  const segments = [[coordinates[0]]];
  for (let i = 1; i < coordinates.length; i += 1) {
    const previous = coordinates[i - 1];
    const current = coordinates[i];
    const delta = current[0] - previous[0];
    if (Math.abs(delta) <= 180) {
      segments[segments.length - 1].push(current);
      continue;
    }
    const adjustedLng = current[0] + (delta > 0 ? -360 : 360);
    const boundary = previous[0] > 0 ? 180 : -180;
    const fraction = (boundary - previous[0]) / (adjustedLng - previous[0]);
    const crossingLat = previous[1] + (current[1] - previous[1]) * fraction;
    segments[segments.length - 1].push([boundary, crossingLat]);
    segments.push([[boundary * -1, crossingLat], current]);
  }
  return segments;
}

function greatCircleGeometry(origin, destination, stepDegrees = 3) {
  const a = toVector(origin);
  const b = toVector(destination);
  const omega = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  const steps = Math.max(2, Math.ceil((omega * 180 / Math.PI) / stepDegrees));
  const sinOmega = Math.sin(omega);
  const coordinates = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    if (sinOmega < 1e-8) {
      coordinates.push([origin[0] + (destination[0] - origin[0]) * t, origin[1] + (destination[1] - origin[1]) * t]);
    } else {
      const weightA = Math.sin((1 - t) * omega) / sinOmega;
      const weightB = Math.sin(t * omega) / sinOmega;
      coordinates.push(toLngLat([a[0] * weightA + b[0] * weightB, a[1] * weightA + b[1] * weightB, a[2] * weightA + b[2] * weightB]));
    }
  }
  const segments = splitAntimeridian(coordinates);
  return segments.length === 1
    ? { type: "LineString", coordinates: segments[0] }
    : { type: "MultiLineString", coordinates: segments };
}

function popup(pkg) {
  const titles = pkg.titles.slice(0, 4).map(title => `<div class="popup-title">${escapeHtml(title)}</div>`).join("");
  const more = pkg.titles.length > 4 ? `<div class="popup-meta">+${pkg.titles.length - 4} more</div>` : "";
  const via = pkg.via ? `<div class="popup-meta popup-via">via ${escapeHtml(titleCase(pkg.via.city))}, ${escapeHtml(pkg.via.region)} · eBay international handoff</div>` : "";
  return `<div class="popup-place">${escapeHtml(titleCase(pkg.city))}, ${escapeHtml(pkg.region)}</div>${via}${titles}${more}<div class="popup-meta">${fmt.format(pkg.distanceMiles)} approximate miles · ${escapeHtml(pkg.month)}</div>`;
}

function groupedPopup(items) {
  const first = items[0];
  return items.length === 1
    ? popup(first)
    : `<div class="popup-place">${escapeHtml(titleCase(first.city))}, ${escapeHtml(first.region)}</div><div class="popup-title">${fmt.format(items.length)} packages to this city</div><div class="popup-meta">Use the filters to narrow this destination.</div>`;
}

function hubPopup(group) {
  const first = group.location;
  const total = group.known.length + group.unknown.length;
  const recovered = group.known.length
    ? `<div class="popup-title">${packageLabel(group.known.length)} continued to a recovered international destination.</div>`
    : "";
  const unavailable = group.unknown.length
    ? `<div class="popup-meta">${packageLabel(group.unknown.length)} ended at this hub in the stored export, so their onward destinations are not shown.</div>`
    : "";
  return `<div class="popup-place hub-place">eBay international shipping hub</div><div class="popup-title">${escapeHtml(titleCase(first.city))}, ${escapeHtml(first.region)}</div><div class="popup-meta">${packageLabel(total)} reached this handoff point.</div>${recovered}${unavailable}`;
}

function setMapData(sourceId, features) {
  map.getSource(sourceId).setData({ type: "FeatureCollection", features });
}

function appendGeometry(target, geometry) {
  if (geometry.type === "LineString") target.push(geometry.coordinates);
  else target.push(...geometry.coordinates);
}

function render(packages, highlightedRegion = null) {
  const grouped = new Map();
  const hubGroups = new Map();
  packages.forEach(pkg => {
    const hub = pkg.via || (isHubOnly(pkg) ? pkg : null);
    if (hub) {
      const hubKey = locationKey(hub);
      if (!hubGroups.has(hubKey)) hubGroups.set(hubKey, { location: hub, known: [], unknown: [] });
      hubGroups.get(hubKey)[pkg.via ? "known" : "unknown"].push(pkg);
    }
    if (isHubOnly(pkg)) return;
    const key = cityKey(pkg);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(pkg);
  });
  visibleGroups = grouped;
  visibleHubGroups = hubGroups;
  visibleInternational = packages.filter(isInternationalDestination);

  const origin = [dataset.origin.lng, dataset.origin.lat];
  const routeLines = [];
  const onwardRouteLines = [];
  const highlightedRouteLines = [];
  const highlightedOnwardRouteLines = [];
  const destinationFeatures = [];
  const hubFeatures = [];
  grouped.forEach((items, key) => {
    const first = items[0];
    const selected = Boolean(highlightedRegion && regionKey(first) === highlightedRegion);
    const routeEnd = first.via ? [first.via.lng, first.via.lat] : [first.lng, first.lat];
    const routeKey = `origin|${routeEnd.join("|")}`;
    if (!routeGeometryCache.has(routeKey)) routeGeometryCache.set(routeKey, greatCircleGeometry(origin, routeEnd));
    const geometry = routeGeometryCache.get(routeKey);
    appendGeometry(routeLines, geometry);
    if (selected) appendGeometry(highlightedRouteLines, geometry);
    if (first.via) {
      const onwardKey = `onward|${first.via.lng}|${first.via.lat}|${first.lng}|${first.lat}`;
      if (!routeGeometryCache.has(onwardKey)) routeGeometryCache.set(onwardKey, greatCircleGeometry([first.via.lng, first.via.lat], [first.lng, first.lat]));
      const onwardGeometry = routeGeometryCache.get(onwardKey);
      appendGeometry(onwardRouteLines, onwardGeometry);
      if (selected) appendGeometry(highlightedOnwardRouteLines, onwardGeometry);
    }
    destinationFeatures.push({ type: "Feature", properties: { key, count: items.length, selected }, geometry: { type: "Point", coordinates: [first.lng, first.lat] } });
  });
  hubGroups.forEach((group, key) => {
    const hub = group.location;
    const selected = Boolean(highlightedRegion && [...group.known, ...group.unknown].some(pkg => regionKey(pkg) === highlightedRegion));
    const routeKey = `origin|${hub.lng}|${hub.lat}`;
    if (!routeGeometryCache.has(routeKey)) routeGeometryCache.set(routeKey, greatCircleGeometry(origin, [hub.lng, hub.lat]));
    const geometry = routeGeometryCache.get(routeKey);
    if (!grouped.size || !group.known.length) {
      appendGeometry(routeLines, geometry);
    }
    if (selected) appendGeometry(highlightedRouteLines, geometry);
    hubFeatures.push({
      type: "Feature",
      properties: { key, count: group.known.length + group.unknown.length, selected },
      geometry: { type: "Point", coordinates: [hub.lng, hub.lat] }
    });
  });

  setMapData("destinations", destinationFeatures);
  setMapData("international-hubs", hubFeatures);
  setMapData("origin", [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: origin } }]);
  setMapData("routes", routeLines.length ? [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: routeLines } }] : []);
  setMapData("onward-routes", onwardRouteLines.length ? [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: onwardRouteLines } }] : []);
  setMapData("highlight-routes", highlightedRouteLines.length ? [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: highlightedRouteLines } }] : []);
  setMapData("highlight-onward-routes", highlightedOnwardRouteLines.length ? [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: highlightedOnwardRouteLines } }] : []);

  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }

  const miles = packages.reduce((n, pkg) => n + pkg.distanceMiles, 0);
  const regions = new Set(packages.map(pkg => `${pkg.country}|${pkg.region}`)).size;
  const cities = new Set(packages.map(cityKey)).size;
  el("stat-packages").textContent = fmt.format(packages.length);
  el("stat-cities").textContent = fmt.format(cities);
  el("stat-miles").textContent = fmt.format(Math.round(miles));
  el("stat-regions").textContent = fmt.format(regions);
  el("empty-state").hidden = packages.length > 0;
  const internationalKnown = packages.filter(isInternationalDestination).length;
  const internationalUnknown = packages.filter(isHubOnly).length;
  const internationalStatus = el("international-status");
  internationalStatus.hidden = internationalKnown + internationalUnknown === 0;
  internationalStatus.disabled = internationalKnown === 0;
  internationalStatus.textContent = internationalKnown ? `Tour ${packageLabel(internationalKnown)}` : "No mapped destinations";
  internationalStatus.title = internationalUnknown
    ? `${packageLabel(internationalKnown)} mapped internationally; ${packageLabel(internationalUnknown)} hub-only`
    : `Tour ${packageLabel(internationalKnown)} mapped internationally`;
  renderRecords(packages);

  const farthest = [...packages].sort((a, b) => b.distanceMiles - a.distanceMiles)[0];
  el("farthest-distance").textContent = farthest ? `${fmt.format(farthest.distanceMiles)} mi` : "— mi";
  el("farthest-place").textContent = farthest ? `${titleCase(farthest.city)}, ${farthest.region}` : "Waiting for the first trip";
  el("farthest-title").textContent = farthest ? farthest.titles.join(" · ") : "The farthest-travelled game will appear here.";
}

function setupMapLayers() {
  map.addSource("routes", { type: "geojson", data: emptyCollection() });
  map.addSource("onward-routes", { type: "geojson", data: emptyCollection() });
  map.addSource("highlight-routes", { type: "geojson", data: emptyCollection() });
  map.addSource("highlight-onward-routes", { type: "geojson", data: emptyCollection() });
  map.addSource("destinations", { type: "geojson", data: emptyCollection() });
  map.addSource("international-hubs", { type: "geojson", data: emptyCollection() });
  map.addSource("origin", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "route-casing",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#02070d", "line-width": 4, "line-opacity": 0.9 }
  });
  map.addLayer({
    id: "routes",
    type: "line",
    source: "routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#7db7ff", "line-width": 1.75, "line-opacity": 0.78 }
  });
  map.addLayer({
    id: "highlight-routes",
    type: "line",
    source: "highlight-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#d6ff54", "line-width": 3.2, "line-opacity": 1 }
  });
  map.addLayer({
    id: "onward-route-casing",
    type: "line",
    source: "onward-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#02070d", "line-width": 5, "line-opacity": 0.95 }
  });
  map.addLayer({
    id: "onward-routes",
    type: "line",
    source: "onward-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffd166", "line-width": 2.5, "line-opacity": 0.96, "line-dasharray": [2, 1.35] }
  });
  map.addLayer({
    id: "highlight-onward-routes",
    type: "line",
    source: "highlight-onward-routes",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#d6ff54", "line-width": 3.2, "line-opacity": 1, "line-dasharray": [2, 1.35] }
  });
  map.addLayer({
    id: "destinations",
    type: "circle",
    source: "destinations",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 4, 4, 7, 10, 11],
      "circle-color": ["case", ["boolean", ["get", "selected"], false], "#d6ff54", "#ff735c"],
      "circle-stroke-color": ["case", ["boolean", ["get", "selected"], false], "#d6ff54", "#111315"],
      "circle-stroke-width": ["case", ["boolean", ["get", "selected"], false], 2.5, 1.5],
      "circle-opacity": ["case", ["boolean", ["get", "selected"], false], 1, 0.82]
    }
  });
  map.addLayer({
    id: "international-hubs",
    type: "circle",
    source: "international-hubs",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "count"], 1, 6, 10, 10],
      "circle-color": ["case", ["boolean", ["get", "selected"], false], "#d6ff54", "#ffd166"],
      "circle-stroke-color": ["case", ["boolean", ["get", "selected"], false], "#d6ff54", "#111315"],
      "circle-stroke-width": ["case", ["boolean", ["get", "selected"], false], 2.5, 2],
      "circle-opacity": 0.96
    }
  });
  map.addLayer({
    id: "origin",
    type: "circle",
    source: "origin",
    paint: { "circle-radius": 9, "circle-color": "#d6ff54", "circle-stroke-color": "#d6ff54", "circle-stroke-width": 2, "circle-blur": 0.08 }
  });

  map.on("click", "destinations", event => {
    event.preventDefault();
    const key = event.features?.[0]?.properties?.key;
    const items = visibleGroups.get(key) || [];
    if (!items.length) return;
    if (activePopup) activePopup.remove();
    activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px" })
      .setLngLat(event.features[0].geometry.coordinates)
      .setHTML(groupedPopup(items))
      .addTo(map);
  });
  map.on("click", "origin", event => {
    event.preventDefault();
    if (activePopup) activePopup.remove();
    activePopup = new maplibregl.Popup({ closeButton: true })
      .setLngLat(event.features[0].geometry.coordinates)
      .setHTML(`<div class="popup-place">Journey origin</div><div class="popup-title">${escapeHtml(dataset?.origin?.name || "Salem, Massachusetts")}</div>`)
      .addTo(map);
  });
  map.on("click", "international-hubs", event => {
    event.preventDefault();
    const key = event.features?.[0]?.properties?.key;
    const group = visibleHubGroups.get(key);
    if (!group) return;
    if (activePopup) activePopup.remove();
    activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: "330px" })
      .setLngLat(event.features[0].geometry.coordinates)
      .setHTML(hubPopup(group))
      .addTo(map);
  });
  ["destinations", "international-hubs", "origin"].forEach(layerId => {
    map.on("mouseenter", layerId, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; });
  });
}

const styleReady = new Promise(resolve => {
  map.once("style.load", () => {
    map.setProjection({ type: "globe" });
    if (typeof map.setSky === "function") {
      map.setSky({
        "sky-color": "#02070d",
        "horizon-color": "#102235",
        "fog-color": "#07111c",
        "sky-horizon-blend": 0.12,
        "horizon-fog-blend": 0.18,
        "fog-ground-blend": 0.28
      });
    }
    setupMapLayers();
    resolve();
  });
});

function applyFilters() {
  const month = el("filter-month").value;
  const region = el("filter-region").value;
  const query = el("filter-title").value.trim().toLowerCase();
  const basePackages = dataset.packages.filter(pkg =>
    (month === "all" || (timelineCumulative ? pkg.month <= month : pkg.month === month)) &&
    (!query || pkg.titles.some(title => title.toLowerCase().includes(query)))
  );
  const regionPackages = region === "all" ? basePackages : basePackages.filter(pkg => regionKey(pkg) === region);
  const visiblePackages = region !== "all" && regionViewMode === "isolate" ? regionPackages : basePackages;
  render(visiblePackages, region === "all" ? null : region);

  const selectedOption = el("filter-region").selectedOptions[0];
  const regionLabel = selectedOption?.textContent || "Everywhere";
  el("region-status").textContent = region === "all"
    ? `Everywhere · ${packageLabel(basePackages.length)}`
    : `${regionLabel} · ${packageLabel(regionPackages.length)}`;
  const regionActive = region !== "all";
  el("region-highlight").disabled = !regionActive;
  el("region-isolate").disabled = !regionActive;
  const selectedMonth = el("filter-month").value;
  el("timeline-status").textContent = selectedMonth === "all" ? "All time" : `${timelineCumulative ? "Through " : ""}${formatMonth(selectedMonth)}`;
}

function setRegionViewMode(mode) {
  regionViewMode = mode;
  el("region-highlight").setAttribute("aria-pressed", String(mode === "highlight"));
  el("region-isolate").setAttribute("aria-pressed", String(mode === "isolate"));
  applyFilters();
}

function populateFilters(packages) {
  timelineMonths = [...new Set(packages.map(pkg => pkg.month))].sort();
  [...timelineMonths].reverse().forEach(month => el("filter-month").add(new Option(month, month)));
  const regions = [...new Map(packages.map(pkg => [
    `${pkg.country}|${pkg.region}`,
    pkg.region === pkg.country ? pkg.country : `${pkg.region}, ${pkg.country}`
  ])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  regions.forEach(([value, label]) => el("filter-region").add(new Option(label, value)));
}

function stopTimeline(buttonLabel = "Play timeline") {
  if (timelineTimer) window.clearInterval(timelineTimer);
  timelineTimer = null;
  el("play-timeline").textContent = buttonLabel;
  el("play-timeline").setAttribute("aria-pressed", "false");
}

function showTimelineMonth(index) {
  timelineIndex = index;
  el("filter-month").value = timelineMonths[index];
  applyFilters();
}

function advanceTimeline() {
  if (timelineIndex >= timelineMonths.length - 1) {
    stopTimeline("Replay timeline");
    return;
  }
  showTimelineMonth(timelineIndex + 1);
}

function toggleTimeline() {
  if (timelineTimer) {
    stopTimeline("Resume timeline");
    return;
  }
  if (!timelineMonths.length) return;
  timelineCumulative = true;
  const selectedIndex = timelineMonths.indexOf(el("filter-month").value);
  showTimelineMonth(selectedIndex >= 0 && selectedIndex < timelineMonths.length - 1 ? selectedIndex : 0);
  el("play-timeline").textContent = "Pause timeline";
  el("play-timeline").setAttribute("aria-pressed", "true");
  const interval = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1300 : 850;
  timelineTimer = window.setInterval(advanceTimeline, interval);
}

function resetGlobe() {
  map.easeTo({ ...DEFAULT_VIEW, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 800 });
}

function focusInternational() {
  if (!visibleInternational.length) return;
  internationalFocusIndex = (internationalFocusIndex + 1) % visibleInternational.length;
  const pkg = visibleInternational[internationalFocusIndex];
  if (activePopup) activePopup.remove();
  map.flyTo({
    center: [pkg.lng, pkg.lat],
    zoom: 2.35,
    duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1200
  });
  map.once("moveend", () => {
    activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: "320px" })
      .setLngLat([pkg.lng, pkg.lat])
      .setHTML(popup(pkg))
      .addTo(map);
  });
}

fetch("data/shipments.json", { cache: "no-store" })
  .then(response => { if (!response.ok) throw new Error(`Data request failed: ${response.status}`); return response.json(); })
  .then(async data => {
    dataset = data;
    populateFilters(data.packages);
    await styleReady;
    applyFilters();
    if (data.generatedAt) el("updated-at").textContent = `Updated ${new Date(data.generatedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
    el("filter-month").addEventListener("change", () => { stopTimeline(); timelineCumulative = false; applyFilters(); });
    el("filter-region").addEventListener("change", applyFilters);
    el("region-highlight").addEventListener("click", () => setRegionViewMode("highlight"));
    el("region-isolate").addEventListener("click", () => setRegionViewMode("isolate"));
    el("filter-title").addEventListener("input", applyFilters);
    el("play-timeline").addEventListener("click", toggleTimeline);
    el("reset-globe").addEventListener("click", resetGlobe);
    el("international-status").addEventListener("click", focusInternational);
    el("reset-filters").addEventListener("click", () => {
      stopTimeline();
      timelineCumulative = false;
      el("filter-month").value = "all";
      el("filter-region").value = "all";
      el("filter-title").value = "";
      regionViewMode = "highlight";
      el("region-highlight").setAttribute("aria-pressed", "true");
      el("region-isolate").setAttribute("aria-pressed", "false");
      applyFilters();
    });
  })
  .catch(error => {
    console.error(error);
    el("empty-state").hidden = false;
    el("empty-state").textContent = "The journey data could not be loaded.";
  });
