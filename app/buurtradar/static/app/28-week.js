/* Buurtradar – onderdeel van de kaart; zie 00-core.js voor state, kaart en hulpfuncties. */
"use strict";

// ---------- afgelopen week ----------

function hiDayName(iso, today) {
  const d = new Date(`${iso}T12:00:00`);
  if (today) return "Vandaag";
  const t = d.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function hiSummary(d) {
  if (d.missing) return "nog niet vastgelegd";
  const parts = [];
  const n = d.incidents.count;
  parts.push(n ? `${n} melding${n === 1 ? "" : "en"}${d.incidents.sirene ? ` (${d.incidents.sirene} met sirene)` : ""}` : "geen meldingen");
  if (d.announcements.count) parts.push(`${d.announcements.count} bekendmaking${d.announcements.count === 1 ? "" : "en"}`);
  if (d.roadworks.count) parts.push(`${d.roadworks.count} afsluiting${d.roadworks.count === 1 ? "" : "en"}`);
  if (d.waste.length) parts.push(d.waste.join(" + "));
  return parts.join(" · ");
}

function renderHistory() {
  const days = state.hi.data;
  if (!days) return;
  const max = Math.max(1, ...days.map((d) => (d.incidents ? d.incidents.count : 0)));
  $("hi-bars").replaceChildren(...[...days].reverse().map((d) => {
    const b = document.createElement("div");
    b.className = `b${d.today ? " today" : ""}`;
    const count = d.incidents ? d.incidents.count : 0;
    const bar = document.createElement("i");
    bar.style.height = `${Math.round((count / max) * 36) + 2}px`;
    const lbl = document.createElement("b"); lbl.textContent = count;
    const day = document.createElement("span"); day.textContent = d.today ? "nu" : new Date(`${d.date}T12:00:00`).toLocaleDateString("nl-NL", { weekday: "short" }).slice(0, 2);
    b.append(lbl, bar, day);
    b.title = `${hiDayName(d.date, d.today)}: ${hiSummary(d)}`;
    return b;
  }));
  $("hi-days").replaceChildren(...days.map((d) => {
    const det = document.createElement("details");
    det.className = "hi-day";
    if (d.today) det.open = true;
    const sum = document.createElement("summary");
    const name = document.createElement("b"); name.textContent = hiDayName(d.date, d.today);
    const txt = document.createElement("span"); txt.textContent = hiSummary(d);
    sum.append(name, txt);
    det.append(sum);
    if (!d.missing) {
      const ul = document.createElement("ul");
      for (const i of d.incidents.top) {
        const li = document.createElement("li");
        li.append(`${fmtTime(i.ts)} · ${LABEL[i.discipline] || i.discipline} · ${i.text} (${fmtDistance(i.distance_m)})`);
        if (i.sirene) { const s = document.createElement("span"); s.className = "sirene"; s.textContent = " sirene"; li.append(s); }
        ul.append(li);
      }
      for (const a of d.announcements.top) {
        const li = document.createElement("li");
        const link = document.createElement("a"); link.href = a.url; link.target = "_blank"; link.rel = "noopener noreferrer";
        link.textContent = a.title; li.append(`${BK_LABEL[a.category] || "Bekendmaking"}: `, link); ul.append(li);
      }
      for (const n of d.roadworks.names) { const li = document.createElement("li"); li.textContent = `Afsluiting: ${n}`; ul.append(li); }
      if (ul.children.length) det.append(ul);
    }
    return det;
  }));
  const week = days.slice(1).filter((d) => !d.missing);
  const total = week.reduce((s, d) => s + d.incidents.count, 0);
  const today = days[0];
  $("hi-hint").textContent = !today.has_location ? "Nog geen locatie bekend." : "";
  setSectionSummary("week", today.has_location
    ? `Vandaag ${today.incidents.count} melding${today.incidents.count === 1 ? "" : "en"} · ${week.length ? `${total} in ${week.length} dag${week.length === 1 ? "" : "en"}` : "eerste dag"}`
    : "");
}

async function loadHistory() {
  if (!state.config.history.enabled || !state.hi.show) return;
  try { state.hi.data = await api("/api/history"); } catch (err) { console.warn("Historie:", err.message); }
  renderHistory();
}

function initHistory() {
  if (!state.config.history.enabled) return;
  $("hi-show-chip").hidden = false;
  state.hi.show = store.get("hiShow") === "1";
  $("hi-show").checked = state.hi.show;
  $("hi-show").addEventListener("change", (e) => setLayer("history", e.target.checked));
  loadHistory().catch(console.error);
  setInterval(() => { if (document.visibilityState === "visible") loadHistory().catch(console.error); }, 10 * 60 * 1000);
}
