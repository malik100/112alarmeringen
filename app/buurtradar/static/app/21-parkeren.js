/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

// ---------- parkeren ----------

const PK_COLORS = { free: "#16a34a", permit: "#6b7280", disc: "#2563eb", unknown: "#9ca3af" };

function pkColor(st) {
  if (st.state === "paid") {
    if (st.rate == null) return "#9ca3af";
    return st.rate < 2.5 ? "#16a34a" : st.rate < 5 ? "#d97706" : "#dc2626";
  }
  return PK_COLORS[st.state] || "#9ca3af";
}

function pkPopup(zone) {
  const st = Parking.status(zone);
  const today = OpeningHours.amsterdamNow().day;
  const rows = Parking.weekLines(zone).map((l, i) =>
    `<tr${i === today ? ' class="today"' : ""}><td>${esc(l.day)}</td><td>${esc(l.text)}</td></tr>`).join("");
  const extras = (zone.extras || []).map((x) => {
    const p = x.schedule.flat()[0];
    const fare = p && p.fare && zone.fares[p.fare];
    return `<li>${esc(x.name)}${fare ? ` · ${esc(fare.text)}` : ""}</li>`;
  }).join("");
  const facts = [
    zone.capacity ? `${zone.capacity} plaatsen` : "",
    zone.max_height_cm ? `max. hoogte ${(zone.max_height_cm / 100).toFixed(2).replace(".", ",")} m` : "",
  ].filter(Boolean).join(" · ");
  return `
    <b>${esc(zone.name)}</b><br>
    ${esc(Parking.KIND_LABEL[zone.kind])} · ${esc(zone.manager)}<br>
    <span class="pk-status" style="--c:${st.state === "paid" ? Parking.zoneColor(zone) : pkColor(st)}">${esc(st.text)}</span>
    <table class="pk-week">${rows}</table>
    ${extras ? `<div><small>Ook mogelijk:</small><ul class="pk-extras">${extras}</ul></div>` : ""}
    ${facts ? `<div><small>${esc(facts)}</small></div>` : ""}
    ${zone.special_days ? '<div class="pk-note">Op feestdagen en bij evenementen kunnen andere tijden gelden.</div>' : ""}
    ${zone.approx === "automaten" ? '<div class="pk-note">Zonegrens niet bekend bij de RDW: de stippen zijn de parkeerautomaten van deze zone.</div>' : ""}
    ${zone.approx === "straat" ? `<div class="pk-note">Zonegrens niet bekend bij de RDW: de P staat op het midden van ${esc(zone.street || "de straat uit de zonenaam")}.</div>` : ""}
    ${zone.approx_distance_m != null ? `<div class="pk-note">Waarschijnlijk geldt deze zone hier: er staat een automaat op ${esc(fmtDistance(zone.approx_distance_m))}.</div>` : ""}
    <div class="pk-note">Bron: RDW/NPR. Borden ter plaatse gaan altijd voor.</div>
    ${zone.kind === "garage" ? `<div class="popup-links">${routeLink(...pkPoint(zone))}</div>` : ""}
    ${zone.url ? `<a href="${esc(/^https?:/.test(zone.url) ? zone.url : "https://" + zone.url)}" target="_blank" rel="noopener noreferrer">${esc(zone.manager)}${icon("external-link")}</a>` : ""}`;
}

/** Punt voor de route naar een garage/terrein: het punt zelf of het midden van het vlak. */
function pkPoint(zone) {
  if (zone.geometry.type === "Point") return [zone.geometry.coordinates[1], zone.geometry.coordinates[0]];
  if (zone.geometry.type === "MultiPoint") {
    const pts = zone.geometry.coordinates.map(([x, y]) => [y, x]);
    if (!state.location) return pts[0];
    return pts.reduce((best, p) => (haversine(state.location.lat, state.location.lon, p[0], p[1])
      < haversine(state.location.lat, state.location.lon, best[0], best[1]) ? p : best));
  }
  return [(zone.bbox[1] + zone.bbox[3]) / 2, (zone.bbox[0] + zone.bbox[2]) / 2];
}

let pkPendingPopup = null;

function renderParking() {
  let reopen = pkPendingPopup;
  for (const [id, shape] of pkShapes) if (shape.isPopupOpen()) reopen = reopen ?? id;
  pkLayer.clearLayers();
  pkShapes.clear();
  if (!state.pk.show || map.getZoom() < state.config.parking.min_zoom) return;
  // Grote vlakken eerst, zodat kleinere (bijv. garages) erbovenop klikbaar blijven.
  const area = (z) => (z.bbox[2] - z.bbox[0]) * (z.bbox[3] - z.bbox[1]);
  const zones = state.pk.zones.filter((z) => state.pk.kinds.has(z.kind)).sort((a, b) => area(b) - area(a));
  const here = new Set(state.pk.here.map((z) => z.id));
  for (const zone of zones) {
    const st = Parking.status(zone);
    const color = Parking.zoneColor(zone);
    let shape;
    if (zone.geometry.type === "MultiPoint") {
      // Zone zonder kaartvlak: de parkeerautomaten als stippen in de tariefkleur.
      shape = L.featureGroup(zone.geometry.coordinates.map(([x, y]) => L.circleMarker([y, x], {
        pane: "parking", radius: 5, color: "#fff", weight: 1.5, fillColor: color, fillOpacity: st.state === "free" ? 0.55 : 0.95,
      })));
      shape.bindTooltip(() => `<b>${esc(zone.name)}</b><br>${esc(st.text)}<br><small>parkeerautomaat</small>`, { sticky: true, direction: "top", className: "pk-tip" });
    } else if (zone.geometry.type === "Point") {
      const [lon, lat] = zone.geometry.coordinates;
      const approx = zone.approx === "straat";
      shape = L.marker([lat, lon], {
        icon: L.divIcon({ className: "pk-marker", html: `<div class="pk-sign${approx ? " approx" : ""}" style="--c:${Parking.zoneColor(zone)}">P</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        keyboard: false,
        zIndexOffset: -600,
      });
    } else {
      // Nu betalen: stevig gekleurd. Nu gratis (buiten de tijden): zelfde kleur, lichter en
      // gestippeld, zodat je de zone en het tarief ook 's avonds ziet. Jouw zone: dikke rand.
      const mine = here.has(zone.id);
      const permit = zone.kind === "vergunning";
      const quiet = st.state === "free" || permit;
      shape = L.geoJSON(zone.geometry, {
        pane: "parking",
        style: {
          color,
          weight: mine ? 4 : permit ? 1 : 2,
          opacity: 0.9,
          dashArray: quiet ? "6 5" : null,
          fillColor: color,
          fillOpacity: (permit ? 0.05 : quiet ? 0.12 : 0.26) + (mine ? 0.08 : 0),
        },
      });
      shape.bindTooltip(() => `<b>${esc(zone.name)}</b><br>${esc(st.text)}`, { sticky: true, direction: "top", className: "pk-tip" });
    }
    shape.bindPopup(() => pkPopup(zone), { maxWidth: 320 }).addTo(pkLayer);
    pkShapes.set(zone.id, shape);
  }
  if (reopen != null && pkShapes.has(reopen)) {
    const shape = pkShapes.get(reopen);
    const zone = state.pk.zones.find((z) => z.id === reopen);
    if (zone && zone.geometry.type === "MultiPoint") {
      shape.openPopup(pkPoint(zone));  // bij de dichtstbijzijnde automaat
    } else if (zone && zone.geometry.type !== "Point" && state.location) {
      shape.openPopup([state.location.lat, state.location.lon]);
    } else {
      shape.openPopup();
    }
    pkPendingPopup = null;
  }
}

function renderParkingHere() {
  const cfg = state.config.parking;
  if (!cfg.enabled) return;
  const empty = $("empty-pk");
  if (!state.location) {
    $("list-pk").replaceChildren();
    empty.textContent = "Nog geen locatie bekend.";
    empty.hidden = false;
    return;
  }
  const order = { betaald: 0, blauw: 1, garage: 2, vergunning: 3 };
  const zones = [...state.pk.here].sort((a, b) => order[a.kind] - order[b.kind]);
  $("list-pk").replaceChildren(...zones.map(pkListItem));
  empty.textContent = "Geen parkeerregeling bekend; meestal vrij parkeren.";
  empty.hidden = zones.length > 0;
  renderParking();  // jouw zone krijgt op de kaart een dikke rand
  renderOverview();
}

function pkListItem(zone) {
  const st = Parking.status(zone);
  const li = document.createElement("li");
  li.className = "item parking";
  li.style.setProperty("--c", Parking.zoneColor(zone));
  li.tabIndex = 0;
  const bar = document.createElement("span");
  bar.className = "bar";
  const what = document.createElement("span");
  what.className = "what";
  what.textContent = zone.name;
  const kind = document.createElement("span");
  kind.className = "dist";
  kind.textContent = Parking.KIND_LABEL[zone.kind].split(" ")[0];
  const meta = document.createElement("span");
  meta.className = "meta";
  const status = document.createElement("span");
  status.className = "pk-status";
  status.textContent = st.text;
  if (st.state !== "paid") status.style.setProperty("--c", pkColor(st));
  meta.append(status, zone.approx_distance_m != null
    ? ` · waarschijnlijk (automaat op ${fmtDistance(zone.approx_distance_m)})` : ` · ${zone.manager}`);
  li.append(bar, what, kind, meta);
  const open = () => {
    pkPendingPopup = zone.id;
    state.pk.kinds.add(zone.kind);
    document.querySelectorAll("[data-pk]").forEach((el) => {
      if (el.dataset.pk.split(",").includes(zone.kind)) el.checked = true;
    });
    setLayer("parking", true);
    map.setView([state.location.lat, state.location.lon], Math.max(map.getZoom(), state.config.parking.min_zoom, 16));
    scheduleParkingViewport();
    if (window.matchMedia("(max-width: 720px)").matches) setPanel(false);
  };
  li.addEventListener("click", open);
  li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  return li;
}

let pkSeq = 0;
let pkTimer = null;
function scheduleParkingViewport() {
  clearTimeout(pkTimer);
  pkTimer = setTimeout(async () => {
    const cfg = state.config.parking;
    if (!cfg.enabled || !state.pk.show || !state.pk.kinds.size || map.getZoom() < cfg.min_zoom) {
      state.pk.zones = [];
      renderParking();
      return;
    }
    const b = map.getBounds();
    const seq = ++pkSeq;
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
    try {
      const zones = await api(`/api/parking?bbox=${bbox}&kinds=${[...state.pk.kinds].join(",")}`);
      if (seq !== pkSeq) return;
      state.pk.zones = zones;
      renderParking();
    } catch (err) { console.warn("Parkeren:", err.message); }
  }, 300);
}

async function loadParkingHere(force) {
  const loc = state.location;
  if (!state.config.parking.enabled || !loc) return renderParkingHere();
  const from = state.pk.hereFrom;
  if (!force && from && haversine(from.lat, from.lon, loc.lat, loc.lon) < 30) return renderParkingHere();
  state.pk.hereFrom = { lat: loc.lat, lon: loc.lon };
  state.pk.here = await api(`/api/parking/at?lat=${loc.lat.toFixed(6)}&lon=${loc.lon.toFixed(6)}`);
  renderParkingHere();
}

function initParking() {
  if (!state.config.parking.enabled) return;
  const swatch = (color, label, cls = "") =>
    `<span><span class="swatch${cls}" style="--c:${color}"></span>${label}</span>`;
  $("pk-legend").innerHTML = Parking.RATE_SCALE.map((b) => swatch(b.color, `${b.label}/u`)).join("")
    + swatch("#2563eb", "blauwe zone")
    + '<span class="legend-note">Dikke rand = jouw zone. Gestippeld = nu gratis (buiten de betaaltijden).</span>';
  $("pk-show-chip").hidden = false;
  state.pk.show = store.get("pkShow") !== "0";
  $("pk-show").checked = state.pk.show;
  $("pk-show").addEventListener("change", (e) => setLayer("parking", e.target.checked));
  const saved = store.get("pkKinds");
  if (saved != null) state.pk.kinds = new Set(saved.split(",").filter(Boolean));
  document.querySelectorAll("[data-pk]").forEach((el) => {
    const kinds = el.dataset.pk.split(",");
    el.checked = kinds.every((k) => state.pk.kinds.has(k));
    el.addEventListener("change", () => {
      kinds.forEach((k) => (el.checked ? state.pk.kinds.add(k) : state.pk.kinds.delete(k)));
      store.set("pkKinds", [...state.pk.kinds].join(","));
      scheduleParkingViewport();
    });
  });
  scheduleParkingViewport();
  loadParkingHere(true).catch(console.error);
}
