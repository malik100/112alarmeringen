/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

// ---------- nieuws en bekendmakingen uit de buurt ----------

const BK_ICON = { bouwen: "construction", verkeer: "traffic-cone", evenementen: "party-popper",
  vergunning: "stamp", overig: "file-text" };
const BK_LABEL = { bouwen: "Bouwen", verkeer: "Verkeer", evenementen: "Evenement", vergunning: "Vergunning",
  overig: "Bekendmaking" };
const BK_PAGE = 15;
const NW_PAGE = 5;
// Vanaf deze score telt een bekendmaking als "belangrijk" (zie relevance() op de server).
const BK_IMPORTANT = 1.5;
const BK_SORT = {
  relevant: (a, b) => b.relevance - a.relevance,
  new: (a, b) => (b.date || "").localeCompare(a.date || "") || b.relevance - a.relevance,
  near: (a, b) => (a.distance_m ?? 1e9) - (b.distance_m ?? 1e9),
};
const LOCAL_REFRESH_MS = 10 * 60 * 1000;
const bkLayer = L.layerGroup().addTo(map);
const bkShapeLayer = L.layerGroup().addTo(map);   // het gebied van de aangeklikte bekendmaking
const BK_COLORS = { bouwen: "#b45309", verkeer: "#2563eb", evenementen: "#7c3aed", vergunning: "#0f766e", overig: "#6b7280" };

/** Teken het aangegeven gebied (straat, bouwvlak) bij een open popup. */
function bkDrawShape(a) {
  bkShapeLayer.clearLayers();
  if (!a || !a.shape) return;
  const color = BK_COLORS[a.category] || BK_COLORS.overig;
  const opts = { color, weight: 3, opacity: 0.9, fillColor: color, fillOpacity: 0.15, interactive: false };
  (a.shape.type === "Polygon" ? L.polygon(a.shape.coords, opts) : L.polyline(a.shape.coords, opts)).addTo(bkShapeLayer);
}
const bkMarkers = new Map();
let bkPendingPopup = null;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "2026-09-28" -> "vandaag", "gisteren" of "28 sep". */
function fmtDay(iso) {
  if (!iso) return "";
  const today = new Date();
  if (iso === isoDate(today)) return "vandaag";
  if (iso === isoDate(new Date(today.getTime() - 86400000))) return "gisteren";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
}

/** Kop en soort uit een bekendmaking: "Het bouwen van een dakkapel" + "Aanvraag omgevingsvergunning". */
function bkParts(a) {
  const comma = a.title.indexOf(",");
  let kind = comma > 0 && comma < 60 ? a.title.slice(0, comma) : BK_LABEL[a.category];
  if (/^aangevraagde evenementenvergunning/i.test(kind)) kind = "Evenement aangevraagd";
  let head = a.abstract && a.abstract.length > 8 ? a.abstract : (comma > 0 && comma < 60 ? a.title.slice(comma + 1) : a.title);
  head = head.trim();
  return { kind, head: head.charAt(0).toUpperCase() + head.slice(1) };
}

/** Waar: het adreslabel, anders het laatste deel van de titel ("…, Domplein te Utrecht"). */
function bkPlace(a) {
  // Oudere opgeslagen items kunnen nog een plaatshouder als "Handmatig 1" hebben.
  if (a.label && !/^\s*(handmatig|gebied|locatie|vlak|geometrie)\b[\s\d]*$/i.test(a.label)) return a.label;
  if (a.distance_m == null) return `hele gemeente ${a.gemeente}`;
  const parts = a.title.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 1] : "";
}

function bkDeadline(a) {
  return a.deadline && a.deadline >= isoDate(new Date()) ? `reageren t/m ${fmtDay(a.deadline)}` : "";
}

function bkVisible(a) {
  return state.bk.cats.has(a.category) && (!state.bk.important || a.relevance >= BK_IMPORTANT);
}

function bkPopup(a) {
  const { kind, head } = bkParts(a);
  const dl = bkDeadline(a);
  return `
    <b>${esc(head)}</b><br>
    <small>${esc(kind)} · ${esc(fmtDay(a.date))}${dl ? ` · ${esc(dl)}` : ""}</small><br>
    ${bkPlace(a) ? `${esc(bkPlace(a))}<br>` : ""}
    <div class="popup-links">
      <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${icon("external-link")}Bekijken</a>
      ${a.lat != null ? routeLink(a.lat, a.lon) : ""}
    </div>`;
}

function bkIcon(a) {
  return L.divIcon({
    className: "bk-marker",
    html: `<div class="bk-sign ${a.category}">${icon(BK_ICON[a.category] || "file-text")}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function renderBkLayer() {
  const reopen = bkPendingPopup ?? openPopupId(bkMarkers);
  bkLayer.clearLayers();
  bkMarkers.clear();
  for (const a of state.bk.items) {
    // Standaard alleen de bekendmaking die je aantikte; de hele laag is optioneel.
    if (a.lat == null || !(state.bk.show ? bkVisible(a) : a.id === state.bk.focus)) continue;
    const marker = L.marker([a.lat, a.lon], { icon: bkIcon(a), keyboard: false, zIndexOffset: -400 })
      .bindPopup(() => bkPopup(a), { maxWidth: 280 });
    marker.on("popupopen", () => bkDrawShape(a));
    marker.on("popupclose", () => bkDrawShape(null));
    marker.addTo(bkLayer);
    bkMarkers.set(a.id, marker);
  }
  if (reopen != null && bkMarkers.has(reopen)) {
    bkMarkers.get(reopen).openPopup();
    bkPendingPopup = null;
  }
}

function nwListItem(n) {
  const li = document.createElement("li");
  li.className = "item nw-item";
  const a = document.createElement("a");
  a.href = n.link;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = "what";
  a.textContent = n.title;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = [n.source, fmtAgo(n.ts), n.place].filter(Boolean).join(" · ");
  li.append(iconEl("newspaper", "lead"), a, meta);
  return li;
}

function bkListItem(a) {
  const { kind, head } = bkParts(a);
  const li = document.createElement("li");
  li.className = "item bk-item";
  li.tabIndex = 0;
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = head;
  const distEl = document.createElement("span");
  distEl.className = "dist";
  distEl.textContent = a.distance_m == null ? "" : fmtDistance(a.distance_m);
  const meta = document.createElement("span");
  meta.className = "meta";
  const dl = bkDeadline(a);
  meta.textContent = [kind, bkPlace(a),
    fmtDay(a.date), dl].filter(Boolean).join(" · ");
  const link = document.createElement("a");
  link.href = a.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "bk-link";
  link.title = "Bekijk op officielebekendmakingen.nl";
  link.setAttribute("aria-label", "Bekijken");
  link.append(iconEl("external-link"));
  link.addEventListener("click", (e) => e.stopPropagation());
  li.append(iconEl(BK_ICON[a.category] || "file-text", `lead ${a.category}`), what, distEl, meta, link);
  const open = () => {
    if (a.lat == null) { window.open(a.url, "_blank", "noopener"); return; }
    bkPendingPopup = a.id;
    state.bk.focus = a.id;
    map.setView([a.lat, a.lon], Math.max(map.getZoom(), 17));
    renderBkLayer();
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function bkItems() {
  return state.bk.items.filter(bkVisible).sort(BK_SORT[state.bk.sort] || BK_SORT.relevant);
}

function renderLocal() {
  const cfg = state.config.local;
  if (!cfg.news && !cfg.announcements) return;
  const noLoc = !state.location;
  $("nw-section").hidden = !cfg.news;
  $("bk-section").hidden = !cfg.announcements;

  const place = state.nw.place;
  $("nw-title").textContent = place ? `Nieuws rond ${place}` : "Nieuws uit je buurt";
  const news = state.nw.showAll ? state.nw.items : state.nw.items.slice(0, NW_PAGE);
  $("list-nw").replaceChildren(...news.map(nwListItem));
  $("nw-more").hidden = news.length >= state.nw.items.length;
  $("nw-more").textContent = `Alle ${state.nw.items.length} tonen`;
  const emptyNw = $("empty-nw");
  emptyNw.textContent = noLoc ? "Nog geen locatie bekend."
    : state.nw.loading ? "Laden…" : "Geen recent nieuws dat een plaats in je buurt noemt.";
  emptyNw.hidden = state.nw.items.length > 0;

  $("bk-title").textContent = `Bekendmakingen binnen ${fmtDistance(cfg.radius_m)}`;
  const items = bkItems();
  const shown = state.bk.showAll ? items : items.slice(0, BK_PAGE);
  $("list-bk").replaceChildren(...shown.map(bkListItem));
  $("bk-more").hidden = shown.length >= items.length;
  $("bk-more").textContent = `Alle ${items.length} tonen`;
  const emptyBk = $("empty-bk");
  const hidden = state.bk.items.length - items.length;
  emptyBk.textContent = noLoc ? "Nog geen locatie bekend."
    : state.nw.loading ? "Laden…"
      : hidden ? `Niets met deze filters. ${hidden} andere bekendmaking${hidden === 1 ? "" : "en"} verborgen.`
        : "Geen bekendmakingen in de afgelopen 30 dagen.";
  emptyBk.hidden = items.length > 0;
  renderBkLayer();
  renderOverview();
}

async function loadLocal(force) {
  const cfg = state.config.local;
  const loc = state.location;
  if ((!cfg.news && !cfg.announcements) || !loc) return renderLocal();
  const from = state.nw.from;
  if (!force && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < 300 &&
      Date.now() - from.at < LOCAL_REFRESH_MS) return renderLocal();
  state.nw.from = { lat: loc.lat, lon: loc.lon, at: Date.now() };
  state.nw.loading = !state.nw.items.length && !state.bk.items.length;
  renderLocal();
  try {
    const out = await api(`/api/local?lat=${loc.lat.toFixed(5)}&lon=${loc.lon.toFixed(5)}`);
    state.nw.items = out.news;
    state.nw.place = out.place;
    state.bk.items = out.announcements;
  } finally {
    state.nw.loading = false;
    renderLocal();
  }
}

function initLocal() {
  const cfg = state.config.local;
  if (!cfg.news && !cfg.announcements) return;
  if (cfg.news) {
    $("nw-show-chip").hidden = false;
    state.nw.show = store.get("nwShow") !== "0";
    $("nw-show").checked = state.nw.show;
    $("nw-show").addEventListener("change", (e) => setLayer("news", e.target.checked));
  }
  if (cfg.announcements) {
    $("bk-show-chip").hidden = false;
    state.bk.show = store.get("bkShow") === "1";
    $("bk-show").checked = state.bk.show;
    $("bk-show").addEventListener("change", (e) => setLayer("announcements", e.target.checked));
  }
  const saved = store.get("bkCats2");
  if (saved != null) state.bk.cats = new Set(saved.split(",").filter(Boolean));
  state.bk.important = store.get("bkImportant") !== "0";
  state.bk.sort = store.get("bkSort") || "relevant";
  document.querySelectorAll("[data-bk]").forEach((el) => {
    const cats = el.dataset.bk.split(",");
    el.checked = cats.every((c) => state.bk.cats.has(c));
    el.addEventListener("change", () => {
      cats.forEach((c) => (el.checked ? state.bk.cats.add(c) : state.bk.cats.delete(c)));
      store.set("bkCats2", [...state.bk.cats].join(","));
      state.bk.showAll = false;
      renderLocal();
    });
  });
  $("bk-important").checked = state.bk.important;
  $("bk-important").addEventListener("change", (e) => {
    state.bk.important = e.target.checked;
    store.set("bkImportant", state.bk.important ? "1" : "0");
    renderLocal();
  });
  $("bk-sort").value = state.bk.sort;
  $("bk-sort").addEventListener("change", (e) => {
    state.bk.sort = e.target.value;
    store.set("bkSort", state.bk.sort);
    renderLocal();
  });
  $("nw-more").addEventListener("click", () => { state.nw.showAll = true; renderLocal(); });
  $("bk-more").addEventListener("click", () => { state.bk.showAll = true; renderLocal(); });
  loadLocal(true).catch(console.error);
  setInterval(() => loadLocal().catch(console.error), LOCAL_REFRESH_MS);
}
