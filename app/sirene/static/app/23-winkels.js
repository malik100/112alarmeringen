/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

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
