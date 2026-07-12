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

const el = id => document.getElementById(id);
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

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
    marker.bindPopup(items.length === 1 ? popup(first) : `<div class="popup-place">${escapeHtml(first.city)}, ${escapeHtml(first.region)}</div><div class="popup-title">${items.length} packages · ${items.reduce((n, x) => n + x.gameCount, 0)} games</div><div class="popup-meta">Select filters to narrow this destination.</div>`);
    marker.addTo(pointLayer);
  });

  L.circleMarker(origin, { radius: 9, color: "#d6ff54", weight: 2, fillColor: "#d6ff54", fillOpacity: 1 })
    .bindPopup(`<div class="popup-place">Journey origin</div><div class="popup-title">${escapeHtml(dataset.origin.name)}</div>`)
    .addTo(pointLayer);

  const games = packages.reduce((n, pkg) => n + pkg.gameCount, 0);
  const miles = packages.reduce((n, pkg) => n + pkg.distanceMiles, 0);
  const regions = new Set(packages.map(pkg => `${pkg.country}|${pkg.region}`)).size;
  el("stat-packages").textContent = fmt.format(packages.length);
  el("stat-games").textContent = fmt.format(games);
  el("stat-miles").textContent = fmt.format(Math.round(miles));
  el("stat-regions").textContent = fmt.format(regions);
  el("empty-state").hidden = packages.length > 0;

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
    (month === "all" || pkg.month === month) &&
    (region === "all" || `${pkg.country}|${pkg.region}` === region) &&
    (!query || pkg.titles.some(title => title.toLowerCase().includes(query)))
  ));
}

function populateFilters(packages) {
  const months = [...new Set(packages.map(pkg => pkg.month))].sort().reverse();
  months.forEach(month => el("filter-month").add(new Option(month, month)));
  const regions = [...new Map(packages.map(pkg => [
    `${pkg.country}|${pkg.region}`,
    pkg.region === pkg.country ? pkg.country : `${pkg.region}, ${pkg.country}`
  ])).entries()].sort((a,b) => a[1].localeCompare(b[1]));
  regions.forEach(([value, label]) => el("filter-region").add(new Option(label, value)));
}

fetch("data/shipments.json")
  .then(response => { if (!response.ok) throw new Error(`Data request failed: ${response.status}`); return response.json(); })
  .then(data => {
    dataset = data;
    populateFilters(data.packages);
    render(data.packages);
    if (data.generatedAt) el("updated-at").textContent = `Updated ${new Date(data.generatedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
    ["filter-month", "filter-region"].forEach(id => el(id).addEventListener("change", applyFilters));
    el("filter-title").addEventListener("input", applyFilters);
    el("reset-filters").addEventListener("click", () => {
      el("filter-month").value = "all"; el("filter-region").value = "all"; el("filter-title").value = ""; applyFilters();
    });
  })
  .catch(error => {
    console.error(error);
    el("empty-state").hidden = false;
    el("empty-state").textContent = "The journey data could not be loaded.";
  });
