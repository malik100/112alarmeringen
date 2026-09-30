/* Buurtradar – live kaart van wat er in je buurt gebeurt: 112-meldingen, flitsers, parkeren, laden en meer. */
"use strict";

const NL_CENTER = [52.2, 5.3];
const CAM_MIN_ZOOM = 10;
const LOCATION_STALE_S = 30 * 60;
const OLD_INCIDENT_S = 60 * 60;
const LABEL = { brandweer: "Brandweer", ambulance: "Ambulance", politie: "Politie", onbekend: "Overig" };
const LETTER = { brandweer: "B", ambulance: "A", politie: "P", onbekend: "?" };
const PRECISION_TEXT = {
  postcode: "locatie op postcode/adres",
  straat: "locatie ≈ midden van de straat",
  plaats: "locatie ≈ midden van de plaats",
};

const state = {
  config: null,
  location: null,
  home: null,
  incidents: new Map(),
  cams: [],
  windowMin: 120,
  disciplines: new Set(["brandweer", "ambulance", "politie", "onbekend"]),
  camKinds: new Set(["flitser", "roodlicht", "traject"]),
  onlySirene: false,
  alerted: new Set(),
  tab: "overzicht",
  navApp: "auto",
  showIncidents: true,
  showCams: true,
  sg: { points: [], near: [], show: true, onlyOpen: false, nearFrom: null },
  pk: { show: true, zones: [], here: [], kinds: new Set(["betaald", "blauw", "garage"]), hereFrom: null },
  sh: { show: false, points: [], near: [], kinds: new Set(["supermarkt", "buurtwinkel", "markt"]),
        onlyOpen: false, lateOnly: false, nearFrom: null },
  rw: { show: false, planned: false, onlyClosed: false, items: [], near: [], nearFrom: null, showAll: false },
  nw: { show: true, items: [], showAll: false, place: null, from: null, loading: false },
  // Standaard wat je merkt op straat (verkeer, evenementen); bouw en vergunningen zijn een optie.
  bk: { show: false, focus: null, items: [], cats: new Set(["verkeer", "evenementen"]), important: true,
        sort: "relevant", showAll: false },
  fu: { show: false, shops: new Set(["ja", "nee", "onbekend"]), onlyOpen: false, points: [], near: [], nearFrom: null },
  ch: { show: false, profile: "snel", custom: null, stations: [], near: [], statusTs: null, nearFrom: null },
  ov: { show: false, parts: new Set(["stops", "lines", "vehicles"]),
        modes: new Set(["trein", "metro", "tram", "bus", "veer"]), haltes: [], lines: [], vehicles: [],
        near: [], nearFrom: null, nearTs: 0, realtimeTs: null, haltesArea: null, linesArea: null,
        linesKey: null, linesZoom: null, vehiclesArea: null },
};

const $ = (id) => document.getElementById(id);

/** Lucide-icoon uit /static/icons.svg (als HTML-tekst). */
function icon(name, cls = "") {
  return `<svg class="i${cls ? ` ${cls}` : ""}" aria-hidden="true"><use href="/static/icons.svg#${name}"/></svg>`;
}

/** Lucide-icoon als DOM-element. */
function iconEl(name, cls = "") {
  const t = document.createElement("template");
  t.innerHTML = icon(name, cls);
  return t.content.firstChild;
}
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* privémodus */ } },
};

// ---------- hulpfuncties ----------

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function haversine(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

const nlNumber = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1 });
function fmtDistance(m) {
  if (m == null) return "";
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${nlNumber.format(m < 10000 ? Math.round(m / 100) / 10 : Math.round(m / 1000))} km`;
}

const rtf = new Intl.RelativeTimeFormat("nl", { numeric: "auto" });
function fmtAgo(ts) {
  const s = Math.round(Date.now() / 1000 - ts);
  if (s < 60) return "zojuist";
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86400), "day");
}

function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
}

function distanceTo(inc) {
  if (!state.location || inc.lat == null) return null;
  return haversine(state.location.lat, state.location.lon, inc.lat, inc.lon);
}

function isVisible(inc) {
  if (!state.disciplines.has(inc.discipline)) return false;
  if (state.onlySirene && !inc.sirene) return false;
  return inc.ts >= Date.now() / 1000 - state.windowMin * 60;
}

async function api(path, options) {
  const resp = await fetch(path, options);
  if (!resp.ok) throw new Error(`${path}: ${resp.status}`);
  return resp.json();
}

// ---------- kaart ----------

// Popups niet onder de bovenbalk of (op een telefoon) het paneel onderaan laten vallen.
L.Popup.mergeOptions({
  autoPanPaddingTopLeft: L.point(16, 110),
  autoPanPaddingBottomRight: L.point(16, window.matchMedia("(max-width: 720px)").matches ? 110 : 16),
});
const map = L.map("map", { zoomControl: false, attributionControl: true }).setView(NL_CENTER, 8);
// Op een touchscreen zoom je met twee vingers; de knoppen zijn daar overbodig.
if (!window.matchMedia("(pointer: coarse)").matches) L.control.zoom({ position: "bottomleft" }).addTo(map);
const incidentLayer = L.layerGroup().addTo(map);
const camLayer = L.layerGroup().addTo(map);
const sgLayer = L.layerGroup().addTo(map);
const sgMarkers = new Map();
map.createPane("parking").style.zIndex = 350; // onder markers en popups
const pkLayer = L.layerGroup().addTo(map);
const pkShapes = new Map();
const shLayer = L.layerGroup().addTo(map);
const shMarkers = new Map();
const chLayer = L.layerGroup().addTo(map);
const chMarkers = new Map();
const meLayer = L.layerGroup().addTo(map);
const markers = new Map();

/** Id van de marker met een open popup, zodat die na hertekenen weer open kan. */
function openPopupId(markerMap) {
  for (const [id, marker] of markerMap) if (marker.isPopupOpen()) return id;
  return null;
}

/**
 * Markers die op het scherm over elkaar vallen een stukje uit elkaar zetten.
 * Geeft per item een verschuiving [dx, dy] in pixels; de echte plek (lat/lon) blijft gelijk.
 * Zo verdwijnt bijv. een Albert Heijn niet onder de Vomar die 40 meter verderop zit.
 */
function spreadOffsets(items, minPx = 22) {
  const pts = items.map((it) => map.latLngToLayerPoint([it.lat, it.lon]));
  const order = pts.map((_, i) => i).sort((a, b) => pts[a].x - pts[b].x);
  const group = new Array(items.length).fill(-1);
  const groups = [];
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    if (group[i] >= 0) continue;
    const g = [i];
    group[i] = groups.length;
    // Uitbreiden zolang er een nieuw punt dicht bij een lid van de groep ligt.
    for (let k = 0; k < g.length; k++) {
      const pk = pts[g[k]];
      for (let oj = 0; oj < order.length; oj++) {
        const j = order[oj];
        if (pts[j].x - pk.x > minPx) break;
        if (group[j] < 0 && Math.abs(pts[j].x - pk.x) < minPx && pk.distanceTo(pts[j]) < minPx) {
          group[j] = groups.length;
          g.push(j);
        }
      }
    }
    groups.push(g);
  }
  const offsets = items.map(() => [0, 0]);
  for (const g of groups) {
    if (g.length < 2) continue;
    const cx = g.reduce((t, i) => t + pts[i].x, 0) / g.length;
    const cy = g.reduce((t, i) => t + pts[i].y, 0) / g.length;
    const r = Math.max(minPx * 0.75, (minPx * g.length) / (2 * Math.PI));
    g.forEach((i, k) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * k) / g.length;
      offsets[i] = [cx + r * Math.cos(angle) - pts[i].x, cy + r * Math.sin(angle) - pts[i].y];
    });
  }
  return offsets;
}

const LABEL_ZOOM = 16;
function shortName(name) {
  return name.length > 18 ? `${name.slice(0, 17).trimEnd()}…` : name;
}

/** Marker met (optioneel) verschoven icoon en, bij genoeg inzoomen, een naamlabel eronder. */
function spreadMarker(lat, lon, html, className, size, [dx, dy], label, zIndexOffset) {
  const half = size / 2;
  const marker = L.marker([lat, lon], {
    icon: L.divIcon({ className, html, iconSize: [size, size], iconAnchor: [half - dx, half - dy],
      popupAnchor: [dx, dy - half] }),
    keyboard: false, zIndexOffset,
  });
  if (label && map.getZoom() >= LABEL_ZOOM) {
    marker.bindTooltip(shortName(label), { permanent: true, direction: "bottom", offset: [dx, dy + half - 4],
      className: "map-label", interactive: false });
  }
  return marker;
}

function incidentIcon(inc) {
  const old = Date.now() / 1000 - inc.ts > OLD_INCIDENT_S;
  const cls = ["inc-dot", inc.discipline, inc.sirene && !old ? "sirene" : "",
    inc.precision === "plaats" ? "approx" : "", old ? "old" : ""].join(" ");
  const size = inc.sirene && !old ? 24 : 18;
  return L.divIcon({
    className: "inc-marker",
    html: `<div class="${cls}">${LETTER[inc.discipline] || "?"}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function incidentPopup(inc) {
  const d = distanceTo(inc);
  const prio = inc.priority == null ? "prio onbekend" : `prio ${inc.priority}`;
  return `
    <b>${esc(inc.description || inc.title)}</b><br>
    ${esc(LABEL[inc.discipline] || inc.discipline)} · ${inc.sirene ? '<span class="sirene-text">met sirene</span>' : esc(prio)}<br>
    ${esc(fmtTime(inc.ts))} (${esc(fmtAgo(inc.ts))})${d != null ? ` · ${esc(fmtDistance(d))} van jou` : ""}<br>
    <small>${esc(PRECISION_TEXT[inc.precision] || "locatie onbekend")}</small>
    <div class="popup-raw">${esc(inc.title)}</div>
    ${newsHtml(inc)}
    ${inc.link ? `<div class="popup-links"><a href="${esc(inc.link)}" target="_blank" rel="noopener noreferrer">Bron${icon("external-link")}</a></div>` : ""}`;
}

function newsDelay(inc, article) {
  const min = Math.round((article.ts - inc.ts) / 60);
  if (min < 0) return `${-min} min vóór de melding`;
  if (min < 60) return `${min} min na de melding`;
  return `${Math.round(min / 60)} uur na de melding`;
}

function newsHtml(inc) {
  if (!inc.news || !inc.news.length) return "";
  const items = inc.news.slice(0, 3).map((n) => `
    <li><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a><br>
      <small>${esc(n.source)} · ${esc(newsDelay(inc, n))} · ${esc(n.label)} gerelateerd</small></li>`).join("");
  return `<div class="news"><b>${icon("newspaper")}Nieuws</b><ul>${items}</ul></div>`;
}

function renderIncidents() {
  const reopen = openPopupId(markers);
  incidentLayer.clearLayers();
  markers.clear();
  if (!state.showIncidents) return;
  // Oudste eerst tekenen, zodat nieuwe incidenten bovenop liggen.
  const list = [...state.incidents.values()]
    .filter((i) => i.lat != null && isVisible(i))
    .sort((a, b) => a.ts - b.ts);
  for (const inc of list) {
    const marker = L.marker([inc.lat, inc.lon], {
      icon: incidentIcon(inc),
      zIndexOffset: inc.sirene ? 1000 : 0,
      keyboard: false,
    }).bindPopup(() => incidentPopup(inc));
    marker.addTo(incidentLayer);
    markers.set(inc.id, marker);
  }
  if (reopen != null) markers.get(reopen)?.openPopup();
}

function camIcon(cam) {
  const content = cam.kind === "traject" ? "T" : cam.kind === "flitser" && cam.maxspeed ? esc(cam.maxspeed) : icon("camera");
  return L.divIcon({
    className: "cam-marker",
    html: `<div class="cam-sign ${cam.kind}">${content}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function camPopup(cam) {
  const kind = { flitser: "Vaste flitser", roodlicht: "Roodlichtcamera", traject: "Trajectcontrole" }[cam.kind];
  return `<b>${esc(kind)}</b>${cam.name ? `<br>${esc(cam.name)}` : ""}` +
    `${cam.maxspeed ? `<br>Max. ${esc(cam.maxspeed)} km/u` : ""}` +
    `<div class="popup-raw">OSM ${esc(cam.osm_id)}</div>`;
}

function renderCams() {
  camLayer.clearLayers();
  if (!state.showCams || map.getZoom() < CAM_MIN_ZOOM) return;
  const bounds = map.getBounds().pad(0.2);
  for (const cam of state.cams) {
    if (!state.camKinds.has(cam.kind)) continue;
    const inView = bounds.contains([cam.lat, cam.lon]) ||
      (cam.geometry || []).some((line) => line.some((p) => bounds.contains(p)));
    if (!inView) continue;
    if (cam.kind === "traject" && cam.geometry) {
      for (const line of cam.geometry) {
        L.polyline(line, { color: "#7c3aed", weight: 5, opacity: 0.7 })
          .bindPopup(() => camPopup(cam)).addTo(camLayer);
      }
    }
    L.marker([cam.lat, cam.lon], { icon: camIcon(cam), keyboard: false })
      .bindPopup(() => camPopup(cam)).addTo(camLayer);
  }
}

function renderMe() {
  meLayer.clearLayers();
  const loc = state.location;
  if (!loc) return;
  const radius = state.config.radius_m;
  L.circle([loc.lat, loc.lon], {
    radius, color: "#0ea5e9", weight: 2, fillColor: "#0ea5e9", fillOpacity: 0.06, interactive: false,
  }).addTo(meLayer);
  if (loc.accuracy && loc.accuracy < radius) {
    L.circle([loc.lat, loc.lon], {
      radius: loc.accuracy, stroke: false, fillColor: "#0ea5e9", fillOpacity: 0.15, interactive: false,
    }).addTo(meLayer);
  }
  L.marker([loc.lat, loc.lon], {
    icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    zIndexOffset: 2000,
    keyboard: false,
  }).bindPopup(`<b>Jij</b><br>via ${esc(loc.source)} · ${esc(fmtAgo(loc.ts))}`).addTo(meLayer);
}

// ---------- paneel ----------

function listItem(inc, dist) {
  const li = document.createElement("li");
  li.className = `item ${inc.discipline}${Date.now() / 1000 - inc.ts > OLD_INCIDENT_S ? " old" : ""}`;
  li.tabIndex = 0;

  const bar = document.createElement("span");
  bar.className = "bar";
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = inc.description || inc.title;
  const distEl = document.createElement("span");
  distEl.className = "dist";
  distEl.textContent = dist != null ? fmtDistance(dist) : "";
  const meta = document.createElement("span");
  meta.className = "meta";
  if (inc.sirene) {
    const tag = document.createElement("span");
    tag.className = "tag sirene";
    tag.textContent = "SIRENE";
    meta.append(tag, " ");
  }
  if (inc.news && inc.news.length) {
    const tag = document.createElement("span");
    tag.className = "tag news";
    tag.textContent = "NIEUWS";
    tag.title = inc.news[0].title;
    meta.append(tag, " ");
  }
  meta.append(`${LABEL[inc.discipline] || inc.discipline} · ${fmtTime(inc.ts)} · ${fmtAgo(inc.ts)}` +
    (inc.precision === "plaats" ? " · locatie ≈ plaats" : "") +
    (inc.lat == null ? " · locatie onbekend" : ""));

  li.append(bar, what, distEl, meta);
  const open = () => {
    if (inc.lat == null) return;
    setLayer("incidents", true);
    map.setView([inc.lat, inc.lon], Math.max(map.getZoom(), 15));
    markers.get(inc.id)?.openPopup();
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function renderList() {
  const radius = state.config.radius_m;
  const visible = [...state.incidents.values()].filter(isVisible);
  const withDist = visible.map((inc) => ({ inc, d: distanceTo(inc) }));

  const near = withDist.filter((x) => x.d != null && x.d <= radius).sort((a, b) => a.d - b.d);
  const nearIds = new Set(near.map((x) => x.inc.id));
  const bounds = map.getBounds();
  const inView = withDist
    .filter((x) => !nearIds.has(x.inc.id) && x.inc.lat != null && bounds.contains([x.inc.lat, x.inc.lon]))
    .sort((a, b) => b.inc.ts - a.inc.ts)
    .slice(0, 50);

  $("near-title").textContent = state.location
    ? `Binnen ${fmtDistance(radius)} van jou`
    : "Binnen je straal";
  $("list-near").replaceChildren(...near.map((x) => listItem(x.inc, x.d)));
  $("empty-near").hidden = near.length > 0 || !state.location;
  $("list-view").replaceChildren(...inView.map((x) => listItem(x.inc, x.d)));
  $("empty-view").hidden = inView.length > 0;

  renderOverview();
}

function renderStatus(live) {
  if (live !== undefined) {
    $("st-live").className = `brand-dot ${live ? "ok" : "err"}`;
    $("st-live").title = live ? "Live verbonden" : "Verbinding met de server weg";
  }
  // Locatie alleen tonen als er iets aan de hand is.
  const loc = state.location;
  const locEl = $("st-loc");
  const age = loc ? Date.now() / 1000 - loc.ts : null;
  if (!loc) {
    locEl.textContent = "Geen locatie";
    locEl.className = "pill err";
  } else if (loc.source === "vast") {
    locEl.textContent = "Vaste locatie";
    locEl.className = "pill warn";
  } else if (age > LOCATION_STALE_S) {
    locEl.textContent = `Locatie ${fmtAgo(loc.ts)}`;
    locEl.className = "pill warn";
  }
  locEl.hidden = !!loc && loc.source !== "vast" && age <= LOCATION_STALE_S;
  const n = $("notify-state");
  if (n) n.textContent = state.config.notifications_enabled ? "Pushmeldingen staan aan." : "Pushmeldingen staan uit.";
}

function renderAll() {
  renderIncidents();
  renderList();
  renderMe();
  renderStatus();
}

const isPhone = () => window.matchMedia("(max-width: 720px)").matches;

/** Kaartlagen-paneel links in- of uitklappen. */
function setLayersPanel(open) {
  $("layers").classList.toggle("collapsed", !open);
  $("layers-toggle").setAttribute("aria-expanded", String(open));
}

function initLayersPanel() {
  // Desktop: standaard open; telefoon: standaard dicht (anders bedekt het de kaart).
  const saved = store.get(isPhone() ? "layersOpenPhone" : "layersOpen");
  setLayersPanel(saved != null ? saved === "1" : !isPhone());
  $("layers-toggle").addEventListener("click", () => {
    const open = $("layers").classList.contains("collapsed");
    setLayersPanel(open);
    store.set(isPhone() ? "layersOpenPhone" : "layersOpen", open ? "1" : "0");
  });
}

function setPanel(open) {
  $("panel").classList.toggle("collapsed", !open);
  $("panel-toggle").setAttribute("aria-expanded", String(open));
}

// In-page waarschuwing, los van (optionele) pushmeldingen.
function checkAlert(inc) {
  const d = distanceTo(inc);
  if (!inc.sirene || d == null || d > state.config.radius_m || state.alerted.has(inc.id)) return;
  if (Date.now() / 1000 - inc.ts > 15 * 60) return;
  state.alerted.add(inc.id);
  const el = $("alert");
  el.replaceChildren(iconEl("siren"),
    `${LABEL[inc.discipline] || "Hulpdienst"} met sirene op ${fmtDistance(d)}: ${inc.description || inc.title}`);
  el.hidden = false;
  el.onclick = () => {
    el.hidden = true;
    map.setView([inc.lat, inc.lon], 16);
    markers.get(inc.id)?.openPopup();
  };
  clearTimeout(checkAlert.timer);
  checkAlert.timer = setTimeout(() => { el.hidden = true; }, 60000);
}

// ---------- statiegeld ----------

const SG_STATE_CLASS = { open: "sg-open", closed: "sg-closed", unknown: "sg-unknown" };

function sgStatus(point) {
  return OpeningHours.status(point.hours);
}

function sgVisible(point, st) {
  return !state.sg.onlyOpen || st.state === "open";
}

function sgPopup(point) {
  const st = sgStatus(point);
  const today = OpeningHours.amsterdamNow().day;
  const rows = OpeningHours.DAYS.map((day, i) => {
    const raw = point.hours_raw[i];
    const text = raw === "NA" ? "onbekend" : raw;
    return `<tr${i === today ? ' class="today"' : ""}><td>${esc(day)}</td><td>${esc(text)}</td></tr>`;
  }).join("");
  const d = state.location ? haversine(state.location.lat, state.location.lon, point.lat, point.lon) : null;
  const facts = [
    point.machine ? "automaat" : "",
    point.manual ? "inleveren aan de balie" : "",
    point.public ? "vrij toegankelijk" : "",
    point.bulk ? "grote hoeveelheden" : "",
  ].filter(Boolean);
  return `
    <b>${esc(point.name)}</b><br>
    ${esc(point.address)}${d != null ? ` · ${esc(fmtDistance(d))} · ${esc(Nav.eta(d))}` : ""}<br>
    <span class="${SG_STATE_CLASS[st.state]}">${esc(st.text)}</span>
    <table class="sg-hours">${rows}</table>
    ${point.materials.length ? `<div><small>Neemt in: ${esc(point.materials.join(", "))}</small></div>` : ""}
    ${point.payouts.length ? `<div><small>Uitbetaling: ${esc(point.payouts.join(", "))}</small></div>` : ""}
    ${facts.length ? `<div><small>${esc(facts.join(" · "))}</small></div>` : ""}
    <div class="popup-links">${routeLink(point.lat, point.lon)}</div>`;
}

let sgPendingPopup = null;

function drawSg(layout) {
  const reopen = sgPendingPopup ?? openPopupId(sgMarkers);
  sgLayer.clearLayers();
  sgMarkers.clear();
  layout.sg.forEach(({ p: point, st }, i) => {
    const marker = spreadMarker(point.lat, point.lon, `<div class="sg-sign ${st.state}">${icon("recycle")}</div>`,
      "sg-marker", 22, layout.sgOff[i], layout.sgLabel[i] ? point.name : null, -500)
      .bindPopup(() => sgPopup(point), { maxWidth: 280 });
    marker.addTo(sgLayer);
    sgMarkers.set(point.id, marker);
  });
  if (reopen != null && sgMarkers.has(reopen)) {
    sgMarkers.get(reopen).openPopup();
    sgPendingPopup = null;
  }
}

function sgListItem(point, st, dist) {
  const li = document.createElement("li");
  li.className = "item statiegeld";
  li.tabIndex = 0;
  const bar = document.createElement("span");
  bar.className = `bar ${st.state}`;
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = point.name;
  const distEl = document.createElement("span");
  distEl.className = "dist";
  distEl.textContent = fmtDistance(dist);
  const meta = document.createElement("span");
  meta.className = "meta";
  const status = document.createElement("span");
  status.className = SG_STATE_CLASS[st.state];
  status.textContent = st.text;
  meta.append(status, " · ", etaSpan(Nav.eta(dist)), ` · ${point.address}`);
  li.append(bar, what, distEl, meta);
  const open = () => {
    // De marker bestaat mogelijk pas na het laden van dit kaartgebied.
    sgPendingPopup = point.id;
    setLayer("statiegeld", true);
    map.setView([point.lat, point.lon], Math.max(map.getZoom(), state.config.statiegeld.min_zoom, 16));
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function renderSgList() {
  const cfg = state.config.statiegeld;
  if (!cfg.enabled) return;
  $("sg-title").textContent = `Statiegeld binnen ${fmtDistance(cfg.list_radius_m)}`;
  const empty = $("empty-sg");
  if (!state.location) {
    $("list-sg").replaceChildren();
    empty.textContent = "Nog geen locatie bekend.";
    empty.hidden = false;
    return;
  }
  const items = state.sg.near
    .map((p) => ({ p, st: sgStatus(p), d: haversine(state.location.lat, state.location.lon, p.lat, p.lon) }))
    .filter((x) => x.d <= cfg.list_radius_m && sgVisible(x.p, x.st))
    .sort((a, b) => a.d - b.d)
    .slice(0, 10);
  $("list-sg").replaceChildren(...items.map((x) => sgListItem(x.p, x.st, x.d)));
  empty.textContent = state.sg.onlyOpen ? "Geen open inleverpunt in de buurt." : "Geen inleverpunten in de buurt.";
  empty.hidden = items.length > 0;
  renderOverview();
}

function bboxAround(lat, lon, radiusM) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

async function fetchSg(bbox) {
  return api(`/api/statiegeld?bbox=${bbox.map((v) => v.toFixed(5)).join(",")}`);
}

let sgViewportSeq = 0;
let sgViewportTimer = null;
function scheduleSgViewport() {
  clearTimeout(sgViewportTimer);
  sgViewportTimer = setTimeout(async () => {
    const cfg = state.config.statiegeld;
    if (!cfg.enabled || !state.sg.show || map.getZoom() < cfg.min_zoom) {
      state.sg.points = [];
      renderSg();
      return;
    }
    const b = map.getBounds();
    const seq = ++sgViewportSeq;
    try {
      const points = await fetchSg([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      if (seq !== sgViewportSeq) return; // intussen verder geschoven
      state.sg.points = points;
      renderSg();
    } catch (err) { console.warn("Statiegeld:", err.message); }
  }, 250);
}

async function loadSgNear(force) {
  const cfg = state.config.statiegeld;
  const loc = state.location;
  if (!cfg.enabled || !loc) return renderSgList();
  const from = state.sg.nearFrom;
  // Pas opnieuw ophalen als je een flink stuk bent verplaatst.
  if (!force && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < cfg.list_radius_m / 4) {
    return renderSgList();
  }
  state.sg.nearFrom = { lat: loc.lat, lon: loc.lon };
  // Iets ruimer ophalen, zodat de lijst klopt terwijl je beweegt.
  state.sg.near = await fetchSg(bboxAround(loc.lat, loc.lon, cfg.list_radius_m * 1.3));
  renderSgList();
}

function initStatiegeld() {
  if (!state.config.statiegeld.enabled) return;
  $("sg-show-chip").hidden = false;
  state.sg.show = store.get("sgShow") === "1";
  state.sg.onlyOpen = store.get("sgOnlyOpen") === "1";
  $("sg-show").checked = state.sg.show;
  $("sg-open").checked = state.sg.onlyOpen;
  $("sg-show").addEventListener("change", (e) => setLayer("statiegeld", e.target.checked));
  $("sg-open").addEventListener("change", (e) => {
    state.sg.onlyOpen = e.target.checked;
    store.set("sgOnlyOpen", state.sg.onlyOpen ? "1" : "0");
    renderSg();
    renderSgList();
  });
  scheduleSgViewport();
  loadSgNear(true).catch(console.error);
}

// ---------- parkeren ----------

const PK_COLORS = { free: "#16a34a", permit: "#6b7280", disc: "#2563eb", unknown: "#9ca3af" };

function pkColor(st) {
  if (st.state === "paid") {
    if (st.rate == null) return "#9ca3af";
    return st.rate < 2.5 ? "#16a34a" : st.rate < 5 ? "#d97706" : "#dc2626";
  }
  return PK_COLORS[st.state] || "#9ca3af";
}

function pkPopup(zone) {
  const st = Parking.status(zone);
  const today = OpeningHours.amsterdamNow().day;
  const rows = Parking.weekLines(zone).map((l, i) =>
    `<tr${i === today ? ' class="today"' : ""}><td>${esc(l.day)}</td><td>${esc(l.text)}</td></tr>`).join("");
  const extras = (zone.extras || []).map((x) => {
    const p = x.schedule.flat()[0];
    const fare = p && p.fare && zone.fares[p.fare];
    return `<li>${esc(x.name)}${fare ? ` · ${esc(fare.text)}` : ""}</li>`;
  }).join("");
  const facts = [
    zone.capacity ? `${zone.capacity} plaatsen` : "",
    zone.max_height_cm ? `max. hoogte ${(zone.max_height_cm / 100).toFixed(2).replace(".", ",")} m` : "",
  ].filter(Boolean).join(" · ");
  return `
    <b>${esc(zone.name)}</b><br>
    ${esc(Parking.KIND_LABEL[zone.kind])} · ${esc(zone.manager)}<br>
    <span class="pk-status" style="--c:${st.state === "paid" ? Parking.zoneColor(zone) : pkColor(st)}">${esc(st.text)}</span>
    <table class="pk-week">${rows}</table>
    ${extras ? `<div><small>Ook mogelijk:</small><ul class="pk-extras">${extras}</ul></div>` : ""}
    ${facts ? `<div><small>${esc(facts)}</small></div>` : ""}
    ${zone.special_days ? '<div class="pk-note">Op feestdagen en bij evenementen kunnen andere tijden gelden.</div>' : ""}
    ${zone.approx === "automaten" ? '<div class="pk-note">Zonegrens niet bekend bij de RDW: de stippen zijn de parkeerautomaten van deze zone.</div>' : ""}
    ${zone.approx_distance_m != null ? `<div class="pk-note">Waarschijnlijk geldt deze zone hier: er staat een automaat op ${esc(fmtDistance(zone.approx_distance_m))}.</div>` : ""}
    <div class="pk-note">Bron: RDW/NPR. Borden ter plaatse gaan altijd voor.</div>
    ${zone.kind === "garage" ? `<div class="popup-links">${routeLink(...pkPoint(zone))}</div>` : ""}
    ${zone.url ? `<a href="${esc(/^https?:/.test(zone.url) ? zone.url : "https://" + zone.url)}" target="_blank" rel="noopener noreferrer">${esc(zone.manager)}${icon("external-link")}</a>` : ""}`;
}

/** Punt voor de route naar een garage/terrein: het punt zelf of het midden van het vlak. */
function pkPoint(zone) {
  if (zone.geometry.type === "Point") return [zone.geometry.coordinates[1], zone.geometry.coordinates[0]];
  if (zone.geometry.type === "MultiPoint") {
    const pts = zone.geometry.coordinates.map(([x, y]) => [y, x]);
    if (!state.location) return pts[0];
    return pts.reduce((best, p) => (haversine(state.location.lat, state.location.lon, p[0], p[1])
      < haversine(state.location.lat, state.location.lon, best[0], best[1]) ? p : best));
  }
  return [(zone.bbox[1] + zone.bbox[3]) / 2, (zone.bbox[0] + zone.bbox[2]) / 2];
}

let pkPendingPopup = null;

function renderParking() {
  let reopen = pkPendingPopup;
  for (const [id, shape] of pkShapes) if (shape.isPopupOpen()) reopen = reopen ?? id;
  pkLayer.clearLayers();
  pkShapes.clear();
  if (!state.pk.show || map.getZoom() < state.config.parking.min_zoom) return;
  // Grote vlakken eerst, zodat kleinere (bijv. garages) erbovenop klikbaar blijven.
  const area = (z) => (z.bbox[2] - z.bbox[0]) * (z.bbox[3] - z.bbox[1]);
  const zones = state.pk.zones.filter((z) => state.pk.kinds.has(z.kind)).sort((a, b) => area(b) - area(a));
  const here = new Set(state.pk.here.map((z) => z.id));
  for (const zone of zones) {
    const st = Parking.status(zone);
    const color = Parking.zoneColor(zone);
    let shape;
    if (zone.geometry.type === "MultiPoint") {
      // Zone zonder kaartvlak: de parkeerautomaten als stippen in de tariefkleur.
      shape = L.featureGroup(zone.geometry.coordinates.map(([x, y]) => L.circleMarker([y, x], {
        pane: "parking", radius: 5, color: "#fff", weight: 1.5, fillColor: color, fillOpacity: st.state === "free" ? 0.55 : 0.95,
      })));
      shape.bindTooltip(() => `<b>${esc(zone.name)}</b><br>${esc(st.text)}<br><small>parkeerautomaat</small>`, { sticky: true, direction: "top", className: "pk-tip" });
    } else if (zone.geometry.type === "Point") {
      const [lon, lat] = zone.geometry.coordinates;
      shape = L.marker([lat, lon], {
        icon: L.divIcon({ className: "pk-marker", html: '<div class="pk-sign">P</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        keyboard: false,
        zIndexOffset: -600,
      });
    } else {
      // Nu betalen: stevig gekleurd. Nu gratis (buiten de tijden): zelfde kleur, lichter en
      // gestippeld, zodat je de zone en het tarief ook 's avonds ziet. Jouw zone: dikke rand.
      const mine = here.has(zone.id);
      const permit = zone.kind === "vergunning";
      const quiet = st.state === "free" || permit;
      shape = L.geoJSON(zone.geometry, {
        pane: "parking",
        style: {
          color,
          weight: mine ? 4 : permit ? 1 : 2,
          opacity: 0.9,
          dashArray: quiet ? "6 5" : null,
          fillColor: color,
          fillOpacity: (permit ? 0.05 : quiet ? 0.12 : 0.26) + (mine ? 0.08 : 0),
        },
      });
      shape.bindTooltip(() => `<b>${esc(zone.name)}</b><br>${esc(st.text)}`, { sticky: true, direction: "top", className: "pk-tip" });
    }
    shape.bindPopup(() => pkPopup(zone), { maxWidth: 320 }).addTo(pkLayer);
    pkShapes.set(zone.id, shape);
  }
  if (reopen != null && pkShapes.has(reopen)) {
    const shape = pkShapes.get(reopen);
    const zone = state.pk.zones.find((z) => z.id === reopen);
    if (zone && zone.geometry.type === "MultiPoint") {
      shape.openPopup(pkPoint(zone));  // bij de dichtstbijzijnde automaat
    } else if (zone && zone.geometry.type !== "Point" && state.location) {
      shape.openPopup([state.location.lat, state.location.lon]);
    } else {
      shape.openPopup();
    }
    pkPendingPopup = null;
  }
}

function renderParkingHere() {
  const cfg = state.config.parking;
  if (!cfg.enabled) return;
  const empty = $("empty-pk");
  if (!state.location) {
    $("list-pk").replaceChildren();
    empty.textContent = "Nog geen locatie bekend.";
    empty.hidden = false;
    return;
  }
  const order = { betaald: 0, blauw: 1, garage: 2, vergunning: 3 };
  const zones = [...state.pk.here].sort((a, b) => order[a.kind] - order[b.kind]);
  $("list-pk").replaceChildren(...zones.map(pkListItem));
  empty.textContent = "Geen parkeerregeling bekend; meestal vrij parkeren.";
  empty.hidden = zones.length > 0;
  renderParking();  // jouw zone krijgt op de kaart een dikke rand
  renderOverview();
}

function pkListItem(zone) {
  const st = Parking.status(zone);
  const li = document.createElement("li");
  li.className = "item parking";
  li.style.setProperty("--c", Parking.zoneColor(zone));
  li.tabIndex = 0;
  const bar = document.createElement("span");
  bar.className = "bar";
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = zone.name;
  const kind = document.createElement("span");
  kind.className = "dist";
  kind.textContent = Parking.KIND_LABEL[zone.kind].split(" ")[0];
  const meta = document.createElement("span");
  meta.className = "meta";
  const status = document.createElement("span");
  status.className = "pk-status";
  status.textContent = st.text;
  if (st.state !== "paid") status.style.setProperty("--c", pkColor(st));
  meta.append(status, zone.approx_distance_m != null
    ? ` · waarschijnlijk (automaat op ${fmtDistance(zone.approx_distance_m)})` : ` · ${zone.manager}`);
  li.append(bar, what, kind, meta);
  const open = () => {
    pkPendingPopup = zone.id;
    state.pk.kinds.add(zone.kind);
    document.querySelectorAll("[data-pk]").forEach((el) => {
      if (el.dataset.pk.split(",").includes(zone.kind)) el.checked = true;
    });
    setLayer("parking", true);
    map.setView([state.location.lat, state.location.lon], Math.max(map.getZoom(), state.config.parking.min_zoom, 16));
    scheduleParkingViewport();
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

let pkSeq = 0;
let pkTimer = null;
function scheduleParkingViewport() {
  clearTimeout(pkTimer);
  pkTimer = setTimeout(async () => {
    const cfg = state.config.parking;
    if (!cfg.enabled || !state.pk.show || !state.pk.kinds.size || map.getZoom() < cfg.min_zoom) {
      state.pk.zones = [];
      renderParking();
      return;
    }
    const b = map.getBounds();
    const seq = ++pkSeq;
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
    try {
      const zones = await api(`/api/parking?bbox=${bbox}&kinds=${[...state.pk.kinds].join(",")}`);
      if (seq !== pkSeq) return;
      state.pk.zones = zones;
      renderParking();
    } catch (err) { console.warn("Parkeren:", err.message); }
  }, 300);
}

async function loadParkingHere(force) {
  const loc = state.location;
  if (!state.config.parking.enabled || !loc) return renderParkingHere();
  const from = state.pk.hereFrom;
  if (!force && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < 30) return renderParkingHere();
  state.pk.hereFrom = { lat: loc.lat, lon: loc.lon };
  state.pk.here = await api(`/api/parking/at?lat=${loc.lat.toFixed(6)}&lon=${loc.lon.toFixed(6)}`);
  renderParkingHere();
}

function initParking() {
  if (!state.config.parking.enabled) return;
  const swatch = (color, label, cls = "") =>
    `<span><span class="swatch${cls}" style="--c:${color}"></span>${label}</span>`;
  $("pk-legend").innerHTML = Parking.RATE_SCALE.map((b) => swatch(b.color, `${b.label}/u`)).join("")
    + swatch("#2563eb", "blauwe zone")
    + '<span class="legend-note">Dikke rand = jouw zone. Gestippeld = nu gratis (buiten de betaaltijden).</span>';
  $("pk-show-chip").hidden = false;
  state.pk.show = store.get("pkShow") !== "0";
  $("pk-show").checked = state.pk.show;
  $("pk-show").addEventListener("change", (e) => setLayer("parking", e.target.checked));
  const saved = store.get("pkKinds");
  if (saved != null) state.pk.kinds = new Set(saved.split(",").filter(Boolean));
  document.querySelectorAll("[data-pk]").forEach((el) => {
    const kinds = el.dataset.pk.split(",");
    el.checked = kinds.every((k) => state.pk.kinds.has(k));
    el.addEventListener("change", () => {
      kinds.forEach((k) => (el.checked ? state.pk.kinds.add(k) : state.pk.kinds.delete(k)));
      store.set("pkKinds", [...state.pk.kinds].join(","));
      scheduleParkingViewport();
    });
  });
  scheduleParkingViewport();
  loadParkingHere(true).catch(console.error);
}

// ---------- laadpalen ----------

const CH_COLORS = { free: "#16a34a", busy: "#d97706", unknown: "#9ca3af" };

function chProfile() {
  return Charging.PROFILES[state.ch.profile] || Charging.PROFILES.snel;
}

function chFilters() {
  return state.ch.profile === "eigen" && state.ch.custom ? state.ch.custom : chProfile().filters;
}

function chStatusAge() {
  if (!state.ch.statusTs) return "status nog niet bekend";
  return `status van ${fmtAgo(state.ch.statusTs)}`;
}

function chPopup(station) {
  const av = Charging.availability(station);
  const conns = station.connectors.map((c) => {
    const kw = c.kw ? `${c.kw} kW` : c.dc ? "snellader" : "vermogen onbekend";
    const plugStatus = station.status && station.status.plugs[c.plug];
    const free = plugStatus ? ` · ${plugStatus[0]}/${plugStatus[1]} vrij` : "";
    const price = Charging.tariffText(c.tariff);
    return `<li>${c.count}× ${esc(c.plug)} · ${esc(kw)}${esc(free)}${price ? `<br><small>${esc(price)}</small>` : ""}</li>`;
  }).join("");
  const pay = [station.payment.creditcard ? "creditcard" : "", station.payment.pinpas ? "pinpas" : ""].filter(Boolean);
  const warn = Charging.warnings(station, chProfile()).map((w) => `<div class="ch-warn">${icon("triangle-alert")}${esc(w)}</div>`).join("");
  const d = state.location ? haversine(state.location.lat, state.location.lon, station.lat, station.lon) : null;
  return `
    <b>${esc(Charging.displayName(station))}</b><br>
    ${esc(station.operator || "")}${station.operator ? " · " : ""}${esc(station.address)}${d != null ? ` · ${esc(fmtDistance(d))} · ${esc(Nav.eta(d, "auto"))}` : ""}<br>
    <span class="ch-status" style="--c:${CH_COLORS[av.state]}">${esc(av.text)}</span> <small>(${esc(chStatusAge())})</small>
    <ul class="ch-conn">${conns}</ul>
    <div><small>Betalen: ${esc(pay.length ? `laadpas, app of ${pay.join("/")}` : "laadpas of app")}</small></div>
    ${warn}
    <div class="pk-note" data-ch-parking="${esc(station.id)}"></div>
    <div class="pk-note">Tarief volgens de exploitant; met je eigen laadpas kan het anders zijn.</div>
    <div class="popup-links">${routeLink(station.lat, station.lon)}</div>`;
}

/** Parkeertarief op de plek van de laadpaal (handig bij bestemmingsladen). */
async function chParkingNote(station, popupEl) {
  if (!state.config.parking.enabled) return;
  try {
    const zones = await api(`/api/parking/at?lat=${station.lat}&lon=${station.lon}&kinds=betaald,blauw`);
    const el = popupEl.querySelector(`[data-ch-parking="${CSS.escape(station.id)}"]`);
    if (!el || !zones.length) return;
    const st = Parking.status(zones[0]);
    el.textContent = `Parkeren hier: ${st.text}`;
  } catch (err) { /* geen parkeerinfo: niet erg */ }
}

function chIcon(station) {
  const av = Charging.availability(station);
  return L.divIcon({
    className: "ch-marker",
    html: `<div class="ch-sign${station.dc ? " dc" : ""}" style="--c:${CH_COLORS[av.state]}">${icon("zap")}</div>`,
    iconSize: station.dc ? [26, 26] : [20, 20],
    iconAnchor: station.dc ? [13, 13] : [10, 10],
  });
}

let chPendingPopup = null;

function renderChargingLayer() {
  const reopen = chPendingPopup ?? openPopupId(chMarkers);
  chLayer.clearLayers();
  chMarkers.clear();
  if (!state.ch.show || map.getZoom() < state.config.charging.min_zoom) return;
  for (const station of state.ch.stations) {
    const marker = L.marker([station.lat, station.lon], { icon: chIcon(station), keyboard: false, zIndexOffset: -400 })
      .bindPopup(() => chPopup(station), { maxWidth: 300 });
    marker.on("popupopen", (e) => chParkingNote(station, e.popup.getElement()));
    marker.addTo(chLayer);
    chMarkers.set(station.id, marker);
  }
  if (reopen != null && chMarkers.has(reopen)) {
    chMarkers.get(reopen).openPopup();
    chPendingPopup = null;
  }
}

function renderChargingList() {
  const cfg = state.config.charging;
  if (!cfg.enabled) return;
  $("ch-title").textContent = `Laden binnen ${fmtDistance(cfg.list_radius_m)} · ${chProfile().label}`;
  const empty = $("empty-ch");
  if (!state.location) {
    $("list-ch").replaceChildren();
    empty.textContent = "Nog geen locatie bekend.";
    empty.hidden = false;
    return;
  }
  $("list-ch").replaceChildren(...state.ch.near.map(chListItem));
  empty.textContent = "Geen laadpunten die bij dit profiel passen. Probeer een ander profiel of minder filters.";
  empty.hidden = state.ch.near.length > 0;
  renderOverview();
}

function chListItem(station) {
  const av = Charging.availability(station);
  const li = document.createElement("li");
  li.className = "item charging";
  li.style.setProperty("--c", CH_COLORS[av.state]);
  li.tabIndex = 0;
  const bar = document.createElement("span");
  bar.className = "bar";
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = Charging.displayName(station);
  const dist = document.createElement("span");
  dist.className = "dist";
  dist.textContent = fmtDistance(station.distance_m);
  const meta = document.createElement("span");
  meta.className = "meta";
  const status = document.createElement("span");
  status.className = "ch-status";
  status.textContent = av.text;
  meta.append(status, " · ", etaSpan(Nav.eta(station.distance_m, "auto")), ` · ${Charging.summary(station)}`);
  for (const w of Charging.warnings(station, chProfile()).slice(0, 1)) meta.append(" · ", iconEl("triangle-alert", "warn"), w);
  li.append(bar, what, dist, meta);
  const open = () => {
    chPendingPopup = station.id;
    setLayer("charging", true);
    map.setView([station.lat, station.lon], Math.max(map.getZoom(), state.config.charging.min_zoom, 16));
    scheduleChargingViewport();
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

let chSeq = 0;
let chTimer = null;
function scheduleChargingViewport() {
  clearTimeout(chTimer);
  chTimer = setTimeout(async () => {
    const cfg = state.config.charging;
    if (!cfg.enabled || !state.ch.show || map.getZoom() < cfg.min_zoom) {
      state.ch.stations = [];
      renderChargingLayer();
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
    const seq = ++chSeq;
    try {
      const res = await api(`/api/charging?bbox=${bbox}&${Charging.query(chFilters())}`);
      if (seq !== chSeq) return;
      state.ch.stations = res.stations;
      state.ch.statusTs = res.status_ts;
      renderChargingLayer();
    } catch (err) { console.warn("Laadpalen:", err.message); }
  }, 300);
}

async function loadChargingNear(force) {
  const cfg = state.config.charging;
  const loc = state.location;
  if (!cfg.enabled || !loc) return renderChargingList();
  const from = state.ch.nearFrom;
  if (!force && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < cfg.list_radius_m / 6) {
    return renderChargingList();
  }
  state.ch.nearFrom = { lat: loc.lat, lon: loc.lon };
  const bbox = bboxAround(loc.lat, loc.lon, cfg.list_radius_m).map((v) => v.toFixed(5)).join(",");
  const res = await api(`/api/charging?bbox=${bbox}&near=${loc.lat.toFixed(6)},${loc.lon.toFixed(6)}&limit=8&${Charging.query(chFilters())}`);
  state.ch.near = res.stations.filter((s) => s.distance_m <= cfg.list_radius_m);
  state.ch.statusTs = res.status_ts;
  renderChargingList();
}

function chReload() {
  scheduleChargingViewport();
  loadChargingNear(true).catch(console.error);
}

/** Zet de filtervelden gelijk aan de filters van het gekozen profiel. */
function chShowFilters() {
  const f = chFilters();
  document.querySelectorAll("[data-ch-plug]").forEach((el) => { el.checked = f.plugs.includes(el.dataset.chPlug); });
  document.querySelectorAll("[data-ch-flag]").forEach((el) => { el.checked = !!f[el.dataset.chFlag]; });
  $("ch-minkw").value = String(f.min_kw || 0);
  $("ch-hint").textContent = chProfile().hint;
}

function chReadFilters() {
  return {
    plugs: [...document.querySelectorAll("[data-ch-plug]")].filter((el) => el.checked).map((el) => el.dataset.chPlug),
    min_kw: Number($("ch-minkw").value),
    ...Object.fromEntries([...document.querySelectorAll("[data-ch-flag]")].map((el) => [el.dataset.chFlag, el.checked])),
  };
}

function initCharging() {
  if (!state.config.charging.enabled) return;
  $("ch-show-chip").hidden = false;
  state.ch.show = store.get("chShow") === "1";
  state.ch.profile = store.get("chProfile") || "snel";
  try { state.ch.custom = JSON.parse(store.get("chCustom") || "null"); } catch { state.ch.custom = null; }
  const select = $("ch-profile");
  for (const [key, p] of Object.entries(Charging.PROFILES)) select.add(new Option(p.label, key));
  select.value = state.ch.profile;
  $("ch-show").checked = state.ch.show;
  chShowFilters();

  $("ch-show").addEventListener("change", (e) => setLayer("charging", e.target.checked));
  select.addEventListener("change", () => {
    state.ch.profile = select.value;
    store.set("chProfile", state.ch.profile);
    chShowFilters();
    chReload();
  });
  // Zelf een filter aanpassen maakt er een eigen profiel van (per apparaat bewaard).
  document.querySelectorAll(".ch-filters input, #ch-minkw").forEach((el) => el.addEventListener("change", () => {
    state.ch.custom = chReadFilters();
    state.ch.profile = "eigen";
    select.value = "eigen";
    store.set("chProfile", "eigen");
    store.set("chCustom", JSON.stringify(state.ch.custom));
    $("ch-hint").textContent = chProfile().hint;
    chReload();
  }));
  chReload();
}

// ---------- winkels ----------

const SH_ICON = { supermarkt: "shopping-cart", buurtwinkel: "store", markt: "shopping-basket" };
const SH_KIND_LABEL = { supermarkt: "Supermarkt", buurtwinkel: "Buurt-/avondwinkel", markt: "Markt" };
const SH_COLORS = { open: "#16a34a", closed: "#9ca3af", unknown: "#e5e7eb" };

function shStatus(shop) {
  return OpeningHours.status(shop.hours);
}

function shMatches(shop, st) {
  if (!state.sh.kinds.has(shop.kind)) return false;
  if (state.sh.onlyOpen && st.state !== "open") return false;
  if (state.sh.lateOnly && !shop.late) return false;
  return true;
}

function shWeekRows(shop) {
  const today = OpeningHours.amsterdamNow().day;
  return OpeningHours.DAYS.map((day, i) => {
    const periods = shop.hours ? shop.hours[i] : null;
    const text = periods == null ? "onbekend"
      : !periods.length ? "gesloten"
        : periods.map(([a, b]) => `${OpeningHours.hhmm(a)}–${b >= 1440 && b % 1440 === 0 ? "24:00" : OpeningHours.hhmm(b)}`).join(", ");
    return `<tr${i === today ? ' class="today"' : ""}><td>${esc(day)}</td><td>${esc(text)}</td></tr>`;
  }).join("");
}

/** Statiegeldinfo in de winkelpopup (als de winkel een eigen inleverpunt heeft). */
function sgInShopHtml(point) {
  const st = sgStatus(point);
  return `
    <div class="sg-in-shop">
      <b>${icon("recycle")}Statiegeld inleveren</b><br>
      <span class="${SG_STATE_CLASS[st.state]}">${esc(st.text)}</span>
      ${point.materials.length ? `<div><small>Neemt in: ${esc(point.materials.join(", "))}</small></div>` : ""}
      ${point.payouts.length ? `<div><small>Uitbetaling: ${esc(point.payouts.join(", "))}</small></div>` : ""}
    </div>`;
}

function shPopup(shop, sgPoint = null) {
  const st = shStatus(shop);
  const d = state.location ? haversine(state.location.lat, state.location.lon, shop.lat, shop.lon) : null;
  const [osmType, osmId] = shop.id.split("/");
  return `
    <b>${esc(shop.name)}</b><br>
    ${esc(SH_KIND_LABEL[shop.kind])}${shop.address ? ` · ${esc(shop.address)}` : ""}${d != null ? ` · ${esc(fmtDistance(d))}<br>${esc(Nav.eta(d))}` : ""}<br>
    <span class="${SG_STATE_CLASS[st.state]}">${esc(st.text)}</span>${shop.late ? ' <span class="tag late">LAAT OPEN</span>' : ""}
    ${shop.hours ? `<table class="sg-hours">${shWeekRows(shop)}</table>` : ""}
    <div class="pk-note">${shop.hours_source ? `Openingstijden: ${esc(shop.hours_source)}. ` : "Geen openingstijden bekend. "}Feestdagen kunnen afwijken.</div>
    ${sgPoint ? sgInShopHtml(sgPoint) : ""}
    <div class="popup-links">${routeLink(shop.lat, shop.lon)}<a href="https://www.openstreetmap.org/${esc(osmType)}/${esc(osmId)}" target="_blank" rel="noopener noreferrer" title="Klopt iets niet? Verbeter het op OpenStreetMap">${icon("pencil")}Aanpassen</a></div>`;
}

let shPendingPopup = null;

function drawShops(layout) {
  const reopen = shPendingPopup ?? openPopupId(shMarkers);
  shLayer.clearLayers();
  shMarkers.clear();
  layout.shops.forEach(({ p: shop, st }, i) => {
    const point = layout.shopSg[i];
    const badge = point ? `<span class="sh-badge" title="Ook statiegeld inleveren">${icon("recycle")}</span>` : "";
    const html = `<div class="sh-sign" style="--c:${SH_COLORS[st.state]}">${icon(SH_ICON[shop.kind])}${badge}</div>`;
    const marker = spreadMarker(shop.lat, shop.lon, html, "sh-marker", 24, layout.shopOff[i], shop.brand || shop.name, -450)
      .bindPopup(() => shPopup(shop, point), { maxWidth: 290 });
    marker.addTo(shLayer);
    shMarkers.set(shop.id, marker);
  });
  // Een samengevoegd inleverpunt opent (bijv. vanuit de statiegeldlijst) de winkelpopup.
  for (const [pointId, shopId] of layout.merged) sgMarkers.set(pointId, shMarkers.get(shopId));
  if (sgPendingPopup != null && layout.merged.has(sgPendingPopup)) {
    shMarkers.get(layout.merged.get(sgPendingPopup)).openPopup();
    sgPendingPopup = null;
  } else if (reopen != null && shMarkers.has(reopen)) {
    shMarkers.get(reopen).openPopup();
    shPendingPopup = null;
  }
}

/**
 * Winkels en statiegeldpunten samen verdelen: zo valt ook een winkel niet over zijn eigen
 * inleverpunt (of over de supermarkt ernaast). Een inleverpunt in een winkel die al op de kaart
 * staat, krijgt geen tweede naamlabel.
 */
function poiLayout() {
  const shops = state.sh.show && map.getZoom() >= state.config.shops.min_zoom
    ? state.sh.points.map((p) => ({ p, st: shStatus(p) })).filter((x) => shMatches(x.p, x.st)) : [];
  const sg = state.sg.show && map.getZoom() >= state.config.statiegeld.min_zoom
    ? state.sg.points.map((p) => ({ p, st: sgStatus(p) })).filter((x) => sgVisible(x.p, x.st)) : [];
  // Winkel met een eigen (zichtbaar) inleverpunt: één icoon, het winkelicoon met een
  // statiegeldteken. Het losse statiegeldicoon van dat punt vervalt.
  const sgById = new Map(sg.map((x) => [x.p.id, x.p]));
  const merged = new Map();  // punt-id -> winkel-id
  const shopSg = shops.map(({ p }) => {
    const point = p.statiegeld && sgById.get(p.statiegeld);
    if (point) merged.set(point.id, p.id);
    return point || null;
  });
  const sgShown = sg.filter((x) => !merged.has(x.p.id));
  const offsets = spreadOffsets([...shops.map((x) => x.p), ...sgShown.map((x) => x.p)], 24);
  const firstWord = (n) => (n || "").toLowerCase().split(/\s+/)[0];
  const sgLabel = sgShown.map(({ p }) => !shops.some(({ p: shop }) =>
    firstWord(shop.brand || shop.name) === firstWord(p.name) && haversine(shop.lat, shop.lon, p.lat, p.lon) < 60));
  return { shops, sg: sgShown, shopSg, merged, sgLabel,
    shopOff: offsets.slice(0, shops.length), sgOff: offsets.slice(shops.length) };
}

function renderPois() {
  if (!state.config) return;
  const layout = poiLayout();
  drawSg(layout);
  drawShops(layout);
}
const renderShops = renderPois;
const renderSg = renderPois;

function shNearItems() {
  if (!state.location) return [];
  return state.sh.near
    .map((p) => ({ p, st: shStatus(p), d: haversine(state.location.lat, state.location.lon, p.lat, p.lon) }))
    .filter((x) => x.d <= state.config.shops.list_radius_m)
    .sort((a, b) => a.d - b.d);
}

function shListItem(x) {
  const { p: shop, st, d } = x;
  const li = document.createElement("li");
  li.className = "item statiegeld";
  li.tabIndex = 0;
  const bar = document.createElement("span");
  bar.className = `bar ${st.state}`;
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = shop.name;
  const distEl = document.createElement("span");
  distEl.className = "dist";
  distEl.textContent = fmtDistance(d);
  const meta = document.createElement("span");
  meta.className = "meta";
  const status = document.createElement("span");
  status.className = SG_STATE_CLASS[st.state];
  status.textContent = st.text;
  meta.append(status);
  if (shop.late) {
    const tag = document.createElement("span");
    tag.className = "tag late";
    tag.textContent = "LAAT OPEN";
    meta.append(" ", tag);
  }
  meta.append(" · ", etaSpan(Nav.eta(d)));
  if (shop.address) meta.append(` · ${shop.address}`);
  li.append(bar, what, distEl, meta);
  const open = () => {
    shPendingPopup = shop.id;
    setLayer("shops", true);
    map.setView([shop.lat, shop.lon], Math.max(map.getZoom(), state.config.shops.min_zoom, 16));
    scheduleShopsViewport();
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function renderShopsList() {
  const cfg = state.config.shops;
  if (!cfg.enabled) return;
  $("sh-title").textContent = `Winkels binnen ${fmtDistance(cfg.list_radius_m)}`;
  const empty = $("empty-sh");
  if (!state.location) {
    $("list-sh").replaceChildren();
    empty.textContent = "Nog geen locatie bekend.";
    empty.hidden = false;
  } else {
    const items = shNearItems().filter((x) => shMatches(x.p, x.st)).slice(0, 12);
    $("list-sh").replaceChildren(...items.map(shListItem));
    empty.textContent = state.sh.onlyOpen || state.sh.lateOnly
      ? "Niets gevonden dat nu aan je filters voldoet." : "Geen winkels of markten in de buurt.";
    empty.hidden = items.length > 0;
  }
  renderOverview();
}

let shSeq = 0;
let shTimer = null;
function scheduleShopsViewport() {
  clearTimeout(shTimer);
  shTimer = setTimeout(async () => {
    const cfg = state.config.shops;
    if (!cfg.enabled || !state.sh.show || map.getZoom() < cfg.min_zoom) {
      state.sh.points = [];
      renderShops();
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
    const seq = ++shSeq;
    try {
      const points = await api(`/api/shops?bbox=${bbox}`);
      if (seq !== shSeq) return;
      state.sh.points = points;
      renderShops();
    } catch (err) { console.warn("Winkels:", err.message); }
  }, 250);
}

async function loadShopsNear(force) {
  const cfg = state.config.shops;
  const loc = state.location;
  if (!cfg.enabled || !loc) return renderShopsList();
  const from = state.sh.nearFrom;
  if (!force && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < cfg.list_radius_m / 4) {
    return renderShopsList();
  }
  state.sh.nearFrom = { lat: loc.lat, lon: loc.lon };
  const bbox = bboxAround(loc.lat, loc.lon, cfg.list_radius_m * 1.3).map((v) => v.toFixed(5)).join(",");
  state.sh.near = await api(`/api/shops?bbox=${bbox}`);
  renderShopsList();
}

function initShops() {
  if (!state.config.shops.enabled) return;
  $("sh-show-chip").hidden = false;
  state.sh.show = store.get("shShow") === "1";
  state.sh.onlyOpen = store.get("shOpen") === "1";
  state.sh.lateOnly = store.get("shLate") === "1";
  const savedKinds = store.get("shKinds");
  if (savedKinds != null) state.sh.kinds = new Set(savedKinds.split(",").filter(Boolean));
  $("sh-show").checked = state.sh.show;
  $("sh-open").checked = state.sh.onlyOpen;
  $("sh-late").checked = state.sh.lateOnly;
  $("sh-show").addEventListener("change", (e) => setLayer("shops", e.target.checked));
  const refilter = () => { renderShops(); renderShopsList(); };
  $("sh-open").addEventListener("change", (e) => { state.sh.onlyOpen = e.target.checked; store.set("shOpen", e.target.checked ? "1" : "0"); refilter(); });
  $("sh-late").addEventListener("change", (e) => { state.sh.lateOnly = e.target.checked; store.set("shLate", e.target.checked ? "1" : "0"); refilter(); });
  document.querySelectorAll("[data-sh-kind]").forEach((el) => {
    el.checked = state.sh.kinds.has(el.dataset.shKind);
    el.addEventListener("change", () => {
      el.checked ? state.sh.kinds.add(el.dataset.shKind) : state.sh.kinds.delete(el.dataset.shKind);
      store.set("shKinds", [...state.sh.kinds].join(","));
      refilter();
    });
  });
  scheduleShopsViewport();
  loadShopsNear(true).catch(console.error);
}

// ---------- tankstations ----------

const FU_SHOP_TEXT = { ja: "Met winkel", nee: "Zonder winkel", onbekend: "Winkel onbekend" };
const FU_SHOP_CLASS = { ja: "shop", nee: "noshop", onbekend: "unknown" };
const FU_PAGE = 12;
const fuLayer = L.layerGroup().addTo(map);
const fuMarkers = new Map();
let fuPendingPopup = null;

function fuStatus(station) {
  return OpeningHours.status(station.hours);
}

function fuMatches(station, st) {
  if (!state.fu.shops.has(station.shop)) return false;
  if (state.fu.onlyOpen && st.state !== "open") return false;
  return true;
}

function fuExtras(station) {
  return [station.truck && "vrachtwagens", station.car_wash && "wasstraat",
    station.compressed_air && "bandenlucht", station.toilets && "toilet"].filter(Boolean);
}

function fuPopup(station) {
  const st = fuStatus(station);
  const d = state.location ? haversine(state.location.lat, state.location.lon, station.lat, station.lon) : null;
  const [osmType, osmId] = station.id.split("/");
  const extras = fuExtras(station);
  return `
    <b>${esc(station.name)}</b><br>
    ${station.address ? `${esc(station.address)}` : ""}${d != null ? `${station.address ? " · " : ""}${esc(fmtDistance(d))} · ${esc(Nav.eta(d, "auto"))}` : ""}<br>
    <span class="fu-shop ${FU_SHOP_CLASS[station.shop]}">${icon(station.shop === "ja" ? "shopping-bag" : "fuel")}${esc(FU_SHOP_TEXT[station.shop])}</span>
    <small>(${esc(station.shop_reason)})</small><br>
    <span class="${SG_STATE_CLASS[st.state]}">${esc(st.text)}</span>
    ${station.hours ? `<table class="sg-hours">${shWeekRows(station)}</table>` : ""}
    ${station.fuels.length ? `<div><small>Brandstof: ${esc(station.fuels.join(", "))}</small></div>` : ""}
    ${extras.length ? `<div><small>Ook: ${esc(extras.join(", "))}</small></div>` : ""}
    <div class="pk-note">Bron: OpenStreetMap. Prijzen zijn niet bekend (daar is geen open bron voor).</div>
    <div class="popup-links">${routeLink(station.lat, station.lon)}<a href="https://www.openstreetmap.org/${esc(osmType)}/${esc(osmId)}" target="_blank" rel="noopener noreferrer" title="Klopt iets niet? Verbeter het op OpenStreetMap">${icon("pencil")}Aanpassen</a></div>`;
}

function fuIconHtml(station, st) {
  const badge = station.shop === "ja" ? `<span class="fu-badge" title="Met winkel">${icon("shopping-bag")}</span>` : "";
  return `<div class="fu-sign ${FU_SHOP_CLASS[station.shop]}${st.state === "closed" ? " closed" : ""}">${icon("fuel")}${badge}</div>`;
}

function renderFuel() {
  const reopen = fuPendingPopup ?? openPopupId(fuMarkers);
  fuLayer.clearLayers();
  fuMarkers.clear();
  const cfg = state.config.fuel;
  if (!cfg.enabled || !state.fu.show || map.getZoom() < cfg.min_zoom) return;
  const items = state.fu.points.map((p) => ({ p, st: fuStatus(p) })).filter((x) => fuMatches(x.p, x.st));
  const offsets = spreadOffsets(items.map((x) => x.p), 24);
  items.forEach(({ p: station, st }, i) => {
    const marker = spreadMarker(station.lat, station.lon, fuIconHtml(station, st), "fu-marker", 24, offsets[i],
      station.brand || station.name, -400).bindPopup(() => fuPopup(station), { maxWidth: 290 });
    marker.addTo(fuLayer);
    fuMarkers.set(station.id, marker);
  });
  if (reopen != null && fuMarkers.has(reopen)) {
    fuMarkers.get(reopen).openPopup();
    fuPendingPopup = null;
  }
}

function fuNearItems() {
  if (!state.location) return [];
  return state.fu.near
    .map((p) => ({ p, st: fuStatus(p), d: haversine(state.location.lat, state.location.lon, p.lat, p.lon) }))
    .filter((x) => x.d <= state.config.fuel.list_radius_m)
    .sort((a, b) => a.d - b.d);
}

function fuListItem(x) {
  const { p: station, st, d } = x;
  const li = document.createElement("li");
  li.className = "item fuel";
  li.tabIndex = 0;
  const bar = document.createElement("span");
  bar.className = `bar ${FU_SHOP_CLASS[station.shop]}`;
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = station.name;
  const distEl = document.createElement("span");
  distEl.className = "dist";
  distEl.textContent = fmtDistance(d);
  const meta = document.createElement("span");
  meta.className = "meta";
  const shop = document.createElement("span");
  shop.className = `fu-shop ${FU_SHOP_CLASS[station.shop]}`;
  shop.textContent = FU_SHOP_TEXT[station.shop];
  const status = document.createElement("span");
  status.className = SG_STATE_CLASS[st.state];
  status.textContent = st.text;
  meta.append(shop, " · ", status, " · ", etaSpan(Nav.eta(d, "auto")));
  if (station.address) meta.append(` · ${station.address}`);
  li.append(bar, what, distEl, meta);
  const open = () => {
    fuPendingPopup = station.id;
    setLayer("fuel", true);
    map.setView([station.lat, station.lon], Math.max(map.getZoom(), state.config.fuel.min_zoom, 16));
    scheduleFuelViewport();
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function renderFuelList() {
  const cfg = state.config.fuel;
  if (!cfg.enabled) return;
  $("fu-title").textContent = `Tankstations binnen ${fmtDistance(cfg.list_radius_m)}`;
  const empty = $("empty-fu");
  if (!state.location) {
    $("list-fu").replaceChildren();
    empty.textContent = "Nog geen locatie bekend.";
    empty.hidden = false;
  } else {
    const items = fuNearItems().filter((x) => fuMatches(x.p, x.st)).slice(0, FU_PAGE);
    $("list-fu").replaceChildren(...items.map(fuListItem));
    empty.textContent = state.fu.onlyOpen || state.fu.shops.size < 3
      ? "Niets gevonden dat aan je filters voldoet." : "Geen tankstations in de buurt.";
    empty.hidden = items.length > 0;
  }
  renderOverview();
}

function fuSummary() {
  const items = fuNearItems();
  if (!items.length) return "Geen tankstations in de buurt";
  const shopOpen = items.filter((x) => x.p.shop === "ja" && x.st.state === "open").length;
  const nearest = items[0];
  return `Dichtstbij ${fmtDistance(nearest.d)} · ${shopOpen} met winkel nu open`;
}

let fuSeq = 0;
let fuTimer = null;
function scheduleFuelViewport() {
  clearTimeout(fuTimer);
  fuTimer = setTimeout(async () => {
    const cfg = state.config.fuel;
    if (!cfg.enabled || !state.fu.show || map.getZoom() < cfg.min_zoom) {
      state.fu.points = [];
      renderFuel();
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
    const seq = ++fuSeq;
    try {
      const points = await api(`/api/fuel?bbox=${bbox}`);
      if (seq !== fuSeq) return;
      state.fu.points = points;
      renderFuel();
    } catch (err) { console.warn("Tankstations:", err.message); }
  }, 250);
}

async function loadFuelNear(force) {
  const cfg = state.config.fuel;
  const loc = state.location;
  if (!cfg.enabled || !loc) return renderFuelList();
  const from = state.fu.nearFrom;
  if (!force && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < cfg.list_radius_m / 4) {
    return renderFuelList();
  }
  state.fu.nearFrom = { lat: loc.lat, lon: loc.lon };
  const bbox = bboxAround(loc.lat, loc.lon, cfg.list_radius_m * 1.2).map((v) => v.toFixed(5)).join(",");
  state.fu.near = await api(`/api/fuel?bbox=${bbox}`);
  renderFuelList();
}

function initFuel() {
  if (!state.config.fuel.enabled) return;
  $("fu-show-chip").hidden = false;
  state.fu.show = store.get("fuShow") === "1";
  state.fu.onlyOpen = store.get("fuOpen") === "1";
  const saved = store.get("fuShops");
  if (saved != null) state.fu.shops = new Set(saved.split(",").filter(Boolean));
  $("fu-show").checked = state.fu.show;
  $("fu-open").checked = state.fu.onlyOpen;
  $("fu-show").addEventListener("change", (e) => setLayer("fuel", e.target.checked));
  const refilter = () => { renderFuel(); renderFuelList(); };
  $("fu-open").addEventListener("change", (e) => {
    state.fu.onlyOpen = e.target.checked;
    store.set("fuOpen", e.target.checked ? "1" : "0");
    refilter();
  });
  document.querySelectorAll("[data-fu-shop]").forEach((el) => {
    el.checked = state.fu.shops.has(el.dataset.fuShop);
    el.addEventListener("change", () => {
      el.checked ? state.fu.shops.add(el.dataset.fuShop) : state.fu.shops.delete(el.dataset.fuShop);
      store.set("fuShops", [...state.fu.shops].join(","));
      refilter();
    });
  });
  scheduleFuelViewport();
  loadFuelNear(true).catch(console.error);
}

// ---------- nieuws en bekendmakingen uit de buurt ----------

const BK_ICON = { bouwen: "construction", verkeer: "traffic-cone", evenementen: "party-popper",
  vergunning: "stamp", overig: "file-text" };
const BK_LABEL = { bouwen: "Bouwen", verkeer: "Verkeer", evenementen: "Evenement", vergunning: "Vergunning",
  overig: "Bekendmaking" };
const BK_PAGE = 15;
const NW_PAGE = 5;
// Vanaf deze score telt een bekendmaking als "belangrijk" (zie relevance() op de server).
const BK_IMPORTANT = 1.5;
const BK_SORT = {
  relevant: (a, b) => b.relevance - a.relevance,
  new: (a, b) => (b.date || "").localeCompare(a.date || "") || b.relevance - a.relevance,
  near: (a, b) => (a.distance_m ?? 1e9) - (b.distance_m ?? 1e9),
};
const LOCAL_REFRESH_MS = 10 * 60 * 1000;
const bkLayer = L.layerGroup().addTo(map);
const bkMarkers = new Map();
let bkPendingPopup = null;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "2026-09-28" -> "vandaag", "gisteren" of "28 sep". */
function fmtDay(iso) {
  if (!iso) return "";
  const today = new Date();
  if (iso === isoDate(today)) return "vandaag";
  if (iso === isoDate(new Date(today.getTime() - 86400000))) return "gisteren";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
}

/** Kop en soort uit een bekendmaking: "Het bouwen van een dakkapel" + "Aanvraag omgevingsvergunning". */
function bkParts(a) {
  const comma = a.title.indexOf(",");
  let kind = comma > 0 && comma < 60 ? a.title.slice(0, comma) : BK_LABEL[a.category];
  if (/^aangevraagde evenementenvergunning/i.test(kind)) kind = "Evenement aangevraagd";
  let head = a.abstract && a.abstract.length > 8 ? a.abstract : (comma > 0 && comma < 60 ? a.title.slice(comma + 1) : a.title);
  head = head.trim();
  return { kind, head: head.charAt(0).toUpperCase() + head.slice(1) };
}

/** Waar: het adreslabel, anders het laatste deel van de titel ("…, Domplein te Utrecht"). */
function bkPlace(a) {
  // Oudere opgeslagen items kunnen nog een plaatshouder als "Handmatig 1" hebben.
  if (a.label && !/^\s*(handmatig|gebied|locatie|vlak|geometrie)\b[\s\d]*$/i.test(a.label)) return a.label;
  if (a.distance_m == null) return `hele gemeente ${a.gemeente}`;
  const parts = a.title.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 1] : "";
}

function bkDeadline(a) {
  return a.deadline && a.deadline >= isoDate(new Date()) ? `reageren t/m ${fmtDay(a.deadline)}` : "";
}

function bkVisible(a) {
  return state.bk.cats.has(a.category) && (!state.bk.important || a.relevance >= BK_IMPORTANT);
}

function bkPopup(a) {
  const { kind, head } = bkParts(a);
  const dl = bkDeadline(a);
  return `
    <b>${esc(head)}</b><br>
    <small>${esc(kind)} · ${esc(fmtDay(a.date))}${dl ? ` · ${esc(dl)}` : ""}</small><br>
    ${bkPlace(a) ? `${esc(bkPlace(a))}<br>` : ""}
    <div class="popup-links">
      <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${icon("external-link")}Bekijken</a>
      ${a.lat != null ? routeLink(a.lat, a.lon) : ""}
    </div>`;
}

function bkIcon(a) {
  return L.divIcon({
    className: "bk-marker",
    html: `<div class="bk-sign ${a.category}">${icon(BK_ICON[a.category] || "file-text")}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function renderBkLayer() {
  const reopen = bkPendingPopup ?? openPopupId(bkMarkers);
  bkLayer.clearLayers();
  bkMarkers.clear();
  for (const a of state.bk.items) {
    // Standaard alleen de bekendmaking die je aantikte; de hele laag is optioneel.
    if (a.lat == null || !(state.bk.show ? bkVisible(a) : a.id === state.bk.focus)) continue;
    const marker = L.marker([a.lat, a.lon], { icon: bkIcon(a), keyboard: false, zIndexOffset: -400 })
      .bindPopup(() => bkPopup(a), { maxWidth: 280 });
    marker.addTo(bkLayer);
    bkMarkers.set(a.id, marker);
  }
  if (reopen != null && bkMarkers.has(reopen)) {
    bkMarkers.get(reopen).openPopup();
    bkPendingPopup = null;
  }
}

function nwListItem(n) {
  const li = document.createElement("li");
  li.className = "item nw-item";
  const a = document.createElement("a");
  a.href = n.link;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = "what";
  a.textContent = n.title;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = [n.source, fmtAgo(n.ts), n.place].filter(Boolean).join(" · ");
  li.append(iconEl("newspaper", "lead"), a, meta);
  return li;
}

function bkListItem(a) {
  const { kind, head } = bkParts(a);
  const li = document.createElement("li");
  li.className = "item bk-item";
  li.tabIndex = 0;
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = head;
  const distEl = document.createElement("span");
  distEl.className = "dist";
  distEl.textContent = a.distance_m == null ? "" : fmtDistance(a.distance_m);
  const meta = document.createElement("span");
  meta.className = "meta";
  const dl = bkDeadline(a);
  meta.textContent = [kind, bkPlace(a),
    fmtDay(a.date), dl].filter(Boolean).join(" · ");
  const link = document.createElement("a");
  link.href = a.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "bk-link";
  link.title = "Bekijk op officielebekendmakingen.nl";
  link.setAttribute("aria-label", "Bekijken");
  link.append(iconEl("external-link"));
  link.addEventListener("click", (e) => e.stopPropagation());
  li.append(iconEl(BK_ICON[a.category] || "file-text", `lead ${a.category}`), what, distEl, meta, link);
  const open = () => {
    if (a.lat == null) { window.open(a.url, "_blank", "noopener"); return; }
    bkPendingPopup = a.id;
    state.bk.focus = a.id;
    map.setView([a.lat, a.lon], Math.max(map.getZoom(), 17));
    renderBkLayer();
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function bkItems() {
  return state.bk.items.filter(bkVisible).sort(BK_SORT[state.bk.sort] || BK_SORT.relevant);
}

function renderLocal() {
  const cfg = state.config.local;
  if (!cfg.news && !cfg.announcements) return;
  const noLoc = !state.location;
  $("nw-section").hidden = !cfg.news;
  $("bk-section").hidden = !cfg.announcements;

  const place = state.nw.place;
  $("nw-title").textContent = place ? `Nieuws rond ${place}` : "Nieuws uit je buurt";
  const news = state.nw.showAll ? state.nw.items : state.nw.items.slice(0, NW_PAGE);
  $("list-nw").replaceChildren(...news.map(nwListItem));
  $("nw-more").hidden = news.length >= state.nw.items.length;
  $("nw-more").textContent = `Alle ${state.nw.items.length} tonen`;
  const emptyNw = $("empty-nw");
  emptyNw.textContent = noLoc ? "Nog geen locatie bekend."
    : state.nw.loading ? "Laden…" : "Geen recent nieuws dat een plaats in je buurt noemt.";
  emptyNw.hidden = state.nw.items.length > 0;

  $("bk-title").textContent = `Bekendmakingen binnen ${fmtDistance(cfg.radius_m)}`;
  const items = bkItems();
  const shown = state.bk.showAll ? items : items.slice(0, BK_PAGE);
  $("list-bk").replaceChildren(...shown.map(bkListItem));
  $("bk-more").hidden = shown.length >= items.length;
  $("bk-more").textContent = `Alle ${items.length} tonen`;
  const emptyBk = $("empty-bk");
  const hidden = state.bk.items.length - items.length;
  emptyBk.textContent = noLoc ? "Nog geen locatie bekend."
    : state.nw.loading ? "Laden…"
      : hidden ? `Niets met deze filters. ${hidden} andere bekendmaking${hidden === 1 ? "" : "en"} verborgen.`
        : "Geen bekendmakingen in de afgelopen 30 dagen.";
  emptyBk.hidden = items.length > 0;
  renderBkLayer();
  renderOverview();
}

async function loadLocal(force) {
  const cfg = state.config.local;
  const loc = state.location;
  if ((!cfg.news && !cfg.announcements) || !loc) return renderLocal();
  const from = state.nw.from;
  if (!force && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < 300 &&
      Date.now() - from.at < LOCAL_REFRESH_MS) return renderLocal();
  state.nw.from = { lat: loc.lat, lon: loc.lon, at: Date.now() };
  state.nw.loading = !state.nw.items.length && !state.bk.items.length;
  renderLocal();
  try {
    const out = await api(`/api/local?lat=${loc.lat.toFixed(5)}&lon=${loc.lon.toFixed(5)}`);
    state.nw.items = out.news;
    state.nw.place = out.place;
    state.bk.items = out.announcements;
  } finally {
    state.nw.loading = false;
    renderLocal();
  }
}

function initLocal() {
  const cfg = state.config.local;
  if (!cfg.news && !cfg.announcements) return;
  if (cfg.news) {
    $("nw-show-chip").hidden = false;
    state.nw.show = store.get("nwShow") !== "0";
    $("nw-show").checked = state.nw.show;
    $("nw-show").addEventListener("change", (e) => setLayer("news", e.target.checked));
  }
  if (cfg.announcements) {
    $("bk-show-chip").hidden = false;
    state.bk.show = store.get("bkShow") === "1";
    $("bk-show").checked = state.bk.show;
    $("bk-show").addEventListener("change", (e) => setLayer("announcements", e.target.checked));
  }
  const saved = store.get("bkCats2");
  if (saved != null) state.bk.cats = new Set(saved.split(",").filter(Boolean));
  state.bk.important = store.get("bkImportant") !== "0";
  state.bk.sort = store.get("bkSort") || "relevant";
  document.querySelectorAll("[data-bk]").forEach((el) => {
    const cats = el.dataset.bk.split(",");
    el.checked = cats.every((c) => state.bk.cats.has(c));
    el.addEventListener("change", () => {
      cats.forEach((c) => (el.checked ? state.bk.cats.add(c) : state.bk.cats.delete(c)));
      store.set("bkCats2", [...state.bk.cats].join(","));
      state.bk.showAll = false;
      renderLocal();
    });
  });
  $("bk-important").checked = state.bk.important;
  $("bk-important").addEventListener("change", (e) => {
    state.bk.important = e.target.checked;
    store.set("bkImportant", state.bk.important ? "1" : "0");
    renderLocal();
  });
  $("bk-sort").value = state.bk.sort;
  $("bk-sort").addEventListener("change", (e) => {
    state.bk.sort = e.target.value;
    store.set("bkSort", state.bk.sort);
    renderLocal();
  });
  $("nw-more").addEventListener("click", () => { state.nw.showAll = true; renderLocal(); });
  $("bk-more").addEventListener("click", () => { state.bk.showAll = true; renderLocal(); });
  loadLocal(true).catch(console.error);
  setInterval(() => loadLocal().catch(console.error), LOCAL_REFRESH_MS);
}

// ---------- wegwerkzaamheden ----------

const RW_COLORS = { closed: "#dc2626", hinder: "#ea580c", event: "#7c3aed" };
const RW_PAGE = 12;
const rwLayer = L.layerGroup().addTo(map);
const rwMarkers = new Map();
let rwPendingPopup = null;

function rwTone(w) {
  return w.kind === "evenement" ? "event" : w.closed ? "closed" : "hinder";
}

/** Wat merk je ervan: "Weg dicht in beide richtingen · omleiding". */
function rwImpact(w, short = false) {
  const closedText = w.warnings.find((x) => /dicht|afgesloten/i.test(x));
  let text = closedText || (w.closed ? "Deels afgesloten" : w.warnings[0])
    || (w.speed ? `Max. ${w.speed} km/u` : w.kind === "evenement" ? "Evenement" : "Hinder");
  if (short && text.length > 60) text = `${text.slice(0, 57).trimEnd()}…`;
  if (w.speed && !text.includes("km/u")) text += ` · max. ${w.speed} km/u`;
  if (w.detour) text += " · omleiding";
  return text;
}

const AMS = { timeZone: "Europe/Amsterdam" };
function fmtDay2(ts) {
  return new Date(ts * 1000).toLocaleDateString("nl-NL", { ...AMS, day: "numeric", month: "short" });
}
function fmtWhen(ts) {
  const d = new Date(ts * 1000);
  const sameDay = d.toLocaleDateString("nl-NL", AMS) === new Date().toLocaleDateString("nl-NL", AMS);
  const time = d.toLocaleTimeString("nl-NL", { ...AMS, hour: "2-digit", minute: "2-digit" });
  return sameDay ? `vandaag ${time}` : `${fmtDay2(ts)} ${time}`;
}

/** "t/m 19 okt", "tot 16:00" of "vanaf 3 okt 07:00". */
function rwPeriod(w) {
  const now = Date.now() / 1000;
  if (w.start && w.start > now) return `vanaf ${fmtWhen(w.start)}`;
  if (!w.end) return "tot nader bericht";
  return w.end - now < 86400 ? `tot ${fmtWhen(w.end).replace("vandaag ", "")}` : `t/m ${fmtDay2(w.end)}`;
}

function rwWhere(w) {
  // Kaartitems hebben zelf geen straatnaam; de lijst (met PDOK-straatnaam) vaak wel.
  const street = w.street || state.rw.near.find((x) => x.id === w.id)?.street;
  return street || w.road || w.note || w.cause || "Wegwerk";
}

function rwWhat(w) {
  const what = w.kind === "evenement" ? (w.note || "Evenement") : (w.cause || w.note || "");
  return what === rwWhere(w) ? "" : what;
}

function rwVisible(w) {
  return (state.rw.planned || w.active) && (!state.rw.onlyClosed || w.closed);
}

function rwPopup(w) {
  const tone = rwTone(w);
  const period = w.start && w.end ? `${fmtWhen(w.start)} – ${fmtWhen(w.end)}` : rwPeriod(w);
  const what = rwWhat(w);
  const d = state.location ? haversine(state.location.lat, state.location.lon, w.lat, w.lon) : null;
  return `
    <b>${esc(rwWhere(w))}</b><br>
    <span class="rw-impact ${tone}">${esc(rwImpact(w))}</span><br>
    <small>${esc(period)}${d != null ? ` · ${esc(fmtDistance(d))}` : ""}</small>
    ${what ? `<div>${esc(what)}</div>` : ""}
    ${w.details.map((x) => `<div><small>${esc(x)}</small></div>`).join("")}
    <div><small>${esc(w.source)}</small></div>
    <div class="popup-links">
      ${w.url ? `<a href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${icon("file-text")}Tekening</a>` : ""}
      ${routeLink(w.lat, w.lon)}
    </div>`;
}

function rwIcon(w) {
  const tone = rwTone(w);
  return L.divIcon({
    className: "rw-marker",
    html: `<div class="rw-sign ${tone}${w.active ? "" : " planned"}">${icon(tone === "event" ? "party-popper" : "construction")}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function renderRoadworks() {
  const reopen = rwPendingPopup ?? openPopupId(rwMarkers);
  rwLayer.clearLayers();
  rwMarkers.clear();
  const cfg = state.config.roadworks;
  if (!state.rw.show || map.getZoom() < cfg.min_zoom) return;
  for (const w of state.rw.items) {
    if (!rwVisible(w)) continue;
    const color = RW_COLORS[rwTone(w)];
    const marker = L.marker([w.lat, w.lon], { icon: rwIcon(w), keyboard: false, zIndexOffset: -300 })
      .bindPopup(() => rwPopup(w), { maxWidth: 300 });
    for (const line of w.lines) {
      L.polyline(line, { color, weight: 5, opacity: w.active ? 0.85 : 0.5, dashArray: w.active ? null : "6 6" })
        .on("click", () => marker.openPopup())
        .addTo(rwLayer);
    }
    marker.addTo(rwLayer);
    rwMarkers.set(w.id, marker);
  }
  if (reopen != null && rwMarkers.has(reopen)) {
    rwMarkers.get(reopen).openPopup();
    rwPendingPopup = null;
  }
}

function rwListItem(w) {
  const li = document.createElement("li");
  li.className = "item roadwork";
  li.tabIndex = 0;
  li.style.setProperty("--c", w.active ? RW_COLORS[rwTone(w)] : "#9ca3af");
  const bar = document.createElement("span");
  bar.className = "bar";
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = rwWhere(w);
  const distEl = document.createElement("span");
  distEl.className = "dist";
  distEl.textContent = w.distance_m != null ? fmtDistance(w.distance_m) : "";
  const meta = document.createElement("span");
  meta.className = "meta";
  const impact = document.createElement("span");
  impact.className = `rw-impact ${rwTone(w)}`;
  impact.textContent = rwImpact(w, true);
  meta.append(impact, ` · ${rwPeriod(w)}`);
  const extra = rwWhat(w);
  if (extra) meta.append(` · ${extra}`);
  li.append(bar, what, distEl, meta);
  const open = () => {
    rwPendingPopup = w.id;
    if (!w.active && !state.rw.planned) { state.rw.planned = true; $("rw-planned").checked = true; }
    setLayer("roadworks", true);
    map.setView([w.lat, w.lon], Math.max(map.getZoom(), state.config.roadworks.min_zoom, 16));
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function rwNearItems() {
  return state.rw.near.filter((w) => rwVisible(w) && w.distance_m <= state.config.roadworks.list_radius_m);
}

function renderRoadworksList() {
  const cfg = state.config.roadworks;
  if (!cfg.enabled) return;
  $("rw-title").textContent = `Wegwerk binnen ${fmtDistance(cfg.list_radius_m)}`;
  const items = rwNearItems();
  const shown = state.rw.showAll ? items : items.slice(0, RW_PAGE);
  $("list-rw").replaceChildren(...shown.map(rwListItem));
  $("rw-more").hidden = shown.length >= items.length;
  $("rw-more").textContent = `Alle ${items.length} tonen`;
  const empty = $("empty-rw");
  empty.textContent = !state.location ? "Nog geen locatie bekend."
    : state.rw.onlyClosed ? "Geen afgesloten wegen in de buurt." : "Geen wegwerkzaamheden in de buurt.";
  empty.hidden = items.length > 0;
  renderOverview();
}

let rwSeq = 0;
let rwTimer = null;
function scheduleRoadworksViewport() {
  clearTimeout(rwTimer);
  rwTimer = setTimeout(async () => {
    const cfg = state.config.roadworks;
    if (!cfg.enabled || !state.rw.show || map.getZoom() < cfg.min_zoom) {
      state.rw.items = [];
      renderRoadworks();
      return;
    }
    const b = map.getBounds();
    const seq = ++rwSeq;
    try {
      const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
      const items = await api(`/api/roadworks?bbox=${bbox}&planned=true`);
      if (seq !== rwSeq) return;
      const now = Date.now() / 1000;
      items.forEach((w) => { w.active = (!w.start || w.start <= now) && (!w.end || w.end >= now); });
      state.rw.items = items;
      renderRoadworks();
    } catch (err) { console.warn("Wegwerk:", err.message); }
  }, 250);
}

async function loadRoadworksNear(force) {
  const cfg = state.config.roadworks;
  const loc = state.location;
  if (!cfg.enabled || !loc) return renderRoadworksList();
  const from = state.rw.nearFrom;
  if (!force && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < cfg.list_radius_m / 4) {
    return renderRoadworksList();
  }
  state.rw.nearFrom = { lat: loc.lat, lon: loc.lon };
  const bbox = bboxAround(loc.lat, loc.lon, cfg.list_radius_m).map((v) => v.toFixed(5)).join(",");
  state.rw.near = await api(`/api/roadworks?bbox=${bbox}&planned=true&near=${loc.lat.toFixed(5)},${loc.lon.toFixed(5)}&limit=150`);
  renderRoadworksList();
}

function initRoadworks() {
  if (!state.config.roadworks.enabled) return;
  $("rw-show-chip").hidden = false;
  state.rw.show = store.get("rwShow") === "1";
  state.rw.planned = store.get("rwPlanned") === "1";
  state.rw.onlyClosed = store.get("rwClosed") === "1";
  $("rw-show").checked = state.rw.show;
  $("rw-planned").checked = state.rw.planned;
  $("rw-closed").checked = state.rw.onlyClosed;
  $("rw-show").addEventListener("change", (e) => setLayer("roadworks", e.target.checked));
  const refilter = () => { state.rw.showAll = false; renderRoadworks(); renderRoadworksList(); };
  $("rw-planned").addEventListener("change", (e) => {
    state.rw.planned = e.target.checked;
    store.set("rwPlanned", state.rw.planned ? "1" : "0");
    refilter();
  });
  $("rw-closed").addEventListener("change", (e) => {
    state.rw.onlyClosed = e.target.checked;
    store.set("rwClosed", state.rw.onlyClosed ? "1" : "0");
    refilter();
  });
  $("rw-more").addEventListener("click", () => { state.rw.showAll = true; renderRoadworksList(); });
  scheduleRoadworksViewport();
  loadRoadworksNear(true).catch(console.error);
}

// ---------- openbaar vervoer ----------

const OV_REFRESH_MS = 30000;
const OV_BOARD = 12;          // zoveel vertrekken meteen in het vertrekbord
const OV_NEAR_DEPS = 4;       // en zoveel per halte in de lijst
const OV_DETAIL_ZOOM = 16;    // vanaf hier de lijnen met alle bochten
// Eigen lagen: lijnen boven de parkeervlakken, de gekozen rit daar weer boven.
map.createPane("ovLines").style.zIndex = 410;
map.createPane("ovTrip").style.zIndex = 420;
const ovRenderer = L.canvas({ pane: "ovLines", padding: 0.3, tolerance: 6 });
const ovTripRenderer = L.canvas({ pane: "ovTrip", padding: 0.3 });
const ovLineLayer = L.layerGroup().addTo(map);
const ovTripLayer = L.layerGroup().addTo(map);
const ovStopLayer = L.layerGroup().addTo(map);
const ovVehicleLayer = L.layerGroup().addTo(map);
const ovStopMarkers = new Map();
const ovVehicleMarkers = new Map();
const ovLinePaths = [];       // [{ route, polyline }] van de getekende lijnen
let ovPendingPopup = null;    // halte waarvan het vertrekbord open moet zodra de marker er is

function ovClock(ts) {
  return new Date(ts * 1000).toLocaleTimeString("nl-NL", { ...AMS, hour: "2-digit", minute: "2-digit" });
}

function ovBbox(pad = 0) {
  const b = map.getBounds().pad(pad);
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

function ovModesParam() {
  return state.ov.modes.size === Ov.MODE_ORDER.length ? "" : `&modes=${[...state.ov.modes].join(",")}`;
}

function ovEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

/** Lijnbordje: "7" in de kleur van de lijn. */
function ovBadge(item, small = false) {
  const { bg, fg } = Ov.badgeColors(item);
  const el = ovEl("span", `ov-badge${small ? " small" : ""}`, Ov.lineLabel(item));
  el.style.background = bg;
  el.style.color = fg;
  el.title = `${Ov.modeInfo(item.mode).label} ${item.line || ""}`.trim();
  return el;
}

/** Eén vertrek: bordje, bestemming, tijd en (bij actuele gegevens) vertraging of "rijdt niet". */
function ovDepRow(d, now) {
  const li = ovEl("li", `ov-dep${d.canceled ? " canceled" : ""}`);
  const main = ovEl("span", "ov-dest", d.headsign || d.product || "");
  const parts = [];   // stukjes van de regel eronder, elk een tekst of element
  const late = Ov.delayText(d.delay);
  // Vertrek over meer dan een uur staat rechts al als kloktijd; alleen herhalen als die afwijkt.
  if (d.canceled || late || d.expected - now < 3600) {
    const clock = [ovEl(d.canceled ? "s" : "span", "", ovClock(d.time))];
    if (late && !d.canceled) clock.push(" ", ovEl("span", Ov.delayMinutes(d.delay) > 0 ? "ov-late" : "ov-early", late));
    parts.push(clock);
  }
  if (d.canceled) parts.push([ovEl("span", "ov-cancel", "rijdt niet")]);
  if (d.new_platform) parts.push([ovEl("span", "ov-cancel", `spoor ${d.new_platform}`), ` (was ${d.platform})`]);
  else if (d.platform) parts.push([`${d.mode === "trein" ? "spoor" : "perron"} ${d.platform}`]);
  if (d.mode === "trein" && d.product && Ov.lineLabel(d) !== d.product) parts.push([d.product]);
  const meta = ovEl("span", "ov-meta");
  parts.forEach((p, i) => meta.append(...(i ? [" · "] : []), ...p));
  const when = ovEl("span", "ov-when");
  if (d.realtime && !d.canceled) when.append(ovEl("span", "ov-live"));
  when.append(d.canceled ? "—" : Ov.untilText(d.expected, now, ovClock));
  li.append(ovBadge(d), main, when);
  if (parts.length) li.append(meta);
  return li;
}

function ovStatusText(ts) {
  if (!ts) return "Geen actuele gegevens: tijden volgens de dienstregeling.";
  return `Live · bijgewerkt ${ovClock(ts)}`;
}

// --- vertrekbord (popup van een halte) ---

async function ovShowBoard(h, popup, showAll = false) {
  let data;
  try {
    data = await api(`/api/ov/departures?halte=${h.id}&limit=40`);
  } catch (err) {
    popup.setContent(`<b>${esc(h.name)}</b><p class="empty">Vertrektijden niet beschikbaar (${esc(err.message)}).</p>`);
    return;
  }
  if (!popup.isOpen()) return;
  const now = Date.now() / 1000;
  const box = ovEl("div", "ov-board");
  const head = ovEl("div", "ov-board-head");
  head.append(ovEl("b", "", h.name));
  const lines = ovEl("div", "ov-lines");
  for (const l of h.lines.slice(0, 18)) lines.append(ovBadge(l, true));
  if (h.lines.length > 18) lines.append(ovEl("small", "", `+${h.lines.length - 18}`));
  box.append(head, lines);
  for (const a of data.alerts) {
    const alert = ovEl("details", "ov-alert");
    const sum = ovEl("summary", "", a.header);
    alert.append(sum);
    if (a.description && a.description !== a.header) alert.append(ovEl("div", "", a.description));
    box.append(alert);
  }
  const deps = data.departures;
  const list = ovEl("ol", "ov-deps");
  const shown = showAll ? deps : deps.slice(0, OV_BOARD);
  for (const d of shown) {
    const row = ovDepRow(d, now);
    row.tabIndex = 0;
    row.title = "Bekijk de hele rit";
    const open = () => ovShowTrip(d.trip, d.date, popup, () => ovShowBoard(h, popup, showAll));
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    list.append(row);
  }
  box.append(deps.length ? list : ovEl("p", "empty", "Geen vertrekken in de komende 24 uur."));
  if (!showAll && deps.length > OV_BOARD) {
    const more = ovEl("button", "more-btn", "Meer vertrekken");
    more.type = "button";
    more.addEventListener("click", () => ovShowBoard(h, popup, true));
    box.append(more);
  }
  const foot = ovEl("div", "popup-links");
  foot.append(ovEl("small", "ov-foot", ovStatusText(data.realtime_ts)));
  box.append(foot);
  const nav = document.createElement("span");
  nav.innerHTML = routeLink(h.lat, h.lon);
  foot.append(nav.firstChild);
  popup.setContent(box);
  popup._ovRefresh = () => ovShowBoard(h, popup, showAll);
}

/** Houd een open vertrekbord (of rit) actueel zolang de popup openstaat. */
function ovAutoRefresh(popup) {
  clearInterval(popup._ovTimer);
  popup._ovTimer = setInterval(() => {
    if (!popup.isOpen()) { clearInterval(popup._ovTimer); return; }
    if (document.visibilityState === "visible" && popup._ovRefresh) popup._ovRefresh();
  }, OV_REFRESH_MS);
}

// --- één rit ---

function ovDrawTrip(trip) {
  ovTripLayer.clearLayers();
  const color = Ov.lineColor(trip);
  L.polyline(trip.shape, { renderer: ovTripRenderer, color: "#fff", weight: 10, opacity: 0.9, interactive: false }).addTo(ovTripLayer);
  L.polyline(trip.shape, { renderer: ovTripRenderer, color, weight: 6, opacity: 1, interactive: false }).addTo(ovTripLayer);
  for (const s of trip.stops) {
    L.circleMarker([s.lat, s.lon], { renderer: ovTripRenderer, radius: 4, color, weight: 2, fillColor: "#fff",
      fillOpacity: 1, interactive: false }).addTo(ovTripLayer);
  }
}

async function ovShowTrip(tripId, date, popup, back) {
  let trip;
  try {
    trip = await api(`/api/ov/trip?trip=${encodeURIComponent(tripId)}&date=${date}`);
  } catch (err) {
    console.warn("Rit:", err.message);
    return;
  }
  if (!popup.isOpen()) return;
  ovDrawTrip(trip);
  const now = Date.now() / 1000;
  const box = ovEl("div", "ov-board");
  if (back) {
    const btn = ovEl("button", "ov-back", "← Vertrektijden");
    btn.type = "button";
    btn.addEventListener("click", () => { ovTripLayer.clearLayers(); back(); });
    box.append(btn);
  }
  const head = ovEl("div", "ov-board-head");
  head.append(ovBadge(trip), ovEl("b", "", ` ${trip.headsign}`));
  box.append(head);
  if (trip.canceled) box.append(ovEl("p", "ov-cancel", "Deze rit rijdt niet."));
  const list = ovEl("ol", "ov-trip");
  let next = null;
  for (const s of trip.stops) {
    const past = s.expected < now - 30;
    const li = ovEl("li", `${past ? "past" : ""}${s.canceled ? " canceled" : ""}`);
    const t = ovEl("span", "ov-when");
    if (s.realtime && !s.canceled) t.append(ovEl("span", "ov-live"));
    t.append(ovClock(s.canceled ? s.time : s.expected));
    const late = Ov.delayText(s.delay);
    li.append(t, ovEl("span", "ov-sname", s.name.replace(/^[^,]+,\s*/, "")));
    if (s.canceled) li.append(ovEl("span", "ov-cancel", " vervalt"));
    else if (late) li.append(ovEl("span", Ov.delayMinutes(s.delay) > 0 ? "ov-late" : "ov-early", ` ${late}`));
    if (!past && !next) { next = li; li.classList.add("next"); }
    list.append(li);
  }
  box.append(list, ovEl("small", "ov-foot", `${trip.agency || ""} · ${ovStatusText(trip.realtime ? state.ov.realtimeTs || now : null)}`));
  popup.setContent(box);
  popup._ovRefresh = () => ovShowTrip(tripId, date, popup, back);
  if (next) next.scrollIntoView({ block: "center" });
}

// --- haltes op de kaart ---

function ovStopVisible(h) {
  return !h.modes.length || h.modes.some((m) => state.ov.modes.has(m));
}

function ovStopIcon(h) {
  const mode = h.modes[0] || "bus";
  const info = Ov.modeInfo(mode);
  return `<div class="ov-stop" style="--c:${info.color}">${icon(info.icon)}</div>`;
}

function ovMakeStopMarker(h) {
  const marker = spreadMarker(h.lat, h.lon, ovStopIcon(h), "ov-stop-marker", 20, [0, 0], h.name, 200);
  marker.bindPopup(() => `<b>${esc(h.name)}</b><p class="empty">Vertrektijden laden…</p>`,
    { maxWidth: 340, minWidth: 260, className: "ov-popup" });
  marker.on("popupopen", (e) => { ovShowBoard(h, e.popup); ovAutoRefresh(e.popup); });
  marker.on("popupclose", () => ovTripLayer.clearLayers());
  marker._ovLabel = map.getZoom() >= LABEL_ZOOM;
  return marker;
}

function renderOvStops() {
  const cfg = state.config.ov;
  const on = state.ov.show && state.ov.parts.has("stops") && map.getZoom() >= cfg.stops_min_zoom;
  const wanted = new Map(on ? state.ov.haltes.filter(ovStopVisible).map((h) => [h.id, h]) : []);
  const label = map.getZoom() >= LABEL_ZOOM;
  for (const [id, marker] of ovStopMarkers) {
    // Een open vertrekbord laten staan, ook als de halte net buiten beeld valt.
    if (marker.isPopupOpen()) continue;
    if (!wanted.has(id) || marker._ovLabel !== label) {
      ovStopLayer.removeLayer(marker);
      ovStopMarkers.delete(id);
    }
  }
  for (const [id, h] of wanted) {
    if (ovStopMarkers.has(id)) continue;
    const marker = ovMakeStopMarker(h).addTo(ovStopLayer);
    ovStopMarkers.set(id, marker);
  }
  if (ovPendingPopup != null && ovStopMarkers.has(ovPendingPopup)) {
    ovStopMarkers.get(ovPendingPopup).openPopup();
    ovPendingPopup = null;
  }
}

// --- lijnen op de kaart ---

function renderOvLines() {
  ovLineLayer.clearLayers();
  ovLinePaths.length = 0;
  const cfg = state.config.ov;
  if (!state.ov.show || !state.ov.parts.has("lines") || map.getZoom() < cfg.lines_min_zoom) return;
  const weight = map.getZoom() >= 15 ? 4 : 3;
  // Bus onderop, trein bovenop: de zeldzame, belangrijke lijnen blijven zichtbaar.
  const order = [...state.ov.lines].sort((a, b) => Ov.MODE_ORDER.indexOf(b.mode) - Ov.MODE_ORDER.indexOf(a.mode));
  for (const route of order) {
    if (!state.ov.modes.has(route.mode)) continue;
    const color = Ov.lineColor(route);
    for (const path of route.paths) {
      const line = L.polyline(path, { renderer: ovRenderer, color, weight, opacity: 0.75 })
        .on("click", (e) => ovLinePopup(e.latlng))
        .addTo(ovLineLayer);
      ovLinePaths.push({ route, line });
    }
  }
}

/** Alle lijnen vlak bij een klik (op drukke plekken liggen er vaak meerdere over elkaar). */
function ovLinesAt(latlng, px = 10) {
  const p = map.latLngToLayerPoint(latlng);
  const found = new Map();
  for (const { route, line } of ovLinePaths) {
    if (found.has(route.id)) continue;
    const pts = line.getLatLngs().map((ll) => map.latLngToLayerPoint(ll));
    for (let i = 1; i < pts.length; i++) {
      if (L.LineUtil.pointToSegmentDistance(p, pts[i - 1], pts[i]) <= px) { found.set(route.id, route); break; }
    }
  }
  return [...found.values()].sort((a, b) => Ov.MODE_ORDER.indexOf(a.mode) - Ov.MODE_ORDER.indexOf(b.mode)
    || String(a.line).localeCompare(String(b.line), "nl", { numeric: true }));
}

function ovHighlight(routeId) {
  for (const { route, line } of ovLinePaths) {
    const on = route.id === routeId;
    line.setStyle({ weight: on ? 7 : (map.getZoom() >= 15 ? 4 : 3), opacity: routeId == null || on ? 0.75 : 0.25 });
    if (on) line.bringToFront();
  }
}

function ovLinePopup(latlng) {
  const routes = ovLinesAt(latlng);
  if (!routes.length) return;
  const box = ovEl("div", "ov-board");
  box.append(ovEl("b", "", routes.length === 1 ? "Lijn" : `${routes.length} lijnen hier`));
  const list = ovEl("ul", "ov-route-list");
  for (const r of routes.slice(0, 12)) {
    const li = ovEl("li");
    li.tabIndex = 0;
    li.append(ovBadge(r), ovEl("span", "", ` ${r.name || Ov.modeInfo(r.mode).label}`));
    if (r.agency) li.append(ovEl("small", "", ` · ${r.agency}`));
    li.addEventListener("mouseenter", () => ovHighlight(r.id));
    li.addEventListener("click", () => ovHighlight(r.id));
    list.append(li);
  }
  box.append(list);
  if (routes.length === 1) ovHighlight(routes[0].id);
  L.popup({ maxWidth: 320, className: "ov-popup" }).setLatLng(latlng).setContent(box)
    .on("remove", () => ovHighlight(null)).openOn(map);
}

// --- voertuigen ---

function ovVehicleIcon(v) {
  const { bg, fg } = Ov.badgeColors(v);
  const late = Ov.delayMinutes(v.delay) >= 3 ? " late" : "";
  return L.divIcon({
    className: "ov-veh-marker",
    html: `<div class="ov-veh${late}" style="background:${bg};color:${fg}">${esc(Ov.lineLabel(v))}</div>`,
    iconSize: [30, 18], iconAnchor: [15, 9], popupAnchor: [0, -9],
  });
}

function ovVehiclePopup(v, popup) {
  const box = ovEl("div", "ov-board");
  const head = ovEl("div", "ov-board-head");
  head.append(ovBadge(v), ovEl("b", "", ` ${v.headsign}`));
  box.append(head);
  const late = Ov.delayText(v.delay);
  const info = ovEl("div", "ov-meta");
  info.append(late ? ovEl("span", Ov.delayMinutes(v.delay) > 0 ? "ov-late" : "ov-early", late) : "op tijd",
    v.ts ? ` · positie van ${fmtAgo(v.ts)}` : "", v.agency ? ` · ${v.agency}` : "");
  box.append(info);
  if (v.trip && v.date) {
    const btn = ovEl("button", "more-btn", "Hele rit bekijken");
    btn.type = "button";
    btn.addEventListener("click", () => ovShowTrip(v.trip, v.date, popup, () => popup.setContent(ovVehiclePopup(v, popup))));
    box.append(btn);
  }
  return box;
}

function renderOvVehicles() {
  const cfg = state.config.ov;
  const on = state.ov.show && state.ov.parts.has("vehicles") && map.getZoom() >= cfg.vehicles_min_zoom;
  const seen = new Set();
  for (const v of on ? state.ov.vehicles : []) {
    if (!state.ov.modes.has(v.mode)) continue;
    seen.add(v.id);
    let marker = ovVehicleMarkers.get(v.id);
    if (!marker) {
      marker = L.marker([v.lat, v.lon], { icon: ovVehicleIcon(v), keyboard: false, zIndexOffset: 600 });
      marker.bindPopup("", { maxWidth: 340, minWidth: 220, className: "ov-popup" });
      marker.on("popupopen", (e) => { e.popup.setContent(ovVehiclePopup(marker._ov, e.popup)); e.popup._ovRefresh = null; ovAutoRefresh(e.popup); });
      marker.on("popupclose", () => ovTripLayer.clearLayers());
      marker.addTo(ovVehicleLayer);
      ovVehicleMarkers.set(v.id, marker);
    } else {
      marker.setLatLng([v.lat, v.lon]);
      if (Ov.delayMinutes(marker._ov.delay) !== Ov.delayMinutes(v.delay)) marker.setIcon(ovVehicleIcon(v));
    }
    marker._ov = v;
  }
  for (const [id, marker] of ovVehicleMarkers) {
    if (!seen.has(id)) { ovVehicleLayer.removeLayer(marker); ovVehicleMarkers.delete(id); }
  }
}

// Voertuigen schuiven soepel naar hun nieuwe plek, maar niet tijdens het zoomen.
map.on("zoomstart", () => map.getContainer().classList.add("ov-still"));
map.on("zoomend", () => setTimeout(() => map.getContainer().classList.remove("ov-still"), 50));

// --- gegevens ophalen voor wat er in beeld is ---

function ovCovers(area, bbox) {
  return area && bbox[0] >= area[0] && bbox[1] >= area[1] && bbox[2] <= area[2] && bbox[3] <= area[3];
}

let ovSeq = 0;
let ovTimer = null;
function scheduleOvViewport(forceVehicles = false) {
  clearTimeout(ovTimer);
  ovTimer = setTimeout(() => loadOvViewport(forceVehicles).catch((err) => console.warn("OV:", err.message)), 250);
}

async function loadOvViewport(forceVehicles) {
  const cfg = state.config.ov;
  if (!cfg.enabled) return;
  const z = map.getZoom();
  const seq = ++ovSeq;
  const view = ovBbox();
  const jobs = [];
  if (state.ov.show && cfg.ready && state.ov.parts.has("stops") && z >= cfg.stops_min_zoom) {
    if (!ovCovers(state.ov.haltesArea, view)) {
      const area = ovBbox(0.5);
      jobs.push(api(`/api/ov/haltes?bbox=${area.map((v) => v.toFixed(5)).join(",")}`).then((haltes) => {
        if (seq !== ovSeq) return;
        state.ov.haltes = haltes;
        state.ov.haltesArea = area;
      }));
    }
  }
  if (state.ov.show && cfg.ready && state.ov.parts.has("lines") && z >= cfg.lines_min_zoom) {
    const detailed = z >= OV_DETAIL_ZOOM;
    const key = `${detailed}`;
    if (!ovCovers(state.ov.linesArea, view) || state.ov.linesKey !== key) {
      const area = ovBbox(0.5);
      jobs.push(api(`/api/ov/lines?bbox=${area.map((v) => v.toFixed(5)).join(",")}&detailed=${detailed}`).then((lines) => {
        if (seq !== ovSeq) return;
        state.ov.lines = lines;
        state.ov.linesArea = area;
        state.ov.linesKey = key;
      }));
    }
  }
  if (state.ov.show && state.ov.parts.has("vehicles") && z >= cfg.vehicles_min_zoom) {
    if (forceVehicles || !ovCovers(state.ov.vehiclesArea, view)) {
      const area = ovBbox(0.3);
      jobs.push(api(`/api/ov/vehicles?bbox=${area.map((v) => v.toFixed(5)).join(",")}`).then((data) => {
        if (seq !== ovSeq) return;
        state.ov.vehicles = data.vehicles;
        state.ov.vehiclesArea = area;
        state.ov.realtimeTs = data.realtime_ts;
      }));
    }
  }
  await Promise.all(jobs);
  if (seq !== ovSeq) return;
  renderOvStops();
  if (jobs.length || state.ov.linesZoom !== z) { renderOvLines(); state.ov.linesZoom = z; }
  renderOvVehicles();
}

/** Lijnen, haltes en voertuigen opnieuw tekenen (bijv. na het wijzigen van een filter). */
function renderOv() {
  renderOvStops();
  renderOvLines();
  renderOvVehicles();
}

// --- haltes in de buurt (rechterpaneel) ---

function ovListItem(h, now) {
  const li = ovEl("li", "item ov-halte");
  li.tabIndex = 0;
  const bar = ovEl("span", "bar");
  bar.style.background = Ov.modeInfo(h.modes[0]).color;
  const lines = ovEl("span", "meta ov-lines");
  for (const l of h.lines.slice(0, 10)) lines.append(ovBadge(l, true));
  if (h.lines.length > 10) lines.append(ovEl("small", "", ` +${h.lines.length - 10}`));
  li.append(bar, ovEl("span", "what", h.name), ovEl("span", "dist", fmtDistance(h.distance_m)), lines);
  const deps = Ov.filterModes(h.departures, state.ov.modes);
  if (deps.length) {
    const list = ovEl("ol", "ov-deps meta");
    for (const d of deps.slice(0, OV_NEAR_DEPS)) list.append(ovDepRow(d, now));
    li.append(list);
  } else {
    li.append(ovEl("span", "meta", "Geen vertrekken in de komende 24 uur"));
  }
  const open = () => {
    ovPendingPopup = h.id;
    if (!state.ov.parts.has("stops")) ovSetPart("stops", true);
    setLayer("ov", true);
    map.setView([h.lat, h.lon], Math.max(map.getZoom(), state.config.ov.stops_min_zoom, 16));
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
    scheduleOvViewport();
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function renderOvList() {
  const cfg = state.config.ov;
  if (!cfg.enabled) return;
  $("ov-title").textContent = `Haltes binnen ${fmtDistance(cfg.list_radius_m)}`;
  $("ov-status").textContent = !cfg.ready
    ? (cfg.importing ? "De dienstregeling wordt ingelezen. Dat gebeurt één keer per dag en duurt een paar minuten."
      : "Nog geen dienstregeling; die wordt zo opgehaald (± 250 MB, daarna een paar minuten inlezen).")
    : ovStatusText(state.ov.realtimeTs);
  const now = Date.now() / 1000;
  const haltes = state.ov.near.filter(ovStopVisible);
  $("list-ov").replaceChildren(...haltes.map((h) => ovListItem(h, now)));
  const empty = $("empty-ov");
  empty.textContent = !state.location ? "Nog geen locatie bekend. Klik op een halte op de kaart voor de vertrektijden."
    : !cfg.ready ? "" : "Geen haltes in de buurt.";
  empty.hidden = haltes.length > 0 || !empty.textContent;
  renderOverview();
}

function ovSummary() {
  const now = Date.now() / 1000;
  const first = state.ov.near.flatMap((h) => Ov.filterModes(h.departures, state.ov.modes).map((d) => ({ h, d })))
    .filter((x) => !x.d.canceled && x.h.distance_m <= 400)
    .sort((a, b) => a.d.expected - b.d.expected)[0];
  if (!state.config.ov.ready) return "Dienstregeling laden…";
  if (!first) return state.ov.near.length ? `${state.ov.near.length} haltes in de buurt` : "Geen haltes in de buurt";
  const label = `${Ov.modeInfo(first.d.mode).label} ${Ov.lineLabel(first.d)}`;
  const until = Ov.untilText(first.d.expected, now, ovClock);
  const when = until === "nu" ? "nu" : until.endsWith("min") ? `over ${until}` : `om ${until}`;
  return `${label} ${when} · ${first.h.name.replace(/^[^,]+,\s*/, "")}`;
}

async function loadOvNear(force) {
  const cfg = state.config.ov;
  const loc = state.location;
  if (!cfg.enabled || !state.ov.show) return;
  if (!cfg.ready || !loc) return renderOvList();
  const from = state.ov.nearFrom;
  const fresh = Date.now() - state.ov.nearTs < OV_REFRESH_MS - 1000;
  if (!force && fresh && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < 100) return renderOvList();
  state.ov.nearFrom = { lat: loc.lat, lon: loc.lon };
  state.ov.nearTs = Date.now();
  const data = await api(`/api/ov/near?lat=${loc.lat.toFixed(5)}&lon=${loc.lon.toFixed(5)}&limit=6&departures=${OV_NEAR_DEPS + 2}`);
  state.ov.near = data.haltes;
  state.ov.realtimeTs = data.realtime_ts || state.ov.realtimeTs;
  renderOvList();
}

function ovSetPart(part, on) {
  on ? state.ov.parts.add(part) : state.ov.parts.delete(part);
  const input = document.querySelector(`[data-ovpart="${part}"]`);
  if (input) input.checked = on;
  store.set("ovParts", JSON.stringify([...state.ov.parts]));
}

async function ovReloadConfig() {
  try {
    const cfg = await api("/api/config");
    state.config.ov = cfg.ov;
  } catch (err) { console.warn("OV:", err.message); }
  state.ov.haltesArea = state.ov.linesArea = null;
  scheduleOvViewport(true);
  loadOvNear(true).catch(console.error);
}

function initOv() {
  const cfg = state.config.ov;
  if (!cfg.enabled) return;
  $("ov-show-chip").hidden = false;
  state.ov.show = store.get("ovShow") === "1";
  $("ov-show").checked = state.ov.show;
  $("ov-layers").hidden = $("ov-modes").hidden = !state.ov.show;
  try {
    const parts = JSON.parse(store.get("ovParts") || "null");
    if (Array.isArray(parts)) state.ov.parts = new Set(parts);
    const modes = JSON.parse(store.get("ovModes") || "null");
    if (Array.isArray(modes) && modes.length) state.ov.modes = new Set(modes);
  } catch { /* oude of kapotte waarde: standaard */ }
  document.querySelectorAll("[data-ovpart]").forEach((el) => {
    el.checked = state.ov.parts.has(el.dataset.ovpart);
    el.addEventListener("change", () => {
      ovSetPart(el.dataset.ovpart, el.checked);
      scheduleOvViewport(true);
      renderOv();
    });
  });
  document.querySelectorAll("[data-ovmode]").forEach((el) => {
    el.checked = state.ov.modes.has(el.dataset.ovmode);
    el.addEventListener("change", () => {
      el.checked ? state.ov.modes.add(el.dataset.ovmode) : state.ov.modes.delete(el.dataset.ovmode);
      store.set("ovModes", JSON.stringify([...state.ov.modes]));
      renderOv();
      renderOvList();
    });
  });
  $("ov-show").addEventListener("change", (e) => setLayer("ov", e.target.checked));
  // Voertuigen en vertrektijden actueel houden, maar alleen als je kijkt.
  setInterval(() => {
    if (!state.ov.show || document.visibilityState !== "visible") return;
    scheduleOvViewport(true);
    loadOvNear().catch(console.error);
  }, OV_REFRESH_MS);
  // Nog aan het inlezen: af en toe kijken of de dienstregeling klaar is (het SSE-bericht kan gemist zijn).
  setInterval(() => { if (!state.config.ov.ready && state.ov.show) ovReloadConfig(); }, 60000);
  scheduleOvViewport(true);
  loadOvNear(true).catch(console.error);
}

// ---------- navigatie ----------

const ROUTE_ICON = icon("navigation-2");

function routeLink(lat, lon) {
  const app = state.navApp === "auto" ? (/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) ? "Apple Kaarten" : "Google Maps")
    : Nav.APPS[state.navApp];
  return `<a class="route-link" href="${esc(Nav.routeUrl(lat, lon, state.navApp, navigator.userAgent))}" target="_blank" rel="noopener noreferrer" title="Open in ${esc(app)}">${ROUTE_ICON}Route</a>`;
}

/** Reistijd vanaf je locatie, bijv. "5 min lopen · 2 min fietsen". */
function etaTo(lat, lon, prefer) {
  if (!state.location) return "";
  return Nav.eta(haversine(state.location.lat, state.location.lon, lat, lon), prefer);
}

function etaSpan(text) {
  const span = document.createElement("span");
  span.className = "eta";
  span.textContent = text;
  return span;
}

function initNav() {
  state.navApp = store.get("navApp") || "auto";
  const select = $("nav-app");
  for (const [key, label] of Object.entries(Nav.APPS)) select.add(new Option(label, key));
  select.value = state.navApp;
  select.addEventListener("change", () => { state.navApp = select.value; store.set("navApp", select.value); });
}

// ---------- overzicht ----------

/** Zet een kaartlaag aan of uit (en onthoud dat per apparaat). */
function setLayer(layer, on) {
  const el = { incidents: "layer-incidents", cams: "layer-cams", parking: "pk-show", shops: "sh-show",
    charging: "ch-show", statiegeld: "sg-show", announcements: "bk-show", roadworks: "rw-show",
    news: "nw-show", ov: "ov-show", fuel: "fu-show" }[layer];
  if ($(el)) $(el).checked = on;
  if (layer === "incidents") { state.showIncidents = on; store.set("showIncidents", on ? "1" : "0"); renderIncidents(); }
  if (layer === "cams") { state.showCams = on; store.set("showCams", on ? "1" : "0"); $("cam-layers").hidden = !on; renderCams(); }
  if (layer === "parking") { state.pk.show = on; store.set("pkShow", on ? "1" : "0"); scheduleParkingViewport(); }
  if (layer === "charging") { state.ch.show = on; store.set("chShow", on ? "1" : "0"); scheduleChargingViewport(); }
  if (layer === "shops") { state.sh.show = on; store.set("shShow", on ? "1" : "0"); scheduleShopsViewport(); }
  if (layer === "fuel") { state.fu.show = on; store.set("fuShow", on ? "1" : "0"); scheduleFuelViewport(); }
  if (layer === "roadworks") { state.rw.show = on; store.set("rwShow", on ? "1" : "0"); scheduleRoadworksViewport(); }
  if (layer === "announcements") { state.bk.show = on; store.set("bkShow", on ? "1" : "0"); renderBkLayer(); }
  if (layer === "statiegeld") { state.sg.show = on; store.set("sgShow", on ? "1" : "0"); scheduleSgViewport(); }
  if (layer === "news") { state.nw.show = on; store.set("nwShow", on ? "1" : "0"); }
  if (layer === "ov") {
    state.ov.show = on;
    store.set("ovShow", on ? "1" : "0");
    $("ov-layers").hidden = $("ov-modes").hidden = !on;
    scheduleOvViewport(true);
    if (on) loadOvNear().catch(console.error);
  }
  // Rechts staat de inhoud van precies de lagen die links aanstaan.
  renderSections();  renderZoomHint();
}

// Lagen die pas vanaf een bepaald zoomniveau getekend worden (anders te veel/te zwaar).
const ZOOM_LAYERS = [
  { layer: "parking", input: "pk-show", name: "parkeerzones", on: () => state.pk.show, zoom: () => state.config.parking.min_zoom, enabled: () => state.config.parking.enabled },
  { layer: "statiegeld", input: "sg-show", name: "statiegeldpunten", on: () => state.sg.show, zoom: () => state.config.statiegeld.min_zoom, enabled: () => state.config.statiegeld.enabled },
  { layer: "shops", input: "sh-show", name: "winkels", on: () => state.sh.show, zoom: () => state.config.shops.min_zoom, enabled: () => state.config.shops.enabled },
  { layer: "fuel", input: "fu-show", name: "tankstations", on: () => state.fu.show, zoom: () => state.config.fuel.min_zoom, enabled: () => state.config.fuel.enabled },
  { layer: "roadworks", input: "rw-show", name: "wegwerk", on: () => state.rw.show, zoom: () => state.config.roadworks.min_zoom, enabled: () => state.config.roadworks.enabled },
  { layer: "ov", input: "ov-show", name: "openbaar vervoer", on: () => state.ov.show, zoom: () => state.config.ov.lines_min_zoom, enabled: () => state.config.ov.enabled },
  { layer: "cams", input: "layer-cams", name: "flitsers", on: () => state.showCams, zoom: () => CAM_MIN_ZOOM, enabled: () => state.config.speedcams_enabled },
  { layer: "charging", input: "ch-show", name: "laadpalen", on: () => state.ch.show, zoom: () => state.config.charging.min_zoom, enabled: () => state.config.charging.enabled },
];

function joinNames(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} en ${names[names.length - 1]}` : names[0];
}

/** Melding "zoom in om … te zien" met één knop die precies ver genoeg inzoomt. */
function renderZoomHint() {
  if (!state.config) return;
  const z = map.getZoom();
  const hidden = ZOOM_LAYERS.filter((l) => l.enabled() && l.on() && z < l.zoom());
  for (const l of ZOOM_LAYERS) {
    const row = $(l.input)?.closest(".layer-row");
    if (row) row.classList.toggle("needs-zoom", l.enabled() && l.on() && z < l.zoom());
  }
  $("zoom-hint").hidden = !hidden.length;
  if (!hidden.length) return;
  $("zoom-hint-text").textContent = `Zoom in om ${joinNames(hidden.map((l) => l.name))} te zien`;
  // Eén klik: tot het laagste niveau waarop de eerste verborgen laag verschijnt.
  $("zoom-hint-btn").onclick = () => map.setZoom(Math.min(...hidden.map((l) => l.zoom())));
}

function initZoomHelp() {
  for (const l of ZOOM_LAYERS) {
    // Wie een laag aanzet terwijl hij te ver is uitgezoomd, wil hem meteen zien.
    $(l.input)?.addEventListener("change", (e) => {
      if (e.target.checked && map.getZoom() < l.zoom()) map.setZoom(l.zoom());
      renderZoomHint();
    });
  }
  map.on("zoomend", renderZoomHint);
  renderZoomHint();
}

// Rechterpaneel: één sectie per ingeschakelde kaartlaag, in dezelfde volgorde als links.
const SECTION_ON = {
  parking: () => state.config.parking.enabled && state.pk.show,
  statiegeld: () => state.config.statiegeld.enabled && state.sg.show,
  shops: () => state.config.shops.enabled && state.sh.show,
  fuel: () => state.config.fuel.enabled && state.fu.show,
  roadworks: () => state.config.roadworks.enabled && state.rw.show,
  ov: () => state.config.ov.enabled && state.ov.show,
  charging: () => state.config.charging.enabled && state.ch.show,
  news: () => state.config.local.news && state.nw.show,
  announcements: () => state.config.local.announcements && state.bk.show,
  incidents: () => state.showIncidents,
};

function renderSections() {
  if (!state.config) return;
  let any = false;
  document.querySelectorAll(".lsec[data-layer]").forEach((sec) => {
    const on = SECTION_ON[sec.dataset.layer];
    if (!on) return;  // bijv. Instellingen: altijd zichtbaar
    sec.hidden = !on();
    any = any || !sec.hidden;
  });
  $("no-sections").hidden = any;
}

function setSectionOpen(sec, open) {
  sec.classList.toggle("collapsed", !open);
  sec.querySelector(".lsec-head").setAttribute("aria-expanded", String(open));
}

function initSections() {
  let closed;
  try { closed = new Set(JSON.parse(store.get("closedSections") || '["instellingen"]')); } catch { closed = new Set(); }
  document.querySelectorAll(".lsec").forEach((sec) => {
    setSectionOpen(sec, !closed.has(sec.dataset.sec));
    sec.querySelector(".lsec-head").addEventListener("click", () => {
      const open = sec.classList.contains("collapsed");
      setSectionOpen(sec, open);
      open ? closed.delete(sec.dataset.sec) : closed.add(sec.dataset.sec);
      store.set("closedSections", JSON.stringify([...closed]));
    });
  });
  renderSections();
}

function incidentsNear() {
  if (!state.location) return [];
  return [...state.incidents.values()].filter(isVisible)
    .map((inc) => ({ inc, d: distanceTo(inc) }))
    .filter((x) => x.d != null && x.d <= state.config.radius_m)
    .sort((a, b) => a.d - b.d);
}

function sgNearItems() {
  if (!state.location) return [];
  return state.sg.near
    .map((p) => ({ p, st: sgStatus(p), d: haversine(state.location.lat, state.location.lon, p.lat, p.lon) }))
    .filter((x) => x.d <= state.config.statiegeld.list_radius_m)
    .sort((a, b) => a.d - b.d);
}

/** Samenvatting per onderwerp: icoon + korte waarde. */
function summaryParts() {
  const parts = [];
  const near = incidentsNear();
  const sirenes = near.filter((x) => x.inc.sirene && Date.now() / 1000 - x.inc.ts < OLD_INCIDENT_S).length;
  parts.push({ icon: "siren", text: sirenes ? `${sirenes} ${sirenes > 1 ? "sirenes" : "sirene"} dichtbij` : String(near.length),
    alert: sirenes > 0, title: `112-meldingen binnen ${fmtDistance(state.config.radius_m)}` });
  if (state.config.shops.enabled && state.location) {
    const open = shNearItems().filter((x) => x.st.state === "open").length;
    parts.push({ icon: "shopping-cart", text: `${open} open`, title: "Winkels in de buurt die nu open zijn" });
  }
  if (state.config.parking.enabled && state.location) {
    const zone = state.pk.here.find((z) => z.kind === "betaald" || z.kind === "blauw");
    const st = zone && Parking.status(zone);
    const text = !st ? "vrij" : st.state === "paid" && st.rate != null
      ? `${fmtEur(st.rate)}/u` : st.state === "disc" ? "schijf" : st.state === "free" ? "gratis" : "?";
    parts.push({ icon: "square-parking", text, title: "Parkeren hier" });
  }
  if (state.config.charging.enabled && state.location) {
    const free = state.ch.near.filter((s) => Charging.availability(s).state === "free").length;
    parts.push({ icon: "zap", text: `${free} vrij`, title: `Laadpunten in de buurt (${chProfile().label})` });
  }
  if (state.config.statiegeld.enabled && state.location) {
    const open = sgNearItems().filter((x) => x.st.state === "open").length;
    parts.push({ icon: "recycle", text: `${open} open`, title: "Statiegeldpunten die nu open zijn" });
  }
  return parts;
}

function fmtEur(v) {
  return `€${v.toFixed(2).replace(".", ",")}`;
}

function renderSummary() {
  const el = $("summary");
  if (!state.location) {
    el.textContent = "Locatie onbekend";
    return;
  }
  el.replaceChildren(...summaryParts().map((p) => {
    const span = document.createElement("span");
    span.className = `sum-part${p.alert ? " urgent" : ""}`;
    span.append(iconEl(p.icon), p.text);
    span.title = p.title;
    return span;
  }));
}

function setSectionSummary(key, text, tone = "") {
  const sec = document.querySelector(`.lsec[data-sec="${key}"]`);
  if (!sec) return;
  sec.querySelector(".lsec-sum").textContent = text;
  sec.classList.toggle("urgent", tone === "urgent");
}

/** Bovenste regel en de korte samenvatting in elke sectiekop bijwerken. */
function renderOverview() {
  if (!state.config) return;
  renderSummary();
  renderSections();
  if (!state.location) {
    document.querySelectorAll(".lsec-sum").forEach((el) => { el.textContent = ""; });
    return;
  }
  const radius = fmtDistance(state.config.radius_m);
  const near = incidentsNear();
  const recentSirene = near.some((x) => x.inc.sirene && Date.now() / 1000 - x.inc.ts < OLD_INCIDENT_S);
  setSectionSummary("112", near.length
    ? `${near.length} melding${near.length > 1 ? "en" : ""} binnen ${radius} (${fmtWindow(state.windowMin)})`
    : `Rustig binnen ${radius} (${fmtWindow(state.windowMin)})`, recentSirene ? "urgent" : "");

  const lc = state.config.local;
  if (lc.news) {
    const n = state.nw.items.length;
    setSectionSummary("nieuws", state.nw.loading ? "Laden…" : n ? `${n} bericht${n === 1 ? "" : "en"}` : "Geen recent nieuws");
  }
  if (lc.announcements) {
    const n = bkItems().length;
    setSectionSummary("bekendmakingen", state.nw.loading ? "Laden…"
      : `${n} ${state.bk.important ? "belangrijke " : ""}binnen ${fmtDistance(lc.radius_m)}`);
  }
  if (state.config.roadworks.enabled) {
    const now = rwNearItems().filter((w) => w.active);
    const closed = now.filter((w) => w.closed).length;
    setSectionSummary("wegwerk", now.length
      ? `${closed} afsluiting${closed === 1 ? "" : "en"} · ${now.length} werk${now.length === 1 ? "" : "en"} nu`
      : "Niets nu binnen " + fmtDistance(state.config.roadworks.list_radius_m));
  }
  if (state.config.ov.enabled && state.ov.show) setSectionSummary("ov", ovSummary());
  if (state.config.fuel.enabled) setSectionSummary("tanken", fuSummary());
  if (state.config.shops.enabled) {
    const items = shNearItems().filter((x) => state.sh.kinds.has(x.p.kind));
    const open = items.filter((x) => x.st.state === "open");
    const late = open.filter((x) => x.p.late).length;
    setSectionSummary("winkels", items.length
      ? `${open.length} van ${items.length} nu open${late ? ` · ${late} laat open` : ""}` : "Geen winkels in de buurt");
  }
  if (state.config.parking.enabled) {
    const zones = state.pk.here.filter((z) => z.kind !== "vergunning");
    const permit = state.pk.here.some((z) => z.kind === "vergunning");
    const first = zones[0] && Parking.status(zones[0]);
    setSectionSummary("parkeren", first ? first.text : permit ? "Alleen met vergunning" : "Geen regeling bekend");
  }
  if (state.config.charging.enabled) {
    const free = state.ch.near.filter((s) => Charging.availability(s).state === "free").length;
    setSectionSummary("laden", state.ch.near.length ? `${free} van ${state.ch.near.length} vrij · ${chProfile().label}`
      : chProfile().label);
  }
  if (state.config.statiegeld.enabled) {
    const items = sgNearItems();
    const open = items.filter((x) => x.st.state === "open").length;
    setSectionSummary("statiegeld", items.length ? `${open} van ${items.length} nu open` : "Geen punten in de buurt");
  }
}

function fmtWindow(min) {
  return min < 60 ? `${min} min` : `${min / 60} uur`;
}

function initOverview() {
  state.showIncidents = store.get("showIncidents") !== "0";
  state.showCams = store.get("showCams") !== "0";
  $("layer-incidents").checked = state.showIncidents;
  $("layer-cams").checked = state.showCams;
  $("cam-layers").hidden = !state.showCams;
  $("layer-incidents").addEventListener("change", (e) => setLayer("incidents", e.target.checked));
  $("layer-cams").addEventListener("change", (e) => setLayer("cams", e.target.checked));
}

// ---------- data ----------

async function loadIncidents() {
  const list = await api(`/api/incidents?minutes=${state.windowMin}`);
  state.incidents = new Map(list.map((i) => [i.id, i]));
}

async function loadCams() {
  if (!state.config.speedcams_enabled) return;
  state.cams = await api("/api/speedcams");
  renderCams();
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onopen = () => renderStatus(true);
  es.onerror = () => renderStatus(false);
  es.addEventListener("incident", (e) => {
    const inc = JSON.parse(e.data);
    state.incidents.set(inc.id, inc);
    renderIncidents();
    renderList();
    checkAlert(inc);
  });
  es.addEventListener("location", (e) => {
    const first = !state.location;
    state.location = JSON.parse(e.data);
    renderLocationCard();
    if (!state.location) { renderMe(); renderStatus(); return; }
    if (first) map.setView([state.location.lat, state.location.lon], 14);
    renderMe();
    renderList();
    renderStatus();
    loadSgNear().catch(console.error);
    loadParkingHere().catch(console.error);
    loadChargingNear().catch(console.error);
    loadShopsNear().catch(console.error);
    loadLocal().catch(console.error);
    loadRoadworksNear().catch(console.error);
    loadOvNear().catch(console.error);
    loadFuelNear().catch(console.error);
  });
  es.addEventListener("ov", ovReloadConfig);
  es.addEventListener("fuel", () => {
    scheduleFuelViewport();
    loadFuelNear(true).catch(console.error);
  });
  es.addEventListener("roadworks", () => {
    scheduleRoadworksViewport();
    loadRoadworksNear(true).catch(console.error);
  });
  es.addEventListener("local", () => loadLocal(true).catch(console.error));
  es.addEventListener("shops", () => {
    scheduleShopsViewport();
    loadShopsNear(true).catch(console.error);
  });
  es.addEventListener("charging", chReload);
  es.addEventListener("charging_status", chReload);
  es.addEventListener("parking", () => {
    scheduleParkingViewport();
    loadParkingHere(true).catch(console.error);
  });
  es.addEventListener("speedcams", () => loadCams().catch(console.error));
  es.addEventListener("statiegeld", () => {
    scheduleSgViewport();
    loadSgNear(true).catch(console.error);
  });
  // Na een herverbinding kunnen we updates gemist hebben.
  es.addEventListener("open", () => loadIncidents().then(renderAll).catch(console.error));
}

// ---------- locatie via de browser ----------

let watchId = null;
let lastSent = 0;
let locError = null;   // laatste fout van de browser ("denied", "unavailable", "timeout")

const LOC_ERRORS = {
  denied: "De browser heeft geen toestemming voor je locatie. Klik op het slotje of het (i) in de adresbalk en zet Locatie op Toestaan. Of kies hieronder een vaste plek.",
  unavailable: "Deze computer kan zijn locatie niet bepalen (geen gps of wifi-positie). Kies een vaste plek op de kaart.",
  timeout: "De locatie bepalen duurde te lang. Probeer het opnieuw of kies een vaste plek.",
};

function canShareLocation() {
  return state.config.browser_location && "geolocation" in navigator && window.isSecureContext;
}

/** Kaartje "Nog geen locatie" met de mogelijke oplossingen; verdwijnt zodra er een locatie is. */
function renderLocationCard() {
  const card = $("loc-card");
  let dismissed = false;
  try { dismissed = sessionStorage.getItem("locCardClosed") === "1"; } catch { /* privémodus */ }
  if (state.location || dismissed) { card.hidden = true; return; }
  const title = $("loc-card-title");
  const text = $("loc-card-text");
  $("loc-share").hidden = !canShareLocation();
  if (locError) {
    title.textContent = "Locatie delen lukt niet";
    text.textContent = LOC_ERRORS[locError] || LOC_ERRORS.unavailable;
  } else if (!state.config.browser_location) {
    title.textContent = "Nog geen locatie";
    text.textContent = "Locatie via de browser staat uit in config.yaml. Kies een vaste plek, of gebruik Home Assistant.";
  } else if (!window.isSecureContext) {
    title.textContent = "Nog geen locatie";
    text.textContent = `Locatie delen werkt in de browser alleen via https of localhost, niet via ${location.host}. `
      + "Open de app op deze computer via http://localhost:8080, of kies een vaste plek.";
  } else {
    title.textContent = "Nog geen locatie";
    text.textContent = "Deel je locatie, dan zie je wat er in jouw buurt speelt: parkeren, winkels, ov, wegwerk en meldingen.";
  }
  card.hidden = false;
}

function startBrowserLocation() {
  if (!("geolocation" in navigator)) {
    locError = "unavailable";
    renderLocationCard();
    return;
  }
  if (!window.isSecureContext) {
    renderLocationCard();
    return;
  }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(async (pos) => {
    locError = null;
    if (Date.now() - lastSent < 10000) return;
    lastSent = Date.now();
    try {
      await api("/api/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      });
    } catch (err) { console.error(err); }
  }, (err) => {
    console.warn("Geolocatie:", err.message);
    locError = { 1: "denied", 2: "unavailable", 3: "timeout" }[err.code] || "unavailable";
    if (err.code === 1) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    renderLocationCard();
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  store.set("browserLocation", "1");
  document.querySelector(".locate-btn")?.classList.add("active");
}

// ---------- vaste plek (thuis) ----------

let picking = false;

async function setHome(lat, lon) {
  const home = await api("/api/location/home", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat, lon }),
  });
  state.home = home;
  renderHome();
}

async function clearHome() {
  await api("/api/location/home", { method: "DELETE" });
  state.home = null;
  renderHome();
}

function renderHome() {
  const home = state.home;
  $("home-state").textContent = home ? `Ingesteld op ${home.lat.toFixed(4)}, ${home.lon.toFixed(4)}.` : "Geen vaste plek ingesteld.";
  $("home-clear").hidden = !home;
}

/** Eén klik op de kaart kiest de vaste plek. */
function pickOnMap() {
  if (picking) return;
  picking = true;
  $("map").classList.add("picking");
  $("loc-card").hidden = true;
  if (isPhone()) setPanel(false);
  const hint = $("zoom-hint");
  const prevText = $("zoom-hint-text").textContent;
  $("zoom-hint-text").textContent = "Klik op de kaart op de plek die je als vaste plek wilt gebruiken";
  $("zoom-hint-btn").textContent = "Annuleren";
  hint.hidden = false;
  const done = () => {
    picking = false;
    $("map").classList.remove("picking");
    $("zoom-hint-text").textContent = prevText;
    $("zoom-hint-btn").textContent = "Inzoomen";
    map.off("click", onClick);
    renderZoomHint();
    renderLocationCard();
  };
  const onClick = (e) => { setHome(e.latlng.lat, e.latlng.lng).catch(console.error); done(); };
  map.once("click", onClick);
  $("zoom-hint-btn").onclick = done;
}

function initLocationUi() {
  $("loc-share").addEventListener("click", startBrowserLocation);
  $("loc-pick").addEventListener("click", pickOnMap);
  $("home-pick").addEventListener("click", pickOnMap);
  const useCenter = () => { const c = map.getCenter(); setHome(c.lat, c.lng).catch(console.error); };
  $("loc-center").addEventListener("click", useCenter);
  $("home-center").addEventListener("click", useCenter);
  $("home-clear").addEventListener("click", () => clearHome().catch(console.error));
  $("loc-card-close").addEventListener("click", () => {
    try { sessionStorage.setItem("locCardClosed", "1"); } catch { /* privémodus */ }
    $("loc-card").hidden = true;
  });
  $("st-loc").addEventListener("click", () => {
    try { sessionStorage.removeItem("locCardClosed"); } catch { /* privémodus */ }
    if (!state.location) renderLocationCard();
  });
  api("/api/location/home").then((home) => { state.home = home; renderHome(); }).catch(console.error);
  renderLocationCard();
}

const LOCATE_ICON = icon("locate-fixed");

/** Eén knop: deel je locatie (als dat kan) en centreer de kaart op jou. */
function addLocateControl() {
  const Locate = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd() {
      const btn = L.DomUtil.create("button", "locate-btn");
      btn.type = "button";
      btn.title = "Mijn locatie";
      btn.setAttribute("aria-label", "Mijn locatie");
      btn.innerHTML = LOCATE_ICON;
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, "click", () => {
        if (canShareLocation() && watchId == null) startBrowserLocation();
        else if (!state.location) { try { sessionStorage.removeItem("locCardClosed"); } catch { /* privémodus */ } renderLocationCard(); }
        if (state.location) map.setView([state.location.lat, state.location.lon], Math.max(map.getZoom(), 15));
      });
      return btn;
    },
  });
  new Locate().addTo(map);
}

// ---------- start ----------

async function init() {
  // Op een telefoon start het paneel ingeklapt, zodat de kaart zichtbaar is; op desktop
  // zoals je het de vorige keer achterliet.
  setPanel(isPhone() ? false : store.get("panelOpen") !== "0");
  initLayersPanel();
  state.config = await api("/api/config");
  const { map: m } = state.config;
  L.tileLayer(m.tile_url, { maxZoom: 19, attribution: m.attribution }).addTo(map);

  const savedWindow = Number(store.get("windowMin"));
  state.windowMin = savedWindow || m.default_window_minutes;
  $("window").value = String(state.windowMin);
  if (!$("window").value) $("window").value = "120";

  const [loc] = await Promise.all([api("/api/location"), loadIncidents()]);
  state.location = loc;
  if (loc) map.setView([loc.lat, loc.lon], 14);
  initOverview();
  initNav();
  renderAll();
  loadCams().catch(console.error);
  initStatiegeld();
  initParking();
  initCharging();
  initShops();
  initFuel();
  initLocal();
  initRoadworks();
  initOv();
  initSections();
  initZoomHelp();
  connectEvents();

  addLocateControl();
  initLocationUi();
  if (state.config.browser_location && store.get("browserLocation") === "1") startBrowserLocation();
}
$("panel-toggle").addEventListener("click", () => {
  const open = $("panel").classList.contains("collapsed");
  setPanel(open);
  if (!isPhone()) store.set("panelOpen", open ? "1" : "0");
});
document.querySelectorAll("[data-disc]").forEach((el) => el.addEventListener("change", () => {
  el.checked ? state.disciplines.add(el.dataset.disc) : state.disciplines.delete(el.dataset.disc);
  renderIncidents();
  renderList();
}));
document.querySelectorAll("[data-cam]").forEach((el) => el.addEventListener("change", () => {
  el.checked ? state.camKinds.add(el.dataset.cam) : state.camKinds.delete(el.dataset.cam);
  renderCams();
}));
$("only-sirene").addEventListener("change", (e) => {
  state.onlySirene = e.target.checked;
  renderIncidents();
  renderList();
});
$("window").addEventListener("change", async (e) => {
  state.windowMin = Number(e.target.value);
  store.set("windowMin", e.target.value);
  await loadIncidents();
  renderIncidents();
  renderList();
});
map.on("moveend", () => {
  renderCams(); renderList(); scheduleSgViewport(); scheduleParkingViewport(); scheduleChargingViewport(); scheduleShopsViewport();
  scheduleRoadworksViewport(); scheduleOvViewport(); scheduleFuelViewport();
});

// Relatieve tijden bijwerken en verlopen incidenten laten verdwijnen.
// Open/gesloten van statiegeldpunten verandert ook met de tijd.
setInterval(() => {
  renderIncidents();
  renderList();
  renderStatus();
  if (state.config) {
    renderPois(); renderSgList(); renderParking(); renderParkingHere(); renderChargingList(); renderShopsList();
    renderFuel(); renderFuelList();
  }
}, 30000);

init().catch((err) => {
  console.error(err);
  $("summary").textContent = "Kan de server niet bereiken.";
});
