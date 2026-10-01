/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

// ---------- AED, toilet, drinkwater ----------

const AM_KIND = {
  aed: { label: "AED", icon: "heart-pulse", color: "#dc2626" },
  toilet: { label: "Toilet", icon: "bath", color: "#2563eb" },
  water: { label: "Drinkwater", icon: "droplets", color: "#0891b2" },
};
const amLayer = L.layerGroup().addTo(map);
const amMarkers = new Map();
let amPendingPopup = null;

function amStatus(a) {
  return OpeningHours.status(a.hours);
}

/** "openbaar · buiten · 24 uur open" of "voor klanten · binnen · gesloten". */
function amDetails(a) {
  const parts = [];
  if (a.access) parts.push(a.access);
  if (a.indoor === true) parts.push("binnen");
  else if (a.indoor === false) parts.push("buiten");
  if (a.hours) parts.push(amStatus(a).text);
  if (a.kind === "toilet") {
    if (a.fee === true) parts.push("betaald");
    else if (a.fee === false) parts.push("gratis");
    if (a.changing_table) parts.push("verschoontafel");
  }
  if (a.kind === "water" && a.bottle) parts.push("fles vullen");
  if (a.wheelchair) parts.push("rolstoel");
  return parts;
}

function amLimited(a) {
  return a.access === "niet openbaar" || a.access === "voor klanten" || (a.hours && amStatus(a).state === "closed");
}

function amPopup(a) {
  const k = AM_KIND[a.kind];
  const d = state.location ? haversine(state.location.lat, state.location.lon, a.lat, a.lon) : null;
  const [osmType, osmId] = a.id.split("/");
  return `
    <b>${esc(a.name || k.label)}</b>${a.name ? `<br><small>${esc(k.label)}</small>` : ""}<br>
    ${a.address ? `${esc(a.address)}<br>` : ""}
    ${amDetails(a).length ? `<span>${esc(amDetails(a).join(" · "))}</span><br>` : ""}
    ${a.location ? `<div><small>Waar: ${esc(a.location)}</small></div>` : ""}
    ${a.description ? `<div><small>${esc(a.description)}</small></div>` : ""}
    ${a.operator ? `<div><small>Beheer: ${esc(a.operator)}</small></div>` : ""}
    ${d != null ? `<div><small>${esc(fmtDistance(d))} · ${esc(Nav.eta(d))}</small></div>` : ""}
    ${a.hours ? `<table class="sg-hours">${shWeekRows(a)}</table>` : ""}
    ${a.kind === "aed" ? '<div class="pk-note">Bel bij een hartstilstand altijd eerst 112. Bron: OpenStreetMap; controleer ter plekke.</div>' : '<div class="pk-note">Bron: OpenStreetMap.</div>'}
    <div class="popup-links">${routeLink(a.lat, a.lon)}<a href="https://www.openstreetmap.org/${esc(osmType)}/${esc(osmId)}" target="_blank" rel="noopener noreferrer">${icon("pencil")}Aanpassen</a></div>`;
}

function renderAmenities() {
  const reopen = amPendingPopup ?? openPopupId(amMarkers);
  amLayer.clearLayers();
  amMarkers.clear();
  const cfg = state.config.amenities;
  if (!cfg.enabled || !state.am.show || map.getZoom() < cfg.min_zoom) return;
  const items = state.am.points.filter((a) => state.am.kinds.has(a.kind));
  const offsets = spreadOffsets(items, 22);
  items.forEach((a, i) => {
    const k = AM_KIND[a.kind];
    const html = `<div class="am-sign${amLimited(a) ? " limited" : ""}" style="--c:${k.color}">${icon(k.icon)}</div>`;
    const marker = spreadMarker(a.lat, a.lon, html, "am-marker", 22, offsets[i], a.name || k.label, -350)
      .bindPopup(() => amPopup(a), { maxWidth: 290 });
    marker.addTo(amLayer);
    amMarkers.set(a.id, marker);
  });
  if (reopen != null && amMarkers.has(reopen)) {
    amMarkers.get(reopen).openPopup();
    amPendingPopup = null;
  }
}

function amNearItems() {
  if (!state.location) return [];
  return state.am.near
    .filter((a) => state.am.kinds.has(a.kind))
    .map((a) => ({ a, d: haversine(state.location.lat, state.location.lon, a.lat, a.lon) }))
    .filter((x) => x.d <= state.config.amenities.list_radius_m)
    .sort((x, y) => x.d - y.d);
}

function amListItem({ a, d }) {
  const k = AM_KIND[a.kind];
  const li = document.createElement("li");
  li.className = "item amenity";
  li.style.setProperty("--c", amLimited(a) ? "#9ca3af" : k.color);
  li.tabIndex = 0;
  const bar = document.createElement("span");
  bar.className = "bar";
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = a.name ? `${k.label} · ${a.name}` : k.label;
  const distEl = document.createElement("span");
  distEl.className = "dist";
  distEl.textContent = fmtDistance(d);
  const meta = document.createElement("span");
  meta.className = "meta";
  const details = [...amDetails(a), a.location, a.address].filter(Boolean).join(" · ");
  if (details) meta.append(details, " · ");
  meta.append(etaSpan(Nav.eta(d)));
  li.append(bar, what, distEl, meta);
  const open = () => {
    amPendingPopup = a.id;
    setLayer("amenities", true);
    map.setView([a.lat, a.lon], Math.max(map.getZoom(), state.config.amenities.min_zoom, 17));
    scheduleAmenitiesViewport();
    if (isPhone()) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function renderAmenitiesList() {
  const cfg = state.config.amenities;
  if (!cfg.enabled) return;
  $("am-title").textContent = `Binnen ${fmtDistance(cfg.list_radius_m)}`;
  const empty = $("empty-am");
  if (!state.location) {
    $("list-am").replaceChildren();
    empty.textContent = "Nog geen locatie bekend.";
    empty.hidden = false;
  } else {
    // Per soort de drie dichtstbijzijnde, AED's eerst.
    const items = amNearItems();
    const shown = ["aed", "toilet", "water"].flatMap((kind) => items.filter((x) => x.a.kind === kind).slice(0, 3));
    $("list-am").replaceChildren(...shown.map(amListItem));
    empty.textContent = "Niets gevonden in de buurt.";
    empty.hidden = shown.length > 0;
  }
  renderOverview();
}

function amSummary() {
  const items = amNearItems();
  const aed = items.find((x) => x.a.kind === "aed" && !amLimited(x.a)) || items.find((x) => x.a.kind === "aed");
  const toilet = items.find((x) => x.a.kind === "toilet");
  const parts = [];
  if (aed) parts.push(`AED ${fmtDistance(aed.d)}`);
  if (toilet) parts.push(`toilet ${fmtDistance(toilet.d)}`);
  return parts.length ? parts.join(" · ") : "Niets in de buurt";
}

let amSeq = 0;
let amTimer = null;
function scheduleAmenitiesViewport() {
  clearTimeout(amTimer);
  amTimer = setTimeout(async () => {
    const cfg = state.config.amenities;
    if (!cfg.enabled || !state.am.show || map.getZoom() < cfg.min_zoom) {
      state.am.points = [];
      renderAmenities();
      return;
    }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
    const seq = ++amSeq;
    try {
      const points = await api(`/api/amenities?bbox=${bbox}`);
      if (seq !== amSeq) return;
      state.am.points = points;
      renderAmenities();
    } catch (err) { console.warn("Voorzieningen:", err.message); }
  }, 250);
}

async function loadAmenitiesNear(force) {
  const cfg = state.config.amenities;
  const loc = state.location;
  if (!cfg.enabled || !loc) return renderAmenitiesList();
  const from = state.am.nearFrom;
  if (!force && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < cfg.list_radius_m / 4) {
    return renderAmenitiesList();
  }
  state.am.nearFrom = { lat: loc.lat, lon: loc.lon };
  const bbox = bboxAround(loc.lat, loc.lon, cfg.list_radius_m * 1.2).map((v) => v.toFixed(5)).join(",");
  state.am.near = await api(`/api/amenities?bbox=${bbox}`);
  renderAmenitiesList();
}

function initAmenities() {
  if (!state.config.amenities.enabled) return;
  $("am-show-chip").hidden = false;
  state.am.show = store.get("amShow") === "1";
  const saved = store.get("amKinds");
  if (saved != null) state.am.kinds = new Set(saved.split(",").filter(Boolean));
  $("am-show").checked = state.am.show;
  $("am-kinds").hidden = !state.am.show;
  $("am-show").addEventListener("change", (e) => setLayer("amenities", e.target.checked));
  document.querySelectorAll("[data-am-kind]").forEach((el) => {
    el.checked = state.am.kinds.has(el.dataset.amKind);
    el.addEventListener("change", () => {
      el.checked ? state.am.kinds.add(el.dataset.amKind) : state.am.kinds.delete(el.dataset.amKind);
      store.set("amKinds", [...state.am.kinds].join(","));
      renderAmenities();
      renderAmenitiesList();
    });
  });
  scheduleAmenitiesViewport();
  loadAmenitiesNear(true).catch(console.error);
}
