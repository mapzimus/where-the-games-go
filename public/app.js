const fmt = new Intl.NumberFormat("en-US");
const map = L.map("map", { zoomControl: false, minZoom: 2 }).setView([39.5, -98.35], 4);
L.control.zoom({ position: "topright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const pointLayer = L.layerGroup().addTo(map);
let dataset;
let timelineTimer = null;
let timelineMonths = [];
let timelineIndex = -1;
let timelineCumulative = false;

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
  return value.replace(/\b\w/g, character => character.toUpperCase());
}

function cityKey(pkg) {
  return `${pkg.city.toLocaleLowerCase()}|${pkg.region.toLocaleLowerCase()}|${pkg.country.toLocaleLowerCase()}`;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function renderRecords(packages) {
  const biggestMonth = topGroup(packages, pkg => ({ key: pkg.month, label: pkg.month }));
  const biggestYear = topGroup(packages, pkg => ({ key: pkg.month.slice(0, 4), label: pkg.month.slice(0, 4) }));
  const topState = topGroup(packages.filter(pkg => pkg.country === "United States"), pkg => ({ key: pkg.region.toUpperCase(), label: stateNames[pkg.region.toUpperCase()] || pkg.region }));
  const topCity = topGroup(packages, pkg => ({
    key: cityKey(pkg),
    label: `${titleCase(pkg.city)}, ${pkg.region}`
  }));
  const averageMiles = packages.length ? Math.round(packages.reduce((total, pkg) => total + pkg.distanceMiles, 0) / packages.length) : null;
  const medianMiles = median(packages.map(pkg => pkg.distanceMiles));
  const cityCounts = new Map();
  packages.forEach(pkg => cityCounts.set(cityKey(pkg), (cityCounts.get(cityKey(pkg)) || 0) + 1));
  const repeatDestinations = [...cityCounts.values()].filter(count => count > 1).length;
  const longHaulTrips = packages.filter(pkg => pkg.distanceMiles >= 2000).length;

  el("record-month").textContent = biggestMonth ? formatMonth(biggestMonth.label) : "—";
  el("record-month-detail").textContent = biggestMonth ? `${fmt.format(biggestMonth.count)} packages` : "No matching packages";
  el("record-year").textContent = biggestYear?.label || "—";
  el("record-year-detail").textContent = biggestYear ? `${fmt.format(biggestYear.count)} packages` : "No matching packages";
  el("record-state").textContent = topState?.label || "—";
  el("record-state-detail").textContent = topState ? `${fmt.format(topState.count)} packages` : "No matching U.S. packages";
  el("record-city").textContent = topCity?.label || "—";
  el("record-city-detail").textContent = topCity ? `${fmt.format(topCity.count)} packages` : "No matching packages";
  el("record-average").textContent = averageMiles === null ? "—" : `${fmt.format(averageMiles)} mi`;
  el("record-median").textContent = medianMiles === null ? "—" : `${fmt.format(medianMiles)} mi`;
  el("record-repeat").textContent = fmt.format(repeatDestinations);
  el("record-longhaul").textContent = fmt.format(longHaulTrips);
}

function curvedRoute(origin, destination) {
  const [aLat, aLng] = origin;
  const [bLat, bLng] = destination;
  const midpoint = [(aLat + bLat) / 2, (aLng + bLng) / 2];
  const bend = Math.min(9, Math.abs(bLng - aLng) * .11);
  midpoint[0] += bend;
  const points = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    points.push([
      (1-t)*(1-t)*aLat + 2*(1-t)*t*midpoint[0] + t*t*bLat,
      (1-t)*(1-t)*aLng + 2*(1-t)*t*midpoint[1] + t*t*bLng
    ]);
  }
  return points;
}

function popup(pkg) {
  const titles = pkg.titles.slice(0, 4).map(title => `<div class="popup-title">${escapeHtml(title)}</div>`).join("");
  const more = pkg.titles.length > 4 ? `<div class="popup-meta">+${pkg.titles.length - 4} more</div>` : "";
  return `<div class="popup-place">${escapeHtml(pkg.city)}, ${escapeHtml(pkg.region)}</div>${titles}${more}<div class="popup-meta">${fmt.format(pkg.distanceMiles)} approximate miles · ${escapeHtml(pkg.month)}</div>`;
}

function render(packages) {
  routeLayer.clearLayers();
  pointLayer.clearLayers();
  const origin = [dataset.origin.lat, dataset.origin.lng];
  const grouped = new Map();

  packages.forEach(pkg => {
    const key = `${pkg.lat}|${pkg.lng}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(pkg);
    L.polyline(curvedRoute(origin, [pkg.lat, pkg.lng]), {
      color: "#71a7ff", weight: 1, opacity: .12, interactive: false
    }).addTo(routeLayer);
  });

  grouped.forEach(items => {
    const first = items[0];
    const radius = Math.min(15, 4.5 + Math.sqrt(items.length) * 1.4);
    const marker = L.circleMarker([first.lat, first.lng], {
      radius, color: "#111315", weight: 1.5, fillColor: "#ff735c", fillOpacity: .86
    });
    marker.bindPopup(items.length === 1 ? popup(first) : `<div class="popup-place">${escapeHtml(first.city)}, ${escapeHtml(first.region)}</div><div class="popup-title">${items.length} packages to this city</div><div class="popup-meta">Select filters to narrow this destination.</div>`);
    marker.addTo(pointLayer);
  });

  L.circleMarker(origin, { radius: 9, color: "#d6ff54", weight: 2, fillColor: "#d6ff54", fillOpacity: 1 })
    .bindPopup(`<div class="popup-place">Journey origin</div><div class="popup-title">${escapeHtml(dataset.origin.name)}</div>`)
    .addTo(pointLayer);

  const miles = packages.reduce((n, pkg) => n + pkg.distanceMiles, 0);
  const regions = new Set(packages.map(pkg => `${pkg.country}|${pkg.region}`)).size;
  const cities = new Set(packages.map(cityKey)).size;
  el("stat-packages").textContent = fmt.format(packages.length);
  el("stat-cities").textContent = fmt.format(cities);
  el("stat-miles").textContent = fmt.format(Math.round(miles));
  el("stat-regions").textContent = fmt.format(regions);
  el("empty-state").hidden = packages.length > 0;
  renderRecords(packages);

  const farthest = [...packages].sort((a, b) => b.distanceMiles - a.distanceMiles)[0];
  el("farthest-distance").textContent = farthest ? `${fmt.format(farthest.distanceMiles)} mi` : "— mi";
  el("farthest-place").textContent = farthest ? `${farthest.city}, ${farthest.region}` : "Waiting for the first trip";
  el("farthest-title").textContent = farthest ? farthest.titles.join(" · ") : "The farthest-travelled game will appear here.";
}

function applyFilters() {
  const month = el("filter-month").value;
  const region = el("filter-region").value;
  const query = el("filter-title").value.trim().toLowerCase();
  render(dataset.packages.filter(pkg =>
    (month === "all" || (timelineCumulative ? pkg.month <= month : pkg.month === month)) &&
    (region === "all" || `${pkg.country}|${pkg.region}` === region) &&
    (!query || pkg.titles.some(title => title.toLowerCase().includes(query)))
  ));
  const selectedMonth = el("filter-month").value;
  el("timeline-status").textContent = selectedMonth === "all" ? "All time" : `${timelineCumulative ? "Through " : ""}${formatMonth(selectedMonth)}`;
}

function populateFilters(packages) {
  timelineMonths = [...new Set(packages.map(pkg => pkg.month))].sort();
  [...timelineMonths].reverse().forEach(month => el("filter-month").add(new Option(month, month)));
  const regions = [...new Map(packages.map(pkg => [
    `${pkg.country}|${pkg.region}`,
    pkg.region === pkg.country ? pkg.country : `${pkg.region}, ${pkg.country}`
  ])).entries()].sort((a,b) => a[1].localeCompare(b[1]));
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

fetch("data/shipments.json", { cache: "no-store" })
  .then(response => { if (!response.ok) throw new Error(`Data request failed: ${response.status}`); return response.json(); })
  .then(data => {
    dataset = data;
    populateFilters(data.packages);
    render(data.packages);
    if (data.generatedAt) el("updated-at").textContent = `Updated ${new Date(data.generatedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
    el("filter-month").addEventListener("change", () => { stopTimeline(); timelineCumulative = false; applyFilters(); });
    el("filter-region").addEventListener("change", applyFilters);
    el("filter-title").addEventListener("input", applyFilters);
    el("play-timeline").addEventListener("click", toggleTimeline);
    el("reset-filters").addEventListener("click", () => {
      stopTimeline(); timelineCumulative = false; el("filter-month").value = "all"; el("filter-region").value = "all"; el("filter-title").value = ""; applyFilters();
    });
  })
  .catch(error => {
    console.error(error);
    el("empty-state").hidden = false;
    el("empty-state").textContent = "The journey data could not be loaded.";
  });
