// Draaien met: node --test "tests/js/*.test.js"
const test = require("node:test");
const assert = require("node:assert");
const { PROFILES, query, tariffText, availability, summary, warnings } = require("../../sirene/static/charging.js");

const station = (extra = {}) => ({
  connectors: [{ plug: "CCS", kw: 150, dc: true, count: 2, tariff: { kwh: 0.59, start: 0.35, hour: null, parking_hour: null, varies: false } }],
  payment: { creditcard: true, pinpas: false }, customers_only: false, twentyfourseven: true,
  status: { available: 1, total: 2, plugs: { CCS: [1, 2] } }, ...extra,
});

test("elk profiel heeft label, uitleg en volledige filters", () => {
  for (const [key, p] of Object.entries(PROFILES)) {
    assert.ok(p.label && p.hint, key);
    assert.deepStrictEqual(Object.keys(p.filters).sort(),
      ["always_open", "available", "card", "min_kw", "plugs", "public"], key);
  }
});

test("querystring per profiel", () => {
  assert.strictEqual(query(PROFILES.snel.filters), "plugs=CCS&min_kw=50&available=true&public=true");
  assert.strictEqual(query(PROFILES.zonderpas.filters), "available=true&card=true&public=true");
  assert.strictEqual(query(PROFILES.eigen.filters), "");
});

test("tarieven leesbaar", () => {
  assert.strictEqual(tariffText({ kwh: 0.41, start: null, hour: null, parking_hour: 1.2, varies: true }),
    "€0,41/kWh · blokkeertarief €1,20/uur (verschilt per tijdstip)");
  assert.strictEqual(tariffText(null), null);
});

test("beschikbaarheid", () => {
  assert.deepStrictEqual(availability(station()), { state: "free", text: "1 van 2 vrij" });
  assert.deepStrictEqual(availability(station({ status: { available: 0, total: 3, plugs: {} } })), { state: "busy", text: "Alle 3 bezet" });
  assert.strictEqual(availability(station({ status: null })).state, "unknown");
});

test("samenvatting voor de lijst", () => {
  assert.strictEqual(summary(station()), "CCS 150 kW · €0,59/kWh");
});

test("waarschuwingen per gebruiker", () => {
  const straatpaal = station({
    connectors: [{ plug: "Type 2", kw: 11, dc: false, count: 1, tariff: { kwh: 0.41, parking_hour: 1.2 } }],
    payment: { creditcard: false, pinpas: false },
  });
  assert.deepStrictEqual(warnings(straatpaal, PROFILES.straat),
    ["Alleen met laadpas of app", "Kosten per uur: laat de auto niet onnodig lang staan"]);
  // de snellader-gebruiker krijgt de blokkeerwaarschuwing niet
  assert.deepStrictEqual(warnings(straatpaal, PROFILES.snel), ["Alleen met laadpas of app"]);
  assert.deepStrictEqual(warnings(station({ customers_only: true, twentyfourseven: false }), PROFILES.bestemming),
    ["Alleen voor klanten", "Niet 24/7 open"]);
});

test("leesbare naam in plaats van interne code", () => {
  const { displayName } = require("../../sirene/static/charging.js");
  const base = { operator: "Vattenfall InCharge", address: "Jansdam 14 3512HB Utrecht" };
  assert.strictEqual(displayName({ ...base, name: "OST23P0070_0167_0" }), "Vattenfall InCharge · Jansdam 14");
  assert.strictEqual(displayName({ ...base, name: "TNLP030402 - Jansdam 14, Utrecht" }), "Jansdam 14, Utrecht");
  assert.strictEqual(displayName({ ...base, name: "EV Hub - Moreelsepark 2, Utrecht" }), "EV Hub - Moreelsepark 2, Utrecht");
  assert.strictEqual(displayName({ ...base, name: null }), "Vattenfall InCharge · Jansdam 14");
});
