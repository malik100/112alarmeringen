/* Openbaar vervoer: weergave van lijnen, vertrektijden en vertraging.
 * Werkt in de browser (window.Ov) en in Node (voor de tests).
 */
(function (root) {
  "use strict";

  const MODES = {
    trein: { label: "Trein", icon: "train-front", color: "#1e40af" },
    metro: { label: "Metro", icon: "train-front", color: "#be185d" },
    tram: { label: "Tram", icon: "tram-front", color: "#0f766e" },
    bus: { label: "Bus", icon: "bus", color: "#475569" },
    veer: { label: "Veer", icon: "ship", color: "#0369a1" },
  };
  const MODE_ORDER = ["trein", "metro", "tram", "bus", "veer"];

  const TRAIN_SHORT = { intercity: "IC", "intercity direct": "ICD", sprinter: "SPR", stoptrein: "ST",
    sneltrein: "SNT", "snelbus ipv trein": "BUS", "stopbus ipv trein": "BUS", "bus ipv trein": "BUS" };

  function modeInfo(mode) {
    return MODES[mode] || MODES.bus;
  }

  /** Tekst op het lijnbordje: "7", "N80", of voor treinen "IC"/"SPR". */
  function lineLabel(item) {
    const line = String(item.line || "").trim();
    if (item.mode === "trein" || /ipv trein/i.test(line)) {
      const short = TRAIN_SHORT[line.toLowerCase()];
      if (short) return short;
      if (line.length > 5) return line.split(/\s+/)[0].slice(0, 5);
    }
    return line.length > 6 ? `${line.slice(0, 5)}…` : line || modeInfo(item.mode).label;
  }

  function hex(color) {
    if (!color) return null;
    const c = String(color).replace(/^#/, "").toLowerCase();
    return /^[0-9a-f]{6}$/.test(c) ? `#${c}` : null;
  }

  /** Relatieve helderheid (WCAG) van een #rrggbb-kleur. */
  function luminance(color) {
    const c = hex(color);
    if (!c) return 0;
    const ch = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  /** Kleuren van het lijnbordje: die van de vervoerder, anders per soort vervoer. */
  function badgeColors(item) {
    const bg = hex(item.color) || modeInfo(item.mode).color;
    let fg = hex(item.text_color);
    if (!fg || Math.abs(luminance(bg) - luminance(fg)) < 0.3) fg = luminance(bg) > 0.45 ? "#111827" : "#ffffff";
    return { bg, fg };
  }

  /** Kleur van een lijn op de kaart. Heel lichte kleuren (wit, lichtgeel) zie je niet op de kaart. */
  function lineColor(item) {
    const c = hex(item.color);
    if (!c || luminance(c) > 0.8) return modeInfo(item.mode).color;
    return c;
  }

  /** Vertraging in hele minuten; onder een minuut telt niet. */
  function delayMinutes(delay) {
    if (delay == null || Math.abs(delay) < 60) return 0;
    return Math.round(delay / 60);
  }

  function delayText(delay) {
    const m = delayMinutes(delay);
    if (!m) return "";
    return m > 0 ? `+${m} min` : `${m} min`.replace("-", "−");
  }

  /** "nu", "4 min" of (verder weg) de kloktijd. */
  function untilText(ts, now, fmtClock) {
    const s = ts - now;
    if (s < 60) return "nu";
    if (s < 60 * 60) return `${Math.floor(s / 60)} min`;
    return fmtClock(ts);
  }

  /** Vertrekken van een halte filteren op soort vervoer (null = alles). */
  function filterModes(items, modes) {
    if (!modes) return items;
    return items.filter((d) => modes.has(d.mode));
  }

  const api = { MODES, MODE_ORDER, modeInfo, lineLabel, badgeColors, lineColor, luminance, delayMinutes,
    delayText, untilText, filterModes };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Ov = api;
})(typeof window !== "undefined" ? window : globalThis);
