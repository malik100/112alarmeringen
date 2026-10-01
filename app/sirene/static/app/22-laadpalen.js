/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

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
