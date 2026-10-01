/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

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
    ${esc(point.address)}${d != null ? ` · ${esc(fmtDistance(d))} · ${esc(Nav.eta(d))}` : ""}<br>
    <span class="${SG_STATE_CLASS[st.state]}">${esc(st.text)}</span>
    <table class="sg-hours">${rows}</table>
    ${point.materials.length ? `<div><small>Neemt in: ${esc(point.materials.join(", "))}</small></div>` : ""}
    ${point.payouts.length ? `<div><small>Uitbetaling: ${esc(point.payouts.join(", "))}</small></div>` : ""}
    ${facts.length ? `<div><small>${esc(facts.join(" · "))}</small></div>` : ""}
    <div class="popup-links">${routeLink(point.lat, point.lon)}</div>`;
}

let sgPendingPopup = null;

function drawSg(layout) {
  const reopen = sgPendingPopup ?? openPopupId(sgMarkers);
  sgLayer.clearLayers();
  sgMarkers.clear();
  layout.sg.forEach(({ p: point, st }, i) => {
    const marker = spreadMarker(point.lat, point.lon, `<div class="sg-sign ${st.state}">${icon("recycle")}</div>`,
      "sg-marker", 22, layout.sgOff[i], layout.sgLabel[i] ? point.name : null, -500)
      .bindPopup(() => sgPopup(point), { maxWidth: 280 });
    marker.addTo(sgLayer);
    sgMarkers.set(point.id, marker);
  });
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
  meta.append(status, " · ", etaSpan(Nav.eta(dist)), ` · ${point.address}`);
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
