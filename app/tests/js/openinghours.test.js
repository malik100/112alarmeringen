// Draaien met: node --test "tests/js/*.test.js"
const test = require("node:test");
const assert = require("node:assert");
const { status, amsterdamNow } = require("../../sirene/static/openinghours.js");

// Maandag 28 september 2026 is zomertijd (UTC+2).
const at = (iso) => new Date(iso);
const WEEK = (day) => Array(7).fill(day);

test("tijd wordt in Nederlandse tijd bepaald", () => {
  assert.deepStrictEqual(amsterdamNow(at("2026-09-28T10:30:00Z")), { day: 0, minute: 12 * 60 + 30 });
  assert.deepStrictEqual(amsterdamNow(at("2026-12-06T23:30:00Z")), { day: 0, minute: 30 }); // wintertijd
});

test("open binnen een gewoon tijdvak", () => {
  const s = status(WEEK([[480, 1200]]), at("2026-09-28T10:00:00Z"));
  assert.deepStrictEqual(s, { state: "open", text: "Open tot 20:00" });
});

test("gesloten voor opening en na sluiting", () => {
  const hours = WEEK([[480, 1200]]);
  assert.strictEqual(status(hours, at("2026-09-28T05:00:00Z")).text, "Gesloten · opent om 08:00");
  assert.strictEqual(status(hours, at("2026-09-28T19:00:00Z")).text, "Gesloten · opent morgen om 08:00");
});

test("middagpauze", () => {
  const hours = WEEK([[480, 720], [780, 1020]]);
  assert.strictEqual(status(hours, at("2026-09-28T10:30:00Z")).text, "Gesloten · opent om 13:00");
  assert.strictEqual(status(hours, at("2026-09-28T11:30:00Z")).text, "Open tot 17:00");
});

test("over middernacht: telt mee op de dag erna", () => {
  const hours = WEEK([[600, 1500]]); // 10:00–01:00
  // dinsdag 00:30 lokale tijd
  assert.deepStrictEqual(status(hours, at("2026-09-28T22:30:00Z")), { state: "open", text: "Open tot 01:00" });
});

test("24 uur per dag, hele week", () => {
  assert.deepStrictEqual(status(WEEK([[0, 1440]]), at("2026-09-28T10:00:00Z")), { state: "open", text: "24 uur open" });
});

test("vandaag gesloten, opent een andere dag", () => {
  const hours = [[], [[540, 1020]], [], [], [], [], []];
  assert.strictEqual(status(hours, at("2026-09-28T10:00:00Z")).text, "Gesloten · opent morgen om 09:00");
  const zondagOpen = [[], [], [], [], [], [], [[600, 960]]];
  assert.strictEqual(status(zondagOpen, at("2026-09-28T10:00:00Z")).text, "Gesloten · opent zondag om 10:00");
});

test("onbekende tijden", () => {
  assert.strictEqual(status(WEEK(null), at("2026-09-28T10:00:00Z")).state, "unknown");
  assert.strictEqual(status(undefined).state, "unknown");
  // onbekend verderop: niet gokken wanneer het opent
  const hours = [[[480, 600]], null, null, null, null, null, null];
  assert.deepStrictEqual(status(hours, at("2026-09-28T10:00:00Z")), { state: "closed", text: "Gesloten" });
});

test("sluit om middernacht, of loopt door tot een andere dag", () => {
  assert.strictEqual(status(WEEK([[480, 1440]]), at("2026-09-28T10:00:00Z")).text, "Open tot middernacht");
  // ma 24 uur, di 00:00–18:00
  const hours = [[[0, 1440]], [[0, 1080]], [], [], [], [], []];
  assert.strictEqual(status(hours, at("2026-09-28T10:00:00Z")).text, "Open tot morgen 18:00");
});
