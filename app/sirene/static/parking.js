/* Parkeerzones: wat geldt er nu, en tot wanneer?
 *
 * zone.schedule: 7 dagen (maandag eerst), per dag een lijst periodes
 * { s, e, fare, max } met s/e in minuten na middernacht, fare een tariefcode
 * (zie zone.fares) en max de maximale parkeerduur in minuten.
 * Werkt in de browser (window.Parking) en in Node (voor de tests).
 */
(function (root) {
  "use strict";

  const OH = typeof module !== "undefined" && module.exports
    ? require("./openinghours.js") : root.OpeningHours;

  const KIND_LABEL = {
    betaald: "Betaald parkeren",
    blauw: "Blauwe zone",
    vergunning: "Vergunninghouders",
    garage: "Garage / terrein / P+R",
  };

  function hhmm(minutes) {
    return minutes >= 1440 ? "24:00" : OH.hhmm(minutes);
  }

  function durationText(min) {
    return min % 60 === 0 ? `${min / 60} uur` : `${min} min`;
  }

  /** Eerstvolgende start van een periode na (dag, minuut). */
  function nextStart(schedule, day, minute) {
    for (let offset = 0; offset < 8; offset++) {
      const d = (day + offset) % 7;
      const next = (schedule[d] || []).filter((p) => offset > 0 || p.s > minute)
        .sort((a, b) => a.s - b.s)[0];
      if (next) return { offset, day: d, start: next.s };
    }
    return null;
  }

  function whenText(next) {
    if (!next) return "";
    const day = next.offset === 0 ? "" : next.offset === 1 ? "morgen " : `${OH.DAYS[next.day]} `;
    return `${day}${hhmm(next.start)}`;
  }

  /** Eind van de huidige periode, doorgerekend over aansluitende periodes met hetzelfde tarief. */
  function untilText(schedule, day, period) {
    let days = 0;
    let p = period;
    while (p.e >= 1440 && days < 7) {
      const next = (schedule[(day + days + 1) % 7] || []).find((q) => q.s === 0 && q.fare === p.fare);
      if (!next) break;
      days += 1;
      p = next;
    }
    if (days >= 7) return "hele week";
    if (days === 0) return p.e >= 1440 ? "tot middernacht" : `tot ${hhmm(p.e)}`;
    const label = days === 1 ? "morgen" : OH.DAYS[(day + days) % 7];
    return `tot ${label} ${hhmm(p.e)}`;
  }

  /**
   * { state, text, rate } met state:
   *   "paid"    betalen (rate = uurprijs)
   *   "free"    nu gratis / vrij parkeren
   *   "permit"  alleen met vergunning
   *   "disc"    parkeerschijf (blauwe zone)
   *   "unknown" geen tijden bekend
   */
  function status(zone, date) {
    const schedule = zone.schedule || [];
    if (!schedule.some((d) => d && d.length)) {
      return { state: "unknown", text: "Tijden onbekend", rate: null };
    }
    const { day, minute } = OH.amsterdamNow(date);
    const period = (schedule[day] || []).find((p) => p.s <= minute && minute < p.e);
    const next = nextStart(schedule, day, minute);

    if (!period) {
      const from = next ? ` · ${zone.kind === "vergunning" ? "vergunning" : zone.kind === "blauw" ? "parkeerschijf" : "betaald"} vanaf ${whenText(next)}` : "";
      return { state: "free", text: `Nu vrij parkeren${from}`, rate: 0 };
    }
    const until = untilText(schedule, day, period);
    const max = period.max ? ` · max ${durationText(period.max)}` : "";
    if (zone.kind === "vergunning") {
      return { state: "permit", text: `Nu alleen met vergunning (${until})${max}`, rate: null };
    }
    if (zone.kind === "blauw") {
      return { state: "disc", text: `Nu parkeerschijf verplicht (${until})${max}`, rate: null };
    }
    const fare = period.fare ? (zone.fares || {})[period.fare] : null;
    if (!fare) return { state: "paid", text: `Nu betaald, tarief onbekend (${until})${max}`, rate: null };
    if (fare.rate_h === 0) return { state: "free", text: `Nu gratis (${until})`, rate: 0 };
    return { state: "paid", text: `Nu ${fare.text} (${until})${max}`, rate: fare.rate_h };
  }

  /** Leesbare regels per dag voor het weekoverzicht: [{ day, text }]. */
  function weekLines(zone) {
    return OH.DAYS.map((day, i) => {
      const periods = (zone.schedule || [])[i] || [];
      if (!periods.length) return { day, text: zone.kind === "garage" ? "geen tijden bekend" : "vrij" };
      const priced = zone.kind === "betaald" || zone.kind === "garage";
      const suffix = (p) => {
        const fare = p.fare && (zone.fares || {})[p.fare];
        const price = priced ? ` ${fare ? fare.text : "tarief onbekend"}` : "";
        return `${price}${p.max ? ` (max ${durationText(p.max)})` : ""}`;
      };
      const times = (p) => `${hhmm(p.s)}–${hhmm(p.e)}`;
      // Zelfde tarief de hele dag: tijden samen, prijs één keer.
      const same = periods.every((p) => suffix(p) === suffix(periods[0]));
      const text = same
        ? `${periods.map(times).join(", ")}${suffix(periods[0])}`
        : periods.map((p) => `${times(p)}${suffix(p)}`).join(", ");
      return { day, text };
    });
  }

  /** Het (hoogste) uurtarief dat in de zone geldt, los van het tijdstip. null = onbekend. */
  function zoneRate(zone) {
    let rate = null;
    for (const day of zone.schedule || []) {
      for (const p of day) {
        const r = p.fare && (zone.fares || {})[p.fare] ? zone.fares[p.fare].rate_h : null;
        if (r != null && (rate == null || r > rate)) rate = r;
      }
    }
    return rate;
  }

  // Kleur per tarief: zo zijn aangrenzende zones met een ander tarief (bijv. in Amsterdam
  // €5,37 / €6,98 / €8,05) op de kaart van elkaar te onderscheiden.
  const RATE_SCALE = [
    { below: 2, color: "#16a34a", label: "< €2" },
    { below: 3.5, color: "#65a30d", label: "€2–3,50" },
    { below: 5, color: "#ca8a04", label: "€3,50–5" },
    { below: 6, color: "#ea580c", label: "€5–6" },
    { below: 7.5, color: "#dc2626", label: "€6–7,50" },
    { below: Infinity, color: "#9333ea", label: "≥ €7,50" },
  ];
  const KIND_COLOR = { blauw: "#2563eb", vergunning: "#6b7280", garage: "#0ea5e9" };

  function zoneColor(zone) {
    if (KIND_COLOR[zone.kind] && zone.kind !== "garage") return KIND_COLOR[zone.kind];
    const rate = zoneRate(zone);
    if (rate == null) return "#9ca3af";
    if (rate === 0) return RATE_SCALE[0].color;
    return RATE_SCALE.find((b) => rate < b.below).color;
  }

  const api = { status, weekLines, zoneRate, zoneColor, RATE_SCALE, KIND_LABEL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Parking = api;
})(typeof window !== "undefined" ? window : globalThis);
