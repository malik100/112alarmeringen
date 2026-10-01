/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

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
    news: "nw-show", ov: "ov-show", fuel: "fu-show", amenities: "am-show", weather: "we-show", waste: "wa-show", history: "hi-show" }[layer];
  if ($(el)) $(el).checked = on;
  if (layer === "incidents") { state.showIncidents = on; store.set("showIncidents", on ? "1" : "0"); renderIncidents(); }
  if (layer === "cams") { state.showCams = on; store.set("showCams", on ? "1" : "0"); $("cam-layers").hidden = !on; renderCams(); }
  if (layer === "parking") { state.pk.show = on; store.set("pkShow", on ? "1" : "0"); scheduleParkingViewport(); }
  if (layer === "charging") { state.ch.show = on; store.set("chShow", on ? "1" : "0"); scheduleChargingViewport(); }
  if (layer === "shops") { state.sh.show = on; store.set("shShow", on ? "1" : "0"); scheduleShopsViewport(); }
  if (layer === "fuel") { state.fu.show = on; store.set("fuShow", on ? "1" : "0"); scheduleFuelViewport(); }
  if (layer === "amenities") { state.am.show = on; store.set("amShow", on ? "1" : "0"); $("am-kinds").hidden = !on; scheduleAmenitiesViewport(); }
  if (layer === "roadworks") { state.rw.show = on; store.set("rwShow", on ? "1" : "0"); scheduleRoadworksViewport(); }
  if (layer === "announcements") { state.bk.show = on; store.set("bkShow", on ? "1" : "0"); renderBkLayer(); }
  if (layer === "statiegeld") { state.sg.show = on; store.set("sgShow", on ? "1" : "0"); scheduleSgViewport(); }
  if (layer === "news") { state.nw.show = on; store.set("nwShow", on ? "1" : "0"); }
  if (layer === "history") { state.hi.show = on; store.set("hiShow", on ? "1" : "0"); if (on) loadHistory().catch(console.error); }
  if (layer === "waste") { state.wa.show = on; store.set("waShow", on ? "1" : "0"); if (on) loadWaste().catch(console.error); }
  if (layer === "weather") { state.we.show = on; store.set("weShow", on ? "1" : "0"); if (on) loadWeather(true).catch(console.error); }
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

// Snel kiezen: één tik zet precies de lagen aan die bij een situatie horen.
const PRESETS = {
  onderweg: ["ov", "fuel", "roadworks", "cams", "parking", "charging", "amenities", "weather"],
  thuis: ["weather", "waste", "news", "announcements", "incidents", "roadworks", "history"],
  boodschappen: ["shops", "statiegeld", "parking"],
  uit: [],
};
const ALL_LAYERS = ["parking", "statiegeld", "shops", "fuel", "amenities", "roadworks", "ov", "cams", "charging", "weather", "waste", "news",
  "announcements", "incidents", "history"];

function applyPreset(name) {
  const on = new Set(PRESETS[name] || []);
  for (const layer of ALL_LAYERS) setLayer(layer, on.has(layer));
  renderPresets();
}

/** Markeer de preset die precies overeenkomt met wat er nu aanstaat (als die er is). */
function layerIsOn(layer) {
  return { parking: state.pk.show, statiegeld: state.sg.show, shops: state.sh.show, fuel: state.fu.show,
    amenities: state.am.show, weather: state.we.show, waste: state.wa.show, history: state.hi.show,
    roadworks: state.rw.show, ov: state.ov.show, cams: state.showCams, charging: state.ch.show,
    news: state.nw.show, announcements: state.bk.show, incidents: state.showIncidents }[layer];
}

function renderPresets() {
  if (!state.config) return;
  const c = state.config;
  const enabled = (layer) => ({ parking: c.parking.enabled, statiegeld: c.statiegeld.enabled, shops: c.shops.enabled,
    fuel: c.fuel.enabled, amenities: c.amenities.enabled, roadworks: c.roadworks.enabled, ov: c.ov.enabled, cams: c.speedcams_enabled,
    charging: c.charging.enabled, weather: c.weather.enabled, waste: c.waste.enabled, history: c.history.enabled, news: c.local.news, announcements: c.local.announcements, incidents: true })[layer];
  const current = ALL_LAYERS.filter((l) => layerIsOn(l) && enabled(l)).join(",");
  document.querySelectorAll("[data-preset]").forEach((btn) => {
    const want = ALL_LAYERS.filter((l) => PRESETS[btn.dataset.preset].includes(l) && enabled(l)).join(",");
    btn.classList.toggle("active", want === current);
  });
}

function initPresets() {
  document.querySelectorAll("[data-preset]").forEach((btn) => btn.addEventListener("click", () => applyPreset(btn.dataset.preset)));
  renderPresets();
}

// Lagen die pas vanaf een bepaald zoomniveau getekend worden (anders te veel/te zwaar).
const ZOOM_LAYERS = [
  { layer: "parking", input: "pk-show", name: "parkeerzones", on: () => state.pk.show, zoom: () => state.config.parking.min_zoom, enabled: () => state.config.parking.enabled },
  { layer: "statiegeld", input: "sg-show", name: "statiegeldpunten", on: () => state.sg.show, zoom: () => state.config.statiegeld.min_zoom, enabled: () => state.config.statiegeld.enabled },
  { layer: "shops", input: "sh-show", name: "winkels", on: () => state.sh.show, zoom: () => state.config.shops.min_zoom, enabled: () => state.config.shops.enabled },
  { layer: "fuel", input: "fu-show", name: "tankstations", on: () => state.fu.show, zoom: () => state.config.fuel.min_zoom, enabled: () => state.config.fuel.enabled },
  { layer: "amenities", input: "am-show", name: "AED's en toiletten", on: () => state.am.show, zoom: () => state.config.amenities.min_zoom, enabled: () => state.config.amenities.enabled },
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
  amenities: () => state.config.amenities.enabled && state.am.show,
  roadworks: () => state.config.roadworks.enabled && state.rw.show,
  ov: () => state.config.ov.enabled && state.ov.show,
  charging: () => state.config.charging.enabled && state.ch.show,
  weather: () => state.config.weather.enabled && state.we.show,
  waste: () => state.config.waste.enabled && state.wa.show,
  history: () => state.config.history.enabled && state.hi.show,
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
  try { closed = new Set(JSON.parse(store.get("closedSections") || '["instellingen", "status"]')); } catch { closed = new Set(); }
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
  if (state.config.amenities.enabled) setSectionSummary("voorzieningen", amSummary());
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
    loadAmenitiesNear().catch(console.error);
    loadWeather().catch(console.error);
  });
  es.addEventListener("weather", () => loadWeather(true).catch(console.error));
  es.addEventListener("waste", () => loadWaste().catch(console.error));
  es.addEventListener("incident", () => { if (state.hi.show) loadHistory().catch(console.error); });
  es.addEventListener("amenities", () => {
    scheduleAmenitiesViewport();
    loadAmenitiesNear(true).catch(console.error);
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
