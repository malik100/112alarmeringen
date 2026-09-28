/* Navigatie: route openen in je eigen navigatie-app en reistijd schatten.
 * Werkt in de browser (window.Nav) en in Node (voor de tests).
 */
(function (root) {
  "use strict";

  const APPS = {
    auto: "Automatisch",
    apple: "Apple Kaarten",
    google: "Google Maps",
    waze: "Waze",
    osm: "OpenStreetMap (website)",
  };

  function isApple(userAgent) {
    return /iPhone|iPad|iPod|Macintosh/.test(userAgent || "");
  }

  /** Link die de route opent in de gekozen app. */
  function routeUrl(lat, lon, app, userAgent) {
    const choice = app === "auto" || !APPS[app] ? (isApple(userAgent) ? "apple" : "google") : app;
    const ll = `${lat},${lon}`;
    switch (choice) {
      case "apple": return `https://maps.apple.com/?daddr=${ll}`;
      case "waze": return `https://waze.com/ul?ll=${encodeURIComponent(ll)}&navigate=yes`;
      case "osm": return `https://www.openstreetmap.org/directions?to=${encodeURIComponent(ll)}`;
      default: return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ll)}`;
    }
  }

  // Schatting zonder routeplanner: hemelsbreed × omrijfactor, gemiddelde snelheden in de stad.
  const DETOUR = 1.3;
  const SPEED_M_PER_MIN = { lopen: 80, fietsen: 250, auto: 500 };
  const VERB = { lopen: "lopen", fietsen: "fietsen", auto: "rijden" };
  const CAR_EXTRA_MIN = 2; // wegrijden en parkeren

  function minutes(distanceM, mode) {
    const m = (distanceM * DETOUR) / SPEED_M_PER_MIN[mode] + (mode === "auto" ? CAR_EXTRA_MIN : 0);
    return Math.max(1, Math.round(m));
  }

  /** "5 min lopen · 2 min fietsen": de twee zinvolste vervoerswijzen voor deze afstand. */
  function eta(distanceM, prefer) {
    if (distanceM == null) return "";
    let modes;
    if (prefer === "auto") modes = distanceM <= 800 ? ["lopen", "auto"] : ["fietsen", "auto"];
    else modes = minutes(distanceM, "lopen") <= 20 ? ["lopen", "fietsen"] : ["fietsen", "auto"];
    return modes.map((m) => `${minutes(distanceM, m)} min ${VERB[m]}`).join(" · ");
  }

  const api = { APPS, routeUrl, eta, minutes };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Nav = api;
})(typeof window !== "undefined" ? window : globalThis);
