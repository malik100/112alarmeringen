/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

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
  const station = mode === "trein" || mode === "metro";
  return `<div class="ov-stop${station ? " station" : ""}" style="--c:${info.color}">${icon(info.icon)}</div>`;
}

function ovMakeStopMarker(h) {
  const station = h.modes[0] === "trein" || h.modes[0] === "metro";
  const marker = spreadMarker(h.lat, h.lon, ovStopIcon(h), "ov-stop-marker", station ? 26 : 20, [0, 0], h.name,
    station ? 300 : 200);
  marker.bindPopup(() => `<b>${esc(h.name)}</b><p class="empty">Vertrektijden laden…</p>`,
    { maxWidth: 340, minWidth: 260, className: "ov-popup" });
  marker.on("popupopen", (e) => { ovShowBoard(h, e.popup); ovAutoRefresh(e.popup); });
  marker.on("popupclose", () => ovTripLayer.clearLayers());
  marker._ovLabel = map.getZoom() >= LABEL_ZOOM;
  return marker;
}

function renderOvStops() {
  const cfg = state.config.ov;
  const z = map.getZoom();
  const on = state.ov.show && state.ov.parts.has("stops") && z >= cfg.lines_min_zoom;
  // Uitgezoomd alleen de stations (trein, metro); alle haltes pas vanaf stops_min_zoom.
  const show = (h) => ovStopVisible(h) && (z >= cfg.stops_min_zoom || h.modes[0] === "trein" || h.modes[0] === "metro");
  const wanted = new Map(on ? state.ov.haltes.filter(show).map((h) => [h.id, h]) : []);
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

const OV_VEH_LABEL_ZOOM = 15;   // daaronder alleen een stip, anders ligt de kaart vol lijnnummers

function ovVehicleIcon(v) {
  const { bg, fg } = Ov.badgeColors(v);
  const late = Ov.delayMinutes(v.delay) >= 3 ? " late" : "";
  if (map.getZoom() < OV_VEH_LABEL_ZOOM) {
    return L.divIcon({
      className: "ov-veh-marker",
      html: `<div class="ov-veh dot${late}" style="background:${bg}" title="${esc(Ov.lineLabel(v))}"></div>`,
      iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6],
    });
  }
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
      const compact = map.getZoom() < OV_VEH_LABEL_ZOOM;
      if (Ov.delayMinutes(marker._ov.delay) !== Ov.delayMinutes(v.delay) || marker._ovCompact !== compact) {
        marker.setIcon(ovVehicleIcon(v));
      }
    }
    marker._ov = v;
    marker._ovCompact = map.getZoom() < OV_VEH_LABEL_ZOOM;
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
  if (state.ov.show && cfg.ready && state.ov.parts.has("stops") && z >= cfg.lines_min_zoom) {
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
