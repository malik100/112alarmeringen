/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

// ---------- weer en luchtkwaliteit ----------

const WE_REFRESH_MS = 5 * 60 * 1000;
const LKI_COLORS = { goed: "#16a34a", matig: "#ca8a04", onvoldoende: "#ea580c", slecht: "#dc2626", "zeer slecht": "#7f1d1d" };
const DAY_SHORT = ["zo", "ma", "di", "wo", "do", "vr", "za"];

function weEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function fmtTemp(t) {
  return t == null ? "–" : `${Math.round(t)}°`;
}

/** Staafdiagram van de buien in de komende 2 uur (per 5 minuten). */
function rainChart(rain) {
  const w = 240, h = 34, top = 4, base = 24;
  const max = Math.max(2, ...rain.map((r) => r.mm_h));
  const bw = w / rain.length;
  const bars = rain.map((r, i) => {
    const bh = r.mm_h > 0 ? Math.max(2, (Math.min(r.mm_h, max) / max) * (base - top)) : 0;
    return `<rect class="bar" x="${(i * bw).toFixed(1)}" y="${(base - bh).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${bh.toFixed(1)}"/>`;
  }).join("");
  const labels = rain.filter((_, i) => i % 6 === 0).map((r, j) => `<text class="lbl" x="${(j * 6 * bw).toFixed(1)}" y="${h - 1}">${esc(r.time)}</text>`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><line class="axis" x1="0" y1="${base}" x2="${w}" y2="${base}"/>${bars}${labels}</svg>`;
}

function renderWeather() {
  const w = state.we.data;
  const cfg = state.config.weather;
  if (!cfg.enabled) return;
  const empty = $("empty-we");
  const st = w && w.station;
  if (!w || !st) {
    empty.textContent = !state.location ? "Nog geen locatie bekend." : "Weer wordt opgehaald…";
    empty.hidden = false;
    ["we-now", "we-rain", "we-air", "we-days"].forEach((id) => $(id).replaceChildren());
    $("we-report").textContent = "";
    setSectionSummary("weer", "");
    return;
  }
  empty.hidden = true;
  const now = weEl("div", "we-now");
  const desc = weEl("div", "we-desc");
  desc.append(st.description || "", weEl("small", "", [
    st.feels_like != null && Math.round(st.feels_like) !== Math.round(st.temperature) ? `voelt als ${fmtTemp(st.feels_like)}` : null,
    st.wind_bft != null ? `wind ${st.wind_dir || ""} ${st.wind_bft} Bft` : null,
    st.humidity != null ? `${Math.round(st.humidity)}% vochtig` : null,
    `station ${st.name} (${fmtDistance(st.distance_m)})`,
  ].filter(Boolean).join(" · ")));
  now.append(weEl("span", "we-temp", fmtTemp(st.temperature)), desc);
  $("we-now").replaceChildren(now);

  const rainBox = $("we-rain");
  rainBox.className = "we-rain";
  rainBox.replaceChildren();
  if (w.rain && w.rain.length) {
    rainBox.append(weEl("b", "", w.rain_summary || ""));
    const chart = document.createElement("div");
    chart.innerHTML = rainChart(w.rain);
    rainBox.append(chart.firstChild);
  }

  const airBox = $("we-air");
  airBox.className = "we-air";
  airBox.replaceChildren();
  if (w.air) {
    const badge = weEl("span", "we-lki", String(w.air.value));
    badge.style.background = LKI_COLORS[w.air.label] || "#6b7280";
    airBox.append(badge, `Luchtkwaliteit ${w.air.label}`, weEl("small", "", ` · ${w.air.name} (${fmtDistance(w.air.distance_m)})`));
  }

  $("we-days").className = "we-days";
  $("we-days").replaceChildren(...(w.days || []).slice(0, 5).map((d) => {
    const box = weEl("div", "d");
    const date = new Date(`${d.day}T12:00:00`);
    box.append(weEl("b", "", DAY_SHORT[date.getDay()]), `${d.max}°`, weEl("small", "", ` / ${d.min}°`), document.createElement("br"),
      weEl("span", "rain", d.rain_chance != null ? `${d.rain_chance}%` : ""));
    box.title = `${d.description || ""}${d.wind_bft ? ` · wind ${d.wind_dir || ""} ${d.wind_bft} Bft` : ""}`;
    return box;
  }));
  $("we-report").textContent = w.report && w.report.title ? `${w.report.title}. ${w.shortterm || ""}` : (w.shortterm || "");

  const parts = [fmtTemp(st.temperature), (st.description || "").toLowerCase()];
  if (w.rain_summary) parts.push(w.rain_summary.toLowerCase());
  if (w.air) parts.push(`lucht ${w.air.label}`);
  setSectionSummary("weer", parts.filter(Boolean).join(" · "), w.air && ["slecht", "zeer slecht"].includes(w.air.label) ? "urgent" : "");
}

async function loadWeather(force) {
  const cfg = state.config.weather;
  if (!cfg.enabled || !state.we.show) return;
  const loc = state.location;
  if (!loc) return renderWeather();
  const from = state.we.from;
  if (!force && from && Date.now() - state.we.ts < WE_REFRESH_MS - 1000
      && haversine(from.lat, from.lon, loc.lat, loc.lon) < 1000) return renderWeather();
  state.we.from = { lat: loc.lat, lon: loc.lon };
  state.we.ts = Date.now();
  try {
    state.we.data = await api(`/api/weather?lat=${loc.lat.toFixed(3)}&lon=${loc.lon.toFixed(3)}`);
  } catch (err) { console.warn("Weer:", err.message); }
  renderWeather();
}

function initWeather() {
  if (!state.config.weather.enabled) return;
  $("we-show-chip").hidden = false;
  state.we.show = store.get("weShow") !== "0";
  $("we-show").checked = state.we.show;
  $("we-show").addEventListener("change", (e) => setLayer("weather", e.target.checked));
  loadWeather(true).catch(console.error);
  setInterval(() => { if (document.visibilityState === "visible") loadWeather().catch(console.error); }, WE_REFRESH_MS);
}
