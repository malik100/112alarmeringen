/* Laadpalen: gebruikersprofielen en weergave van tarieven en beschikbaarheid.
 * Werkt in de browser (window.Charging) en in Node (voor de tests).
 */
(function (root) {
  "use strict";

  /** Profielen voor verschillende soorten gebruikers. */
  const PROFILES = {
    snel: {
      label: "⚡ Snelladen onderweg",
      hint: "Snelladers met CCS vanaf 50 kW die nu vrij zijn.",
      filters: { plugs: ["CCS"], min_kw: 50, available: true, card: false, public: true, always_open: false },
    },
    straat: {
      label: "🏠 Laden in de straat",
      hint: "Gewone laadpalen (Type 2) die nu vrij zijn. Let op een blokkeertarief als je de auto lang laat staan.",
      filters: { plugs: ["Type 2"], min_kw: 0, available: true, card: false, public: true, always_open: false },
      warnParking: true,
    },
    bestemming: {
      label: "🛒 Bestemmingsladen",
      hint: "Laden bij werk, winkel of uitje (Type 2, vanaf 11 kW). De popup toont ook het parkeertarief.",
      filters: { plugs: ["Type 2"], min_kw: 11, available: false, card: false, public: false, always_open: false },
    },
    zonderpas: {
      label: "💳 Zonder laadpas",
      hint: "Punten waar je met creditcard of pinpas kunt betalen, bijv. met een huurauto of als gast.",
      filters: { plugs: [], min_kw: 0, available: true, card: true, public: true, always_open: false },
    },
    chademo: {
      label: "🔌 CHAdeMO (bijv. oudere Nissan Leaf)",
      hint: "Alleen laadpunten met een CHAdeMO-stekker.",
      filters: { plugs: ["CHAdeMO"], min_kw: 0, available: true, card: false, public: true, always_open: false },
    },
    eigen: {
      label: "⚙️ Eigen instellingen",
      hint: "Stel hieronder zelf de filters in.",
      filters: { plugs: [], min_kw: 0, available: false, card: false, public: false, always_open: false },
    },
  };

  function eur(v, digits = 2) {
    return `€${v.toFixed(digits).replace(".", ",")}`;
  }

  /** Querystring voor /api/charging op basis van filters. */
  function query(filters) {
    const p = new URLSearchParams();
    if (filters.plugs && filters.plugs.length) p.set("plugs", filters.plugs.join(","));
    if (filters.min_kw) p.set("min_kw", String(filters.min_kw));
    for (const flag of ["available", "card", "public", "always_open"]) {
      if (filters[flag]) p.set(flag, "true");
    }
    return p.toString();
  }

  /** "€0,41/kWh · start €0,35 · €1,20/uur" of null. */
  function tariffText(t) {
    if (!t) return null;
    const parts = [];
    if (t.kwh != null) parts.push(`${eur(t.kwh)}/kWh`);
    if (t.start != null) parts.push(`start ${eur(t.start)}`);
    if (t.hour != null) parts.push(`${eur(t.hour)}/uur laadtijd`);
    if (t.parking_hour != null) parts.push(`blokkeertarief ${eur(t.parking_hour)}/uur`);
    if (!parts.length) return null;
    return parts.join(" · ") + (t.varies ? " (verschilt per tijdstip)" : "");
  }

  /** Beschikbaarheid: { state: "free"|"busy"|"unknown", text }. */
  function availability(station) {
    const s = station.status;
    if (!s || !s.total) return { state: "unknown", text: "Beschikbaarheid onbekend" };
    if (s.available > 0) return { state: "free", text: `${s.available} van ${s.total} vrij` };
    return { state: "busy", text: `Alle ${s.total} bezet` };
  }

  /** Korte samenvatting voor de lijst: "CCS 150 kW · €0,59/kWh". */
  function summary(station) {
    const best = station.connectors[0];
    if (!best) return "";
    const kw = best.kw ? ` ${best.kw} kW` : best.dc ? " snellader" : "";
    const price = best.tariff && best.tariff.kwh != null ? ` · ${eur(best.tariff.kwh)}/kWh` : "";
    return `${best.plug}${kw}${price}`;
  }

  /** Belangrijke kanttekeningen bij deze locatie voor dit profiel. */
  function warnings(station, profile) {
    const out = [];
    if (station.customers_only) out.push("Alleen voor klanten");
    if (station.twentyfourseven === false) out.push("Niet 24/7 open");
    if (!station.payment.creditcard && !station.payment.pinpas) out.push("Alleen met laadpas of app");
    if (profile && profile.warnParking &&
        station.connectors.some((c) => c.tariff && (c.tariff.parking_hour != null || c.tariff.hour != null))) {
      out.push("Kosten per uur: laat de auto niet onnodig lang staan");
    }
    return out;
  }

  /** Leesbare naam: interne codes van exploitanten ("TNLP030856") vervangen door exploitant + straat. */
  function displayName(station) {
    const street = (station.address || "").split(/\s\d{4}\s?[A-Z]{2}\b/)[0].trim();
    let name = (station.name || "").trim().replace(/^[A-Z0-9_]{5,}\s*-\s*/, "");
    if (!name || /^[A-Z0-9_\-]+$/.test(name) || !/[a-z]/.test(name)) name = "";
    if (name) return name;
    return [station.operator, street].filter(Boolean).join(" · ") || "Laadpunt";
  }

  const api = { PROFILES, query, tariffText, availability, summary, warnings, displayName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Charging = api;
})(typeof window !== "undefined" ? window : globalThis);
