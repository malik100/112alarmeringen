/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

// ---------- wegwerkzaamheden ----------

const RW_COLORS = { closed: "#dc2626", hinder: "#ea580c", event: "#7c3aed" };
const RW_PAGE = 12;
const rwLayer = L.layerGroup().addTo(map);
const rwMarkers = new Map();
let rwPendingPopup = null;

function rwTone(w) {
  return w.kind === "evenement" ? "event" : w.closed ? "closed" : "hinder";
}

/** Wat merk je ervan: "Weg dicht in beide richtingen · omleiding". */
function rwImpact(w, short = false) {
  const closedText = w.warnings.find((x) => /dicht|afgesloten/i.test(x));
  let text = closedText || (w.closed ? "Deels afgesloten" : w.warnings[0])
    || (w.speed ? `Max. ${w.speed} km/u` : w.kind === "evenement" ? "Evenement" : "Hinder");
  if (short && text.length > 60) text = `${text.slice(0, 57).trimEnd()}…`;
  if (w.speed && !text.includes("km/u")) text += ` · max. ${w.speed} km/u`;
  if (w.detour) text += " · omleiding";
  return text;
}

const AMS = { timeZone: "Europe/Amsterdam" };
function fmtDay2(ts) {
  return new Date(ts * 1000).toLocaleDateString("nl-NL", { ...AMS, day: "numeric", month: "short" });
}
function fmtWhen(ts) {
  const d = new Date(ts * 1000);
  const sameDay = d.toLocaleDateString("nl-NL", AMS) === new Date().toLocaleDateString("nl-NL", AMS);
  const time = d.toLocaleTimeString("nl-NL", { ...AMS, hour: "2-digit", minute: "2-digit" });
  return sameDay ? `vandaag ${time}` : `${fmtDay2(ts)} ${time}`;
}

/** "t/m 19 okt", "tot 16:00" of "vanaf 3 okt 07:00". */
function rwPeriod(w) {
  const now = Date.now() / 1000;
  if (w.start && w.start > now) return `vanaf ${fmtWhen(w.start)}`;
  if (!w.end) return "tot nader bericht";
  return w.end - now < 86400 ? `tot ${fmtWhen(w.end).replace("vandaag ", "")}` : `t/m ${fmtDay2(w.end)}`;
}

function rwWhere(w) {
  // Kaartitems hebben zelf geen straatnaam; de lijst (met PDOK-straatnaam) vaak wel.
  const street = w.street || state.rw.near.find((x) => x.id === w.id)?.street;
  return street || w.road || w.note || w.cause || "Wegwerk";
}

function rwWhat(w) {
  const what = w.kind === "evenement" ? (w.note || "Evenement") : (w.cause || w.note || "");
  return what === rwWhere(w) ? "" : what;
}

function rwVisible(w) {
  return (state.rw.planned || w.active) && (!state.rw.onlyClosed || w.closed);
}

function rwPopup(w) {
  const tone = rwTone(w);
  const period = w.start && w.end ? `${fmtWhen(w.start)} – ${fmtWhen(w.end)}` : rwPeriod(w);
  const what = rwWhat(w);
  const d = state.location ? haversine(state.location.lat, state.location.lon, w.lat, w.lon) : null;
  return `
    <b>${esc(rwWhere(w))}</b><br>
    <span class="rw-impact ${tone}">${esc(rwImpact(w))}</span><br>
    <small>${esc(period)}${d != null ? ` · ${esc(fmtDistance(d))}` : ""}</small>
    ${what ? `<div>${esc(what)}</div>` : ""}
    ${w.details.map((x) => `<div><small>${esc(x)}</small></div>`).join("")}
    <div><small>${esc(w.source)}</small></div>
    <div class="popup-links">
      ${w.url ? `<a href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${icon("file-text")}Tekening</a>` : ""}
      ${routeLink(w.lat, w.lon)}
    </div>`;
}

function rwIcon(w) {
  const tone = rwTone(w);
  return L.divIcon({
    className: "rw-marker",
    html: `<div class="rw-sign ${tone}${w.active ? "" : " planned"}">${icon(tone === "event" ? "party-popper" : "construction")}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function renderRoadworks() {
  const reopen = rwPendingPopup ?? openPopupId(rwMarkers);
  rwLayer.clearLayers();
  rwMarkers.clear();
  const cfg = state.config.roadworks;
  if (!state.rw.show || map.getZoom() < cfg.min_zoom) return;
  for (const w of state.rw.items) {
    if (!rwVisible(w)) continue;
    const color = RW_COLORS[rwTone(w)];
    const marker = L.marker([w.lat, w.lon], { icon: rwIcon(w), keyboard: false, zIndexOffset: -300 })
      .bindPopup(() => rwPopup(w), { maxWidth: 300 });
    for (const line of w.lines) {
      L.polyline(line, { color, weight: 5, opacity: w.active ? 0.85 : 0.5, dashArray: w.active ? null : "6 6" })
        .on("click", () => marker.openPopup())
        .addTo(rwLayer);
    }
    marker.addTo(rwLayer);
    rwMarkers.set(w.id, marker);
  }
  if (reopen != null && rwMarkers.has(reopen)) {
    rwMarkers.get(reopen).openPopup();
    rwPendingPopup = null;
  }
}

function rwListItem(w) {
  const li = document.createElement("li");
  li.className = "item roadwork";
  li.tabIndex = 0;
  li.style.setProperty("--c", w.active ? RW_COLORS[rwTone(w)] : "#9ca3af");
  const bar = document.createElement("span");
  bar.className = "bar";
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = rwWhere(w);
  const distEl = document.createElement("span");
  distEl.className = "dist";
  distEl.textContent = w.distance_m != null ? fmtDistance(w.distance_m) : "";
  const meta = document.createElement("span");
  meta.className = "meta";
  const impact = document.createElement("span");
  impact.className = `rw-impact ${rwTone(w)}`;
  impact.textContent = rwImpact(w, true);
  meta.append(impact, ` · ${rwPeriod(w)}`);
  const extra = rwWhat(w);
  if (extra) meta.append(` · ${extra}`);
  li.append(bar, what, distEl, meta);
  const open = () => {
    rwPendingPopup = w.id;
    if (!w.active && !state.rw.planned) { state.rw.planned = true; $("rw-planned").checked = true; }
    setLayer("roadworks", true);
    map.setView([w.lat, w.lon], Math.max(map.getZoom(), state.config.roadworks.min_zoom, 16));
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function rwNearItems() {
  return state.rw.near.filter((w) => rwVisible(w) && w.distance_m <= state.config.roadworks.list_radius_m);
}

function renderRoadworksList() {
  const cfg = state.config.roadworks;
  if (!cfg.enabled) return;
  $("rw-title").textContent = `Wegwerk binnen ${fmtDistance(cfg.list_radius_m)}`;
  const items = rwNearItems();
  const shown = state.rw.showAll ? items : items.slice(0, RW_PAGE);
  $("list-rw").replaceChildren(...shown.map(rwListItem));
  $("rw-more").hidden = shown.length >= items.length;
  $("rw-more").textContent = `Alle ${items.length} tonen`;
  const empty = $("empty-rw");
  empty.textContent = !state.location ? "Nog geen locatie bekend."
    : state.rw.onlyClosed ? "Geen afgesloten wegen in de buurt." : "Geen wegwerkzaamheden in de buurt.";
  empty.hidden = items.length > 0;
  renderOverview();
}

let rwSeq = 0;
let rwTimer = null;
function scheduleRoadworksViewport() {
  clearTimeout(rwTimer);
  rwTimer = setTimeout(async () => {
    const cfg = state.config.roadworks;
    if (!cfg.enabled || !state.rw.show || map.getZoom() < cfg.min_zoom) {
      state.rw.items = [];
      renderRoadworks();
      return;
    }
    const b = map.getBounds();
    const seq = ++rwSeq;
    try {
      const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
      const items = await api(`/api/roadworks?bbox=${bbox}&planned=true`);
      if (seq !== rwSeq) return;
      const now = Date.now() / 1000;
      items.forEach((w) => { w.active = (!w.start || w.start <= now) && (!w.end || w.end >= now); });
      state.rw.items = items;
      renderRoadworks();
    } catch (err) { console.warn("Wegwerk:", err.message); }
  }, 250);
}

async function loadRoadworksNear(force) {
  const cfg = state.config.roadworks;
  const loc = state.location;
  if (!cfg.enabled || !loc) return renderRoadworksList();
  const from = state.rw.nearFrom;
  if (!force && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < cfg.list_radius_m / 4) {
    return renderRoadworksList();
  }
  state.rw.nearFrom = { lat: loc.lat, lon: loc.lon };
  const bbox = bboxAround(loc.lat, loc.lon, cfg.list_radius_m).map((v) => v.toFixed(5)).join(",");
  state.rw.near = await api(`/api/roadworks?bbox=${bbox}&planned=true&near=${loc.lat.toFixed(5)},${loc.lon.toFixed(5)}&limit=150`);
  renderRoadworksList();
}

function initRoadworks() {
  if (!state.config.roadworks.enabled) return;
  $("rw-show-chip").hidden = false;
  state.rw.show = store.get("rwShow") === "1";
  state.rw.planned = store.get("rwPlanned") === "1";
  state.rw.onlyClosed = store.get("rwClosed") === "1";
  $("rw-show").checked = state.rw.show;
  $("rw-planned").checked = state.rw.planned;
  $("rw-closed").checked = state.rw.onlyClosed;
  $("rw-show").addEventListener("change", (e) => setLayer("roadworks", e.target.checked));
  const refilter = () => { state.rw.showAll = false; renderRoadworks(); renderRoadworksList(); };
  $("rw-planned").addEventListener("change", (e) => {
    state.rw.planned = e.target.checked;
    store.set("rwPlanned", state.rw.planned ? "1" : "0");
    refilter();
  });
  $("rw-closed").addEventListener("change", (e) => {
    state.rw.onlyClosed = e.target.checked;
    store.set("rwClosed", state.rw.onlyClosed ? "1" : "0");
    refilter();
  });
  $("rw-more").addEventListener("click", () => { state.rw.showAll = true; renderRoadworksList(); });
  scheduleRoadworksViewport();
  loadRoadworksNear(true).catch(console.error);
}
