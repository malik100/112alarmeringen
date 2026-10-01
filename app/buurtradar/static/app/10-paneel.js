/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

// ---------- paneel ----------

function listItem(inc, dist) {
  const li = document.createElement("li");
  li.className = `item ${inc.discipline}${Date.now() / 1000 - inc.ts > OLD_INCIDENT_S ? " old" : ""}`;
  li.tabIndex = 0;

  const bar = document.createElement("span");
  bar.className = "bar";
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = inc.description || inc.title;
  const distEl = document.createElement("span");
  distEl.className = "dist";
  distEl.textContent = dist != null ? fmtDistance(dist) : "";
  const meta = document.createElement("span");
  meta.className = "meta";
  if (inc.sirene) {
    const tag = document.createElement("span");
    tag.className = "tag sirene";
    tag.textContent = "SIRENE";
    meta.append(tag, " ");
  }
  if (inc.news && inc.news.length) {
    const tag = document.createElement("span");
    tag.className = "tag news";
    tag.textContent = "NIEUWS";
    tag.title = inc.news[0].title;
    meta.append(tag, " ");
  }
  meta.append(`${LABEL[inc.discipline] || inc.discipline} · ${fmtTime(inc.ts)} · ${fmtAgo(inc.ts)}` +
    (inc.precision === "plaats" ? " · locatie ≈ plaats" : "") +
    (inc.lat == null ? " · locatie onbekend" : ""));

  li.append(bar, what, distEl, meta);
  const open = () => {
    if (inc.lat == null) return;
    setLayer("incidents", true);
    map.setView([inc.lat, inc.lon], Math.max(map.getZoom(), 15));
    markers.get(inc.id)?.openPopup();
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

function renderList() {
  const radius = state.config.radius_m;
  const visible = [...state.incidents.values()].filter(isVisible);
  const withDist = visible.map((inc) => ({ inc, d: distanceTo(inc) }));

  const near = withDist.filter((x) => x.d != null && x.d <= radius).sort((a, b) => a.d - b.d);
  const nearIds = new Set(near.map((x) => x.inc.id));
  const bounds = map.getBounds();
  const inView = withDist
    .filter((x) => !nearIds.has(x.inc.id) && x.inc.lat != null && bounds.contains([x.inc.lat, x.inc.lon]))
    .sort((a, b) => b.inc.ts - a.inc.ts)
    .slice(0, 50);

  $("near-title").textContent = state.location
    ? `Binnen ${fmtDistance(radius)} van jou`
    : "Binnen je straal";
  $("list-near").replaceChildren(...near.map((x) => listItem(x.inc, x.d)));
  $("empty-near").hidden = near.length > 0 || !state.location;
  $("list-view").replaceChildren(...inView.map((x) => listItem(x.inc, x.d)));
  $("empty-view").hidden = inView.length > 0;

  renderOverview();
}

function renderStatus(live) {
  if (live !== undefined) {
    $("st-live").className = `brand-dot ${live ? "ok" : "err"}`;
    $("st-live").title = live ? "Live verbonden" : "Verbinding met de server weg";
  }
  // Locatie alleen tonen als er iets aan de hand is.
  const loc = state.location;
  const locEl = $("st-loc");
  const age = loc ? Date.now() / 1000 - loc.ts : null;
  if (!loc) {
    locEl.textContent = "Geen locatie";
    locEl.className = "pill err";
  } else if (loc.source === "vast") {
    locEl.textContent = "Vaste locatie";
    locEl.className = "pill warn";
  } else if (age > LOCATION_STALE_S) {
    locEl.textContent = `Locatie ${fmtAgo(loc.ts)}`;
    locEl.className = "pill warn";
  }
  locEl.hidden = !!loc && loc.source !== "vast" && age <= LOCATION_STALE_S;
  const n = $("notify-state");
  if (n) n.textContent = state.config.notifications_enabled ? "Pushmeldingen staan aan." : "Pushmeldingen staan uit.";
}

function renderAll() {
  renderIncidents();
  renderList();
  renderMe();
  renderStatus();
}

const isPhone = () => window.matchMedia("(max-width: 720px)").matches;

/** Kaartlagen-paneel links in- of uitklappen. */
function setLayersPanel(open) {
  $("layers").classList.toggle("collapsed", !open);
  $("layers-toggle").setAttribute("aria-expanded", String(open));
}

function initLayersPanel() {
  // Desktop: standaard open; telefoon: standaard dicht (anders bedekt het de kaart).
  const saved = store.get(isPhone() ? "layersOpenPhone" : "layersOpen");
  setLayersPanel(saved != null ? saved === "1" : !isPhone());
  $("layers-toggle").addEventListener("click", () => {
    const open = $("layers").classList.contains("collapsed");
    setLayersPanel(open);
    store.set(isPhone() ? "layersOpenPhone" : "layersOpen", open ? "1" : "0");
  });
}

function setPanel(open) {
  $("panel").classList.toggle("collapsed", !open);
  $("panel-toggle").setAttribute("aria-expanded", String(open));
}

// In-page waarschuwing, los van (optionele) pushmeldingen.
function checkAlert(inc) {
  const d = distanceTo(inc);
  if (!inc.sirene || d == null || d > state.config.radius_m || state.alerted.has(inc.id)) return;
  if (Date.now() / 1000 - inc.ts > 15 * 60) return;
  state.alerted.add(inc.id);
  const el = $("alert");
  el.replaceChildren(iconEl("siren"),
    `${LABEL[inc.discipline] || "Hulpdienst"} met sirene op ${fmtDistance(d)}: ${inc.description || inc.title}`);
  el.hidden = false;
  el.onclick = () => {
    el.hidden = true;
    map.setView([inc.lat, inc.lon], 16);
    markers.get(inc.id)?.openPopup();
  };
  clearTimeout(checkAlert.timer);
  checkAlert.timer = setTimeout(() => { el.hidden = true; }, 60000);
}
