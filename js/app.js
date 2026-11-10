// Page wiring: map, forms, result list, quarry card, export and print.
// The calculation lives in geo.js, network.js, route.js and haul.js; nothing here computes a distance.
// Wording comes from data/strings.json; text from the data goes in as text nodes, never as markup.
import { midpoint, parseCoordinate, inBbox } from "./geo.js";
import { decode } from "./network.js";
import { pathGeometry } from "./route.js";
import { rank, quarrySnap, warning } from "./haul.js";
import { makeT, applyTo } from "./i18n.js";
import { exportRows, strengthText, reservesValue, lengthText, warningText } from "./exportrows.js";
import { workbook } from "./xlsx.js";
import { filterQuarries, regionSummary, catalogueRows, attributeText, samples, ATTRIBUTES, BALANCE } from "./catalogue.js";

const LANGS = ["uz", "ru", "en"];
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_COPYRIGHT = "https://www.openstreetmap.org/copyright";
const ROAD_COLOUR = "#b9b3a6", EDGE_COLOUR = "#5c574d", WARN_COLOUR = "#a1281b", ROUTE_COLOUR = "#111111";

const state = {
  data: null,            // {net, quarries, meta, strings, boundaries}
  lang: "uz",
  t: (key) => key,
  ends: { start: null, end: null },   // each [lon, lat] or null
  results: null,         // ranked list from the last search, or null
  searched: null,        // {start, end, mid, group} of the last search
  shown: 0,
  selected: null,        // quarry_id
  browse: { list: [], shown: 0, withoutStrength: 0 },   // the filtered register list
  map: null, layers: {},
};

const $ = (id) => document.getElementById(id);

/** Create an element. Text is always set as text. */
function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.cls) node.className = options.cls;
  if (options.text !== undefined) node.textContent = String(options.text);
  for (const [name, value] of Object.entries(options.attrs || {})) node.setAttribute(name, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

const km = (value) => value.toFixed(1);
const fixed5 = (value) => value.toFixed(5);

function savedLanguage() {
  try {
    const saved = window.localStorage.getItem("lang");
    if (LANGS.includes(saved)) return saved;
  } catch (e) { /* storage unavailable: use the default */ }
  return "uz";
}

function rememberLanguage(lang) {
  try { window.localStorage.setItem("lang", lang); } catch (e) { /* not remembered, nothing else lost */ }
}

// ---------------------------------------------------------------- loading

// Always ask the server whether a file has changed: quarries.json refers to edges of network.json
// by number, so an old copy of one beside a new copy of the other would give wrong distances.
async function get(name) {
  const response = await fetch("data/" + name, { cache: "no-cache" });
  if (!response.ok) throw new Error(name + ": " + response.status);
  return response.json();
}

async function load(strings) {
  const [network, quarries, meta] = await Promise.all(["network.json", "quarries.json", "meta.json"].map(get));
  // the outlines are decoration: the page works without them
  const boundaries = await get("boundaries.json").catch(() => null);
  return { net: decode(network), quarries, meta, strings, boundaries };
}

// ---------------------------------------------------------------- map

function buildMap() {
  const { net, quarries, meta, boundaries } = state.data;
  const [west, south, east, north] = meta.bbox;
  const map = L.map("map", { preferCanvas: true, attributionControl: true });
  map.attributionControl.setPrefix(false);
  map.fitBounds([[south, west], [north, east]]);

  // Background tiles are a convenience: when they cannot be fetched the layer is dropped and the
  // page carries on with its own boundaries and roads.
  const tiles = L.tileLayer(TILE_URL, { maxZoom: 17, opacity: 0.55 });
  let failures = 0;
  tiles.on("tileerror", () => { if (++failures >= 6 && map.hasLayer(tiles)) map.removeLayer(tiles); });
  tiles.on("tileload", () => { failures = 0; });
  tiles.addTo(map);

  if (boundaries) L.geoJSON(boundaries, { interactive: false, style: { color: EDGE_COLOUR, weight: 1.2, fill: false } }).addTo(map);

  const roads = net.edges.map((e) => {
    const line = [];
    for (let i = 0; i < e.geom.length; i += 2) line.push([e.geom[i + 1], e.geom[i]]);
    return line;
  });
  L.polyline(roads, { color: ROAD_COLOUR, weight: 1.2, interactive: false }).addTo(map);

  state.layers.route = L.layerGroup().addTo(map);
  state.layers.quarries = L.layerGroup().addTo(map);
  state.layers.section = L.layerGroup().addTo(map);
  state.layers.markers = new Map();
  for (const q of quarries) {
    const marked = warning(q) !== null;
    const marker = L.circleMarker([q.lat, q.lon], {
      radius: 5.5, weight: marked ? 2.5 : 1, color: marked ? WARN_COLOUR : "#222222",
      fillColor: meta.colours[q.group_no - 1], fillOpacity: 0.95,
    });
    marker.bindTooltip(el("span", { text: q.quarry_id + " " + q.name }));
    marker.on("click", (event) => { L.DomEvent.stopPropagation(event); select(q.quarry_id); });
    marker.addTo(state.layers.quarries);
    state.layers.markers.set(q.quarry_id, marker);
  }

  // A double click zooms the map and arrives as two clicks first, so a click waits a moment
  // before it places an end.
  let pending = null;
  map.on("click", (event) => {
    clearTimeout(pending);
    const point = [event.latlng.lng, event.latlng.lat];
    pending = setTimeout(() => placeEnd(point), 250);
  });
  map.on("dblclick", () => clearTimeout(pending));
  state.map = map;
}

function endIcon(cls) {
  return L.divIcon({ className: "", html: el("div", { cls }), iconSize: [14, 14], iconAnchor: [7, 7] });
}

/**
 * A map click sets whichever end is still missing. Once both are set, clicks leave them alone
 * (coordinates typed from a survey must not be lost to a stray click): ends are moved by dragging.
 */
function placeEnd(point) {
  const { start, end } = state.ends;
  if (start && end) return;
  setEnd(start ? "end" : "start", point, true);
}

function setEnd(which, point, writeFields) {
  if (point && !inBbox(point[0], point[1], state.data.meta.bbox)) {
    $("section-error").textContent = state.t("site.err.outside");
    drawSection();                    // a marker dragged out of bounds goes back where it was
    return;
  }
  state.ends[which] = point;
  if (writeFields && point) {
    $(which + "-lat").value = fixed5(point[1]);
    $(which + "-lon").value = fixed5(point[0]);
    for (const id of [which + "-lat", which + "-lon"]) $(id).classList.remove("bad");
    $("section-error").textContent = "";
  }
  drawSection();
}

function currentMidpoint() {
  const { start, end } = state.ends;
  return start && end ? midpoint(start[0], start[1], end[0], end[1]) : null;
}

function drawSection() {
  const group = state.layers.section;
  group.clearLayers();
  const { start, end } = state.ends, mid = currentMidpoint();
  for (const which of ["start", "end"]) {
    const point = state.ends[which];
    if (!point) continue;
    const marker = L.marker([point[1], point[0]], { icon: endIcon("end-marker"), draggable: true, keyboard: false });
    marker.on("dragend", () => {
      const at = marker.getLatLng();
      setEnd(which, [at.lng, at.lat], true);
    });
    marker.addTo(group);
  }
  if (start && end) L.polyline([[start[1], start[0]], [end[1], end[0]]], { color: ROUTE_COLOUR, weight: 2, dashArray: "2 5", interactive: false }).addTo(group);
  if (mid) L.marker([mid[1], mid[0]], { icon: endIcon("mid-marker"), interactive: false, keyboard: false }).addTo(group);
  $("midpoint").textContent = mid ? state.t("site.midpoint", { lat: fixed5(mid[1]), lon: fixed5(mid[0]) }) : "";
  $("find").disabled = !mid;
  withdrawStaleResults();
}

/** Results belong to the section they were calculated for: once the section changes they go. */
function withdrawStaleResults() {
  const s = state.searched;
  if (!state.results || !s) return;
  const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  if (same(state.ends.start, s.start) && same(state.ends.end, s.end)) return;
  state.results = null;
  state.searched = null;
  renderResults();
  renderCard();
  drawRoute();
}

// ---------------------------------------------------------------- the section fields

/** Read the four fields; mark the bad ones; keep state.ends in step. */
function readFields() {
  const bbox = state.data.meta.bbox;
  let message = "";
  for (const which of ["start", "end"]) {
    const latField = $(which + "-lat"), lonField = $(which + "-lon");
    const lat = parseCoordinate(latField.value), lon = parseCoordinate(lonField.value);
    const latTyped = latField.value.trim() !== "", lonTyped = lonField.value.trim() !== "";
    latField.classList.toggle("bad", latTyped && lat === null);
    lonField.classList.toggle("bad", lonTyped && lon === null);
    let point = null;
    if ((latTyped && lat === null) || (lonTyped && lon === null)) {
      message = message || state.t("site.err.number");
    } else if (lat !== null && lon !== null) {
      if (inBbox(lon, lat, bbox)) point = [lon, lat];
      else {
        message = message || state.t("site.err.outside");
        latField.classList.add("bad"); lonField.classList.add("bad");
      }
    }
    state.ends[which] = point;
  }
  $("section-error").textContent = message;
  drawSection();
}

// ---------------------------------------------------------------- search and results

function materialName(group) {
  return group === 0 ? state.t("site.material.all") : state.t("group." + group);
}

function fillMaterials() {
  const select = $("material"), chosen = select.value || "0";
  select.replaceChildren(
    el("option", { text: state.t("site.material.all"), attrs: { value: "0" } }),
    ...state.data.meta.groups.map((_, i) => el("option", { text: state.t("group." + (i + 1)), attrs: { value: String(i + 1) } })));
  select.value = chosen;
}

function find() {
  const mid = currentMidpoint();
  if (!mid) return;
  const { net, quarries, meta } = state.data;
  const group = Number($("material").value);
  state.results = rank(net, quarries, mid, group, meta.offroad_factor);
  state.searched = { start: state.ends.start, end: state.ends.end, mid, group };
  state.shown = Math.min(meta.results_shown, state.results.length);
  state.selected = state.results.length ? state.results[0].quarry.quarry_id : null;
  renderResults();
  renderCard();
  drawRoute();
}

function resultFor(quarryId) {
  return state.results ? state.results.find((r) => r.quarry.quarry_id === quarryId) || null : null;
}

function renderResults() {
  const section = $("results");
  if (!state.results) { section.hidden = true; renderPrintView(); return; }
  section.hidden = false;
  $("results-title").textContent = state.t("site.results", { material: materialName(state.searched.group) });
  const none = state.results.length === 0;
  $("results-none").hidden = !none;
  $("list").hidden = none;
  $("export").disabled = none;
  $("print").disabled = none;
  $("more").hidden = state.shown >= state.results.length;

  const rows = state.results.slice(0, state.shown).map((r, i) => {
    const q = r.quarry, mark = warningText(q, state.t);
    const name = el("td", {}, [
      el("span", { text: q.quarry_id + " " + q.name }),
      el("span", { cls: "sub", text: q.district }),
      mark ? el("span", { cls: "sub warn", text: "⚠ " + mark }) : null,
    ]);
    const row = el("tr", { cls: q.quarry_id === state.selected ? "selected" : "", attrs: { tabindex: "0" } }, [
      el("td", { text: i + 1 }), name, el("td", { cls: "num", text: km(r.shown.totalKm) }),
    ]);
    const choose = () => select(q.quarry_id);
    row.addEventListener("click", choose);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } });
    return row;
  });
  $("list-body").replaceChildren(...rows);
  renderPrintView();
}

function select(quarryId) {
  state.selected = quarryId;
  if (state.results) {
    const position = state.results.findIndex((r) => r.quarry.quarry_id === quarryId);
    if (position >= state.shown) state.shown = position + 1;      // a quarry picked on the map joins the list
    renderResults();
  }
  renderBrowse();
  renderCard();
  drawRoute();
}

// ---------------------------------------------------------------- quarry card

function breakdownRows(result) {
  const r = result.shown;             // the rounded figures, which add up
  const t = state.t, factor = String(state.data.meta.offroad_factor), unit = " " + t("site.unit.km");
  const line = (label, value, cls) => el("tr", { cls: cls || "" }, [el("td", { text: label }), el("td", { cls: "num", text: value })]);
  if (r.direct) {
    return [line(t("site.dist.direct", { km: km(r.directStraightKm), factor }), km(r.totalKm) + unit),
      line(t("site.dist.total"), km(r.totalKm) + unit, "total")];
  }
  return [
    line(t("site.dist.site_offroad", { km: km(r.siteStraightKm), factor }), km(r.siteOffroadKm) + unit),
    line(t("site.dist.onroad"), km(r.onroadKm) + unit),
    line(t("site.dist.quarry_offroad", { km: km(r.quarryStraightKm), factor }), km(r.quarryOffroadKm) + unit),
    line(t("site.dist.total"), km(r.totalKm) + unit, "total"),
  ];
}

function renderCard() {
  const card = $("card"), t = state.t;
  const q = state.data.quarries.find((x) => x.quarry_id === state.selected);
  if (!q) { card.replaceChildren(el("p", { cls: "hint", text: t("site.card.select") })); return; }

  const pair = (label, value) => [el("dt", { text: label }), el("dd", { text: value })];
  const reserves = reservesValue(q, t);
  const strength = strengthText(q, t);
  const coords = fixed5(q.lat) + ", " + fixed5(q.lon) +
    (q.warn_coarse ? " (" + t("site.card.precision", { precision: lengthText(q.coord_precision_m, t) }) + ")" : "");
  const parts = [
    el("h3", { text: q.quarry_id + " " + q.name }),
    el("dl", {}, [
      ...pair(t("site.card.region"), q.region),
      ...pair(t("site.card.district"), q.district),
      ...pair(t("site.card.rock"), q.rock_type),
      ...pair(t("site.card.group"), t("group." + q.group_no)),
      ...pair(t("site.card.reserves"), typeof reserves === "number" ? reserves + " " + t("site.unit.reserves") : reserves),
      ...pair(t("site.card.strength"), q.strength_min === null ? strength : strength + " " + t("site.unit.strength")),
      ...pair(t("site.card.coords"), coords),
    ]),
  ];

  const mark = warningText(q, t);
  if (mark) parts.push(el("p", { cls: "warn", text: "⚠ " + mark }));

  const r = resultFor(q.quarry_id);
  if (r) parts.push(el("table", { cls: "breakdown" }, [el("tbody", {}, breakdownRows(r))]));

  parts.push(el("h2", { text: t("site.card.findings") }));
  parts.push(q.findings.length
    ? el("ul", {}, q.findings.map((code) => el("li", { text: t("cat." + code) })))
    : el("p", { cls: "hint", text: t("site.card.findings.none") }));

  // what people entered beside the source tables; an empty field says so, it is never left out
  const more = [el("summary", { text: t("site.card.more") }),
    el("dl", { cls: "attrs" }, ATTRIBUTES.flatMap((field) => pair(t("site.attr." + field), attributeText(q, field, t))))];
  if (q.balance_deposit) {
    more.push(el("p", { cls: "hint", text: t("site.card.balance") }),
      el("dl", { cls: "attrs" }, BALANCE.flatMap((field) => pair(t("site.attr." + field), q[field] || t("site.card.nodata")))));
  }
  parts.push(el("details", {}, more));

  if (q.lab.length) {
    // one table per sample: a later survey of the quarry stands beside the earlier one, never mixed with it
    const blocks = [el("summary", { text: t("site.card.lab") })];
    for (const sample of samples(q.lab)) {
      const withMethod = sample.rows.some((row) => row.method);
      const keys = ["site.lab.indicator", "site.lab.unit", "site.lab.standard", "site.lab.obtained", "site.lab.compliance"];
      const head = el("tr", {}, [...keys, ...(withMethod ? ["site.lab.method"] : [])].map((key) => el("th", { text: t(key) })));
      const body = sample.rows.map((row) => el("tr", {},
        [row.indicator, row.unit, row.standard_value, row.obtained_value, row.compliance, ...(withMethod ? [row.method] : [])]
          .map((value) => el("td", { text: value }))));
      const title = sample.laboratory
        ? t("site.card.samplelab", { id: sample.id, laboratory: sample.laboratory, tested: sample.tested })
        : t("site.card.sample", { id: sample.id }) + ". " + t("site.card.survey", { id: q.survey_id, sampled: q.sampled, tested: sample.tested });
      blocks.push(el("p", { cls: "hint", text: title }),
        el("table", { cls: "lab" }, [el("thead", {}, [head]), el("tbody", {}, body)]));
    }
    parts.push(el("details", {}, blocks));
  } else {
    parts.push(el("p", { cls: "hint", text: t("site.card.lab.none") }));
  }
  card.replaceChildren(...parts);
}

// ---------------------------------------------------------------- browsing the register

function fillFilters() {
  const t = state.t, { meta } = state.data;
  const region = $("f-region"), group = $("f-group");
  const chosenRegion = region.value || "", chosenGroup = group.value || "0";
  region.replaceChildren(
    el("option", { text: t("site.browse.region.all"), attrs: { value: "" } }),
    ...meta.regions.map((code) => el("option", { text: t("region." + code), attrs: { value: code } })));
  group.replaceChildren(
    el("option", { text: t("site.material.all"), attrs: { value: "0" } }),
    ...meta.groups.map((_, i) => el("option", { text: t("group." + (i + 1)), attrs: { value: String(i + 1) } })));
  region.value = chosenRegion;
  group.value = chosenGroup;
}

/** The filters as typed, or null when the strength is not a number. */
function readFilters() {
  const typed = $("f-strength").value.trim();
  const strength = typed === "" ? null : parseCoordinate(typed);      // the same number reading: comma or point
  const bad = typed !== "" && (strength === null || strength < 0);
  $("f-strength").classList.toggle("bad", bad);
  $("browse-error").textContent = bad ? state.t("site.browse.err") : "";
  if (bad) return null;
  return { region: $("f-region").value, group: Number($("f-group").value), minStrengthMpa: strength, labOnly: Boolean($("f-lab").checked) };
}

function applyFilters() {
  const filters = readFilters();
  if (!filters) return;                      // the list stays as it was until the number is put right
  const { list, withoutStrength } = filterQuarries(state.data.quarries, filters);
  state.browse = { list, withoutStrength, shown: Math.min(state.data.meta.results_shown, list.length) };
  const active = filters.region || filters.group || filters.minStrengthMpa !== null || filters.labOnly;
  const kept = new Set(list.map((q) => q.quarry_id));
  for (const [id, marker] of state.layers.markers) {
    const dim = active && !kept.has(id);
    marker.setStyle({ opacity: dim ? 0.25 : 1, fillOpacity: dim ? 0.12 : 0.95 });
  }
  renderBrowse();
}

function renderBrowse() {
  const t = state.t, { list, shown, withoutStrength } = state.browse;
  $("browse-count").textContent = t("site.browse.count", { n: String(list.length), total: String(state.data.quarries.length) });
  $("browse-left-out").textContent = withoutStrength ? t("site.browse.nostrength", { n: String(withoutStrength) }) : "";
  $("browse-list").hidden = list.length === 0;
  $("browse-export").disabled = list.length === 0;
  $("browse-more").hidden = shown >= list.length;
  $("browse-body").replaceChildren(...list.slice(0, shown).map((q) => {
    const mark = warningText(q, t);
    const strength = q.strength_min_mpa === null ? t("site.card.nodata")
      : (q.strength_min_mpa === q.strength_max_mpa ? String(q.strength_min_mpa) : q.strength_min_mpa + "–" + q.strength_max_mpa);
    const row = el("tr", { cls: q.quarry_id === state.selected ? "selected" : "", attrs: { tabindex: "0" } }, [
      el("td", {}, [
        el("span", { text: q.quarry_id + " " + q.name }),
        el("span", { cls: "sub", text: q.rock_type + ", " + q.district }),
        mark ? el("span", { cls: "sub warn", text: "⚠ " + mark }) : null,
      ]),
      el("td", { cls: "num", text: strength }),
    ]);
    const choose = () => select(q.quarry_id);
    row.addEventListener("click", choose);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } });
    return row;
  }));
}

function renderSummary() {
  const t = state.t, { meta, quarries } = state.data;
  const rows = regionSummary(quarries, meta.groups.length);
  const cells = (first, numbers, cls) => el("tr", { cls: cls || "" }, [el("td", { text: first }), ...numbers.map((n) => el("td", { text: n }))]);
  $("summary-head").replaceChildren(
    el("th", { text: t("site.card.region") }),
    ...meta.groups.map((_, i) => el("th", { text: t("group." + (i + 1)) })),
    el("th", { text: t("site.summary.total") }), el("th", { text: t("site.browse.lab") }));
  const sum = (pick) => rows.reduce((total, row) => total + pick(row), 0);
  $("summary-body").replaceChildren(
    ...rows.map((row) => cells(t("region." + row.region), [...row.groups, row.total, row.lab])),
    cells(t("site.summary.total"), [...meta.groups.map((_, i) => sum((row) => row.groups[i])), sum((row) => row.total), sum((row) => row.lab)], "total"));
}

function download(bytes, name) {
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const link = el("a", { attrs: { href: URL.createObjectURL(blob), download: name } });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

function exportBrowse() {
  if (!state.browse.list.length) return;
  download(workbook(state.t("site.col.quarry"), catalogueRows(state.browse.list, state.t)), "register-" + state.data.meta.built + ".xlsx");
}

// ---------------------------------------------------------------- route on the map

function drawRoute() {
  const group = state.layers.route;
  group.clearLayers();
  for (const [id, marker] of state.layers.markers) marker.setRadius(id === state.selected ? 9 : 5.5);
  const r = resultFor(state.selected);
  if (!r) return;
  const q = r.quarry, mid = state.searched.mid;
  const dashed = { color: ROUTE_COLOUR, weight: 2.5, dashArray: "6 6", interactive: false };
  let bounds;
  if (r.direct) {
    bounds = L.polyline([[mid[1], mid[0]], [q.lat, q.lon]], dashed).addTo(group).getBounds();
  } else {
    const to = quarrySnap(q);
    const path = pathGeometry(state.data.net, r.tree, r.siteSnap, to).map(([lon, lat]) => [lat, lon]);
    bounds = L.polyline(path, { color: ROUTE_COLOUR, weight: 3.5, interactive: false }).addTo(group).getBounds();
    L.polyline([[mid[1], mid[0]], [r.siteSnap.lat, r.siteSnap.lon]], dashed).addTo(group);
    L.polyline([[to.lat, to.lon], [q.lat, q.lon]], dashed).addTo(group);
    bounds.extend([mid[1], mid[0]]);
    bounds.extend([q.lat, q.lon]);
  }
  state.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
}

// ---------------------------------------------------------------- export and print

function currentRows() {
  const s = state.searched;
  return exportRows(state.results.slice(0, state.shown), { start: s.start, end: s.end, mid: s.mid },
    materialName(s.group), state.data.meta.offroad_factor, state.t);
}

function exportExcel() {
  if (!state.results || !state.results.length) return;
  download(workbook(state.t("site.col.quarry"), currentRows()), "quarries-" + state.data.meta.built + ".xlsx");
}

/** The same rows as the export, as a table that only shows on paper. */
function renderPrintView() {
  const view = $("print-view");
  if (!state.results || !state.results.length) { view.replaceChildren(); return; }
  const rows = currentRows(), headerAt = rows.findIndex((row) => row.length === 0) + 1;
  const cell = (tag) => (value) => el(tag, { text: value === null || value === undefined ? "" : value });
  view.replaceChildren(
    ...rows.slice(0, headerAt - 1).map((row) => el("p", { text: row.filter((v) => v !== null && v !== "").join("  ") })),
    el("table", {}, [
      el("thead", {}, [el("tr", {}, rows[headerAt].map(cell("th")))]),
      el("tbody", {}, rows.slice(headerAt + 1).map((row) => el("tr", {}, row.map(cell("td"))))),
    ]));
}

// ---------------------------------------------------------------- legend, footer, language

function renderLegend() {
  const t = state.t, { meta } = state.data;
  const item = (swatch, text) => el("li", {}, [swatch, el("span", { text })]);
  $("legend").replaceChildren(
    ...meta.groups.map((_, i) => {
      const dot = el("span", { cls: "dot" });
      dot.style.background = meta.colours[i];
      return item(dot, t("group." + (i + 1)));
    }),
    item(el("span", { cls: "dot ring" }), t("site.legend.warn")),
    item(el("span", { cls: "road" }), t("site.legend.roads")),
    item(el("span", { cls: "edge" }), t("site.legend.boundary")),
    item(el("span", { cls: "diamond" }), t("site.legend.section")));
}

function renderFooter() {
  const t = state.t, { meta } = state.data;
  $("foot").replaceChildren(
    el("p", { text: t("site.footer.sources", { date: meta.built }) }),
    el("p", { text: t("site.footer.method", { factor: String(meta.offroad_factor) }) }),
    el("p", { text: t("site.footer.limits") }),
    el("p", { text: t("site.footer.boundaries") }),
    el("p", {}, [el("a", { text: t("site.footer.osm"), attrs: { href: OSM_COPYRIGHT, rel: "noopener" } })]));
}

function setLanguage(lang) {
  const credit = (t) => t("site.footer.osm");
  if (state.map) state.map.attributionControl.removeAttribution(credit(state.t));
  state.lang = lang;
  state.t = makeT(state.data.strings, lang);
  if (state.map) state.map.attributionControl.addAttribution(credit(state.t));
  rememberLanguage(lang);
  document.documentElement.lang = lang;
  document.title = state.t("site.title");
  applyTo(document, state.t);
  for (const button of $("langs").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
  fillMaterials();
  fillFilters();
  renderSummary();
  renderBrowse();
  renderLegend();
  renderFooter();
  drawSection();
  renderResults();
  renderCard();
}

// ---------------------------------------------------------------- start

export async function init() {
  const status = $("status"), boot = $("boot");
  let strings;
  try {
    strings = await get("strings.json");
  } catch (error) {
    throw error;                       // the static line stays: it is the only wording there is
  }
  if (boot) boot.remove();
  const t = makeT(strings, savedLanguage());
  status.textContent = t("site.loading");
  try {
    state.data = await load(strings);
  } catch (error) {
    status.textContent = t("site.loadfail");
    status.title = String(error);
    throw error;
  }
  $("layout").hidden = false;          // the map needs its real size before it is drawn
  buildMap();
  state.browse = { list: state.data.quarries, withoutStrength: 0, shown: Math.min(state.data.meta.results_shown, state.data.quarries.length) };
  setLanguage(savedLanguage());
  for (const id of ["start-lat", "start-lon", "end-lat", "end-lon"]) $(id).addEventListener("input", readFields);
  $("find").addEventListener("click", find);
  $("more").addEventListener("click", () => { state.shown = Math.min(state.shown + state.data.meta.results_shown, state.results.length); renderResults(); });
  $("export").addEventListener("click", exportExcel);
  for (const id of ["f-region", "f-group", "f-lab"]) $(id).addEventListener("change", applyFilters);
  $("f-strength").addEventListener("input", applyFilters);
  $("browse-more").addEventListener("click", () => { state.browse.shown = Math.min(state.browse.shown + state.data.meta.results_shown, state.browse.list.length); renderBrowse(); });
  $("browse-export").addEventListener("click", exportBrowse);
  $("print").addEventListener("click", () => window.print());
  for (const button of $("langs").querySelectorAll("button")) button.addEventListener("click", () => setLanguage(button.dataset.lang));
  status.textContent = "";
  state.map.invalidateSize();
  return state;
}

export const ready = init();
