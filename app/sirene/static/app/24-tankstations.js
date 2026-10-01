/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

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
