// Draaien met: node --test "tests/js/*.test.js"
const test = require("node:test");
const assert = require("node:assert");
const Ov = require("../../buurtradar/static/ov.js");

test("tekst op het lijnbordje", () => {
  assert.strictEqual(Ov.lineLabel({ line: "7", mode: "tram" }), "7");
  assert.strictEqual(Ov.lineLabel({ line: "Intercity", mode: "trein" }), "IC");
  assert.strictEqual(Ov.lineLabel({ line: "Sprinter", mode: "trein" }), "SPR");
  assert.strictEqual(Ov.lineLabel({ line: "Snelbus ipv trein", mode: "bus" }), "BUS");
  assert.strictEqual(Ov.lineLabel({ line: "European Sleeper", mode: "trein" }), "Europ");
  assert.strictEqual(Ov.lineLabel({ line: "", mode: "veer" }), "Veer");
});

test("kleuren van het bordje zijn altijd leesbaar", () => {
  assert.deepStrictEqual(Ov.badgeColors({ mode: "bus", color: "ffcc00", text_color: "000000" }), { bg: "#ffcc00", fg: "#000000" });
  // Geen kleur van de vervoerder: kleur per soort vervoer, witte tekst.
  assert.deepStrictEqual(Ov.badgeColors({ mode: "tram" }), { bg: "#0f766e", fg: "#ffffff" });
  // Tekstkleur die niet afsteekt (geel op wit) wordt vervangen.
  assert.deepStrictEqual(Ov.badgeColors({ mode: "bus", color: "fff200", text_color: "ffffff" }), { bg: "#fff200", fg: "#111827" });
  assert.strictEqual(Ov.lineColor({ mode: "bus", color: "ffffff" }), "#475569");   // wit zie je niet op de kaart
  assert.strictEqual(Ov.lineColor({ mode: "metro", color: "d81118" }), "#d81118");
});

test("vertraging en vertrektijd", () => {
  assert.strictEqual(Ov.delayText(null), "");
  assert.strictEqual(Ov.delayText(45), "");            // minder dan een minuut telt niet
  assert.strictEqual(Ov.delayText(150), "+3 min");
  assert.strictEqual(Ov.delayText(-120), "−2 min");
  const clock = (ts) => `klok ${ts}`;
  assert.strictEqual(Ov.untilText(1030, 1000, clock), "nu");
  assert.strictEqual(Ov.untilText(1000 + 4 * 60 + 30, 1000, clock), "4 min");
  assert.strictEqual(Ov.untilText(1000 + 3600, 1000, clock), "klok 4600");
});

test("filteren op soort vervoer", () => {
  const deps = [{ mode: "tram" }, { mode: "bus" }];
  assert.strictEqual(Ov.filterModes(deps, null).length, 2);
  assert.deepStrictEqual(Ov.filterModes(deps, new Set(["bus"])), [{ mode: "bus" }]);
});
