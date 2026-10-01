/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

// ---------- zoeken ----------

const SEARCH_ICON = { adres: "map-pin", weg: "map-pin", woonplaats: "map-pin", gemeente: "map-pin", postcode: "map-pin", halte: "bus" };
const SEARCH_TYPE = { adres: "adres", weg: "straat", woonplaats: "plaats", gemeente: "gemeente", postcode: "postcode", halte: "halte" };
const searchLayer = L.layerGroup().addTo(map);
let searchSeq = 0;
let searchTimer = null;
let searchItems = [];
let searchIndex = -1;

function searchRender(items, text) {
  const list = $("search-results");
  searchItems = items;
  searchIndex = -1;
  list.replaceChildren(...(items.length ? items : [null]).map((it, i) => {
    const li = document.createElement("li");
    if (!it) { li.className = "empty"; li.textContent = `Niets gevonden voor "${text}".`; return li; }
    li.setAttribute("role", "option");
    li.append(iconEl(SEARCH_ICON[it.type] || "map-pin"), it.name);
    const small = document.createElement("small");
    small.textContent = it.type === "halte" ? (it.modes || []).map((m) => Ov.modeInfo(m).label.toLowerCase()).join(", ") : SEARCH_TYPE[it.type] || "";
    li.append(small);
    li.addEventListener("mousedown", (e) => e.preventDefault());  // focus houden
    li.addEventListener("click", () => searchPick(i));
    return li;
  }));
  list.hidden = false;
}

function searchClose() {
  $("search-results").hidden = true;
  searchItems = [];
}

/** Resultaat kiezen: kaart erheen, marker met popup; een halte opent meteen het vertrekbord. */
function searchPick(i) {
  const it = searchItems[i];
  if (!it) return;
  searchClose();
  $("search-q").blur();
  if (isPhone()) setPanel(false);
  searchLayer.clearLayers();
  if (it.type === "halte" && state.config.ov.enabled) {
    ovPendingPopup = it.halte;
    if (!state.ov.parts.has("stops")) ovSetPart("stops", true);
    setLayer("ov", true);
    map.setView([it.lat, it.lon], Math.max(map.getZoom(), state.config.ov.stops_min_zoom, 16));
    scheduleOvViewport();
    return;
  }
  const zoom = { adres: 17, postcode: 16, weg: 16, woonplaats: 13, gemeente: 12 }[it.type] || 15;
  map.setView([it.lat, it.lon], zoom);
  const marker = L.marker([it.lat, it.lon], {
    icon: L.divIcon({ className: "", html: '<div class="search-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    zIndexOffset: 1500,
  }).addTo(searchLayer);
  marker.bindPopup(() => {
    const d = state.location ? haversine(state.location.lat, state.location.lon, it.lat, it.lon) : null;
    return `<b>${esc(it.name)}</b><br><small>${esc(SEARCH_TYPE[it.type] || "")}${d != null ? ` · ${esc(fmtDistance(d))} van jou` : ""}</small>
      <div class="popup-links">${routeLink(it.lat, it.lon)}
      <a href="#" class="search-home">${icon("locate-fixed")}Als vaste plek</a>
      <a href="#" class="search-clear">${icon("x")}Weg</a></div>`;
  }, { maxWidth: 280 }).openPopup();
  marker.on("popupopen", (e) => {
    e.popup.getElement().querySelector(".search-home")?.addEventListener("click", (ev) => {
      ev.preventDefault(); setHome(it.lat, it.lon).catch(console.error); marker.closePopup();
    });
    e.popup.getElement().querySelector(".search-clear")?.addEventListener("click", (ev) => {
      ev.preventDefault(); searchLayer.clearLayers();
    });
  });
}

async function searchRun(text) {
  const seq = ++searchSeq;
  try {
    const items = await api(`/api/search?q=${encodeURIComponent(text)}`);
    if (seq !== searchSeq) return;
    searchRender(items, text);
  } catch (err) { console.warn("Zoeken:", err.message); }
}

function initSearch() {
  const input = $("search-q");
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const text = input.value.trim();
    if (text.length < 2) { searchClose(); return; }
    searchTimer = setTimeout(() => searchRun(text), 250);
  });
  input.addEventListener("focus", () => { if (searchItems.length) $("search-results").hidden = false; });
  input.addEventListener("blur", () => setTimeout(searchClose, 150));
  input.addEventListener("keydown", (e) => {
    const list = $("search-results");
    if (e.key === "Escape") { searchClose(); input.blur(); return; }
    if (!searchItems.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      searchIndex = (searchIndex + (e.key === "ArrowDown" ? 1 : -1) + searchItems.length) % searchItems.length;
      [...list.children].forEach((li, i) => li.setAttribute("aria-selected", String(i === searchIndex)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      searchPick(searchIndex >= 0 ? searchIndex : 0);
    }
  });
  $("search").addEventListener("submit", (e) => { e.preventDefault(); if (searchItems.length) searchPick(0); });
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

// ---------- status ----------

const nlInt = new Intl.NumberFormat("nl-NL");
function fmtBytes(b) {
  if (b == null) return "?";
  if (b >= 1e9) return `${(b / 1e9).toFixed(1).replace(".", ",")} GB`;
  return `${Math.round(b / 1e6)} MB`;
}

async function renderStatusPanel() {
  let data;
  try { data = await api("/api/status/overview"); } catch { return; }
  const now = Date.now() / 1000;
  let problems = 0;
  $("status-list").replaceChildren(...data.sources.map((s) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    const stale = s.last_ok && now - s.last_ok > 2 * 86400;
    dot.className = `dot ${s.error ? "err" : !s.last_ok ? "none" : stale ? "warn" : ""}`;
    if (s.error) problems++;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = s.name + (s.count ? ` · ${nlInt.format(s.count)}` : "");
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = s.busy ? "bezig met inlezen…" : s.last_ok ? `bijgewerkt ${fmtAgo(s.last_ok)}` : "nog niet opgehaald";
    li.append(dot, name, when);
    if (s.error) {
      li.className = "has-error";
      const err = document.createElement("span");
      err.className = "err-text";
      err.textContent = s.error.length > 140 ? `${s.error.slice(0, 137)}…` : s.error;
      li.append(err);
    }
    return li;
  }));
  const d = data.disk;
  const parts = [];
  if (d.database != null) parts.push(`database ${fmtBytes(d.database)}`);
  if (d.ov != null) parts.push(`ov-dienstregeling ${fmtBytes(d.ov)}`);
  if (d.free != null) parts.push(`${fmtBytes(d.free)} vrij op de schijf`);
  if (data.started) parts.push(`draait sinds ${fmtAgo(data.started).replace("geleden", "").trim()}`);
  $("status-disk").textContent = parts.join(" · ");
  const low = d.free != null && d.free < 2e9;
  setSectionSummary("status", problems ? `${problems} bron${problems > 1 ? "nen" : ""} met een fout`
    : low ? `Weinig schijfruimte: ${fmtBytes(d.free)} vrij` : "Alles in orde", problems || low ? "urgent" : "");
}

function initStatusPanel() {
  renderStatusPanel();
  setInterval(renderStatusPanel, 60000);
}

function initAccess() {
  if (!state.config.password_protected) return;
  $("access-box").hidden = false;
  $("logout").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    location.href = "/login";
  });
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
