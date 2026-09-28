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
  sg: { points: [], near: [], show: true, onlyOpen: false, nearFrom: null },
  pk: { zones: [], here: [], kinds: new Set(["betaald", "blauw", "garage"]), hereFrom: null },
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
const sgLayer = L.layerGroup().addTo(map);
const sgMarkers = new Map();
map.createPane("parking").style.zIndex = 350; // onder markers en popups
const pkLayer = L.layerGroup().addTo(map);
const pkShapes = new Map();
const meLayer = L.layerGroup().addTo(map);
const markers = new Map();

/** Id van de marker met een open popup, zodat die na hertekenen weer open kan. */
function openPopupId(markerMap) {
  for (const [id, marker] of markerMap) if (marker.isPopupOpen()) return id;
  return null;
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
    ${esc(LABEL[inc.discipline] || inc.discipline)} · ${inc.sirene ? "🚨 met sirene" : esc(prio)}<br>
    ${esc(fmtTime(inc.ts))} (${esc(fmtAgo(inc.ts))})${d != null ? ` · ${esc(fmtDistance(d))} van jou` : ""}<br>
    <small>${esc(PRECISION_TEXT[inc.precision] || "locatie onbekend")}</small>
    <div class="popup-raw">${esc(inc.title)}</div>
    ${inc.link ? `<a href="${esc(inc.link)}" target="_blank" rel="noopener noreferrer">Meer informatie ↗</a>` : ""}`;
}

function renderIncidents() {
  const reopen = openPopupId(markers);
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
  if (reopen != null) markers.get(reopen)?.openPopup();
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
    ${esc(point.address)}${d != null ? ` · ${esc(fmtDistance(d))}` : ""}<br>
    <span class="${SG_STATE_CLASS[st.state]}">${esc(st.text)}</span>
    <table class="sg-hours">${rows}</table>
    ${point.materials.length ? `<div><small>Neemt in: ${esc(point.materials.join(", "))}</small></div>` : ""}
    ${point.payouts.length ? `<div><small>Uitbetaling: ${esc(point.payouts.join(", "))}</small></div>` : ""}
    ${facts.length ? `<div><small>${esc(facts.join(" · "))}</small></div>` : ""}
    <a href="https://www.openstreetmap.org/directions?to=${point.lat}%2C${point.lon}" target="_blank" rel="noopener noreferrer">Route ↗</a>`;
}

function sgIcon(st) {
  return L.divIcon({
    className: "sg-marker",
    html: `<div class="sg-sign ${st.state}">♻</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

let sgPendingPopup = null;

function renderSg() {
  const reopen = sgPendingPopup ?? openPopupId(sgMarkers);
  sgLayer.clearLayers();
  sgMarkers.clear();
  if (!state.sg.show || map.getZoom() < state.config.statiegeld.min_zoom) return;
  for (const point of state.sg.points) {
    const st = sgStatus(point);
    if (!sgVisible(point, st)) continue;
    const marker = L.marker([point.lat, point.lon], { icon: sgIcon(st), keyboard: false, zIndexOffset: -500 })
      .bindPopup(() => sgPopup(point), { maxWidth: 280 });
    marker.addTo(sgLayer);
    sgMarkers.set(point.id, marker);
  }
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
  meta.append(status, ` · ${point.address}`);
  li.append(bar, what, distEl, meta);
  const open = () => {
    // De marker bestaat mogelijk pas na het laden van dit kaartgebied.
    sgPendingPopup = point.id;
    map.setView([point.lat, point.lon], Math.max(map.getZoom(), state.config.statiegeld.min_zoom, 16));
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function renderSgList() {
  const cfg = state.config.statiegeld;
  $("sg-section").hidden = !cfg.enabled || !state.sg.show;
  if ($("sg-section").hidden) return;
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
  if (!cfg.enabled || !state.sg.show || !loc) return renderSgList();
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
  $("sg-controls").hidden = false;
  state.sg.show = store.get("sgShow") !== "0";
  state.sg.onlyOpen = store.get("sgOnlyOpen") === "1";
  $("sg-show").checked = state.sg.show;
  $("sg-open").checked = state.sg.onlyOpen;
  $("sg-show").addEventListener("change", (e) => {
    state.sg.show = e.target.checked;
    store.set("sgShow", state.sg.show ? "1" : "0");
    scheduleSgViewport();
    loadSgNear(true).catch(console.error);
  });
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
    <span class="pk-status" style="--c:${pkColor(st)}">${esc(st.text)}</span>
    <table class="pk-week">${rows}</table>
    ${extras ? `<div><small>Ook mogelijk:</small><ul class="pk-extras">${extras}</ul></div>` : ""}
    ${facts ? `<div><small>${esc(facts)}</small></div>` : ""}
    ${zone.special_days ? '<div class="pk-note">Op feestdagen en bij evenementen kunnen andere tijden gelden.</div>' : ""}
    <div class="pk-note">Bron: RDW/NPR. Borden ter plaatse gaan altijd voor.</div>
    ${zone.url ? `<a href="${esc(/^https?:/.test(zone.url) ? zone.url : "https://" + zone.url)}" target="_blank" rel="noopener noreferrer">${esc(zone.manager)} ↗</a>` : ""}`;
}

let pkPendingPopup = null;

function renderParking() {
  let reopen = pkPendingPopup;
  for (const [id, shape] of pkShapes) if (shape.isPopupOpen()) reopen = reopen ?? id;
  pkLayer.clearLayers();
  pkShapes.clear();
  if (map.getZoom() < state.config.parking.min_zoom) return;
  // Grote vlakken eerst, zodat kleinere (bijv. garages) erbovenop klikbaar blijven.
  const area = (z) => (z.bbox[2] - z.bbox[0]) * (z.bbox[3] - z.bbox[1]);
  const zones = state.pk.zones.filter((z) => state.pk.kinds.has(z.kind)).sort((a, b) => area(b) - area(a));
  for (const zone of zones) {
    const st = Parking.status(zone);
    const color = pkColor(st);
    let shape;
    if (zone.geometry.type === "Point") {
      const [lon, lat] = zone.geometry.coordinates;
      shape = L.marker([lat, lon], {
        icon: L.divIcon({ className: "pk-marker", html: '<div class="pk-sign">P</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        keyboard: false,
        zIndexOffset: -600,
      });
    } else {
      shape = L.geoJSON(zone.geometry, {
        pane: "parking",
        style: {
          color,
          weight: zone.kind === "vergunning" ? 1 : 2,
          opacity: 0.8,
          dashArray: st.state === "free" || zone.kind === "vergunning" ? "5 5" : null,
          fillColor: color,
          fillOpacity: st.state === "free" ? 0.04 : zone.kind === "vergunning" ? 0.06 : 0.15,
        },
      });
    }
    shape.bindPopup(() => pkPopup(zone), { maxWidth: 320 }).addTo(pkLayer);
    pkShapes.set(zone.id, shape);
  }
  if (reopen != null && pkShapes.has(reopen)) {
    const shape = pkShapes.get(reopen);
    const zone = state.pk.zones.find((z) => z.id === reopen);
    if (zone && zone.geometry.type !== "Point" && state.location) {
      shape.openPopup([state.location.lat, state.location.lon]);
    } else {
      shape.openPopup();
    }
    pkPendingPopup = null;
  }
}

function renderParkingHere() {
  const cfg = state.config.parking;
  $("pk-section").hidden = !cfg.enabled;
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
  $("list-pk").replaceChildren(...zones.map((zone) => {
    const st = Parking.status(zone);
    const li = document.createElement("li");
    li.className = "item parking";
    li.style.setProperty("--c", pkColor(st));
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
    meta.append(status, ` · ${zone.manager}`);
    li.append(bar, what, kind, meta);
    const open = () => {
      pkPendingPopup = zone.id;
      state.pk.kinds.add(zone.kind);
      document.querySelectorAll("[data-pk]").forEach((el) => {
        if (el.dataset.pk.split(",").includes(zone.kind)) el.checked = true;
      });
      map.setView([state.location.lat, state.location.lon], Math.max(map.getZoom(), state.config.parking.min_zoom, 16));
      scheduleParkingViewport();
      if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
    };
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    return li;
  }));
  empty.textContent = "Geen parkeerregeling bekend op deze plek (of vrij parkeren).";
  empty.hidden = zones.length > 0;
}

let pkSeq = 0;
let pkTimer = null;
function scheduleParkingViewport() {
  clearTimeout(pkTimer);
  pkTimer = setTimeout(async () => {
    const cfg = state.config.parking;
    if (!cfg.enabled || !state.pk.kinds.size || map.getZoom() < cfg.min_zoom) {
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
  $("pk-controls").hidden = false;
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
    loadSgNear().catch(console.error);
    loadParkingHere().catch(console.error);
  });
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
  initStatiegeld();
  initParking();
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
map.on("moveend", () => { renderCams(); renderList(); scheduleSgViewport(); scheduleParkingViewport(); });

// Relatieve tijden bijwerken en verlopen incidenten laten verdwijnen.
// Open/gesloten van statiegeldpunten verandert ook met de tijd.
setInterval(() => {
  renderIncidents();
  renderList();
  renderStatus();
  if (state.config) { renderSg(); renderSgList(); renderParking(); renderParkingHere(); }
}, 30000);

init().catch((err) => {
  console.error(err);
  $("summary").textContent = "Kan de server niet bereiken.";
});
