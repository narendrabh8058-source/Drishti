/* ---------- Voice assistant (Gemini Live) ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const WAKE = /drishti|dristi|drishthi|trishti|dishti|दृष्टि|दृष्टी|द्रष्टि|दृस्टि|दिष्टि|दृष्ठि/i;
let standby = false, live = null, wakeRec = null, wakeTimer = null;

const vshow = (state, you, bot) => {
  if (state != null) { $("v-state").textContent = state; setAvState(state); }
  if (you != null) $("v-you").textContent = you;
  if (bot != null) $("v-bot").textContent = bot;
};
const micOff = () => { $("mic").classList.remove("on"); $("mic").title = "🎤 Voice चालू करें"; };

/* ---- wake word: "Hey Drishti" ---- */
function startWake() {
  stopWake();
  if (!standby || live) return;
  const r = wakeRec = new SR();
  r.lang = "hi-IN"; r.continuous = true; r.interimResults = false;
  r.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      const text = e.results[i][0].transcript.trim();
      if (WAKE.test(text)) { stopWake(); startLive(); return; }
      vshow("Standby — बोलिए: Hey Drishti", "सुना: " + text, null);
    }
  };
  r.onend = () => { if (wakeRec === r) { wakeRec = null; if (standby && !live) wakeTimer = setTimeout(startWake, 250); } };
  r.onerror = e => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      standby = false; micOff();
      vshow("Mic blocked", null, "माइक की permission दीजिए (address bar में 🔒 पर क्लिक करके)।");
    }
  };
  try { r.start(); } catch (_) {}
}
function stopWake() {
  clearTimeout(wakeTimer);
  if (wakeRec) { const r = wakeRec; wakeRec = null; r.onend = null; r.onresult = null; try { r.abort(); } catch (_) {} }
}

/* ---- live session ---- */
const workletCode = `
class Cap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("cap", Cap);`;

async function startLive() {
  if (live) return;
  const s = live = { ws: null, stream: null, inCtx: null, outCtx: null, next: 0, srcs: [], closed: false, you: "", bot: "" };
  vshow("Connecting…", "", "");
  try {
    s.stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1}});
  } catch (_) {
    live = null; standby = false; micOff();
    vshow("Mic blocked", null, "माइक की permission दीजिए (address bar में 🔒 पर क्लिक करके)।"); return;
  }
  s.outCtx = new AudioContext({sampleRate: 24000});
  s.anOut = s.outCtx.createAnalyser(); s.anOut.fftSize = 1024; s.anOut.connect(s.outCtx.destination);
  s.inCtx = new AudioContext({sampleRate: 16000});
  await s.outCtx.resume(); await s.inCtx.resume();
  await s.inCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([workletCode], {type: "application/javascript"})));

  const proto = location.protocol === "https:" ? "wss" : "ws";
  s.ws = new WebSocket(`${proto}://${location.host}/ws/voice`);
  s.ws.binaryType = "arraybuffer";

  s.ws.onopen = () => {
    const src = s.inCtx.createMediaStreamSource(s.stream);
    s.anIn = s.inCtx.createAnalyser(); s.anIn.fftSize = 1024; src.connect(s.anIn);
    const node = new AudioWorkletNode(s.inCtx, "cap");
    node.port.onmessage = e => {
      if (s.ws.readyState !== 1) return;
      const f = e.data, out = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); out[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
      s.ws.send(out.buffer);
    };
    src.connect(node);
    s.node = node;
  };

  s.ws.onmessage = ev => {
    if (typeof ev.data !== "string") return playChunk(s, ev.data);
    const m = JSON.parse(ev.data);
    if (m.type === "ready") vshow("Listening…", null, null);
    else if (m.type === "you") { s.you += m.text; vshow(null, "आप: " + s.you, null); }
    else if (m.type === "bot") { s.bot += m.text; vshow("Speaking…", null, s.bot); }
    else if (m.type === "turn_complete") { s.you = ""; s.bot = ""; vshow("Listening…", null, null); }
    else if (m.type === "interrupted") { stopPlayback(s); s.bot = ""; }
    else if (m.type === "filters") applyFilters(m.filters);
    else if (m.type === "open") openViewer(m.id, m.title, m.platform, m.link);
    else if (m.type === "refresh") load();
    else if (m.type === "error") { vshow("Error", null, m.text); endLive(); }
    else if (m.type === "end") setTimeout(endLive, Math.max(300, (s.next - s.outCtx.currentTime) * 1000 + 300));
    else voiceEvent(m);
  };
  s.ws.onclose = () => endLive();
  s.ws.onerror = () => vshow("Error", null, "सर्वर से जुड़ नहीं पाया।");
}

function playChunk(s, buf) {
  const i16 = new Int16Array(buf), f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const ab = s.outCtx.createBuffer(1, f32.length, 24000);
  ab.copyToChannel(f32, 0);
  const src = s.outCtx.createBufferSource();
  src.buffer = ab; src.connect(s.anOut);
  const t = Math.max(s.outCtx.currentTime + 0.05, s.next);
  src.start(t); s.next = t + ab.duration;
  s.srcs.push(src); src.onended = () => { s.srcs = s.srcs.filter(x => x !== src); };
}
function stopPlayback(s) {
  s.srcs.forEach(x => { try { x.stop(); } catch (_) {} });
  s.srcs = []; s.next = 0;
}


function endLive() {
  const s = live;
  if (!s || s.closed) return;
  s.closed = true; live = null;
  try { s.ws.onclose = null; if (s.ws.readyState === 1) s.ws.send("stop"); s.ws.close(); } catch (_) {}
  try { s.node && s.node.disconnect(); } catch (_) {}
  try { s.stream && s.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { s.inCtx && s.inCtx.close(); } catch (_) {}
  stopPlayback(s); try { s.outCtx && s.outCtx.close(); } catch (_) {}
  if (standby) { vshow("Standby — बोलिए: Hey Drishti", "", ""); setTimeout(startWake, 400); }
}

$("mic").addEventListener("click", () => {
  if (!SR) { vshow("Not supported", null, "यह browser voice सुनना सपोर्ट नहीं करता। कृपया Google Chrome में खोलिए।"); return; }
  if (standby || live) {
    standby = false; stopWake(); endLive(); micOff();
    $("voicebox").classList.remove("show"); return;
  }
  standby = true; $("mic").classList.add("on"); $("mic").title = "🎤 सुन रहा हूँ… (बंद करें)";
  vshow("Standby — बोलिए: Hey Drishti", "", "");
  startWake();
});

