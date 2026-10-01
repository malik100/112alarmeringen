// Draaien met: node --test "tests/js/*.test.js"
const test = require("node:test");
const assert = require("node:assert");
const { routeUrl, eta, minutes } = require("../../buurtradar/static/nav.js");

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36";

test("route openen in de gekozen app", () => {
  assert.strictEqual(routeUrl(52.09, 5.12, "auto", IPHONE), "https://maps.apple.com/?daddr=52.09,5.12");
  assert.strictEqual(routeUrl(52.09, 5.12, "auto", ANDROID), "https://www.google.com/maps/dir/?api=1&destination=52.09%2C5.12");
  assert.strictEqual(routeUrl(52.09, 5.12, "waze", IPHONE), "https://waze.com/ul?ll=52.09%2C5.12&navigate=yes");
  assert.strictEqual(routeUrl(52.09, 5.12, "osm", IPHONE), "https://www.openstreetmap.org/directions?to=52.09%2C5.12");
  assert.strictEqual(routeUrl(52.09, 5.12, "onzin", ANDROID), routeUrl(52.09, 5.12, "google", ANDROID));
});

test("reistijd schatten", () => {
  assert.strictEqual(minutes(400, "lopen"), 7);      // 400 m × 1,3 / 80 m/min
  assert.strictEqual(minutes(400, "fietsen"), 2);
  assert.strictEqual(minutes(10, "lopen"), 1);       // nooit 0 minuten
  assert.strictEqual(minutes(3000, "auto"), 10);     // 3000 × 1,3 / 500 + 2
});

test("zinvolle vervoerswijzen per afstand", () => {
  assert.strictEqual(eta(400), "7 min lopen · 2 min fietsen");
  assert.strictEqual(eta(2500), "13 min fietsen · 9 min rijden");   // te ver om te lopen
  assert.strictEqual(eta(600, "auto"), "10 min lopen · 4 min rijden");
  assert.strictEqual(eta(2000, "auto"), "10 min fietsen · 7 min rijden");
  assert.strictEqual(eta(null), "");
});
