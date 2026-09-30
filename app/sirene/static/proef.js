/* Buurtradar – proefversie van de kaart met MapLibre GL JS.
 *
 * Zelfde gegevens (dezelfde /api/...-endpoints) als de huidige kaart, maar getekend als
 * vectorkaart door de videokaart: vloeiend zoomen, draaien en kantelen, scherpe tekst, en een
 * donkere kaart die met je systeem meeschakelt. Nog zonder het inhoudspaneel rechts.
 */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privémodus */ } },
};

const NL_CENTER = [5.3, 52.2];
const MIN_ZOOM = { parking: 13, statiegeld: 12, shops: 13, roadworks: 12, cams: 10 };
const NAMES = { parking: "parkeerzones", statiegeld: "statiegeldpunten", shops: "winkels", roadworks: "wegwerk", cams: "flitsers" };
const LABEL_ZOOM = 16;
const RW_COLORS = { closed: "#dc2626", hinder: "#ea580c", event: "#7c3aed" };
const SH_RING = { open: "#16a34a", closed: "#9ca3af", unknown: "#d1d5db" };
const SH_ICON = { supermarkt: "shopping-cart", buurtwinkel: "store", markt: "shopping-basket" };
const SG_FILL = { open: "#15803d", closed: "#9ca3af", unknown: "#ffffff" };

let cfg = null;
let me = null;
const on = {};
const data = { parking: [], shops: [], statiegeld: [], roadworks: [], cams: [] };
const byId = { parking: new Map(), pois: new Map(), roadworks: new Map(), cams: new Map() };
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

async function api(path, options) {
  const r = await fetch(path, options);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

// ---------- iconen: Lucide-symbolen uit icons.svg, als afbeelding voor MapLibre ----------

let SYMBOLS = {};
async function loadSymbols() {
  const txt = await (await fetch("/static/icons.svg")).text();
  const doc = new DOMParser().parseFromString(txt, "image/svg+xml");
  for (const s of doc.querySelectorAll("symbol")) SYMBOLS[s.id] = s.innerHTML;
}

function glyph(name, x, y, size, stroke, width = 2.2) {
  const k = size / 24;
  return `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="${stroke}" stroke-width="${width}"
    stroke-linecap="round" stroke-linejoin="round">${SYMBOLS[name] || ""}</g>`;
}

function roundIcon(name, ring, { badge = false, fill = "#fff", fg = "#1f2937" } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">
    <circle cx="26" cy="30" r="19" fill="${fill}" stroke="${ring}" stroke-width="5"/>
    ${glyph(name, 15, 19, 22, fg)}
    ${badge ? `<circle cx="44" cy="12" r="10" fill="#15803d" stroke="#fff" stroke-width="2.5"/>${glyph("recycle", 36.5, 4.5, 15, "#fff", 2.8)}` : ""}
  </svg>`;
}

function sgIcon(state) {
  const fill = SG_FILL[state];
  const fg = state === "unknown" ? "#6b7280" : "#fff";
  const stroke = state === "unknown" ? "#9ca3af" : "#fff";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">
    <rect x="8" y="12" width="40" height="40" rx="11" fill="${fill}" stroke="${stroke}" stroke-width="4"/>
    ${glyph("recycle", 16, 20, 24, fg, 2.6)}
  </svg>`;
}

function addSvgImage(map, id, svg) {
  return new Promise((resolve) => {
    if (map.hasImage(id)) return resolve();
    const img = new Image(56, 56);
    img.onload = () => { if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 }); resolve(); };
    img.onerror = resolve;
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

async function addImages(map) {
  const jobs = [];
  for (const kind of Object.keys(SH_ICON)) {
    for (const st of Object.keys(SH_RING)) {
      jobs.push(addSvgImage(map, `shop-${kind}-${st}`, roundIcon(SH_ICON[kind], SH_RING[st])));
      jobs.push(addSvgImage(map, `shop-${kind}-${st}-sg`, roundIcon(SH_ICON[kind], SH_RING[st], { badge: true })));
    }
  }
  for (const st of Object.keys(SG_FILL)) jobs.push(addSvgImage(map, `sg-${st}`, sgIcon(st)));
  jobs.push(addSvgImage(map, "cam-flitser", roundIcon("camera", "#dc2626")));
  jobs.push(addSvgImage(map, "cam-roodlicht", roundIcon("camera", "#111", { fill: "#fde047" })));
  jobs.push(addSvgImage(map, "cam-traject", roundIcon("radar", "#7c3aed")));
  jobs.push(addSvgImage(map, "cam-blank", `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">
    <circle cx="26" cy="30" r="19" fill="#fff" stroke="#dc2626" stroke-width="5"/></svg>`));
  for (const [tone, color] of Object.entries(RW_COLORS)) {
    jobs.push(addSvgImage(map, `rw-${tone}`, roundIcon(tone === "event" ? "party-popper" : "construction", "#fff", { fill: color, fg: "#fff" })));
  }
  jobs.push(addSvgImage(map, "rw-planned", roundIcon("construction", "#fff", { fill: "#9ca3af", fg: "#fff" })));
  await Promise.all(jobs);
}

// ---------- kaart ----------

function styleUrl() {
  return darkQuery.matches ? cfg.map.vector_style_dark : cfg.map.vector_style_light;
}

let map;

function firstLabelLayer() {
  // Vlakken en lijnen onder de straatnamen van de ondergrond tekenen, zodat die leesbaar blijven.
  return map.getStyle().layers.find((l) => l.type === "symbol")?.id;
}

function addOverlays() {
  const empty = { type: "FeatureCollection", features: [] };
  for (const id of ["parking", "roadworks", "pois", "cams", "me"]) {
    if (!map.getSource(id)) map.addSource(id, { type: "geojson", data: empty });
  }
  const below = firstLabelLayer();
  const polygon = ["==", ["geometry-type"], "Polygon"];
  // Parkeren: vlak in tariefkleur; nu betalen stevig, nu gratis licht en gestippeld; jouw zone dik.
  map.addLayer({ id: "pk-fill", type: "fill", source: "parking", filter: polygon, paint: {
    "fill-color": ["get", "color"],
    "fill-opacity": ["case", ["get", "permit"], 0.05, ["get", "paid"], 0.24, 0.1],
  } }, below);
  map.addLayer({ id: "pk-line", type: "line", source: "parking", filter: ["all", polygon, ["get", "paid"]], paint: {
    "line-color": ["get", "color"], "line-width": ["case", ["get", "mine"], 4, 2], "line-opacity": 0.9,
  } }, below);
  map.addLayer({ id: "pk-line-quiet", type: "line", source: "parking", filter: ["all", polygon, ["!", ["get", "paid"]]], paint: {
    "line-color": ["get", "color"], "line-width": ["case", ["get", "mine"], 4, 1.5], "line-opacity": 0.9,
    "line-dasharray": [3, 2],
  } }, below);
  map.addLayer({ id: "pk-meters", type: "circle", source: "parking", filter: ["get", "meter"], paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 3, 17, 6],
    "circle-color": ["get", "color"], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5,
  } });
  map.addLayer({ id: "pk-garage", type: "circle", source: "parking", filter: ["get", "garage"], paint: {
    "circle-radius": 9, "circle-color": "#2563eb", "circle-stroke-color": "#fff", "circle-stroke-width": 2,
  } });
  map.addLayer({ id: "pk-garage-p", type: "symbol", source: "parking", filter: ["get", "garage"], layout: {
    "text-field": "P", "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true,
  }, paint: { "text-color": "#fff" } });
  // Wegwerk: afgesloten wegdelen als lijn, met een icoon op het werk.
  map.addLayer({ id: "rw-line", type: "line", source: "roadworks", filter: ["all", ["==", ["geometry-type"], "LineString"], ["get", "active"]],
    layout: { "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": 5, "line-opacity": 0.85 } }, below);
  map.addLayer({ id: "rw-line-planned", type: "line", source: "roadworks", filter: ["all", ["==", ["geometry-type"], "LineString"], ["!", ["get", "active"]]],
    paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": 0.5, "line-dasharray": [2, 2] } }, below);
  map.addLayer({ id: "rw-icon", type: "symbol", source: "roadworks", filter: ["==", ["geometry-type"], "Point"], layout: {
    "icon-image": ["get", "icon"], "icon-allow-overlap": true, "icon-anchor": "center",
  } });
  // Flitsers: trajecten als paarse lijn, icoon met maximumsnelheid.
  map.addLayer({ id: "cam-line", type: "line", source: "cams", filter: ["==", ["geometry-type"], "LineString"],
    paint: { "line-color": "#7c3aed", "line-width": 5, "line-opacity": 0.6 } }, below);
  map.addLayer({ id: "cam-icon", type: "symbol", source: "cams", filter: ["==", ["geometry-type"], "Point"], layout: {
    "icon-image": ["get", "icon"], "icon-allow-overlap": true,
    "text-field": ["get", "speed"], "text-font": ["Noto Sans Bold"], "text-size": 11, "text-allow-overlap": true,
    "text-offset": [-0.2, 0.25],
  }, paint: { "text-color": "#111" } });
  // Winkels en statiegeld: één icoon per winkel (met statiegeldteken), uit elkaar gezet als ze
  // op het scherm over elkaar vallen; vanaf zoom 16 de naam eronder.
  map.addLayer({ id: "poi", type: "symbol", source: "pois", layout: {
    "icon-image": ["get", "icon"], "icon-allow-overlap": true, "icon-offset": ["get", "off"],
    "symbol-sort-key": ["get", "rank"],
    "text-field": ["step", ["zoom"], "", LABEL_ZOOM, ["get", "label"]],
    "text-font": ["Noto Sans Bold"], "text-size": 11, "text-anchor": "top",
    "text-offset": ["get", "textOff"], "text-optional": true,
  }, paint: {
    "text-color": darkQuery.matches ? "#f9fafb" : "#111827",
    "text-halo-color": darkQuery.matches ? "#111827" : "#ffffff", "text-halo-width": 1.5,
  } });
  // Jij.
  map.addLayer({ id: "me-halo", type: "circle", source: "me", paint: {
    "circle-radius": 14, "circle-color": "#0ea5e9", "circle-opacity": 0.2 } });
  map.addLayer({ id: "me", type: "circle", source: "me", paint: {
    "circle-radius": 7, "circle-color": "#0ea5e9", "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
}

function setData(id, features) {
  map.getSource(id)?.setData({ type: "FeatureCollection", features });
}

// ---------- parkeren ----------

function renderParking() {
  byId.parking = new Map();
  const here = new Set((data.parkingHere || []).map((z) => z.id));
  const features = [];
  for (const zone of on.parking && map.getZoom() >= MIN_ZOOM.parking ? data.parking : []) {
    if (zone.kind === "vergunning") continue;
    byId.parking.set(zone.id, zone);
    const st = Parking.status(zone);
    const props = { id: zone.id, color: Parking.zoneColor(zone), paid: st.state === "paid" || st.state === "disc",
      permit: zone.kind === "vergunning", mine: here.has(zone.id) };
    const g = zone.geometry;
    if (g.type === "Point") {
      features.push({ type: "Feature", geometry: g, properties: { ...props, garage: true } });
    } else if (g.type === "MultiPoint") {
      for (const c of g.coordinates) features.push({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: { ...props, meter: true } });
    } else {
      features.push({ type: "Feature", geometry: g, properties: props });
    }
  }
  setData("parking", features);
}

function parkingPopup(zone) {
  const st = Parking.status(zone);
  const rows = Parking.weekLines(zone).map((l) => `<tr><td>${esc(l.day)}</td><td>${esc(l.text)}</td></tr>`).join("");
  return `<b>${esc(zone.name)}</b><br>${esc(Parking.KIND_LABEL[zone.kind])} · ${esc(zone.manager)}<br>
    <span class="pk-status" style="--c:${Parking.zoneColor(zone)}">${esc(st.text)}</span>
    <table class="pk-week">${rows}</table>
    ${zone.approx === "automaten" ? '<div class="pk-note">Zonegrens niet bekend bij de RDW: de stippen zijn de parkeerautomaten.</div>' : ""}
    <div class="pk-note">Bron: RDW/NPR. Borden ter plaatse gaan altijd voor.</div>`;
}

// ---------- winkels en statiegeld ----------

function spreadOffsets(points, minPx = 24) {
  const pts = points.map((p) => map.project([p.lon, p.lat]));
  const group = new Array(points.length).fill(-1);
  const offsets = points.map(() => [0, 0]);
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    if (group[i] >= 0) continue;
    const g = [i];
    group[i] = n;
    for (let k = 0; k < g.length; k++) {
      for (let j = 0; j < pts.length; j++) {
        if (group[j] < 0 && Math.hypot(pts[j].x - pts[g[k]].x, pts[j].y - pts[g[k]].y) < minPx) { group[j] = n; g.push(j); }
      }
    }
    n++;
    if (g.length < 2) continue;
    const cx = g.reduce((t, i2) => t + pts[i2].x, 0) / g.length;
    const cy = g.reduce((t, i2) => t + pts[i2].y, 0) / g.length;
    const r = Math.max(minPx * 0.75, (minPx * g.length) / (2 * Math.PI));
    g.forEach((i2, k) => {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / g.length;
      offsets[i2] = [cx + r * Math.cos(a) - pts[i2].x, cy + r * Math.sin(a) - pts[i2].y];
    });
  }
  return offsets;
}

function renderPois() {
  byId.pois = new Map();
  const z = map.getZoom();
  const shops = on.shops && z >= MIN_ZOOM.shops ? data.shops : [];
  const sg = on.statiegeld && z >= MIN_ZOOM.statiegeld ? data.statiegeld : [];
  const sgById = new Map(sg.map((p) => [p.id, p]));
  const merged = new Set();
  const items = [];
  for (const shop of shops) {
    const point = shop.statiegeld && sgById.get(shop.statiegeld);
    if (point) merged.add(point.id);
    const st = OpeningHours.status(shop.hours).state;
    items.push({ key: `sh:${shop.id}`, lat: shop.lat, lon: shop.lon, obj: shop, sg: point || null,
      icon: `shop-${shop.kind}-${st}${point ? "-sg" : ""}`, label: shop.brand || shop.name, rank: shop.kind === "supermarkt" ? 2 : 1 });
  }
  for (const p of sg) {
    if (merged.has(p.id)) continue;
    const st = OpeningHours.status(p.hours).state;
    items.push({ key: `sg:${p.id}`, lat: p.lat, lon: p.lon, obj: p, icon: `sg-${st}`, label: p.name, rank: 0 });
  }
  // Tijdens draaien/kantelen niet herberekenen; bij stilstand (moveend) wel.
  const offsets = spreadOffsets(items);
  setData("pois", items.map((it, i) => {
    byId.pois.set(it.key, it);
    const [dx, dy] = offsets[i];
    return { type: "Feature", geometry: { type: "Point", coordinates: [it.lon, it.lat] }, properties: {
      key: it.key, icon: it.icon, label: it.label.length > 18 ? `${it.label.slice(0, 17)}…` : it.label, rank: it.rank,
      off: [dx, dy],  // icon-offset in schermpixels (x icon-size 1)
      textOff: [dx / 11, (dy + 14) / 11],  // text-offset in em (tekstgrootte 11)
    } };
  }));
}

function statusLine(hours) {
  const st = OpeningHours.status(hours);
  const color = st.state === "open" ? "#15803d" : st.state === "closed" ? "#dc2626" : "#6b7280";
  return `<span style="color:${color};font-weight:600">${esc(st.text)}</span>`;
}

function poiPopup(it) {
  const o = it.obj;
  if (it.key.startsWith("sg:")) {
    return `<b>${esc(o.name)}</b><br>${esc(o.address)}<br>${statusLine(o.hours)}
      ${o.materials?.length ? `<div><small>Neemt in: ${esc(o.materials.join(", "))}</small></div>` : ""}`;
  }
  const sg = it.sg ? `<div class="sg-in-shop"><b>♻ Statiegeld inleveren</b><br>${statusLine(it.sg.hours)}
      ${it.sg.materials?.length ? `<div><small>Neemt in: ${esc(it.sg.materials.join(", "))}</small></div>` : ""}</div>` : "";
  return `<b>${esc(o.name)}</b><br>${esc(o.address || "")}<br>${statusLine(o.hours)}${sg}`;
}

// ---------- wegwerk ----------

function renderRoadworks() {
  byId.roadworks = new Map();
  const now = Date.now() / 1000;
  const features = [];
  for (const w of on.roadworks && map.getZoom() >= MIN_ZOOM.roadworks ? data.roadworks : []) {
    const active = (!w.start || w.start <= now) && (!w.end || w.end >= now);
    const tone = w.kind === "evenement" ? "event" : w.closed ? "closed" : "hinder";
    byId.roadworks.set(w.id, w);
    const props = { id: w.id, color: RW_COLORS[tone], active, icon: active ? `rw-${tone}` : "rw-planned" };
    for (const line of w.lines) {
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line.map(([la, lo]) => [lo, la]) }, properties: props });
    }
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [w.lon, w.lat] }, properties: props });
  }
  setData("roadworks", features);
}

function roadworkPopup(w) {
  const when = (ts) => new Date(ts * 1000).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const impact = w.warnings[0] || (w.closed ? "Weg dicht" : "Hinder");
  return `<b>${esc(w.street || w.note || w.cause || "Wegwerk")}</b><br>
    <span style="color:${w.closed ? "#dc2626" : "#c2410c"};font-weight:600">${esc(impact)}${w.detour ? " · omleiding" : ""}</span><br>
    <small>${w.start ? esc(when(w.start)) : ""} – ${w.end ? esc(when(w.end)) : "onbekend"}</small>
    ${w.cause ? `<div>${esc(w.cause)}</div>` : ""}<div><small>${esc(w.source)}</small></div>`;
}

// ---------- flitsers ----------

function renderCams() {
  byId.cams = new Map();
  const features = [];
  if (on.cams && map.getZoom() >= MIN_ZOOM.cams) {
    const b = map.getBounds();
    for (const cam of data.cams) {
      const inView = b.contains([cam.lon, cam.lat]) || (cam.geometry || []).some((l) => l.some(([la, lo]) => b.contains([lo, la])));
      if (!inView) continue;
      byId.cams.set(String(cam.osm_id), cam);
      const props = { id: String(cam.osm_id) };
      if (cam.kind === "traject") {
        for (const line of cam.geometry || []) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: line.map(([la, lo]) => [lo, la]) }, properties: props });
      }
      const speed = cam.kind === "flitser" && cam.maxspeed ? String(cam.maxspeed) : "";
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [cam.lon, cam.lat] },
        properties: { ...props, speed, icon: speed ? "cam-blank" : `cam-${cam.kind}` } });
    }
  }
  setData("cams", features);
}

function camPopup(cam) {
  const kind = { flitser: "Vaste flitser", roodlicht: "Roodlichtcamera", traject: "Trajectcontrole" }[cam.kind];
  return `<b>${esc(kind)}</b>${cam.name ? `<br>${esc(cam.name)}` : ""}${cam.maxspeed ? `<br>Max. ${esc(cam.maxspeed)} km/u` : ""}`;
}

// ---------- laden ----------

function bboxParam(maxDeg) {
  const b = map.getBounds();
  const w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
  if (e - w > maxDeg || n - s > maxDeg) return null;
  return [w, s, e, n].map((v) => v.toFixed(5)).join(",");
}

let loadSeq = 0;
async function loadVisible() {
  const seq = ++loadSeq;
  const z = map.getZoom();
  const jobs = [];
  const want = (layer) => on[layer] && z >= MIN_ZOOM[layer];
  if (want("parking")) {
    const bb = bboxParam(0.5);
    if (bb) jobs.push(api(`/api/parking?bbox=${bb}&kinds=betaald,blauw,garage`).then((d) => { data.parking = d; }));
  }
  if (want("shops")) {
    const bb = bboxParam(1);
    if (bb) jobs.push(api(`/api/shops?bbox=${bb}`).then((d) => { data.shops = d; }));
  }
  if (want("statiegeld")) {
    const bb = bboxParam(1.5);
    if (bb) jobs.push(api(`/api/statiegeld?bbox=${bb}`).then((d) => { data.statiegeld = d; }));
  }
  if (want("roadworks")) {
    const bb = bboxParam(1);
    if (bb) jobs.push(api(`/api/roadworks?bbox=${bb}&planned=true`).then((d) => { data.roadworks = d; }));
  }
  await Promise.allSettled(jobs);
  if (seq !== loadSeq) return;  // intussen verder geschoven
  renderAll();
}

function renderAll() {
  if (!map.getSource("parking")) return;
  renderParking();
  renderPois();
  renderRoadworks();
  renderCams();
  renderMe();
  renderZoomHint();
}

function renderMe() {
  setData("me", me ? [{ type: "Feature", geometry: { type: "Point", coordinates: [me.lon, me.lat] }, properties: {} }] : []);
}

function renderZoomHint() {
  const z = map.getZoom();
  const hidden = Object.keys(MIN_ZOOM).filter((l) => on[l] && z < MIN_ZOOM[l]);
  $("zoom-hint").hidden = !hidden.length;
  if (!hidden.length) return;
  const names = hidden.map((l) => NAMES[l]);
  $("zoom-hint-text").textContent = `Zoom in om ${names.length > 1 ? `${names.slice(0, -1).join(", ")} en ${names.at(-1)}` : names[0]} te zien`;
  $("zoom-hint-btn").onclick = () => map.easeTo({ zoom: Math.min(...hidden.map((l) => MIN_ZOOM[l])) });
}

// ---------- klikken ----------

function popupAt(lngLat, html) {
  new maplibregl.Popup({ maxWidth: "300px", offset: 14 }).setLngLat(lngLat).setHTML(html).addTo(map);
}

function wireClicks() {
  const handlers = [
    [["poi"], (f) => { const it = byId.pois.get(f.properties.key); return it && [[it.lon, it.lat], poiPopup(it)]; }],
    [["cam-icon", "cam-line"], (f, e) => { const c = byId.cams.get(f.properties.id); return c && [e.lngLat, camPopup(c)]; }],
    [["rw-icon", "rw-line", "rw-line-planned"], (f, e) => { const w = byId.roadworks.get(f.properties.id); return w && [e.lngLat, roadworkPopup(w)]; }],
    [["pk-garage", "pk-meters", "pk-fill"], (f, e) => { const z = byId.parking.get(f.properties.id); return z && [e.lngLat, parkingPopup(z)]; }],
  ];
  map.on("click", (e) => {
    // Bovenste laag eerst: een winkel binnen een parkeerzone opent de winkel, niet de zone.
    for (const [layers, fn] of handlers) {
      const f = map.queryRenderedFeatures(e.point, { layers: layers.filter((l) => map.getLayer(l)) })[0];
      const res = f && fn(f, e);
      if (res) { popupAt(res[0], res[1]); return; }
    }
  });
  for (const id of ["poi", "cam-icon", "rw-icon", "pk-garage", "pk-meters", "pk-fill", "rw-line"]) {
    map.on("mouseenter", id, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", id, () => { map.getCanvas().style.cursor = ""; });
  }
}

// ---------- start ----------

function initLayers() {
  let saved = {};
  try { saved = JSON.parse(store.get("proefLayers") || "{}"); } catch { /* leeg */ }
  document.querySelectorAll("[data-layer]").forEach((el) => {
    const layer = el.dataset.layer;
    if (saved[layer] != null) el.checked = saved[layer];
    on[layer] = el.checked;
    el.addEventListener("change", () => {
      on[layer] = el.checked;
      store.set("proefLayers", JSON.stringify(on));
      if (el.checked && map.getZoom() < MIN_ZOOM[layer]) map.easeTo({ zoom: MIN_ZOOM[layer] });
      loadVisible();
    });
  });
  const toggle = $("layers-toggle");
  const setOpen = (open) => { $("layers").classList.toggle("collapsed", !open); toggle.setAttribute("aria-expanded", String(open)); };
  setOpen(store.get("proefLayersOpen") !== "0" && !window.matchMedia("(max-width: 720px)").matches);
  toggle.addEventListener("click", () => {
    const open = $("layers").classList.contains("collapsed");
    setOpen(open);
    store.set("proefLayersOpen", open ? "1" : "0");
  });
}

let lastSent = 0;
async function init() {
  [cfg, me] = await Promise.all([api("/api/config"), api("/api/location")]);
  await loadSymbols();
  initLayers();
  map = new maplibregl.Map({
    container: "map",
    style: styleUrl(),
    center: me ? [me.lon, me.lat] : NL_CENTER,
    zoom: me ? 15 : 7,
    attributionControl: { compact: true },
    maxPitch: 60,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-left");
  const geo = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserHeading: true,
  });
  map.addControl(geo, "bottom-left");
  geo.on("geolocate", (pos) => {
    // Zelfde locatie als de gewone kaart: doorgeven aan de server (hooguit elke 10 s).
    if (Date.now() - lastSent < 10000) return;
    lastSent = Date.now();
    api("/api/location", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }) }).catch(() => {});
  });
  // Na elke (nieuwe) stijl, bijv. bij wisselen naar donker, de eigen lagen opnieuw toevoegen.
  map.on("style.load", async () => {
    await addImages(map);
    addOverlays();
    renderAll();
    // Meteen gegevens laden, ook als de ondergrond (tegels) nog laadt of niet bereikbaar is.
    loadVisible();
  });
  map.on("moveend", () => { loadVisible(); renderPois(); });
  darkQuery.addEventListener("change", () => map.setStyle(styleUrl()));
  wireClicks();
  if (me) data.parkingHere = await api(`/api/parking/at?lat=${me.lat}&lon=${me.lon}`).catch(() => []);
  if (cfg.speedcams_enabled) api("/api/speedcams").then((d) => { data.cams = d; renderCams(); }).catch(() => {});
  const es = new EventSource("/api/events");
  es.addEventListener("location", async (e) => {
    me = JSON.parse(e.data);
    data.parkingHere = await api(`/api/parking/at?lat=${me.lat}&lon=${me.lon}`).catch(() => []);
    renderMe();
    renderParking();
  });
  // Open/dicht en betaald/gratis veranderen met de tijd.
  setInterval(() => { renderParking(); renderPois(); renderRoadworks(); }, 60000);
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<p class="proef-error">Kan de kaart niet laden: ${esc(err.message)}</p>`);
});
