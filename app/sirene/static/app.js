/* Sirene Radar – live kaart met P2000-incidenten en flitsers. */
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
  incidents: new Map(),
  cams: [],
  windowMin: 120,
  disciplines: new Set(["brandweer", "ambulance", "politie", "onbekend"]),
  camKinds: new Set(["flitser", "roodlicht", "traject"]),
  onlySirene: false,
  alerted: new Set(),
};

const $ = (id) => document.getElementById(id);
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

function fmtDistance(m) {
  if (m == null) return "";
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
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

const map = L.map("map", { zoomControl: false, attributionControl: true }).setView(NL_CENTER, 8);
L.control.zoom({ position: "bottomleft" }).addTo(map);
const incidentLayer = L.layerGroup().addTo(map);
const camLayer = L.layerGroup().addTo(map);
const meLayer = L.layerGroup().addTo(map);
const markers = new Map();

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
    ${esc(LABEL[inc.discipline] || inc.discipline)} · ${inc.sirene ? "🚨 met sirene" : esc(prio)}<br>
    ${esc(fmtTime(inc.ts))} (${esc(fmtAgo(inc.ts))})${d != null ? ` · ${esc(fmtDistance(d))} van jou` : ""}<br>
    <small>${esc(PRECISION_TEXT[inc.precision] || "locatie onbekend")}</small>
    <div class="popup-raw">${esc(inc.title)}</div>
    ${inc.link ? `<a href="${esc(inc.link)}" target="_blank" rel="noopener noreferrer">Meer informatie ↗</a>` : ""}`;
}

function renderIncidents() {
  incidentLayer.clearLayers();
  markers.clear();
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
}

function camIcon(cam) {
  const text = cam.kind === "roodlicht" ? "🚦" : cam.kind === "traject" ? "T" : (cam.maxspeed || "📷");
  return L.divIcon({
    className: "cam-marker",
    html: `<div class="cam-sign ${cam.kind}">${esc(text)}</div>`,
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
  if (map.getZoom() < CAM_MIN_ZOOM) return;
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
    meta.append(tag);
  }
  meta.append(`${LABEL[inc.discipline] || inc.discipline} · ${fmtTime(inc.ts)} · ${fmtAgo(inc.ts)}` +
    (inc.precision === "plaats" ? " · locatie ≈ plaats" : "") +
    (inc.lat == null ? " · locatie onbekend" : ""));

  li.append(bar, what, distEl, meta);
  const open = () => {
    if (inc.lat == null) return;
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
    : "In de buurt (nog geen locatie)";
  $("list-near").replaceChildren(...near.map((x) => listItem(x.inc, x.d)));
  $("empty-near").hidden = near.length > 0 || !state.location;
  $("list-view").replaceChildren(...inView.map((x) => listItem(x.inc, x.d)));
  $("empty-view").hidden = inView.length > 0;

  const sirenesNear = near.filter((x) => x.inc.sirene).length;
  $("summary").textContent = state.location
    ? `${sirenesNear} met sirene · ${near.length} totaal binnen ${fmtDistance(radius)}`
    : `${visible.length} incidenten · locatie nog onbekend`;
}

function renderStatus(live) {
  if (live !== undefined) {
    $("st-live").textContent = live ? "Live" : "Verbinding weg";
    $("st-live").className = `pill ${live ? "ok" : "err"}`;
  }
  const loc = state.location;
  const locEl = $("st-loc");
  if (loc) {
    const age = Date.now() / 1000 - loc.ts;
    const src = { homeassistant: "HA", browser: "browser", vast: "vast" }[loc.source] || loc.source;
    locEl.textContent = `📍 ${src} · ${fmtAgo(loc.ts)}`;
    locEl.className = `pill ${loc.source === "vast" || age > LOCATION_STALE_S ? "warn" : "ok"}`;
  } else {
    locEl.textContent = "Geen locatie";
    locEl.className = "pill err";
  }
  const n = $("st-notify");
  n.textContent = state.config.notifications_enabled ? "🔔 Meldingen aan" : "🔕 Meldingen uit";
  n.className = `pill ${state.config.notifications_enabled ? "ok" : ""}`;
}

function renderAll() {
  renderIncidents();
  renderList();
  renderMe();
  renderStatus();
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
  el.textContent = `🚨 ${LABEL[inc.discipline] || ""} met sirene op ${fmtDistance(d)}: ${inc.description || inc.title}`;
  el.hidden = false;
  el.onclick = () => {
    el.hidden = true;
    map.setView([inc.lat, inc.lon], 16);
    markers.get(inc.id)?.openPopup();
  };
  clearTimeout(checkAlert.timer);
  checkAlert.timer = setTimeout(() => { el.hidden = true; }, 60000);
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
    if (first) map.setView([state.location.lat, state.location.lon], 14);
    renderMe();
    renderList();
    renderStatus();
  });
  es.addEventListener("speedcams", () => loadCams().catch(console.error));
  // Na een herverbinding kunnen we updates gemist hebben.
  es.addEventListener("open", () => loadIncidents().then(renderAll).catch(console.error));
}

// ---------- locatie via de browser ----------

let watchId = null;
let lastSent = 0;

function startBrowserLocation() {
  if (!("geolocation" in navigator)) {
    alert("Deze browser ondersteunt geen locatiebepaling.");
    return;
  }
  if (!window.isSecureContext) {
    alert("Locatie via de browser werkt alleen via HTTPS (of op localhost). " +
      "Gebruik de Home Assistant-app of zet een reverse proxy met HTTPS voor deze server.");
    return;
  }
  if (watchId != null) return;
  watchId = navigator.geolocation.watchPosition(async (pos) => {
    if (Date.now() - lastSent < 10000) return;
    lastSent = Date.now();
    try {
      await api("/api/location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      });
    } catch (err) { console.error(err); }
  }, (err) => console.warn("Geolocatie:", err.message), { enableHighAccuracy: true, maximumAge: 10000 });
  store.set("browserLocation", "1");
  $("btn-locate").textContent = "📍 Locatie wordt gedeeld";
}

// ---------- start ----------

async function init() {
  // Op een telefoon start het paneel ingeklapt, zodat de kaart zichtbaar is.
  if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
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
  renderAll();
  loadCams().catch(console.error);
  connectEvents();

  if (state.config.browser_location) {
    $("btn-locate").hidden = false;
    if (store.get("browserLocation") === "1") startBrowserLocation();
  }
}

$("btn-locate").addEventListener("click", startBrowserLocation);
$("btn-center").addEventListener("click", () => {
  if (state.location) map.setView([state.location.lat, state.location.lon], 15);
});
$("panel-toggle").addEventListener("click", () => {
  if (window.matchMedia("(max-width: 720px)").matches) {
    setPanel($("panel").classList.contains("collapsed"));
  }
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
map.on("moveend", () => { renderCams(); renderList(); });

// Relatieve tijden bijwerken en verlopen incidenten laten verdwijnen.
setInterval(() => { renderIncidents(); renderList(); renderStatus(); }, 30000);

init().catch((err) => {
  console.error(err);
  $("summary").textContent = "Kan de server niet bereiken.";
});
