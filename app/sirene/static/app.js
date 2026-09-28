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
  incidents: new Map(),
  cams: [],
  windowMin: 120,
  disciplines: new Set(["brandweer", "ambulance", "politie", "onbekend"]),
  camKinds: new Set(["flitser", "roodlicht", "traject"]),
  onlySirene: false,
  alerted: new Set(),
  tab: "overzicht",
  showIncidents: true,
  showCams: true,
  sg: { points: [], near: [], show: true, onlyOpen: false, nearFrom: null },
  pk: { show: true, zones: [], here: [], kinds: new Set(["betaald", "blauw", "garage"]), hereFrom: null },
  ch: { show: false, profile: "snel", custom: null, stations: [], near: [], statusTs: null, nearFrom: null },
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
const chLayer = L.layerGroup().addTo(map);
const chMarkers = new Map();
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
    ${newsHtml(inc)}
    ${inc.link ? `<a href="${esc(inc.link)}" target="_blank" rel="noopener noreferrer">Meer informatie ↗</a>` : ""}`;
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
  return `<div class="news"><b>📰 Nieuws</b><ul>${items}</ul></div>`;
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
    tag.textContent = "📰 NIEUWS";
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
    : "In de buurt (nog geen locatie)";
  $("list-near").replaceChildren(...near.map((x) => listItem(x.inc, x.d)));
  $("empty-near").hidden = near.length > 0 || !state.location;
  $("list-view").replaceChildren(...inView.map((x) => listItem(x.inc, x.d)));
  $("empty-view").hidden = inView.length > 0;

  renderOverview();
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
  document.querySelector('[data-tab="statiegeld"]').hidden = false;
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
  if (!state.pk.show || map.getZoom() < state.config.parking.min_zoom) return;
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
  empty.textContent = "Geen parkeerregeling bekend op deze plek (of vrij parkeren).";
  empty.hidden = zones.length > 0;
  renderOverview();
}

function pkListItem(zone) {
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
  document.querySelector('[data-tab="parkeren"]').hidden = false;
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
  const warn = Charging.warnings(station, chProfile()).map((w) => `<div class="ch-warn">⚠ ${esc(w)}</div>`).join("");
  const d = state.location ? haversine(state.location.lat, state.location.lon, station.lat, station.lon) : null;
  return `
    <b>${esc(Charging.displayName(station))}</b><br>
    ${esc(station.operator || "")}${station.operator ? " · " : ""}${esc(station.address)}${d != null ? ` · ${esc(fmtDistance(d))}` : ""}<br>
    <span class="ch-status" style="--c:${CH_COLORS[av.state]}">${esc(av.text)}</span> <small>(${esc(chStatusAge())})</small>
    <ul class="ch-conn">${conns}</ul>
    <div><small>Betalen: ${esc(pay.length ? `laadpas, app of ${pay.join("/")}` : "laadpas of app")}</small></div>
    ${warn}
    <div class="pk-note" data-ch-parking="${esc(station.id)}"></div>
    <div class="pk-note">Tarief volgens de exploitant; met je eigen laadpas kan het anders zijn.</div>
    <a href="https://www.openstreetmap.org/directions?to=${station.lat}%2C${station.lon}" target="_blank" rel="noopener noreferrer">Route ↗</a>`;
}

/** Parkeertarief op de plek van de laadpaal (handig bij bestemmingsladen). */
async function chParkingNote(station, popupEl) {
  if (!state.config.parking.enabled) return;
  try {
    const zones = await api(`/api/parking/at?lat=${station.lat}&lon=${station.lon}&kinds=betaald,blauw`);
    const el = popupEl.querySelector(`[data-ch-parking="${CSS.escape(station.id)}"]`);
    if (!el || !zones.length) return;
    const st = Parking.status(zones[0]);
    el.textContent = `🅿 Parkeren hier: ${st.text}`;
  } catch (err) { /* geen parkeerinfo: niet erg */ }
}

function chIcon(station) {
  const av = Charging.availability(station);
  return L.divIcon({
    className: "ch-marker",
    html: `<div class="ch-sign${station.dc ? " dc" : ""}" style="--c:${CH_COLORS[av.state]}">⚡</div>`,
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
  meta.append(status, ` · ${Charging.summary(station)}`);
  for (const w of Charging.warnings(station, chProfile()).slice(0, 1)) meta.append(` · ⚠ ${w}`);
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
  document.querySelector('[data-tab="laden"]').hidden = false;
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

// ---------- overzicht ----------

/** Zet een kaartlaag aan of uit (en onthoud dat per apparaat). */
function setLayer(layer, on) {
  const el = { incidents: "layer-incidents", cams: "layer-cams", parking: "pk-show",
    charging: "ch-show", statiegeld: "sg-show" }[layer];
  if ($(el)) $(el).checked = on;
  if (layer === "incidents") { state.showIncidents = on; store.set("showIncidents", on ? "1" : "0"); renderIncidents(); }
  if (layer === "cams") { state.showCams = on; store.set("showCams", on ? "1" : "0"); $("cam-layers").hidden = !on; renderCams(); }
  if (layer === "parking") { state.pk.show = on; store.set("pkShow", on ? "1" : "0"); scheduleParkingViewport(); }
  if (layer === "charging") { state.ch.show = on; store.set("chShow", on ? "1" : "0"); scheduleChargingViewport(); }
  if (layer === "statiegeld") { state.sg.show = on; store.set("sgShow", on ? "1" : "0"); scheduleSgViewport(); }
}

function setTab(tab) {
  const btn = document.querySelector(`[data-tab="${tab}"]`);
  if (!btn || btn.hidden) tab = "overzicht";
  state.tab = tab;
  store.set("tab", tab);
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  // Wie een onderwerp opent, wil het meestal ook op de kaart zien.
  const layer = { 112: "incidents", parkeren: "parking", laden: "charging", statiegeld: "statiegeld" }[tab];
  if (layer) setLayer(layer, true);
  $("panel-body").scrollTop = 0;
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

function card(tab, title, summary, items, tone) {
  const sec = document.createElement("section");
  sec.className = `card${tone ? ` ${tone}` : ""}`;
  const h = document.createElement("h2");
  const link = document.createElement("button");
  link.className = "card-link";
  link.textContent = `${title} ›`;
  link.addEventListener("click", () => setTab(tab));
  h.append(link);
  const p = document.createElement("p");
  p.className = "card-sum";
  p.textContent = summary;
  const ol = document.createElement("ol");
  ol.className = "list";
  ol.append(...items);
  sec.append(h, p, ol);
  return sec;
}

/** Samenvatting per onderwerp, als losse stukjes tekst. */
function summaryParts() {
  const parts = [];
  const near = incidentsNear();
  const sirenes = near.filter((x) => x.inc.sirene && Date.now() / 1000 - x.inc.ts < OLD_INCIDENT_S).length;
  parts.push({ text: sirenes ? `🚨 ${sirenes} sirene${sirenes > 1 ? "s" : ""} dichtbij` : `🚨 ${near.length}`,
    alert: sirenes > 0, title: "112-meldingen binnen je straal" });
  if (state.config.parking.enabled && state.location) {
    const zone = state.pk.here.find((z) => z.kind === "betaald" || z.kind === "blauw");
    const st = zone && Parking.status(zone);
    const text = !st ? "🅿 vrij" : st.state === "paid" && st.rate != null
      ? `🅿 ${fmtEur(st.rate)}/u` : st.state === "disc" ? "🅿 schijf" : st.state === "free" ? "🅿 gratis" : "🅿 ?";
    parts.push({ text, title: "Parkeren op jouw plek" });
  }
  if (state.config.charging.enabled && state.location) {
    const free = state.ch.near.filter((s) => Charging.availability(s).state === "free").length;
    parts.push({ text: `⚡ ${free} vrij`, title: `Laadpunten in de buurt (${chProfile().label})` });
  }
  if (state.config.statiegeld.enabled && state.location) {
    const open = sgNearItems().filter((x) => x.st.state === "open").length;
    parts.push({ text: `♻ ${open} open`, title: "Statiegeldpunten die nu open zijn" });
  }
  return parts;
}

function fmtEur(v) {
  return `€${v.toFixed(2).replace(".", ",")}`;
}

function renderSummary() {
  const el = $("summary");
  if (!state.location) {
    el.textContent = "Buurtoverzicht · locatie nog onbekend";
    return;
  }
  el.replaceChildren(...summaryParts().map((p) => {
    const span = document.createElement("span");
    span.className = `sum-part${p.alert ? " urgent" : ""}`;
    span.textContent = p.text;
    span.title = p.title;
    return span;
  }));
}

function renderOverview() {
  if (!state.config) return;
  renderSummary();
  const cards = [];
  if (!state.location) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Deel je locatie (knop hierboven) of stel een vaste locatie in, dan zie je hier wat er in je buurt speelt.";
    $("ov-cards").replaceChildren(p);
    return;
  }
  const radius = fmtDistance(state.config.radius_m);

  // 112: bovenaan bij een recente sirene dichtbij, anders onderaan.
  const near = incidentsNear();
  const recentSirene = near.some((x) => x.inc.sirene && Date.now() / 1000 - x.inc.ts < OLD_INCIDENT_S);
  const inc112 = card("112", "🚨 112-meldingen",
    near.length
      ? `${near.length} melding${near.length > 1 ? "en" : ""} binnen ${radius} (${fmtWindow(state.windowMin)})`
      : `Rustig: geen meldingen binnen ${radius} (${fmtWindow(state.windowMin)}).`,
    near.slice(0, 2).map((x) => listItem(x.inc, x.d)), recentSirene ? "urgent" : "");

  const topical = [];
  if (state.config.parking.enabled) {
    const zones = state.pk.here.filter((z) => z.kind !== "vergunning");
    const permit = state.pk.here.some((z) => z.kind === "vergunning");
    const first = zones[0] && Parking.status(zones[0]);
    topical.push(card("parkeren", "🅿 Parkeren hier",
      first ? first.text : permit ? "Alleen vergunninghouders op deze plek." : "Geen parkeerregeling bekend: meestal vrij parkeren.",
      zones.slice(0, 1).map(pkListItem)));
  }
  if (state.config.charging.enabled) {
    const free = state.ch.near.filter((s) => Charging.availability(s).state === "free").length;
    topical.push(card("laden", "⚡ Laden",
      state.ch.near.length
        ? `${free} van ${state.ch.near.length} dichtstbijzijnde vrij · ${chProfile().label}`
        : `Niets gevonden binnen ${fmtDistance(state.config.charging.list_radius_m)} · ${chProfile().label}`,
      state.ch.near.slice(0, 2).map(chListItem)));
  }
  if (state.config.statiegeld.enabled) {
    const items = sgNearItems();
    const open = items.filter((x) => x.st.state === "open");
    const show = (open.length ? open : items).slice(0, 2);
    topical.push(card("statiegeld", "♻ Statiegeld",
      items.length ? `${open.length} van ${items.length} punten binnen ${fmtDistance(state.config.statiegeld.list_radius_m)} nu open`
        : "Geen inleverpunten in de buurt.",
      show.map((x) => sgListItem(x.p, x.st, x.d))));
  }
  cards.push(...(recentSirene ? [inc112, ...topical] : [...topical, inc112]));
  $("ov-cards").replaceChildren(...cards);
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
  document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
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
    loadChargingNear().catch(console.error);
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
  initOverview();
  renderAll();
  loadCams().catch(console.error);
  initStatiegeld();
  initParking();
  initCharging();
  setTab(store.get("tab") || "overzicht");
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
map.on("moveend", () => {
  renderCams(); renderList(); scheduleSgViewport(); scheduleParkingViewport(); scheduleChargingViewport();
});

// Relatieve tijden bijwerken en verlopen incidenten laten verdwijnen.
// Open/gesloten van statiegeldpunten verandert ook met de tijd.
setInterval(() => {
  renderIncidents();
  renderList();
  renderStatus();
  if (state.config) { renderSg(); renderSgList(); renderParking(); renderParkingHere(); renderChargingList(); }
}, 30000);

init().catch((err) => {
  console.error(err);
  $("summary").textContent = "Kan de server niet bereiken.";
});
