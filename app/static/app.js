/* Drishti command centre - dashboard logic. voice.js (Gemini Live) is loaded after this file and shares these globals. */
"use strict";
const $ = id => document.getElementById(id);
const esc = s => (s == null ? "" : String(s)).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const nf = n => n == null ? "—" : Number(n).toLocaleString("en-IN");
const THR = {critical: ["CRITICAL", "#ff3b4e"], high: ["HIGH", "#ff9a3d"], medium: ["MEDIUM", "#ffd23d"], low: ["LOW", "#3ddc84"]};
const PLAT = {news: ["NEWS", "#19d3f0", "▤"], youtube: ["YOUTUBE", "#ff6b6b", "▶"], reddit: ["REDDIT", "#ff9a3d", "◉"], instagram: ["INSTAGRAM", "#ff7ac6", "◎"], facebook: ["FACEBOOK", "#6ea8ff", "f"], x: ["X (TWITTER)", "#e7e9ea", "✕"]};
const PLATS = Object.keys(PLAT);
const SENTC = {positive: "#2ee86b", neutral: "#f5c518", negative: "#ff4d6a"};
const CATL = {protest: "Protest", defence: "Defence", space: "Space", crime: "Crime", accident: "Accident", security: "Security", recruitment: "Recruitment", achievement: "Achievement", other: "Other"};
const S = {tab: "live", chip: "ALL", threat: "", category: "", location: "", source: "", scope: [], author: "", alerts: false, view: "india"};
let D = null, lastMaxId = 0, loading = false;

/* ---------- compatibility with voice.js ---------- */
const av = {state: "STANDBY", setState(x) { this.state = x; }};
function setAvState(s) { av.setState(s); }
function nearestHours(h) { h = +h || 0; if (!h) return ""; const o = [1, 6, 24, 168, 720]; return String(o.reduce((p, c) => Math.abs(c - h) < Math.abs(p - h) ? c : p)); }
function applyFilters(f) {
  for (const k of ["q", "sentiment", "platform", "language"]) $(k).value = f[k] || "";
  $("hours").value = nearestHours(f.hours);
  const tokens = [...String(f.scope || "").split(","), ...String(f.topic || "").split(","), ...String(f.unit || "").split(",")].map(x => x.trim().toUpperCase()).filter(Boolean);
  if (f.category === "space") tokens.push("SPACE");
  S.threat = f.threat || ""; S.category = (f.category && f.category !== "space") ? f.category : ""; S.location = f.location || ""; S.author = f.author || ""; S.source = ""; S.alerts = false;
  setScope(tokens); showTab("live"); closeViewer(); load();
}
/* everything else the voice assistant can do on the site */
function voiceEvent(m) {
  if (m.type === "tab") { if (m.tab === "live") closeViewer(); showTab(m.tab); }
  else if (m.type === "map") {                       // the map lives on the main dashboard
    S.view = m.view || "india";
    document.querySelectorAll(".mtabs button").forEach(b => { if (b.dataset.view) b.classList.toggle("active", b.dataset.view === S.view); });
    closeViewer(); showTab("live");
    if (D) drawMap($("map"), D.locations, S.view, false);
    setTimeout(() => $("mtabs").scrollIntoView({behavior: "smooth", block: "center"}), 300);
  }
  else if (m.type === "source") { showTab("sources"); socPick(m.platform || "instagram", true, m.author || ""); }
  else if (m.type === "accounts") { showTab("sources"); ACC.plat = m.platform || ""; loadAccounts(); setTimeout(() => $("acc-tabs").scrollIntoView({behavior: "smooth", block: "start"}), 400); }
  else if (m.type === "profile") openEmbed(profileEmbed(m.platform, m.username, m.url), "@" + m.username, m.platform, m.url);
  else if (m.type === "report") { showTab("reports"); $("reportbox").textContent = m.text; $("rp-meta").textContent = m.meta || ""; }
  else if (m.type === "close") closeViewer();
}

/* ---------- clock ---------- */
function tick() {
  const d = new Date();
  $("clock").textContent = d.toLocaleTimeString("en-GB");
  $("date").textContent = d.toLocaleDateString("en-IN", {day: "numeric", month: "short", year: "numeric"}).toUpperCase();
  if (D) { const up = $("uptime-v"); if (up) { const s = D.uptime + Math.floor((Date.now() - D._at) / 1000); up.textContent = [Math.floor(s / 3600), Math.floor(s % 3600 / 60), s % 60].map(x => String(x).padStart(2, "0")).join(":"); } }
}
tick(); setInterval(tick, 1000);

/* ---------- filters ---------- */
function filterParams(forDash) {
  const p = new URLSearchParams();
  const f = {q: $("q").value, scope: S.scope.join(","), sentiment: $("sentiment").value, platform: $("platform").value, language: $("language").value, hours: $("hours").value,
    threat: S.threat, category: S.category, location: S.location, source: S.source, author: S.author, alerts: S.alerts ? "1" : ""};
  for (const k in f) if (f[k] && !(forDash && ["q", "sentiment", "threat", "category", "location", "source", "author", "alerts"].includes(k))) p.set(k, f[k]);
  return p;
}
const UNIT_LABEL = {SPACE: "Space (अंतरिक्ष)"};
function markActive() {
  document.querySelectorAll(".sent").forEach(el => el.classList.toggle("active", el.dataset.s === $("sentiment").value));
  document.querySelectorAll(".thr-row").forEach(el => el.classList.toggle("active", el.dataset.t === S.threat));
  const chips = [];
  if (S.threat) chips.push(["threat", "Threat: " + S.threat.toUpperCase()]);
  if (S.location) chips.push(["location", "📍 " + S.location]);
  if (S.category) chips.push(["category", "Category: " + (CATL[S.category] || S.category)]);
  if (S.source) chips.push(["source", "Source: " + S.source]);
  if (S.author) chips.push(["author", "👤 @" + S.author]);
  if (S.alerts) chips.push(["alerts", "🚨 Alerts: High + Critical (24h)"]);
  $("fchips").innerHTML = chips.map(([k, t]) => `<span data-k="${k}">${esc(t)} ✕</span>`).join("");
}
$("fchips").addEventListener("click", e => { const k = e.target.dataset.k; if (k) { S[k] = ""; load(); } });
document.querySelectorAll(".sent").forEach(el => el.addEventListener("click", () => { $("sentiment").value = $("sentiment").value === el.dataset.s ? "" : el.dataset.s; load(); }));
/* ---- topic / ISRO-centre multi-choice box ---- */
function setScope(tokens) { S.scope = [...new Set(tokens)]; renderScope(); }
function renderScope() {
  document.querySelectorAll("#scope-menu input").forEach(i => { i.checked = S.scope.includes(i.value); });
  const n = S.scope.length;
  $("scope-label").textContent = !n ? "CISF + ISRO" : n <= 3 ? S.scope.map(t => t === "SPACE" ? "Space" : t).join(" + ") : n + " चुने गए";
}
$("scope-btn").addEventListener("click", e => { e.stopPropagation(); const m = $("scope-menu"), open = m.style.display === "none"; m.style.display = open ? "" : "none"; $("scope").classList.toggle("open", open); });
document.addEventListener("click", e => { if (!e.target.closest("#scope")) { $("scope-menu").style.display = "none"; $("scope").classList.remove("open"); } });
$("scope-menu").addEventListener("change", () => { S.scope = [...document.querySelectorAll("#scope-menu input:checked")].map(i => i.value); S.alerts = false; renderScope(); load(); });
$("scope-clear").addEventListener("click", () => { setScope([]); S.alerts = false; load(); });


["sentiment", "platform", "language", "hours"].forEach(k => $(k).addEventListener("change", load));
let qt; $("q").addEventListener("input", () => { clearTimeout(qt); qt = setTimeout(load, 350); });
$("apply").addEventListener("click", load);
$("refresh").addEventListener("click", async () => {
  const b = $("refresh"); b.disabled = true; b.textContent = "…";
  await fetch("/api/collect", {method: "POST"}).catch(() => {});
  await load(); b.disabled = false; b.textContent = "⟳";
});
$("hd-alert-card").addEventListener("click", () => {
  // show exactly what the number counts: high + critical items of the last 24 hours. Topic / platform / language stay (the number follows them); the rest is cleared.
  $("q").value = ""; $("sentiment").value = "";
  S.threat = S.category = S.location = S.source = S.author = ""; S.alerts = false; S.alerts = true;
  closeViewer(); showTab("live"); load();
});

/* ---------- small chart helpers ---------- */
function bars(arr, color, w, h, gap = 2) {
  const n = arr.length, mx = Math.max(1, ...arr), bw = (w - gap * (n - 1)) / n;
  return arr.map((v, i) => { const bh = Math.max(1.5, (v / mx) * (h - 3)); return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity="${(0.35 + 0.65 * (i + 1) / n).toFixed(2)}" rx="1"/>`; }).join("");
}
function line(arr, color, w, h) {
  const n = arr.length, mx = Math.max(1, ...arr), pts = arr.map((v, i) => [i * (w / (n - 1)), h - 3 - (v / mx) * (h - 8)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  return `<path d="${d} L${w},${h} L0,${h} Z" fill="${color}" opacity=".16"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.8"/>`;
}
const delta = v => v == null ? "" : (v >= 0 ? "▲ +" : "▼ ") + v + "%";

/* ---------- India map (approximate outline, projected equirectangular) ---------- */
/* Official outline of India (Survey of India, via datameet/maps, simplified): app/static/india.json = list of rings [[lon,lat],...] */
let RINGS = null;
fetch("/static/india.json").then(r => r.json()).then(j => {
  RINGS = j.map(ring => { let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return {pts: ring, box: [x0, y0, x1, y1]}; });
  for (const k in dotCache) delete dotCache[k];
  if (D) { drawMap($("map"), D.locations, S.view, false); if (S.tab === "map") drawMap($("bigmap"), D.locations, S.view, true); }
}).catch(() => {});
const VIEWS = {india: {lon: [65, 99], lat: [5, 38], step: 0.5}, asia: {lon: [52, 112], lat: [-4, 44], step: 0.9}, world: {lon: [-25, 155], lat: [-38, 68], step: 2.2}};
const NEIGH = [["PAKISTAN", 68.5, 30.2], ["CHINA", 84, 35.2], ["NEPAL", 84.2, 28.9], ["BANGLADESH", 89.9, 23.9], ["MYANMAR", 96.4, 22], ["SRI LANKA", 80.8, 7.3], ["ARABIAN SEA", 67.5, 15], ["BAY OF BENGAL", 87.5, 14], ["INDIAN OCEAN", 78, 3.5]];
function inRing(x, y, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const inIndia = (x, y) => RINGS.some(r => x >= r.box[0] && x <= r.box[2] && y >= r.box[1] && y <= r.box[3] && inRing(x, y, r.pts));
const dotCache = {};
function drawMap(svg, locs, view, big) {
  if (!RINGS) return;
  const v = VIEWS[view], W = 600, H = 560, sc = Math.min(W / (v.lon[1] - v.lon[0]), H / (v.lat[1] - v.lat[0]));
  const ox = (W - sc * (v.lon[1] - v.lon[0])) / 2, oy = (H - sc * (v.lat[1] - v.lat[0])) / 2;
  const X = lon => ox + (lon - v.lon[0]) * sc, Y = lat => oy + (v.lat[1] - lat) * sc;
  if (!dotCache[view]) { const d = []; for (let lo = 68; lo < 98; lo += v.step) for (let la = 6.5; la < 37.5; la += v.step) if (inIndia(lo, la)) d.push([lo, la]); dotCache[view] = d; }
  let h = `<defs><filter id="gl${big ? "b" : "s"}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter></defs>`;
  for (let lo = Math.ceil(v.lon[0] / 10) * 10; lo < v.lon[1]; lo += 10) h += `<line x1="${X(lo)}" y1="0" x2="${X(lo)}" y2="${H}" stroke="rgba(25,211,240,.07)"/>`;
  for (let la = Math.ceil(v.lat[0] / 10) * 10; la < v.lat[1]; la += 10) h += `<line x1="0" y1="${Y(la)}" x2="${W}" y2="${Y(la)}" stroke="rgba(25,211,240,.07)"/>`;
  const r = Math.max(1.1, v.step * sc * 0.16);
  h += dotCache[view].map(([lo, la]) => `<circle cx="${X(lo).toFixed(1)}" cy="${Y(la).toFixed(1)}" r="${r.toFixed(2)}" fill="#19d3f0" opacity=".38"/>`).join("");
  const path = RINGS.map(r => r.pts.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1)).join("") + "Z").join(" ");
  h += `<path d="${path}" fill="rgba(25,211,240,.05)" stroke="#19d3f0" stroke-width="1.4" opacity=".9" filter="url(#gl${big ? "b" : "s"})"/><path d="${path}" fill="none" stroke="#5be6ff" stroke-width="1.1"/>`;
  for (const [n, lo, la] of NEIGH) if (lo > v.lon[0] && lo < v.lon[1] && la > v.lat[0] && la < v.lat[1]) h += `<text x="${X(lo)}" y="${Y(la)}" font-size="${big ? 11 : 9.5}" fill="#4f93a8" letter-spacing="2" text-anchor="middle" font-family="Consolas,monospace">${n}</text>`;
  const shown = locs.filter(l => l.lon > v.lon[0] && l.lon < v.lon[1] && l.lat > v.lat[0] && l.lat < v.lat[1]);
  const mx = Math.max(1, ...shown.map(l => l.count));
  shown.forEach((l, i) => {
    const c = THR[l.level][1], rad = 4.5 + 9 * Math.sqrt(l.count / mx), x = X(l.lon), y = Y(l.lat);
    h += `<g class="mk" data-loc="${esc(l.name)}" style="cursor:pointer">`;
    if (l.level === "critical" || l.level === "high") h += `<circle class="pulse" cx="${x}" cy="${y}" r="${rad}" fill="none" stroke="${c}" stroke-width="1.5"/>`;
    h += `<circle cx="${x}" cy="${y}" r="${rad * 1.9}" fill="${c}" opacity=".18"/><circle cx="${x}" cy="${y}" r="${rad}" fill="${c}" opacity=".9" stroke="#fff" stroke-width=".8"/>`;
    if (i < (big ? 18 : 9)) h += `<text x="${x + rad + 4}" y="${y + 3.5}" font-size="${big ? 12 : 10.5}" fill="#fff" font-family="Rajdhani,Segoe UI,sans-serif" font-weight="600" paint-order="stroke" stroke="#02080f" stroke-width="3">${esc(l.name)}</text>`;
    h += `<title>${esc(l.name)}: ${l.count} items · ${l.status}</title></g>`;
  });
  svg.innerHTML = h;
}
function insightsHtml(locs) {
  if (!locs.length) return '<div class="empty" style="padding:20px 0;font-size:11px">// जगह का डेटा नहीं //</div>';
  return locs.slice(0, 14).map(l => `<div class="ins" data-loc="${esc(l.name)}" title="इसकी खबरें दिखाइए"><span style="color:${THR[l.level][1]}">${esc(l.name)}</span><b>${l.count}</b><span class="st" style="color:${THR[l.level][1]}">${l.status}</span></div>`).join("");
}
function goLoc(name) { S.location = name; showTab("live"); load(); }
for (const id of ["map", "bigmap", "insights", "bm-ins"]) $(id).addEventListener("click", e => { const t = e.target.closest("[data-loc]"); if (t) goLoc(t.dataset.loc); });
function mapTabs(box, setter) { box.addEventListener("click", e => { const v = e.target.dataset.view; if (!v) return; S.view = v; document.querySelectorAll(".mtabs button").forEach(b => b.classList.toggle("active", b.dataset.view === v)); setter(); }); }
mapTabs($("mtabs"), () => D && drawMap($("map"), D.locations, S.view, false));
mapTabs($("bmtabs"), () => D && drawMap($("bigmap"), D.locations, S.view, true));

/* ---------- live pipeline ---------- */
const PIPE = {paths: {}, boxes: {}};
function buildPipe() {
  const svg = $("pipe"), NS = "http://www.w3.org/2000/svg"; let h = "";
  const cols = [14, 112, 210], rows = [20, 100], bw = 92, bh = 64;
  PLATS.forEach((p, i) => {
    const x = cols[i % 3], y = rows[Math.floor(i / 3)], [name, col, g] = PLAT[p];
    h += `<g class="box" id="pb-${p}"><rect x="${x}" y="${y}" width="${bw}" height="${bh}"/><text x="${x + 10}" y="${y + 17}" font-size="9.5" fill="${col}">${g} ${name.split(" ")[0]}</text>
      <text id="pc-${p}" x="${x + 10}" y="${y + 40}" font-size="17" fill="#fff" font-weight="700">0</text><text id="pl-${p}" x="${x + 10}" y="${y + 56}" font-size="8.5" fill="#2ee86b">● LIVE</text></g>`;
    PIPE.paths[p] = `M${x + bw},${y + bh / 2} C${x + bw + 40},${y + bh / 2} 300,98 352,98`;
    h += `<path class="flow" d="${PIPE.paths[p]}"/>`;
  });
  h += `<g class="box" id="pb-ai"><rect x="352" y="12" width="168" height="172"/><circle cx="436" cy="52" r="22" fill="none" stroke="#19d3f0" stroke-width="1.5" opacity=".9"/><circle cx="436" cy="52" r="12" fill="rgba(25,211,240,.3)" stroke="#5be6ff"/>
    <text x="436" y="94" font-size="11" fill="#fff" text-anchor="middle" font-weight="700" letter-spacing="2">AI PROCESSING</text>
    ${["NLP ANALYSIS", "ENTITY EXTRACTION", "THREAT DETECTION", "SENTIMENT ANALYSIS", "MULTI-LANGUAGE AI"].map((t, i) => `<text x="372" y="${112 + i * 15}" font-size="8.5" fill="#6a99ad">▸ ${t}</text>`).join("")}</g>`;
  const outs = [["INTELLIGENCE DB", 12], ["THREAT CORRELATION", 58], ["REAL-TIME ALERTS", 104], ["DASHBOARD", 150]];
  outs.forEach(([t, y], i) => {
    h += `<g class="box" id="po-${i}"><rect x="572" y="${y}" width="176" height="34"/><text x="590" y="${y + 21}" font-size="10" fill="#d3f1fb" letter-spacing="1.5" font-weight="700">${t}</text></g>`;
    PIPE.paths["o" + i] = `M520,98 C546,98 546,${y + 17} 572,${y + 17}`;
    h += `<path class="flow" d="${PIPE.paths["o" + i]}"/>`;
  });
  svg.innerHTML = h;
}
buildPipe();
function runPacket(d1, d2, col) {
  const svg = $("pipe"), NS = "http://www.w3.org/2000/svg";
  const make = d => { const p = document.createElementNS(NS, "path"); p.setAttribute("d", d); p.setAttribute("fill", "none"); svg.appendChild(p); return p; };
  const p1 = make(d1), p2 = make(d2), c = document.createElementNS(NS, "circle");
  c.setAttribute("r", 3.4); c.setAttribute("fill", col); c.setAttribute("class", "pkt"); c.style.color = col; svg.appendChild(c);
  const L1 = p1.getTotalLength(), L2 = p2.getTotalLength(), dur = 2200, t0 = performance.now();
  (function step(now) {
    const f = (now - t0) / dur;
    if (f >= 1) { c.remove(); p1.remove(); p2.remove(); return; }
    const pt = f < 0.55 ? p1.getPointAtLength(f / 0.55 * L1) : p2.getPointAtLength((f - 0.55) / 0.45 * L2);
    c.setAttribute("cx", pt.x); c.setAttribute("cy", pt.y);
    $("pb-ai").classList.toggle("hot", f > 0.45 && f < 0.7); requestAnimationFrame(step);
  })(performance.now());
}
function firePacket(plat) {
  const b = $("pb-" + plat); if (b) { b.classList.add("hot"); setTimeout(() => b.classList.remove("hot"), 800); }
  runPacket(PIPE.paths[plat] || PIPE.paths.news, PIPE.paths["o" + Math.floor(Math.random() * 4)], (PLAT[plat] || PLAT.news)[1]);
}
function updatePipe(d) {
  const now = Date.now();
  PLATS.forEach(p => {
    const el = $("pc-" + p); if (el) el.textContent = nf(d.platforms[p]);
    const last = d.platform_last && d.platform_last[p], live = last && now - new Date(last).getTime() < 6 * 3600e3;
    const l = $("pl-" + p); if (l) { l.textContent = live ? "● LIVE" : "○ IDLE"; l.setAttribute("fill", live ? "#2ee86b" : "#6a99ad"); }
  });
  $("pipe-note").textContent = `${nf(d.total_all)} ITEMS IN DATABASE`;
}

/* ---------- centre cards ---------- */
function renderCards(d) {
  const hrs = d.hourly, ent = d.entities, pct = d.total_all ? Math.round(d.ai_done * 100 / d.total_all) : 0;
  const tcount = d.threat, tmx = Math.max(1, ...Object.values(tcount));
  const el = (cls, inner) => `<div class="panel scard ${cls || ""}">${inner}</div>`;
  $("cards5").innerHTML =
    el("", `<h5>Data ingestion</h5><div class="sub">(last 24 hours, per hour)</div><div class="big">${nf(hrs.reduce((a, b) => a + b, 0))}</div><svg viewBox="0 0 150 44" preserveAspectRatio="none">${bars(hrs, "#19d3f0", 150, 44, 1.5)}</svg>`) +
    el("", `<h5>AI processing</h5><div class="sub">items analysed by Gemini</div><div class="big">${pct}%</div><div class="prog"><i style="width:${pct}%"></i></div><div class="sub" style="margin-top:6px">${nf(d.ai_done)} / ${nf(d.total_all)}</div>`) +
    el("", `<h5>Detected entities</h5><div class="big">${nf(ent.total)}</div>${[["Person", "#ff6b9a"], ["Org", "#19d3f0"], ["Location", "#2ee86b"], ["Event", "#ffd23d"]].map(([k, c]) => `<div class="erow"><i style="background:${c}"></i>${k}<b>${nf(ent[k])}</b></div>`).join("")}`) +
    el("", `<h5>Alerts <span class="sub">(high + critical, 24h)</span></h5><div class="big" style="color:var(--neg);text-shadow:0 0 8px rgba(255,77,106,.5)">${nf(d.alerts)}</div><svg viewBox="0 0 150 44" preserveAspectRatio="none">${["critical", "high", "medium", "low"].map((k, i) => `<rect x="${i * 38}" y="${44 - Math.max(2, tcount[k] / tmx * 40)}" width="34" height="${Math.max(2, tcount[k] / tmx * 40)}" fill="${THR[k][1]}" opacity=".85" rx="2"/>`).join("")}</svg>`) +
    el("", `<h5>System uptime</h5><div class="big mono" id="uptime-v" style="font-size:22px">--:--:--</div><div class="sub">sources active ${d.sources_active}/${d.sources_total} · health ${d.health}%</div><svg viewBox="0 0 150 44" preserveAspectRatio="none">${line([4, 6, 5, 7, 9, 8, 10, 9, 11, 10, 12, d.health / 10], "#2ee86b", 150, 44)}</svg>`);
}

/* ---------- feed ---------- */
function ago(iso) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d)) return "";
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return "just now"; if (m < 60) return m + " min ago"; if (m < 1440) return Math.round(m / 60) + " h ago";
  return d.toLocaleDateString("en-IN", {day: "numeric", month: "short"});
}
function cardHtml(m) {
  const th = m.threat && THR[m.threat] ? m.threat : "", tl = th ? THR[th][0] : "PENDING", plat = m.platform || "news";
  return `<div class="card ${th}">
    <div class="thumb ${esc(plat)}" data-id="${m.id}" data-plat="${esc(plat)}" data-link="${esc(m.link)}">${(PLAT[plat] || PLAT.news)[2]}</div>
    <div style="min-width:0"><div class="crow"><span class="thrb">${tl}</span>${m.confidence ? `<span class="conf">◉ CONFIDENCE ${m.confidence}%</span>` : ""}<span class="ctime">${esc(ago(m.published))}</span></div>
      <a class="open" href="${esc(m.link)}" data-id="${m.id}" data-plat="${esc(plat)}">${esc(m.title)}</a>
      <div class="tags"><span class="tag topic">${esc(m.topic)}</span><span class="tag ${esc(m.sentiment)}">${esc(m.sentiment)}</span><span class="tag plat ${esc(plat)}">${esc(plat)}</span>${m.location && m.location !== "Global" ? `<span class="loc">📍 ${esc(m.location)}</span>` : ""}${m.author ? `<span class="loc">👤 @${esc(m.author)}</span>` : ""}</div></div></div>`;
}
const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); thumbQ.push(e.target); pump(); } }), {root: $("list"), rootMargin: "300px"});
const thumbQ = []; let busy = 0;
function pump() { while (busy < 3 && thumbQ.length) { busy++; loadThumb(thumbQ.shift()).finally(() => { busy--; pump(); }); } }
async function loadThumb(el) {
  let url = null; const plat = el.dataset.plat;
  if (plat === "youtube") { const m = /v=([\w-]+)/.exec(el.dataset.link || ""); if (m) url = `https://i.ytimg.com/vi/${m[1]}/mqdefault.jpg`; }
  else if (plat === "news") { try { url = (await fetch("/api/thumb/" + el.dataset.id).then(r => r.json())).url; } catch (_) {} }
  if (!url) return;
  await new Promise(res => { const img = new Image(); img.referrerPolicy = "no-referrer"; img.onload = () => { el.textContent = ""; el.appendChild(img); res(); }; img.onerror = res; img.src = url; });
}
function renderFeed(items) {
  $("feed-n").textContent = items.length + " ITEMS";
  $("list").innerHTML = items.length ? items.map(cardHtml).join("") : '<div class="empty">// कोई डेटा नहीं //</div>';
  document.querySelectorAll("#list .thumb").forEach(t => io.observe(t));
}
$("list").addEventListener("click", e => {
  const a = e.target.closest("a.open"); if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault(); openViewer(a.dataset.id, a.textContent, a.dataset.plat, a.href);
});
function renderRight(d) {
  document.querySelectorAll("#scope-menu .msrow").forEach(r => { const v = r.querySelector("input").value, n = (d.units || {})[v]; r.querySelector("small").textContent = n ? n : ""; });
  $("topent").innerHTML = d.top_entities.length ? d.top_entities.map((e, i) => `<div class="mrow"><span style="color:var(--muted)">${i + 1}</span><span title="${esc(e.type)}">${esc(e.name)}</span><b>${e.count}</b></div>`).join("") : '<div class="sub" style="color:var(--muted);font-size:11px">// विश्लेषण जारी //</div>';
  const mx = Math.max(1, ...d.keywords.map(k => k.count));
  $("topkw").innerHTML = d.keywords.length ? d.keywords.slice(0, 6).map(k => `<div class="krow"><span>${esc(k.word.slice(0, 9))}</span><div class="kbar"><i style="width:${Math.round(k.count / mx * 100)}%"></i></div><b style="text-align:right">${k.count}</b></div>`).join("") : "";
}

/* ---------- left ---------- */
function renderLeft(d) {
  for (const k of ["positive", "neutral", "negative"]) {
    $("s-" + k).textContent = nf(d.sentiment[k]);
    $("d-" + k).textContent = delta(d.change[k]);
    $("sp-" + k).innerHTML = bars(d.series[k], SENTC[k], 86, 34, 2);
  }
  const t = d.threat, sum = Math.max(1, t.critical + t.high + t.medium + t.low);
  $("threat").innerHTML = ["critical", "high", "medium", "low"].map((k, i) => `<div class="thr-row" data-t="${k}" style="--c:${THR[k][1]}"><div class="sq">${["⚠", "▲", "◆", "●"][i]}</div><div class="nm">${THR[k][0]}</div><div class="n">${nf(t[k])}</div><div class="p">${Math.round(t[k] * 100 / sum)}%</div></div>`).join("");
  $("unc").textContent = d.unclassified ? `${nf(d.unclassified)} pending AI` : "";
  document.querySelectorAll(".thr-row").forEach(el => el.addEventListener("click", () => { S.threat = S.threat === el.dataset.t ? "" : el.dataset.t; load(); }));
  $("hd-src").textContent = `${d.sources_active}/${d.sources_total}`; $("hd-alerts").textContent = nf(d.alerts);
  $("hd-health").textContent = d.health + "%"; $("hd-hbar").style.width = d.health + "%";
}

/* ---------- main load ---------- */
async function load() {
  if (loading) return; loading = true;
  try {
    const p = filterParams(false); p.set("limit", 120);
    const [items, d] = await Promise.all([fetch("/api/mentions?" + p).then(r => r.json()), fetch("/api/dashboard?" + filterParams(true)).then(r => r.json())]);
    d._at = Date.now(); D = d;
    markActive(); renderLeft(d); renderCards(d); renderFeed(items); renderRight(d); updatePipe(d);
    drawMap($("map"), d.locations, S.view, false); $("insights").innerHTML = insightsHtml(d.locations);
    $("map-note").textContent = `${d.locations.reduce((a, l) => a + l.count, 0)} located items`;
    if (lastMaxId) items.filter(m => m.id > lastMaxId).slice(0, 5).forEach((m, i) => setTimeout(() => firePacket(m.platform || "news"), i * 500));
    lastMaxId = Math.max(lastMaxId, ...items.map(m => m.id), 0);
    if (S.tab !== "live") renderTab();
  } catch (e) { console.error(e); }
  loading = false;
}
setInterval(load, 45000);

/* ---------- system logs ---------- */
async function loadLogs() {
  try {
    const l = await fetch("/api/logs?n=7").then(r => r.json());
    $("logs").innerHTML = l.length ? l.map(x => `<div><span class="t">[${esc(x.t)}]</span> <span class="${esc(x.level)}">${esc(x.level)}</span> ${esc(x.msg)}</div>`).join("") : '<div><span class="t">[--:--:--]</span> <span class="INFO">INFO</span> waiting for the next collection cycle…</div>';
  } catch (_) {}
}
loadLogs(); setInterval(loadLogs, 4000);

/* ---------- viewer: posts open inside the centre column ---------- */
let viewSeq = 0;
async function openViewer(id, title, plat, href) {
  showTab("live");
  const seq = ++viewSeq, body = $("vw-body");
  $("viewer").classList.add("show");
  $("vw-title").textContent = title; $("vw-plat").textContent = plat; $("vw-plat").className = "tag plat " + plat;
  $("vw-orig").href = href; $("vw-orig").style.display = "none"; body.className = "body";
  body.innerHTML = '<div class="msg mono">// लोड हो रहा है… //</div>';
  let v;
  try { v = await fetch("/api/view/" + id).then(r => r.json()); } catch (_) { v = {kind: "link", note: "लोड नहीं हो पाया।"}; }
  if (seq !== viewSeq) return;
  if (v.original) $("vw-orig").href = v.original;
  if (v.kind === "embed") {
    body.className = "body embed";
    body.innerHTML = `<iframe src="${esc(v.embed)}" sandbox="allow-scripts allow-same-origin allow-presentation allow-forms" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  } else if (v.kind === "article") {
    const paras = (v.text || "").split("\n").filter((t, i) => t.trim() && !(i === 0 && (v.title || "").trim().startsWith(t.trim().slice(0, 40)))).map(t => `<p>${esc(t)}</p>`).join("");
    body.innerHTML = `<div class="article">${v.image ? `<img src="${esc(v.image)}" alt="" referrerpolicy="no-referrer">` : ""}<div class="site mono">${esc(v.site || "")}</div><h2>${esc(v.title || title)}</h2>${paras}</div>`;
  } else {
    $("vw-orig").style.display = "";
    body.innerHTML = `<div class="msg">${esc(v.note || "यह पेज यहाँ नहीं खुल सकता।")}</div>`;
  }
}
function openEmbed(embedUrl, title, plat, fallbackHref) {
  showTab("live"); const seq = ++viewSeq, body = $("vw-body");
  $("viewer").classList.add("show");
  $("vw-title").textContent = title; $("vw-plat").textContent = plat; $("vw-plat").className = "tag plat " + plat;
  $("vw-orig").href = fallbackHref; $("vw-orig").style.display = "none"; body.className = "body embed";
  body.innerHTML = `<iframe src="${esc(embedUrl)}" sandbox="allow-scripts allow-same-origin allow-presentation allow-forms" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}
function closeViewer() { viewSeq++; $("viewer").classList.remove("show"); $("vw-body").innerHTML = ""; }
$("vw-close").addEventListener("click", closeViewer);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeViewer(); });

/* ---------- ask Drishti AI (text) ---------- */
const chatHistory = [];
async function ask(text) {
  text = (text || "").trim(); if (!text) return;
  $("v-you").textContent = "आप: " + text; $("v-bot").textContent = "सोच रहा हूँ…"; $("ask").value = "";
  try {
    const r = await fetch("/api/chat", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({message: text, history: chatHistory})}).then(r => r.json());
    chatHistory.push({role: "user", content: text}, {role: "assistant", content: r.reply}); $("v-bot").textContent = r.reply;
  } catch (_) { $("v-bot").textContent = "जवाब नहीं मिल पाया।"; }
}
$("send").addEventListener("click", () => ask($("ask").value));
$("ask").addEventListener("keydown", e => { if (e.key === "Enter") ask($("ask").value); });
$("sugg").addEventListener("click", e => {
  const a = e.target.dataset.a; if (!a) return;
  if (a === "cisf-neg") { setScope(["CISF"]); $("sentiment").value = "negative"; S.category = S.location = ""; load(); }
  else if (a === "isro") { setScope(["ISRO"]); $("sentiment").value = ""; S.category = S.location = ""; load(); }
  else if (a === "delhi") { setScope([]); S.location = "Delhi"; S.category = "protest"; load(); }
  else if (a === "trend") { $("hours").value = "24"; load(); showTab("analytics"); }
});

/* ---------- tabs ---------- */
function showTab(name) {
  if (name === "sources") SOC.loaded = false;
  S.tab = name; document.body.className = "tab-" + name;
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  if (name !== "live") renderTab();
}
document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
function barRows(entries, color, total) {
  const mx = Math.max(1, ...entries.map(e => e[1]));
  return entries.map(([k, v, c]) => `<div class="bar2"><span style="color:${c || "var(--text)"}">${esc(k)}</span><div class="tr"><i style="width:${Math.round(v / mx * 100)}%;background:${c || color};color:${c || color}"></i></div><b style="text-align:right">${nf(v)}${total ? ` <span style="color:var(--muted);font-weight:400">${Math.round(v * 100 / total)}%</span>` : ""}</b></div>`).join("");
}
function renderTab() {
  if (!D) return;
  if (S.tab === "analytics") renderAnalytics(D);
  else if (S.tab === "map") { drawMap($("bigmap"), D.locations, S.view, true); $("bm-ins").innerHTML = insightsHtml(D.locations); $("bm-note").textContent = `${D.locations.reduce((a, l) => a + l.count, 0)} located items`; }
  else if (S.tab === "sources") { renderSources(D); loadAccounts(); if (!SOC.loaded) { SOC.loaded = true; loadSocial(); } }
}
function renderAnalytics(d) {
  const W = 520, H = 200, n = 12, series = d.series, mx = Math.max(1, ...Object.values(series).flat());
  const lines = ["positive", "neutral", "negative"].map(k => { const pts = series[k].map((v, i) => `${(i * W / (n - 1)).toFixed(1)},${(H - 8 - v / mx * (H - 24)).toFixed(1)}`).join(" "); return `<polyline points="${pts}" fill="none" stroke="${SENTC[k]}" stroke-width="2.2"/>`; }).join("");
  const grid = [0, 1, 2, 3].map(i => `<line x1="0" x2="${W}" y1="${8 + i * (H - 16) / 3}" y2="${8 + i * (H - 16) / 3}" stroke="rgba(25,211,240,.1)"/>`).join("");
  const tot = Object.values(d.threat).reduce((a, b) => a + b, 0) || 1, cats = Object.entries(d.categories).sort((a, b) => b[1] - a[1]);
  const panel = (t, inner) => `<div class="panel bigpanel"><div class="ptitle">${t}</div><div class="inner">${inner}</div></div>`;
  $("an-grid").innerHTML =
    panel("✦ Sentiment trend", `<svg viewBox="0 0 ${W} ${H + 16}" style="width:100%">${grid}${lines}<text x="0" y="${H + 12}" font-size="10" fill="#6a99ad">पुराना</text><text x="${W}" y="${H + 12}" font-size="10" fill="#6a99ad" text-anchor="end">अब</text></svg>
      <div style="display:flex;gap:16px;font-size:12px;margin-top:4px">${["positive", "neutral", "negative"].map(k => `<span style="color:${SENTC[k]}">● ${k.toUpperCase()} ${nf(d.sentiment[k])}</span>`).join("")}</div>`) +
    panel("▲ Threat distribution", barRows(["critical", "high", "medium", "low"].map(k => [THR[k][0], d.threat[k], THR[k][1]]), "#19d3f0", tot)) +
    panel("◈ Categories", cats.length ? barRows(cats.map(([k, v]) => [CATL[k] || k, v]), "#a78bfa") : '<div class="empty">// विश्लेषण जारी //</div>') +
    panel("☁ Platforms", barRows(PLATS.map(p => [PLAT[p][0], d.platforms[p], PLAT[p][1]]), "#19d3f0")) +
    panel("⌖ Ingestion — last 24 hours", `<svg viewBox="0 0 520 120" preserveAspectRatio="none" style="width:100%;height:120px">${bars(d.hourly, "#19d3f0", 520, 120, 3)}</svg><div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted)"><span>24 घंटे पहले</span><span>अभी</span></div>`) +
    panel("☺ Top entities", d.top_entities.length ? barRows(d.top_entities.map(e => [e.name, e.count])) : '<div class="empty">// विश्लेषण जारी //</div>') +
    panel("# Top keywords", barRows(d.keywords.map(k => [k.word, k.count]), "#2ee86b"));
}
const SRCINFO = {news: "Google News + The Hindu, Indian Express, NDTV, HT", youtube: "YouTube Data API", reddit: "Reddit खोज (RSS)", instagram: "Google index + Apify hashtags", facebook: "Google index", x: "Google index"};
function renderSources(d) {
  const tot = Object.values(d.platforms).reduce((a, b) => a + b, 0) || 1, now = Date.now();
  $("srcgrid").innerHTML = PLATS.map(p => {
    const last = d.platform_last[p], live = last && now - new Date(last).getTime() < 6 * 3600e3;
    return `<div class="panel src ${SOC.plat === p ? "active" : ""}" data-p="${p}" title="${PLAT[p][0]} की पोस्ट देखिए"><h4 style="color:${PLAT[p][1]}">${PLAT[p][2]} ${PLAT[p][0]}</h4><div class="n">${nf(d.platforms[p])}</div>
      <div class="m"><span class="okdot ${live ? "" : "off"}"></span>${live ? "ACTIVE" : "IDLE"} · ${last ? "आख़िरी: " + ago(last) : "—"}<br>हिस्सा: ${Math.round(d.platforms[p] * 100 / tot)}%<br>${esc(SRCINFO[p])}</div><div class="go">▼ पोस्ट देखें</div></div>`;
  }).join("");
}

/* ---------- CISF-named Instagram accounts (Sources tab) ---------- */
const cnt = n => n == null ? "—" : n >= 1e5 ? (n / 1e5).toFixed(1) + " लाख" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(n);
const ACC = {plat: "", seq: 0, mode: "accounts", mood: ""};
const PLNAME = {instagram: "Instagram", facebook: "Facebook", x: "X"};
async function loadAccounts() {
  const p = new URLSearchParams();
  if ($("acc-q").value) p.set("q", $("acc-q").value);
  if ($("acc-w").checked) p.set("watched", 1);
  if (ACC.plat) p.set("platform", ACC.plat);
  const seq = ++ACC.seq;
  const d = await fetch("/api/accounts?" + p).then(r => r.json());
  if (seq !== ACC.seq) return;                       // a newer click already asked for fresh data
  const by = d.by_platform || {};
  document.querySelectorAll("#acc-tabs button").forEach(b => { const k = b.dataset.ap; b.querySelector("span").textContent = k ? (by[k] || 0) : d.total; b.classList.toggle("active", k === ACC.plat); });
  $("acc-total").textContent = `${d.total} अकाउंट`;
  $("acc-count").textContent = `कुल ${d.total} अकाउंट मिले जिनके username/नाम में CISF है · ${d.watching} को Watch पर रखा है। ये सार्वजनिक अकाउंट हैं: कौन असली CISF का है और कौन सिर्फ़ नाम रखकर बैठा है, यह आप खुद प्रोफ़ाइल खोलकर जाँचिए।`;
  $("acc-list").innerHTML = d.items.length ? d.items.map(a => `
    <div class="panel acc ${a.watched ? "w" : ""}"><div class="who"><div class="un">@${esc(a.username)} <span class="tag plat ${esc(a.platform)}" style="vertical-align:2px">${esc(PLNAME[a.platform] || a.platform)}</span></div><div class="fn">${esc(a.full_name || "")}</div>
      <div class="chips2">${a.followers != null ? `<span class="tag">👥 ${cnt(a.followers)}</span>` : ""}${a.private == null ? "" : `<span class="tag ${a.private ? "negative" : "positive"}">${a.private ? "🔒 Private" : "🌐 Public"}</span>`}${a.verified ? '<span class="tag topic">✔ Verified</span>' : ""}<span class="tag plat">${a.posts} पोस्ट हमारे पास</span></div></div>
      <div class="btns"><button class="wbtn ${a.watched ? "on" : ""}" data-p="${esc(a.platform)}" data-u="${esc(a.username)}" data-w="${a.watched ? 0 : 1}">${a.watched ? "★ Watching" : "☆ Watch"}</button><button class="ibtn" data-p="${esc(a.platform)}" data-u="${esc(a.username)}" data-url="${esc(a.url)}">${esc(PLNAME[a.platform] || a.platform)}</button><a class="obtn" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" title="आपके अपने ब्राउज़र के नए टैब में खुलेगा (login के साथ)">↗ असली ${esc(PLNAME[a.platform] || a.platform)}</a>${a.posts ? `<button class="pbtn" data-p="${esc(a.platform)}" data-u="${esc(a.username)}">पोस्ट देखें</button>` : ""}</div></div>`).join("") : '<div class="empty">// अभी कोई अकाउंट नहीं //</div>';
}
function profileEmbed(plat, u, url) {
  if (plat === "facebook") return `https://www.facebook.com/plugins/page.php?href=${encodeURIComponent(url)}&tabs=timeline&width=500&height=800&small_header=false&adapt_container_width=true&hide_cover=false&show_facepile=false`;
  if (plat === "x") return `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(u)}?dnt=true&theme=dark`;
  return `https://www.instagram.com/${encodeURIComponent(u)}/embed/`;
}
$("acc-tabs").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; ACC.plat = b.dataset.ap; loadAccounts(); if (ACC.mode === "posts") loadAccPosts(); });
const MOOD = {positive: ["😊", "var(--pos)"], neutral: ["😐", "var(--neu)"], negative: ["😢", "var(--neg)"]};
function setAccMode(m) {
  ACC.mode = m;
  document.querySelectorAll("#acc-mode button").forEach(b => b.classList.toggle("active", b.dataset.m === m));
  $("acc-moodbar").style.display = m === "posts" ? "" : "none";
  $("acc-list").style.display = m === "posts" ? "none" : "";
  document.querySelector("#p-sources .acc-head").style.display = m === "posts" ? "none" : "";
  $("acc-count").style.display = m === "posts" ? "none" : "";
  if (m === "posts") loadAccPosts();
}
let accPSeq = 0;
async function loadAccPosts() {
  const seq = ++accPSeq, p = new URLSearchParams({limit: 150});
  if (ACC.plat) p.set("platform", ACC.plat);
  if (ACC.mood) p.set("sentiment", ACC.mood);
  const d = await fetch("/api/accounts/posts?" + p).then(r => r.json());
  if (seq !== accPSeq) return;
  const mc = d.mood_counts, all = mc.positive + mc.neutral + mc.negative;
  document.querySelectorAll("#acc-mood button").forEach(b => { const k = b.dataset.s; b.querySelector("span").textContent = k ? mc[k] : all; b.classList.toggle("active", k === ACC.mood); });
  $("acc-posts").innerHTML = d.items.length ? d.items.map(m => {
    const [em, col] = MOOD[m.sentiment] || MOOD.neutral;
    return `<div class="spost" data-id="${m.id}" data-plat="${esc(m.platform)}" data-link="${esc(m.link)}"><div class="crow"><span class="who">@${esc(m.author)}</span><span class="tag plat ${esc(m.platform)}">${esc(PLNAME[m.platform] || m.platform)}</span>
      <span class="ctime">${esc(ago(m.published))}<a class="ext" href="${esc(m.real_url || m.link)}" target="_blank" rel="noopener noreferrer" title="असली पोस्ट नए टैब में">↗</a></span></div>
      <div class="tt">${esc(m.title)}</div><div class="tags"><span class="tag" style="color:${col};border-color:${col}">${em} ${esc({positive: "खुश / अच्छी", neutral: "सामान्य", negative: "उदास / बुरी"}[m.sentiment] || m.sentiment)}</span></div></div>`;
  }).join("") : '<div class="empty">// इस मूड की कोई पोस्ट नहीं //</div>';
}
$("acc-mode").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setAccMode(b.dataset.m); });
$("acc-mood").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; ACC.mood = b.dataset.s; loadAccPosts(); });
$("acc-posts").addEventListener("click", e => { if (e.target.closest(".ext")) return; const c = e.target.closest(".spost"); if (c) openViewer(c.dataset.id, c.querySelector(".tt").textContent, c.dataset.plat, c.dataset.link); });
$("acc-list").addEventListener("click", async e => {
  const w = e.target.closest(".wbtn"), pb = e.target.closest(".pbtn"), ib = e.target.closest(".ibtn");
  if (w) { await fetch(`/api/accounts/${encodeURIComponent(w.dataset.p)}/${encodeURIComponent(w.dataset.u)}/watch`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({watched: w.dataset.w === "1"})}); loadAccounts(); }
  else if (ib) { const u = ib.dataset.u, pl = ib.dataset.p; openEmbed(profileEmbed(pl, u, ib.dataset.url), "@" + u, pl, ib.dataset.url); }
  else if (pb) {
    S.author = pb.dataset.u; S.alerts = false; S.threat = S.category = S.location = S.source = ""; setScope([]);
    $("q").value = ""; $("sentiment").value = ""; $("platform").value = pb.dataset.p; $("hours").value = "";
    showTab("live"); load();
  }
});
$("acc-w").addEventListener("change", loadAccounts);
let at; $("acc-q").addEventListener("input", () => { clearTimeout(at); at = setTimeout(loadAccounts, 300); });
$("acc-refresh").addEventListener("click", async () => {
  const b = $("acc-refresh"); b.disabled = true; b.textContent = "खोज चालू है… (10-20 मिनट)";
  try { await fetch("/api/accounts/refresh", {method: "POST"}); } catch (_) {}
  const timer = setInterval(async () => {
    loadAccounts(); const st = await fetch("/api/accounts/status").then(r => r.json()).catch(() => ({running: true}));
    if (!st.running) { clearInterval(timer); b.disabled = false; b.textContent = "🔍 नए अकाउंट खोजें"; }
  }, 20000);
});

/* ---------- social accounts: who posts what on Instagram / Facebook / X ---------- */
const SOC = {plat: "instagram", author: "", q: "", loaded: false, seq: 0, pseq: 0};
const SOC_BY_SOURCE = ["news", "youtube", "reddit"];          // for these the "who" is the outlet / channel / subreddit
const socKey = () => SOC_BY_SOURCE.includes(SOC.plat) ? "source" : "author";
const socWho = n => SOC_BY_SOURCE.includes(SOC.plat) ? esc(n) : "@" + esc(n);
function socPick(pl, scroll, author) {
  SOC.plat = pl; SOC.author = author || ""; SOC.q = ""; $("soc-q").value = "";
  $("soc-q").placeholder = SOC_BY_SOURCE.includes(pl) ? "नाम खोजें..." : "@username खोजें...";
  document.querySelectorAll("#soc-tabs button").forEach(b => b.classList.toggle("active", b.dataset.p === pl));
  document.querySelectorAll("#srcgrid .src").forEach(c => c.classList.toggle("active", c.dataset.p === pl));
  loadSocial();
  if (scroll) $("soc-tabs").scrollIntoView({behavior: "smooth", block: "start"});
}
async function loadSocial() {
  const p = new URLSearchParams({platform: SOC.plat}); if (SOC.q) p.set("q", SOC.q);
  const sq = ++SOC.seq;
  const d = await fetch("/api/authors?" + p).then(r => r.json());
  if (sq !== SOC.seq) return;
  $("soc-note").textContent = `${nf(d.accounts)} अकाउंट · ${nf(d.total)} पोस्ट` + (d.unknown ? ` · ${nf(d.unknown)} का ${SOC_BY_SOURCE.includes(SOC.plat) ? "स्रोत" : "username"} अभी पता नहीं` : "");
  $("soc-accts").innerHTML = `<div class="arow ${SOC.author === "" ? "active" : ""}" data-a=""><span class="nm">सभी पोस्ट</span><b>${nf(d.total)}</b></div>` + d.items.map(a => {
    const t = a.count || 1;
    return `<div class="arow ${SOC.author.toLowerCase() === a.author.toLowerCase() ? "active" : ""}" data-a="${esc(a.author)}"><span class="nm">${socWho(a.author)}${a.alerts ? ` <span style="color:var(--neg);font-size:11px">▲${a.alerts}</span>` : ""}</span><b>${a.count}</b>
      <span class="sb"><i style="width:${a.positive / t * 100}%;background:var(--pos)"></i><i style="width:${a.neutral / t * 100}%;background:var(--neu)"></i><i style="width:${a.negative / t * 100}%;background:var(--neg)"></i></span></div>`;
  }).join("");
  loadSocialPosts();
}
async function loadSocialPosts() {
  const p = new URLSearchParams({platform: SOC.plat, limit: 80}); if (SOC.author) p.set(socKey(), SOC.author);
  const pq = ++SOC.pseq;
  const items = await fetch("/api/mentions?" + p).then(r => r.json());
  if (pq !== SOC.pseq) return;
  $("soc-head").innerHTML = SOC.author
    ? `<div style="margin-bottom:8px;color:var(--muted);font-size:13px">${socWho(SOC.author)} की पोस्ट (${items.length}) &nbsp;<button id="soc-all" style="padding:2px 10px;font-size:11px">सभी देखें</button></div>`
    : `<div style="margin-bottom:8px;color:var(--muted);font-size:13px">सारी पोस्ट — नई पहले (${items.length} दिखा रहा हूँ)</div>`;
  $("soc-posts").innerHTML = items.length ? items.map(m => `<div class="spost" data-id="${m.id}" data-plat="${esc(m.platform)}" data-link="${esc(m.link)}">
      <div class="crow"><span class="who">${SOC_BY_SOURCE.includes(m.platform) ? esc(m.source || "—") : (m.author ? "@" + esc(m.author) : "username अभी पता नहीं")}</span><span class="ctime">${esc(ago(m.published))}<a class="ext" href="${esc(m.real_url || m.link)}" target="_blank" rel="noopener noreferrer" title="असली पेज नए टैब में">↗</a></span></div>
      <div class="tt">${esc(m.title)}</div>
      <div class="tags"><span class="tag topic">${esc(m.topic)}</span><span class="tag ${esc(m.sentiment)}">${esc(m.sentiment)}</span>${m.threat ? `<span class="tag" style="color:${THR[m.threat][1]};border-color:${THR[m.threat][1]}">${THR[m.threat][0]}</span>` : ""}${m.location && m.location !== "Global" ? `<span class="loc">📍 ${esc(m.location)}</span>` : ""}</div></div>`).join("")
    : '<div class="empty">// कोई पोस्ट नहीं //</div>';
}
$("soc-tabs").addEventListener("click", e => { const pl = e.target.dataset.p; if (pl) socPick(pl, false); });
$("srcgrid").addEventListener("click", e => { const c = e.target.closest(".src"); if (c) socPick(c.dataset.p, true); });
$("soc-accts").addEventListener("click", e => {
  const r = e.target.closest(".arow"); if (!r) return;
  SOC.author = r.dataset.a;
  document.querySelectorAll("#soc-accts .arow").forEach(x => x.classList.toggle("active", x === r));
  loadSocialPosts();
});
$("soc-head").addEventListener("click", e => { if (e.target.id === "soc-all") { SOC.author = ""; document.querySelectorAll("#soc-accts .arow").forEach(x => x.classList.toggle("active", x.dataset.a === "")); loadSocialPosts(); } });
$("soc-posts").addEventListener("click", e => { if (e.target.closest(".ext")) return; const c = e.target.closest(".spost"); if (c) openViewer(c.dataset.id, c.querySelector(".tt").textContent, c.dataset.plat, c.dataset.link); });
let sct; $("soc-q").addEventListener("input", () => { clearTimeout(sct); sct = setTimeout(() => { SOC.q = $("soc-q").value; loadSocial(); }, 300); });

/* ---------- reports ---------- */
$("rp-go").addEventListener("click", async () => {
  const b = $("rp-go"); b.disabled = true; b.textContent = "बन रही है…"; $("reportbox").textContent = "";
  try {
    const r = await fetch(`/api/report?topic=${encodeURIComponent($("rp-topic").value)}&hours=${$("rp-hours").value}`, {method: "POST"}).then(r => r.json());
    $("reportbox").textContent = r.text; $("rp-meta").textContent = r.ok ? `GENERATED ${r.generated} · ${r.window}` : "";
  } catch (_) { $("reportbox").textContent = "रिपोर्ट नहीं बन पाई।"; }
  b.disabled = false; b.textContent = "▤ रिपोर्ट बनाइए";
});
$("rp-copy").addEventListener("click", () => { navigator.clipboard && navigator.clipboard.writeText($("reportbox").textContent); });
$("rp-print").addEventListener("click", () => window.print());
const pst = document.createElement("style");
pst.textContent = "@media print { body { background:#fff !important; color:#000 !important; display:block; height:auto; overflow:visible } header, .cols, nav, .frow, #rp-meta, .ptitle { display:none !important } .page { display:none !important } body.tab-reports #p-reports { display:block !important } .panel { border:0 !important; background:#fff !important } .panel::before, .panel::after { display:none } #reportbox { color:#000 !important; font-size:14pt } }";
document.head.appendChild(pst);

load();
