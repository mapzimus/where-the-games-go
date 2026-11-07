import { createGlobe, PALETTE } from "./globe.js?v=atlas-3";

function el(id) { return document.getElementById(id); }
const fmt = new Intl.NumberFormat("en-US");
if (new URLSearchParams(window.location.search).has("preview")) document.documentElement.classList.add("preview-mode");
const DEFAULT_VIEW = { lng: -92, lat: 34 };
const canvas = el("globe-canvas");
const popupEl = el("globe-popup");
let popupAnchor = null;

const globe = createGlobe({
  canvas,
  startLng: DEFAULT_VIEW.lng,
  startLat: DEFAULT_VIEW.lat,
  onPick: handlePick,
  onFrame: positionPopup,
  onTextureError: () => {
    el("empty-state").hidden = false;
    el("empty-state").textContent = "Earth imagery could not be loaded. Refresh the page to try again.";
  }
});

let dataset;
let timelineTimer = null;
let timelineMonths = [];
let timelineIndex = -1;
let timelineCumulative = false;
let regionViewMode = "highlight";
let routesVisible = true;
let routeOpacity = 0.3;
let visibleGroups = new Map();
let visibleHubGroups = new Map();
let visibleInternational = [];
let internationalFocusIndex = -1;
const routeArcCache = new Map();
const INTERNATIONAL_HUB_KEYS = new Set(["glendale heights|il|united states"]);
const CONSOLES = [
  { id: "switch", label: "Nintendo Switch", pattern: /\bnintendo\s+switch\b|\bswitch\b.*\bgame\b|\bgame\b.*\bswitch\b/i },
  { id: "3ds", label: "Nintendo 3DS / 2DS", pattern: /\b(?:nintendo\s*)?[23]ds\b/i },
  { id: "ds", label: "Nintendo DS", pattern: /\bnintendo\s+ds\b|\bnds\b/i },
  { id: "gba", label: "Game Boy Advance", pattern: /\bgame\s*boy\s*advance\b|\bgba\b/i },
  { id: "gbc", label: "Game Boy Color", pattern: /\bgame\s*boy\s*colou?r\b|\bgbc\b/i },
  { id: "gameboy", label: "Game Boy", pattern: /\bgame\s*boy\b(?!\s*(?:advance|colou?r))|\bgameboy\b(?!\s*(?:advance|colou?r))/i },
  { id: "wiiu", label: "Wii U", pattern: /\bwii\s*u\b/i },
  { id: "wii", label: "Wii", pattern: /\bwii\b(?!\s*u\b)/i },
  { id: "gamecube", label: "Nintendo GameCube", pattern: /\bgame\s*cube\b|\bgcn\b/i },
  { id: "n64", label: "Nintendo 64", pattern: /\bnintendo\s*64\b|\bn64\b/i },
  { id: "snes", label: "Super Nintendo", pattern: /\bsuper\s+nintendo\b|\bsnes\b/i },
  { id: "nes", label: "Nintendo Entertainment System", pattern: /\bnintendo\s+entertainment\s+system\b|\bnes\b/i },
  { id: "ps5", label: "PlayStation 5", pattern: /\bplaystation\s*5\b|\bps5\b/i },
  { id: "ps4", label: "PlayStation 4", pattern: /\bplaystation\s*4\b|\bps4\b/i },
  { id: "ps3", label: "PlayStation 3", pattern: /\bplaystation\s*3\b|\bps3\b/i },
  { id: "ps2", label: "PlayStation 2", pattern: /\bplaystation\s*2\b|\bps2\b/i },
  { id: "ps1", label: "PlayStation", pattern: /\bplaystation\b(?!\s*[2345])|\bps1\b|\bpsx\b/i },
  { id: "psvita", label: "PlayStation Vita", pattern: /\bps\s*vita\b|\bplaystation\s+vita\b/i },
  { id: "psp", label: "PSP", pattern: /\b(?:sony\s+)?psp\b/i },
  { id: "xbox-series", label: "Xbox Series X / S", pattern: /\bxbox\s+series\s*[xs]\b/i },
  { id: "xbox-one", label: "Xbox One", pattern: /\bxbox\s+one\b/i },
  { id: "xbox-360", label: "Xbox 360", pattern: /\bxbox\s*360\b/i },
  { id: "xbox", label: "Xbox", pattern: /\bxbox\b(?!\s*(?:360|one|series))/i },
  { id: "dreamcast", label: "Sega Dreamcast", pattern: /\bdreamcast\b/i },
  { id: "saturn", label: "Sega Saturn", pattern: /\bsega\s+saturn\b/i },
  { id: "genesis", label: "Sega Genesis / Mega Drive", pattern: /\bsega\s+genesis\b|\bmega\s+drive\b/i },
  { id: "game-gear", label: "Sega Game Gear", pattern: /\bgame\s+gear\b/i },
  { id: "atari", label: "Atari", pattern: /\batari(?:\s*(?:2600|5200|7800))?\b/i }
];
const consoleCache = new WeakMap();

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

function formatCoverageDate(value) {
  if (!value) return "unknown date";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function renderCoverage(coverage) {
  const notice = el("data-coverage");
  const incomplete = coverage?.status === "incomplete";
  notice.hidden = !incomplete;
  if (!incomplete) return false;
  const gaps = Array.isArray(coverage.knownGaps) ? coverage.knownGaps : [];
  el("coverage-detail").textContent = coverage.note || "Some orders are not represented in the current dataset. Headline totals reflect known records only.";
  const gapLabel = gaps.length === 1 ? "1 known gap" : `${gaps.length} known gaps`;
  const rangeLabel = gaps.length === 1
    ? `${formatCoverageDate(gaps[0].start)}–${formatCoverageDate(gaps[0].end)}`
    : gapLabel;
  const asOfLabel = coverage.asOf ? `Known through ${formatCoverageDate(coverage.asOf)}` : "Coverage date unavailable";
  el("coverage-meta").textContent = `${asOfLabel} · ${rangeLabel}`;
  return true;
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

function packageConsoleIds(pkg) {
  if (!consoleCache.has(pkg)) {
    const titles = pkg.titles.join(" ");
    consoleCache.set(pkg, new Set(CONSOLES.filter(console => console.pattern.test(titles)).map(console => console.id)));
  }
  return consoleCache.get(pkg);
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
  el("record-console-gross").textContent = financial.topGrossingConsole?.label || "—";
  el("record-console-volume").textContent = financial.topConsoleByUnits?.label || "—";
  el("record-console-volume-detail").textContent = financial.topConsoleByUnits
    ? `${fmt.format(financial.topConsoleByUnits.gameCount)} games sold`
    : "ranking unavailable";
}

function arcBetween(key, start, end) {
  if (!routeArcCache.has(key)) routeArcCache.set(key, globe.buildArc(start, end));
  return routeArcCache.get(key);
}

function popup(pkg) {
  const titles = pkg.titles.slice(0, 4).map(title => `<div class="popup-title">${escapeHtml(title)}</div>`).join("");
  const more = pkg.titles.length > 4 ? `<div class="popup-meta">+${pkg.titles.length - 4} more</div>` : "";
  const via = pkg.via ? `<div class="popup-meta popup-via">via ${escapeHtml(titleCase(pkg.via.city))}, ${escapeHtml(pkg.via.region)} · eBay international handoff</div>` : "";
  return `<div class="popup-place">${escapeHtml(titleCase(pkg.city))}, ${escapeHtml(pkg.region)}</div>${via}${titles}${more}<div class="popup-meta">${fmt.format(pkg.distanceMiles)} estimated route miles · ${escapeHtml(pkg.month)}</div>`;
}

function groupedPopup(items) {
  const first = items[0];
  return items.length === 1
    ? popup(first)
    : `<div class="popup-place">${escapeHtml(titleCase(first.city))}, ${escapeHtml(first.region)}</div><div class="popup-title">${packageLabel(items.length)} mapped to this community</div><div class="popup-meta">Apply a period or platform filter to refine this destination.</div>`;
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

function updateRouteAppearance() {
  globe.setRouteStrength(routesVisible ? routeOpacity : 0);
  el("toggle-routes").textContent = routesVisible ? "Hide lines" : "Show lines";
  el("toggle-routes").setAttribute("aria-pressed", String(routesVisible));
  el("route-opacity-value").textContent = `${Math.round(routeOpacity * 100)}%`;
}

function closePopup() {
  popupAnchor = null;
  popupEl.hidden = true;
}

function openPopup(lng, lat, html) {
  el("globe-popup-body").innerHTML = html;
  popupAnchor = { lng, lat };
  popupEl.hidden = false;
  positionPopup();
}

function positionPopup() {
  if (!popupAnchor) return;
  const screen = globe.project(popupAnchor.lng, popupAnchor.lat);
  popupEl.style.visibility = screen.visible ? "visible" : "hidden";
  const stage = el("explore").getBoundingClientRect();
  popupEl.style.transform = `translate(${Math.round(screen.x - stage.left)}px, ${Math.round(screen.y - stage.top)}px) translate(-50%, calc(-100% - 14px))`;
}

function handlePick(item) {
  if (!item) { closePopup(); return; }
  if (item.type === "origin") {
    openPopup(item.lng, item.lat, `<div class="popup-place">Where orders ship from</div><div class="popup-title">${escapeHtml(dataset?.origin?.name || "Salem, Massachusetts")}</div>`);
    return;
  }
  if (item.type === "hub") {
    const group = visibleHubGroups.get(item.key);
    if (group) openPopup(item.lng, item.lat, hubPopup(group));
    return;
  }
  const items = visibleGroups.get(item.key) || [];
  if (items.length) openPopup(item.lng, item.lat, groupedPopup(items));
}

const pointSize = (count, base) => base + Math.min(Math.sqrt(count) * 2.4, 11);

function render(packages, highlightedRegion = null, freshMonth = null) {
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
  const base = [];
  const onwardArcs = [];
  const highlight = [];
  const highlightOnwardArcs = [];
  const fresh = [];
  const destinationItems = [];
  const hubItems = [];
  grouped.forEach((items, key) => {
    const first = items[0];
    const selected = Boolean(highlightedRegion && regionKey(first) === highlightedRegion);
    const routeEnd = first.via ? [first.via.lng, first.via.lat] : [first.lng, first.lat];
    const arc = arcBetween(`origin|${routeEnd.join("|")}`, origin, routeEnd);
    base.push(arc);
    if (selected) highlight.push(arc);
    if (freshMonth && items.some(pkg => pkg.month === freshMonth)) fresh.push(arc);
    if (first.via) {
      const onwardArc = arcBetween(`onward|${first.via.lng}|${first.via.lat}|${first.lng}|${first.lat}`, [first.via.lng, first.via.lat], [first.lng, first.lat]);
      onwardArcs.push(onwardArc);
      if (selected) highlightOnwardArcs.push(onwardArc);
    }
    destinationItems.push({
      key,
      lng: first.lng,
      lat: first.lat,
      size: pointSize(items.length, selected ? 10 : 7),
      color: selected ? PALETTE.selected : PALETTE.destination
    });
  });
  hubGroups.forEach((group, key) => {
    const hub = group.location;
    const selected = Boolean(highlightedRegion && [...group.known, ...group.unknown].some(pkg => regionKey(pkg) === highlightedRegion));
    const arc = arcBetween(`origin|${hub.lng}|${hub.lat}`, origin, [hub.lng, hub.lat]);
    if (!grouped.size || !group.known.length) base.push(arc);
    if (selected) highlight.push(arc);
    hubItems.push({
      key,
      lng: hub.lng,
      lat: hub.lat,
      size: pointSize(group.known.length + group.unknown.length, 8),
      color: selected ? PALETTE.selected : PALETTE.hub
    });
  });

  globe.setPoints({
    destinationItems,
    hubItems,
    originItem: { key: "origin", lng: origin[0], lat: origin[1], size: 15, color: PALETTE.origin }
  });
  globe.setRoutes({ base, onwardArcs, highlight, highlightOnwardArcs });
  globe.showFreshRoutes(fresh);
  closePopup();

  const miles = packages.reduce((n, pkg) => n + pkg.distanceMiles, 0);
  const regions = new Set(packages.map(pkg => `${pkg.country}|${pkg.region}`)).size;
  const cities = new Set(packages.map(cityKey)).size;
  el("stat-packages").textContent = fmt.format(packages.length);
  el("stat-items").textContent = fmt.format(packages.reduce((total, pkg) => total + pkg.gameCount, 0));
  el("stat-cities").textContent = fmt.format(cities);
  el("stat-miles").textContent = fmt.format(Math.round(miles));
  el("stat-regions").textContent = fmt.format(regions);
  el("empty-state").hidden = packages.length > 0;
  const internationalKnown = packages.filter(isInternationalDestination).length;
  const internationalUnknown = packages.filter(isHubOnly).length;
  const internationalStatus = el("international-status");
  internationalStatus.hidden = internationalKnown + internationalUnknown === 0;
  internationalStatus.disabled = internationalKnown === 0;
  internationalStatus.textContent = internationalKnown ? `Tour ${fmt.format(internationalKnown)} international shipments` : "No mapped international destinations";
  internationalStatus.title = internationalUnknown
    ? `${packageLabel(internationalKnown)} mapped internationally; ${packageLabel(internationalUnknown)} hub-only`
    : `Tour ${packageLabel(internationalKnown)} mapped internationally`;
  renderRecords(packages);

  const farthest = [...packages].sort((a, b) => b.distanceMiles - a.distanceMiles)[0];
  el("farthest-distance").textContent = farthest ? `${fmt.format(farthest.distanceMiles)} mi` : "— mi";
  el("farthest-place").textContent = farthest ? `${titleCase(farthest.city)}, ${farthest.region}` : "No matching destination";
  el("farthest-title").textContent = farthest ? farthest.titles.join(" · ") : "The longest matching shipment will appear here.";
}

function applyFilters() {
  const month = el("filter-month").value;
  const region = el("filter-region").value;
  const consoleId = el("filter-console").value;
  const query = el("filter-title").value.trim().toLowerCase();
  const basePackages = dataset.packages.filter(pkg =>
    (month === "all" || (timelineCumulative ? pkg.month <= month : pkg.month === month)) &&
    (consoleId === "all" || packageConsoleIds(pkg).has(consoleId)) &&
    (!query || pkg.titles.some(title => title.toLowerCase().includes(query)))
  );
  const regionPackages = region === "all" ? basePackages : basePackages.filter(pkg => regionKey(pkg) === region);
  const visiblePackages = region !== "all" && regionViewMode === "isolate" ? regionPackages : basePackages;
  render(visiblePackages, region === "all" ? null : region, timelineCumulative && month !== "all" ? month : null);
  markTimeline(month);

  const selectedOption = el("filter-region").selectedOptions[0];
  const regionLabel = selectedOption?.textContent || "All destinations";
  el("region-status").textContent = region === "all"
    ? `All destinations · ${packageLabel(basePackages.length)}`
    : `${regionLabel} · ${packageLabel(regionPackages.length)}`;
  const regionActive = region !== "all";
  el("region-highlight").disabled = !regionActive;
  el("region-isolate").disabled = !regionActive;
  const selectedMonth = el("filter-month").value;
  el("timeline-status").textContent = selectedMonth === "all" ? "All periods" : `${timelineCumulative ? "Through " : ""}${formatMonth(selectedMonth)}`;
}

function setRegionViewMode(mode) {
  regionViewMode = mode;
  el("region-highlight").setAttribute("aria-pressed", String(mode === "highlight"));
  el("region-isolate").setAttribute("aria-pressed", String(mode === "isolate"));
  applyFilters();
}

function toggleRoutes() {
  routesVisible = !routesVisible;
  updateRouteAppearance();
}

function setRouteOpacity(event) {
  routeOpacity = Number(event.target.value) / 100;
  routesVisible = true;
  updateRouteAppearance();
}

function populateFilters(packages) {
  timelineMonths = [...new Set(packages.map(pkg => pkg.month))].sort();
  [...timelineMonths].reverse().forEach(month => el("filter-month").add(new Option(formatMonth(month), month)));
  buildTimelineStrip(packages);
  const regions = [...new Map(packages.map(pkg => [
    `${pkg.country}|${pkg.region}`,
    pkg.region === pkg.country ? pkg.country : `${pkg.region}, ${pkg.country}`
  ])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  regions.forEach(([value, label]) => el("filter-region").add(new Option(label, value)));
  CONSOLES.forEach(console => {
    const count = packages.filter(pkg => packageConsoleIds(pkg).has(console.id)).length;
    if (count) el("filter-console").add(new Option(`${console.label} · ${fmt.format(count)}`, console.id));
  });
}

function buildTimelineStrip(packages) {
  const counts = new Map();
  packages.forEach(pkg => counts.set(pkg.month, (counts.get(pkg.month) || 0) + 1));
  const peak = Math.max(...counts.values());
  const strip = el("timeline-strip");
  timelineMonths.forEach(month => {
    const count = counts.get(month);
    const bar = document.createElement("button");
    bar.type = "button";
    bar.dataset.month = month;
    bar.title = `${formatMonth(month)}: ${packageLabel(count)}`;
    bar.setAttribute("aria-label", bar.title);
    bar.style.setProperty("--fill", `${Math.max(8, Math.round(count / peak * 100))}%`);
    bar.addEventListener("click", () => {
      stopTimeline();
      timelineCumulative = false;
      el("filter-month").value = el("filter-month").value === month ? "all" : month;
      applyFilters();
    });
    strip.append(bar);
  });
}

function markTimeline(month) {
  el("timeline-strip").querySelectorAll("button").forEach(bar => {
    const active = month === "all" || (timelineCumulative ? bar.dataset.month <= month : bar.dataset.month === month);
    bar.classList.toggle("is-active", active);
    bar.setAttribute("aria-pressed", String(month === bar.dataset.month));
  });
}

function stopTimeline(buttonLabel = "Play by month") {
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
    stopTimeline("Replay");
    return;
  }
  showTimelineMonth(timelineIndex + 1);
}

function toggleTimeline() {
  if (timelineTimer) {
    stopTimeline("Resume");
    return;
  }
  if (!timelineMonths.length) return;
  timelineCumulative = true;
  const selectedIndex = timelineMonths.indexOf(el("filter-month").value);
  showTimelineMonth(selectedIndex >= 0 && selectedIndex < timelineMonths.length - 1 ? selectedIndex : 0);
  el("play-timeline").textContent = "Pause";
  el("play-timeline").setAttribute("aria-pressed", "true");
  const interval = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1300 : 850;
  timelineTimer = window.setInterval(advanceTimeline, interval);
}

function resetGlobe() {
  closePopup();
  globe.flyTo(DEFAULT_VIEW.lng, DEFAULT_VIEW.lat, 1, 900);
}

async function focusInternational() {
  if (!visibleInternational.length) return;
  internationalFocusIndex = (internationalFocusIndex + 1) % visibleInternational.length;
  const pkg = visibleInternational[internationalFocusIndex];
  closePopup();
  await globe.flyTo(pkg.lng, pkg.lat, .72, 1400);
  openPopup(pkg.lng, pkg.lat, popup(pkg));
}

function setLight(name) {
  document.querySelectorAll("[data-light]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.light === name)));
  globe.setLight(name);
}

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = value => Math.min(1, Math.max(0, value));
const smooth = t => t * t * (3 - 2 * t);

/** Scroll moves the camera: a close horizon in the hero, the whole disc in the explorer, a quiet backdrop after. */
function updateFraming(jump = false) {
  const wide = window.innerWidth > 900;
  const fit = wide ? 1 : Math.max(1, window.innerHeight / window.innerWidth * .78);
  const stage = el("explore");
  const toStage = smooth(clamp01(window.scrollY / Math.max(1, stage.offsetTop)));
  const pastStage = smooth(clamp01((window.scrollY - stage.offsetTop) / window.innerHeight));
  const hero = wide ? { distance: 2.05, offsetX: .2, offsetY: .24 } : { distance: 2.5 * fit, offsetX: 0, offsetY: .3 };
  const explore = { distance: 4.5 * fit, offsetX: wide ? .015 : 0, offsetY: wide ? -.035 : -.08 };
  const after = { distance: 5.2 * fit, offsetX: wide ? .24 : 0, offsetY: 0 };
  const framing = {};
  Object.keys(hero).forEach(key => { framing[key] = mix(mix(hero[key], explore[key], toStage), after[key], pastStage); });
  if (jump) globe.jumpFraming(framing);
  else globe.setFraming(framing);
  const rect = stage.getBoundingClientRect();
  globe.setInteractive(rect.top < window.innerHeight * .4 && rect.bottom > window.innerHeight * .6);
}

window.addEventListener("scroll", () => updateFraming(), { passive: true });
window.addEventListener("resize", () => updateFraming());
updateFraming(true);

fetch("data/shipments.json", { cache: "no-store" })
  .then(response => { if (!response.ok) throw new Error(`Data request failed: ${response.status}`); return response.json(); })
  .then(async data => {
    dataset = data;
    const coverageIncomplete = renderCoverage(data.dataCoverage);
    populateFilters(data.packages);
    updateRouteAppearance();
    applyFilters();
    updateFraming(true);
    if (data.generatedAt) {
      const updated = `Updated ${new Date(data.generatedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
      el("updated-at").textContent = coverageIncomplete ? `${updated} · Coverage incomplete` : updated;
    }
    el("filter-month").addEventListener("change", () => { stopTimeline(); timelineCumulative = false; applyFilters(); });
    el("filter-region").addEventListener("change", applyFilters);
    el("filter-console").addEventListener("change", applyFilters);
    el("region-highlight").addEventListener("click", () => setRegionViewMode("highlight"));
    el("region-isolate").addEventListener("click", () => setRegionViewMode("isolate"));
    el("filter-title").addEventListener("input", applyFilters);
    el("play-timeline").addEventListener("click", toggleTimeline);
    el("toggle-routes").addEventListener("click", toggleRoutes);
    el("route-opacity").addEventListener("input", setRouteOpacity);
    el("reset-globe").addEventListener("click", resetGlobe);
    el("international-status").addEventListener("click", focusInternational);
    el("zoom-in").addEventListener("click", () => globe.zoomBy(.85));
    el("zoom-out").addEventListener("click", () => globe.zoomBy(1.18));
    el("globe-popup-close").addEventListener("click", closePopup);
    document.querySelectorAll("[data-light]").forEach(button => button.addEventListener("click", () => setLight(button.dataset.light)));
    el("reset-filters").addEventListener("click", () => {
      stopTimeline();
      timelineCumulative = false;
      el("filter-month").value = "all";
      el("filter-region").value = "all";
      el("filter-console").value = "all";
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
    el("empty-state").textContent = "Shipment data could not be loaded. Refresh the page to try again.";
  });
