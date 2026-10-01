/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

// ---------- afvalkalender ----------

const WA_COLORS = { gft: "#16a34a", papier: "#2563eb", pmd: "#ea580c", rest: "#4b5563", glas: "#0891b2",
  textiel: "#9333ea", kerstboom: "#15803d", grof: "#92400e", chemisch: "#dc2626", overig: "#6b7280" };
const WA_SHOW = 8;

function waDayLabel(iso, today) {
  const d = new Date(`${iso}T12:00:00`);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "Vandaag";
  if (diff === 1) return "Morgen";
  const text = d.toLocaleDateString("nl-NL", { weekday: diff < 7 ? "long" : "short", day: "numeric", month: diff < 7 ? undefined : "short" });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderWaste() {
  const cfg = state.config.waste;
  if (!cfg.enabled) return;
  const data = state.wa.data;
  const empty = $("empty-wa");
  const list = $("list-wa");
  const setup = $("wa-setup");
  $("wa-url").value = (data && data.url) || "";
  $("wa-clear").hidden = !(data && data.url);
  if (!data || !data.url) {
    list.replaceChildren();
    empty.textContent = "Nog geen afvalkalender gekoppeld. Stel hieronder de agenda-link van je gemeente in.";
    empty.hidden = false;
    setup.open = true;
    setSectionSummary("afval", "Nog niet ingesteld");
    return;
  }
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const events = data.events.slice(0, WA_SHOW);
  list.replaceChildren(...events.map((e) => {
    const li = document.createElement("li");
    const diff = Math.round((new Date(`${e.date}T12:00:00`) - today) / 86400000);
    li.className = `item${diff === 0 ? " today" : diff === 1 ? " tomorrow" : ""}`;
    li.style.setProperty("--c", WA_COLORS[e.kind] || WA_COLORS.overig);
    const bar = document.createElement("span"); bar.className = "bar";
    const what = document.createElement("span"); what.className = "what"; what.textContent = e.label;
    what.title = e.summary;
    const when = document.createElement("span"); when.className = "dist"; when.textContent = waDayLabel(e.date, today);
    li.append(bar, what, when);
    return li;
  }));
  empty.textContent = data.error ? `Ophalen mislukt: ${data.error}` : "Geen ophaaldagen in de komende drie weken.";
  empty.hidden = events.length > 0 && !data.error;
  const next = data.events[0];
  const sameDay = next ? data.events.filter((e) => e.date === next.date).map((e) => e.label).join(" + ") : "";
  setSectionSummary("afval", next ? `${waDayLabel(next.date, today)}: ${sameDay}` : "Niets gepland",
    next && waDayLabel(next.date, today) === "Morgen" ? "urgent" : "");
}

async function loadWaste() {
  if (!state.config.waste.enabled || !state.wa.show) return;
  try { state.wa.data = await api("/api/waste"); } catch (err) { console.warn("Afval:", err.message); }
  renderWaste();
}

function initWaste() {
  if (!state.config.waste.enabled) return;
  $("wa-show-chip").hidden = false;
  state.wa.show = store.get("waShow") !== "0";
  $("wa-show").checked = state.wa.show;
  $("wa-show").addEventListener("change", (e) => setLayer("waste", e.target.checked));
  $("wa-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("wa-msg");
    msg.textContent = "Agenda ophalen…";
    try {
      const resp = await fetch("/api/waste", { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: $("wa-url").value.trim() }) });
      const body = await resp.json();
      if (!resp.ok) { msg.textContent = body.detail || "Dat lukte niet."; return; }
      msg.textContent = `Gelukt: ${body.count} ophaaldagen gevonden.`;
      $("wa-setup").open = false;
      await loadWaste();
    } catch (err) { msg.textContent = `Dat lukte niet: ${err.message}`; }
  });
  $("wa-clear").addEventListener("click", async () => {
    await fetch("/api/waste", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "" }) });
    $("wa-msg").textContent = "";
    await loadWaste();
  });
  loadWaste().catch(console.error);
  setInterval(() => { if (document.visibilityState === "visible") loadWaste().catch(console.error); }, 30 * 60 * 1000);
}
