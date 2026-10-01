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
  centeredLive: false,   // al gecentreerd op een live locatie (telefoon/browser) deze sessie?
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
  wa: { show: true, data: null },
  hi: { show: false, data: null },
  we: { show: true, data: null, from: null, ts: 0 },
  am: { show: false, kinds: new Set(["aed", "toilet", "water"]), points: [], near: [], nearFrom: null },
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
  if (resp.status === 401) { location.href = "/login"; throw new Error("Inloggen vereist"); }
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

/** Standaardzoom bij het openen en bij de locatieknop (map.default_zoom in config.yaml, standaard 15). */
function homeZoom() {
  const z = Number(state.config && state.config.map && state.config.map.default_zoom);
  return z >= 10 && z <= 18 ? z : 15;
}
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
