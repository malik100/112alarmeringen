// Draaien met: node --test "tests/js/*.test.js"
const test = require("node:test");
const assert = require("node:assert");
const { status, weekLines } = require("../../buurtradar/static/parking.js");

// Maandag 28 september 2026, zomertijd (UTC+2).
const at = (iso) => new Date(iso);
const WEEK = (periods) => Array.from({ length: 7 }, () => periods.map((p) => ({ ...p })));
const FARES = { T1: { text: "€5,34 per uur", rate_h: 5.34 }, G: { text: "gratis", rate_h: 0 } };

test("betaald binnen de tijden, gratis erbuiten", () => {
  const zone = { kind: "betaald", fares: FARES, schedule: WEEK([{ s: 540, e: 1260, fare: "T1", max: null }]) };
  assert.deepStrictEqual(status(zone, at("2026-09-28T10:00:00Z")),
    { state: "paid", text: "Nu €5,34 per uur (tot 21:00)", rate: 5.34 });
  assert.deepStrictEqual(status(zone, at("2026-09-28T05:00:00Z")),
    { state: "free", text: "Nu vrij parkeren · betaald vanaf 09:00", rate: 0 });
  assert.strictEqual(status(zone, at("2026-09-28T20:00:00Z")).text, "Nu vrij parkeren · betaald vanaf morgen 09:00");
});

test("zondag vrij: volgende betaalde dag", () => {
  const schedule = WEEK([{ s: 540, e: 1080, fare: "T1", max: null }]);
  schedule[6] = [];
  const zone = { kind: "betaald", fares: FARES, schedule };
  // zaterdag 3 oktober 19:00 lokaal
  assert.strictEqual(status(zone, at("2026-10-03T17:00:00Z")).text, "Nu vrij parkeren · betaald vanaf maandag 09:00");
});

test("24/7 betaald", () => {
  const zone = { kind: "betaald", fares: FARES, schedule: WEEK([{ s: 0, e: 1440, fare: "T1", max: null }]) };
  assert.strictEqual(status(zone, at("2026-09-28T10:00:00Z")).text, "Nu €5,34 per uur (hele week)");
});

test("tarief 0 is gratis, en maximale parkeerduur", () => {
  const zone = { kind: "betaald", fares: FARES, schedule: WEEK([{ s: 0, e: 1440, fare: "G", max: null }]) };
  assert.strictEqual(status(zone, at("2026-09-28T10:00:00Z")).state, "free");
  const blauw = { kind: "blauw", fares: {}, schedule: WEEK([{ s: 540, e: 1080, fare: null, max: 120 }]) };
  assert.deepStrictEqual(status(blauw, at("2026-09-28T10:00:00Z")),
    { state: "disc", text: "Nu parkeerschijf verplicht (tot 18:00) · max 2 uur", rate: null });
});

test("vergunningzone", () => {
  const zone = { kind: "vergunning", fares: {}, schedule: WEEK([{ s: 540, e: 1440, fare: null, max: null }]) };
  assert.strictEqual(status(zone, at("2026-09-28T10:00:00Z")).text, "Nu alleen met vergunning (tot middernacht)");
  assert.strictEqual(status(zone, at("2026-09-28T05:00:00Z")).text, "Nu vrij parkeren · vergunning vanaf 09:00");
});

test("geen tijden bekend", () => {
  assert.strictEqual(status({ kind: "betaald", schedule: WEEK([]) }).state, "unknown");
});

test("weekoverzicht", () => {
  const schedule = WEEK([{ s: 540, e: 1260, fare: "T1", max: 120 }]);
  schedule[6] = [];
  const lines = weekLines({ kind: "betaald", fares: FARES, schedule });
  assert.deepStrictEqual(lines[0], { day: "maandag", text: "09:00–21:00 €5,34 per uur (max 2 uur)" });
  assert.deepStrictEqual(lines[6], { day: "zondag", text: "vrij" });
});

test("doorlopend over middernacht tot een volgende dag", () => {
  const schedule = WEEK([]);
  schedule[0] = [{ s: 540, e: 1440, fare: "T1", max: null }];
  schedule[1] = [{ s: 0, e: 120, fare: "T1", max: null }];
  const zone = { kind: "betaald", fares: FARES, schedule };
  assert.strictEqual(status(zone, at("2026-09-28T10:00:00Z")).text, "Nu €5,34 per uur (tot morgen 02:00)");
});

test("weekoverzicht: tijdvakken met hetzelfde tarief samen", () => {
  const schedule = WEEK([{ s: 0, e: 60, fare: "T1", max: null }, { s: 420, e: 1440, fare: "T1", max: null }]);
  assert.strictEqual(weekLines({ kind: "betaald", fares: FARES, schedule })[1].text,
    "00:00–01:00, 07:00–24:00 €5,34 per uur");
});

test("kleur per tarief, los van het tijdstip", () => {
  const { zoneRate, zoneColor, RATE_SCALE } = require("../../buurtradar/static/parking.js");
  const zone = (rate, kind = "betaald") => ({
    kind, fares: { A: { rate_h: rate }, D: { rate_h: 1 } },
    schedule: WEEK([{ s: 540, e: 1440, fare: "A", max: null }]),
  });
  assert.strictEqual(zoneRate(zone(5.37)), 5.37);
  // Amsterdam: aangrenzende tarieven krijgen elk een eigen kleur.
  const colors = [1.72, 3.01, 4.19, 5.37, 6.98, 8.05].map((r) => zoneColor(zone(r)));
  assert.strictEqual(new Set(colors).size, 6);
  assert.strictEqual(zoneColor(zone(8.05)), RATE_SCALE[RATE_SCALE.length - 1].color);
  assert.strictEqual(zoneColor(zone(2, "blauw")), "#2563eb");
  assert.strictEqual(zoneRate({ kind: "betaald", fares: {}, schedule: WEEK([]) }), null);
});
