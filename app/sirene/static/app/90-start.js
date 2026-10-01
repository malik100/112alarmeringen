/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

// ---------- start ----------

async function init() {
  // Op een telefoon start het paneel ingeklapt, zodat de kaart zichtbaar is; op desktop
  // zoals je het de vorige keer achterliet.
  setPanel(isPhone() ? false : store.get("panelOpen") !== "0");
  initLayersPanel();
  state.config = await api("/api/config");
  const { map: m } = state.config;
  L.tileLayer(m.tile_url, { maxZoom: 19, attribution: m.attribution }).addTo(map);

  const savedWindow = Number(store.get("windowMin"));
  state.windowMin = savedWindow || m.default_window_minutes;
  $("window").value = String(state.windowMin);
  if (!$("window").value) $("window").value = "120";

  const [loc] = await Promise.all([api("/api/location"), loadIncidents()]);
  state.location = loc;
  if (loc) map.setView([loc.lat, loc.lon], homeZoom());
  initOverview();
  initNav();
  renderAll();
  loadCams().catch(console.error);
  initStatiegeld();
  initParking();
  initCharging();
  initShops();
  initFuel();
  initAmenities();
  initWeather();
  initWaste();
  initHistory();
  initLocal();
  initRoadworks();
  initOv();
  initSections();
  initZoomHelp();
  initPresets();
  connectEvents();

  addLocateControl();
  initLocationUi();
  initSearch();
  initAccess();
  initStatusPanel();
  if (state.config.browser_location && store.get("browserLocation") === "1") startBrowserLocation();
}
$("panel-toggle").addEventListener("click", () => {
  const open = $("panel").classList.contains("collapsed");
  setPanel(open);
  if (!isPhone()) store.set("panelOpen", open ? "1" : "0");
});
document.querySelectorAll("[data-disc]").forEach((el) => el.addEventListener("change", () => {
  el.checked ? state.disciplines.add(el.dataset.disc) : state.disciplines.delete(el.dataset.disc);
  renderIncidents();
  renderList();
}));
document.querySelectorAll("[data-cam]").forEach((el) => el.addEventListener("change", () => {
  el.checked ? state.camKinds.add(el.dataset.cam) : state.camKinds.delete(el.dataset.cam);
  renderCams();
}));
$("only-sirene").addEventListener("change", (e) => {
  state.onlySirene = e.target.checked;
  renderIncidents();
  renderList();
});
$("window").addEventListener("change", async (e) => {
  state.windowMin = Number(e.target.value);
  store.set("windowMin", e.target.value);
  await loadIncidents();
  renderIncidents();
  renderList();
});
map.on("moveend", () => {
  renderCams(); renderList(); scheduleSgViewport(); scheduleParkingViewport(); scheduleChargingViewport(); scheduleShopsViewport();
  scheduleRoadworksViewport(); scheduleOvViewport(); scheduleFuelViewport(); scheduleAmenitiesViewport();
});

// Relatieve tijden bijwerken en verlopen incidenten laten verdwijnen.
// Open/gesloten van statiegeldpunten verandert ook met de tijd.
setInterval(() => {
  renderIncidents();
  renderList();
  renderStatus();
  if (state.config) {
    renderPois(); renderSgList(); renderParking(); renderParkingHere(); renderChargingList(); renderShopsList();
    renderFuel(); renderFuelList(); renderAmenities(); renderAmenitiesList();
  }
}, 30000);

init().catch((err) => {
  console.error(err);
  $("summary").textContent = "Kan de server niet bereiken.";
});
