/* Openingstijden van statiegeldpunten: is een punt nu open, en tot/vanaf wanneer?
 *
 * `hours` komt van de server: 7 dagen (maandag eerst), per dag null (onbekend),
 * [] (gesloten) of een lijst [start, eind] in minuten na middernacht. Een eind
 * groter dan 1440 loopt door in de nacht erna.
 * Werkt in de browser (window.OpeningHours) en in Node (voor de tests).
 */
(function (root) {
  "use strict";

  const DAYS = ["maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"];
  const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Amsterdam", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });

  /** Dag (0 = maandag) en minuut van de dag in Nederlandse tijd. */
  function amsterdamNow(date) {
    const parts = Object.fromEntries(fmt.formatToParts(date || new Date()).map((p) => [p.type, p.value]));
    return { day: WEEKDAY_INDEX[parts.weekday], minute: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  function hhmm(minutes) {
    const m = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }

  /**
   * Eindtijd van een open periode in minuten vanaf vandaag 00:00. Sluit de periode om
   * middernacht aan op een periode die om 00:00 begint, dan wordt die meegenomen.
   * Geeft null als het punt de hele week doorlopend open is.
   */
  function closingMinute(hours, day, absEnd) {
    for (let i = 0; i < 8; i++) {
      if (absEnd % 1440 !== 0) return absEnd;
      const next = hours[(day + absEnd / 1440 + 7) % 7];
      const cont = next && next.find(([s]) => s === 0);
      if (!cont) return absEnd;
      absEnd += cont[1];
    }
    return null;
  }

  function closingText(day, absEnd) {
    const dayOffset = Math.ceil(absEnd / 1440) - 1;
    const at = absEnd % 1440 === 0 ? "middernacht" : hhmm(absEnd);
    // Tot vroeg in de nacht erna (bijv. 01:00) is gewoon "tot 01:00".
    if (dayOffset === 0 || (dayOffset === 1 && absEnd % 1440 <= 360 && absEnd % 1440 !== 0)) {
      return `Open tot ${at}`;
    }
    const label = dayOffset === 1 ? "morgen" : DAYS[(day + dayOffset) % 7];
    return `Open tot ${label} ${at}`;
  }

  function nextOpening(hours, day, minute) {
    for (let offset = 0; offset < 8; offset++) {
      const d = (day + offset) % 7;
      const ranges = hours[d];
      if (ranges == null) return null; // onbekende dag: niet verder gokken
      const next = ranges
        .filter(([s]) => offset > 0 || s > minute)
        .sort((a, b) => a[0] - b[0])[0];
      if (next) return { offset, day: d, start: next[0] };
    }
    return null;
  }

  function dayLabel(offset, day) {
    if (offset === 0) return "";
    if (offset === 1) return "morgen ";
    return `${DAYS[day]} `;
  }

  /** { state: "open" | "closed" | "unknown", text } */
  function status(hours, date) {
    if (!Array.isArray(hours) || hours.length !== 7) return { state: "unknown", text: "Openingstijden onbekend" };
    const { day, minute } = amsterdamNow(date);
    const yesterday = hours[(day + 6) % 7];
    const today = hours[day];

    // Eindtijden van open periodes, in minuten vanaf vandaag 00:00.
    const ends = [];
    for (const [, e] of yesterday || []) {
      if (e > 1440 && minute < e - 1440) ends.push(e - 1440);
    }
    for (const [s, e] of today || []) {
      if (s <= minute && minute < e) ends.push(e);
    }
    if (ends.length) {
      const close = closingMinute(hours, day, Math.max(...ends));
      if (close == null) return { state: "open", text: "24 uur open" };
      return { state: "open", text: closingText(day, close) };
    }
    if (today == null) return { state: "unknown", text: "Openingstijden onbekend" };
    const next = nextOpening(hours, day, minute);
    if (!next) return { state: "closed", text: "Gesloten" };
    return { state: "closed", text: `Gesloten · opent ${dayLabel(next.offset, next.day)}om ${hhmm(next.start)}` };
  }

  const api = { status, amsterdamNow, hhmm, DAYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OpeningHours = api;
})(typeof window !== "undefined" ? window : globalThis);
