/* Holographic CISF jawan, human-proportioned: the real MediaPipe face/head mesh (head.json, from Mark-LIII) on a lofted
   body (smooth torso, tapered limbs, boots) with a peaked cap. Same public API as before:
   new HoloSoldier(canvas, getLevel, getMic), setState(), state. */
(function () {
  const CAM_D = 4.6, LUT_N = 160, SEG = 16;
  const HS = 0.175, HY = 0.70;                       // head scale and the body height of the chin
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rate = (dt, tau) => 1 - Math.exp(-dt / tau);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const ease = t => t * t * (3 - 2 * t);

  /* ---------- 3x3 + translation transforms: [m00..m22, tx, ty, tz] ---------- */
  const I = () => [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const Rx = a => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };
  const Ry = a => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
  const Rz = a => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
  const mm = (A, B) => [
    A[0] * B[0] + A[1] * B[3] + A[2] * B[6], A[0] * B[1] + A[1] * B[4] + A[2] * B[7], A[0] * B[2] + A[1] * B[5] + A[2] * B[8],
    A[3] * B[0] + A[4] * B[3] + A[5] * B[6], A[3] * B[1] + A[4] * B[4] + A[5] * B[7], A[3] * B[2] + A[4] * B[5] + A[5] * B[8],
    A[6] * B[0] + A[7] * B[3] + A[8] * B[6], A[6] * B[1] + A[7] * B[4] + A[8] * B[7], A[6] * B[2] + A[7] * B[5] + A[8] * B[8]];
  const mv = (M, x, y, z) => [M[0] * x + M[1] * y + M[2] * z, M[3] * x + M[4] * y + M[5] * z, M[6] * x + M[7] * y + M[8] * z];
  const about = (R, c) => { const r = mv(R, c[0], c[1], c[2]); return [...R, c[0] - r[0], c[1] - r[1], c[2] - r[2]]; };
  const compose = (P, L) => { const M = mm(P, L), t = mv(P, L[9], L[10], L[11]); return [...M, t[0] + P[9], t[1] + P[10], t[2] + P[11]]; };

  /* ---------- geometry: every prim is {v:[[x,y,z]], f:[[idx..]], emit?, head?}; winding is fixed once at build time ---------- */
  function newell(v, idx) {
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < idx.length; i++) {
      const a = v[idx[i]], b = v[idx[(i + 1) % idx.length]];
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return [nx, ny, nz];
  }
  function orientBy(prim, outward) {              // outward(faceCentroid, faceIdx) -> reference vector; flip faces that point inwards
    for (const f of prim.f) {
      const c = [0, 0, 0]; for (const i of f) { c[0] += prim.v[i][0]; c[1] += prim.v[i][1]; c[2] += prim.v[i][2]; }
      c[0] /= f.length; c[1] /= f.length; c[2] /= f.length;
      const n = newell(prim.v, f), o = outward(c, f);
      if (n[0] * o[0] + n[1] * o[1] + n[2] * o[2] < 0) f.reverse();
    }
    return prim;
  }
  /* A smooth tube / body part lofted through elliptical rings. rings: [{y, rx, rz, cx, cz}] */
  function loft(rings, capTop = true, capBottom = true) {
    const v = [], f = [], R = rings.length;
    for (const r of rings) for (let i = 0; i < SEG; i++) { const a = (i / SEG) * Math.PI * 2; v.push([(r.cx || 0) + r.rx * Math.cos(a), r.y, (r.cz || 0) + r.rz * Math.sin(a)]); }
    for (let k = 0; k < R - 1; k++) for (let i = 0; i < SEG; i++) { const j = (i + 1) % SEG; f.push([k * SEG + i, k * SEG + j, (k + 1) * SEG + j, (k + 1) * SEG + i]); }
    const nSide = f.length;
    if (capTop) f.push([...Array(SEG).keys()]);
    if (capBottom) f.push([...Array(SEG).keys()].map(i => (R - 1) * SEG + i));
    const prim = { v, f };
    const ys = rings.map(r => r.y), up = ys[0] > ys[R - 1] ? 1 : -1;
    orientBy(prim, (c, idx) => {
      if (f.indexOf(idx) >= nSide) return [0, (idx[0] < SEG ? up : -up), 0];          // caps point along the axis
      // sides: radially away from the axis at this height
      let k = 0, best = 1e9; rings.forEach((r, ri) => { const d = Math.abs(r.y - c[1]); if (d < best) { best = d; k = ri; } });
      return [c[0] - (rings[k].cx || 0), 0, c[2] - (rings[k].cz || 0)];
    });
    return prim;
  }
  function ellipsoid(cx, cy, cz, rx, ry, rz, rings = 6) {
    const rs = [];
    for (let k = 0; k <= rings; k++) { const th = (k / rings) * Math.PI; rs.push({ y: cy + ry * Math.cos(th), rx: Math.max(1e-4, rx * Math.sin(th)), rz: Math.max(1e-4, rz * Math.sin(th)), cx, cz }); }
    return loft(rs, false, false);
  }
  function box(cx, cy, cz, w, h, d) {
    const x = w / 2, y = h / 2, z = d / 2;
    const v = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]].map(p => [p[0] + cx, p[1] + cy, p[2] + cz]);
    return orientBy({ v, f: [[4, 5, 6, 7], [1, 0, 3, 2], [0, 4, 7, 3], [5, 1, 2, 6], [3, 7, 6, 2], [0, 1, 5, 4]] }, c => [c[0] - cx, c[1] - cy, c[2] - cz]);
  }
  const ring = (y, r, rz, cx = 0, cz = 0) => ({ y, rx: r, rz: rz == null ? r : rz, cx, cz });

  /* ---------- the body ---------- */
  const SX = 0.27, SH = 0.60, ELB = 0.34, HIP = 0.10;
  function bodyParts() {
    const P = {};
    const part = (name, parent, pivot) => (P[name] = { name, parent, pivot, prims: [] });
    const add = (n, prim, emit = false) => { prim.emit = emit; P[n].prims.push(prim); };

    part("torso", null, [0, 0.1, 0]);
    add("torso", loft([ring(0.70, 0.075, 0.075), ring(0.655, 0.135, 0.09), ring(0.60, 0.262, 0.105, 0, -0.005), ring(0.52, 0.25, 0.122, 0, 0.005),
      ring(0.40, 0.215, 0.128, 0, 0.012), ring(0.28, 0.186, 0.115), ring(0.14, 0.165, 0.105), ring(0.0, 0.176, 0.11),
      ring(-0.10, 0.192, 0.118), ring(-0.22, 0.182, 0.112)]));                     // torso: neck base -> hips
    add("torso", loft([ring(-0.02, 0.200, 0.128), ring(-0.075, 0.200, 0.128)]));   // belt
    add("torso", loft([ring(0.715, 0.092, 0.092), ring(0.66, 0.112, 0.105)]));      // collar
    add("torso", box(0, 0.40, 0.138, 0.22, 0.17, 0.02));                           // vest / chest panel
    add("torso", box(-0.105, 0.50, 0.135, 0.07, 0.04, 0.015));                     // name tag
    for (const s of [-1, 1]) add("torso", box(s * 0.205, 0.625, 0, 0.11, 0.018, 0.13));     // epaulettes

    part("head", "torso", [0, HY + 0.02, 0]);                                       // the real face mesh is added later (needs head.json)

    for (const side of [-1, 1]) {
      const n = side < 0 ? "R" : "L", sx = side * SX;                              // R = viewer's left (his right hand)
      part("ua" + n, "torso", [sx, SH, 0]);
      add("ua" + n, ellipsoid(sx, SH - 0.005, 0, 0.075, 0.07, 0.075, 5));                       // shoulder
      add("ua" + n, loft([ring(SH - 0.01, 0.066, 0.064, sx), ring(0.47, 0.058, 0.056, sx), ring(ELB, 0.047, 0.046, sx)]));   // upper arm
      part("fa" + n, "ua" + n, [sx, ELB, 0]);
      add("fa" + n, loft([ring(ELB, 0.047, 0.046, sx), ring(0.22, 0.044, 0.043, sx), ring(0.07, 0.031, 0.030, sx)]));         // forearm
      add("fa" + n, ellipsoid(sx, 0.015, 0.005, 0.034, 0.064, 0.026, 5));                       // hand
      const hx = side * HIP;
      part("leg" + n, null, [hx, -0.2, 0]);
      add("leg" + n, loft([ring(-0.20, 0.106, 0.104, hx), ring(-0.40, 0.090, 0.088, hx), ring(-0.68, 0.064, 0.064, hx)], true, false));         // thigh
      add("leg" + n, loft([ring(-0.68, 0.064, 0.064, hx), ring(-0.80, 0.061, 0.066, hx, -0.006), ring(-1.00, 0.047, 0.047, hx), ring(-1.17, 0.040, 0.040, hx)], false, false)); // shin
      add("leg" + n, loft([ring(-1.14, 0.046, 0.050, hx), ring(-1.20, 0.064, 0.095, hx, 0.03), ring(-1.26, 0.070, 0.150, hx, 0.055), ring(-1.30, 0.064, 0.150, hx, 0.055)]));   // boot
    }
    return P;
  }

  /* peaked cap + the face mesh, both defined in head-mesh units and mapped onto the body */
  const mapH = (x, y, z) => [x * HS, HY + (y + 1.0) * HS, (z + 0.1) * HS];
  function capPrims() {
    const R = (y, rx, rz) => ({ y, rx, rz, cx: 0, cz: -0.14 });
    const dome = loft([R(1.075, 0.001, 0.001), R(1.04, 0.24, 0.27), R(0.93, 0.50, 0.56), R(0.76, 0.69, 0.78), R(0.58, 0.745, 0.83), R(0.44, 0.77, 0.86), R(0.40, 0.77, 0.86)], false, false);
    const band = loft([R(0.33, 0.795, 0.89), R(0.50, 0.80, 0.90)]);
    const peak = (() => {   // flat brim sloping slightly down at the front
      const v = [[-0.62, 0.40, 0.58], [0.62, 0.40, 0.58], [0.46, 0.33, 1.13], [-0.46, 0.33, 1.13],
                 [-0.62, 0.36, 0.58], [0.62, 0.36, 0.58], [0.46, 0.29, 1.13], [-0.46, 0.29, 1.13]];
      const f = [[0, 1, 2, 3], [7, 6, 5, 4], [0, 3, 7, 4], [1, 5, 6, 2], [3, 2, 6, 7], [0, 4, 5, 1]];
      return orientBy({ v, f }, c => [c[0], c[1] - 0.36, c[2] - 0.85]);
    })();
    const badge = orientBy({ v: [[-0.13, 0.78, 0.80], [0.13, 0.78, 0.80], [0.13, 0.99, 0.80], [-0.13, 0.99, 0.80]], f: [[0, 1, 2, 3]] }, () => [0, 0, 1]);
    // the dome front must clear the forehead: push the badge onto the dome surface
    const prims = [dome, band, peak];
    const out = prims.map(p => ({ v: p.v.map(q => mapH(q[0], q[1], q[2])), f: p.f, emit: false }));
    badge.v = badge.v.map(q => [q[0], q[1], 0.74 + 0.0]);   // placed against the dome front (z ~ 0.74)
    out.push({ v: badge.v.map(q => mapH(q[0], q[1], q[2])), f: badge.f, emit: true });
    return out;
  }

  class HoloSoldier {
    constructor(canvas, getLevel, getMic) {
      this.cv = canvas; this.ctx = canvas.getContext("2d");
      this.getLevel = getLevel || (() => 0); this.getMic = getMic || (() => 0);
      this.primary = [0, 200, 235]; this.accent = [70, 225, 255]; this.bg = [2, 12, 20];
      this.state = "STANDBY"; this.t = 0; this.sway = 0; this.glow = 0; this.scan = -1.6;
      this.headYaw = 0; this.headPitch = 0.25; this.salT = -1; this.salAmt = 0; this.lastSalute = -99;
      this.vPeak = 0.18; this.mouth = 0; this.emph = 0; this.gest = 0; this.gestAt = 0; this.gestTgt = 0;
      this.look = 0; this.lookTgt = 0; this.lookAt = 0;
      this.ampSlow = 0; this.expr = 0; this.exprTgt = 0; this.exprAt = 0; this.brow = 0; this.browBias = 0;
      this.gaze = [0, 0]; this.gazeTgt = [0, 0]; this.gazeAt = 0; this.gazeBias = [0, 0]; this.biasTgt = [0, 0]; this.biasAt = 0;
      this.lids = 0.22; this.blink = 0; this.blinkAt = 3;
      this.ready = false; this.lut = null;
      fetch("/static/head.json").then(r => r.json()).then(m => { this._buildMesh(m); this.ready = true; });
      this._last = performance.now(); this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    _buildMesh(m) {
      const parts = bodyParts();
      // the face / cranium / neck mesh becomes part of 'head'
      const hv = m.verts.map(q => mapH(q[0], q[1], q[2]));
      const headPrim = { v: hv, f: m.faces.map(t => t.slice()), emit: false, isHead: true };
      const nrm = m.normals;
      orientBy(headPrim, (c, idx) => { const o = [0, 0, 0]; for (const i of idx) { o[0] += nrm[i][0]; o[1] += nrm[i][1]; o[2] += nrm[i][2]; } return o; });
      parts.head.prims.push(headPrim, ...capPrims());
      this.order = Object.keys(parts); this.parts = parts;

      const V = [], F = [];
      let off = 0;
      for (const name of this.order) {
        const p = parts[name]; p.v0 = off;
        for (const pr of p.prims) {
          const base = off;
          for (const q of pr.v) { V.push(q[0], q[1], q[2]); off++; }
          if (pr.isHead) this.head = { base, n: pr.v.length };
          for (const poly of pr.f) F.push({ idx: poly.map(i => i + base), emit: pr.emit, head: !!pr.isHead });
        }
        p.v1 = off;
      }
      this.V0 = Float32Array.from(V); this.nV = off; this.F = F;
      this.V = new Float32Array(V.length); this.xs = new Float32Array(off); this.ys = new Float32Array(off);
      // face animation data
      this.m = { rest: Float32Array.from(m.verts.flat()), jaw: Float32Array.from(m.jaw), brow: Float32Array.from(m.brow), pivot: m.jaw_pivot, jawMax: m.jaw_max, lm: m.landmarks };
      const li = m.landmarks.lips_in; this.lipUp = li.slice(10).concat(li.slice(0, 1));
    }

    setState(s) {
      const ns = (s || "STANDBY").toUpperCase();
      if (ns === "SPEAKING" && this.state !== "SPEAKING" && this.t - this.lastSalute > 25) this.salute();
      this.state = ns;
    }
    salute() { this.salT = 0; this.lastSalute = this.t; }

    /* ---------- animation ---------- */
    _step(dt) {
      dt = clamp(dt, 0.001, 0.1); this.t += dt; const t = this.t, st = this.state;
      const out = this.getLevel(), mic = this.getMic();
      const speaking = st === "SPEAKING" || out > 0.03, asleep = st === "STANDBY", thinking = st === "THINKING";
      this.sway += dt * (speaking ? 1.2 : 1);
      const lv = speaking ? out : 0, ref = Math.max(0.18, this.vPeak = Math.max(lv, this.vPeak - dt * 0.55));
      const drive = speaking ? clamp((lv - 0.1 * ref) / (ref * 0.9), 0, 1) ** 0.85 : 0;
      this.mouth += (drive - this.mouth) * rate(dt, drive > this.mouth ? 0.022 : speaking ? 0.012 : 0.055);
      if (this.mouth < 0.002) this.mouth = 0;
      this.emph += (this.mouth - this.emph) * rate(dt, this.mouth > this.emph ? 0.055 : 0.32);

      if (t >= this.lookAt) { this.lookTgt = rnd(-0.30, 0.30) * (speaking ? 1 : 0.6); this.lookAt = t + (thinking ? 2.5 : 1.4) + 2 * Math.random(); }
      this.look += (this.lookTgt - this.look) * 0.04;
      const yawT = asleep ? 0 : thinking ? 0.40 * Math.sin(t * 0.7) : this.look;
      const pitchT = asleep ? 0.34 : thinking ? -0.08 : st === "LISTENING" ? -0.03 : -0.02 + this.emph * 0.07;
      this.headYaw += (yawT - this.headYaw) * 0.06; this.headPitch += (pitchT - this.headPitch) * 0.06;

      // brows / eyes / gaze (as in the Jarvis head)
      const env = speaking ? lv : 0; this.ampSlow += (env - this.ampSlow) * rate(dt, env > this.ampSlow ? 0.16 : 0.36);
      if (speaking) { if (t >= this.exprAt) { this.exprTgt = rnd(-0.35, 1.0); this.exprAt = t + 1.1 + 2 * Math.random(); } } else { this.exprTgt = 0; this.exprAt = t + 0.8; }
      this.expr += (this.exprTgt - this.expr) * 0.075;
      let bb, lt;
      if (thinking) { if (t >= this.biasAt) { this.biasTgt = [(Math.random() < 0.5 ? -1 : 1) * rnd(0.45, 0.8), rnd(0.25, 0.55)]; this.biasAt = t + 1.4 + 1.6 * Math.random(); } bb = -0.28; lt = 0.94; }
      else if (asleep) { this.biasTgt = [0, -0.25]; bb = -0.05; lt = 0.22; }
      else { this.biasTgt = [0, 0]; this.biasAt = 0; bb = st === "LISTENING" ? 0.10 : 0; lt = 1; }
      for (let i = 0; i < 2; i++) this.gazeBias[i] += (this.biasTgt[i] - this.gazeBias[i]) * 0.06;
      this.lids += (lt - this.lids) * 0.08; this.browBias += (bb - this.browBias) * 0.06;
      this.brow += (clamp(0.55 * this.ampSlow + 0.60 * this.expr + this.browBias, -0.4, 1.2) - this.brow) * 0.20;
      if (t >= this.gazeAt) { const reach = speaking ? 0.9 : thinking ? 0.35 : 0.55; this.gazeTgt = [rnd(-1, 1) * reach, rnd(-1, 1) * reach * 0.55]; this.gazeAt = t + (speaking ? 0.55 + 1.7 * Math.random() : 1.3 + 2.8 * Math.random()); }
      for (let i = 0; i < 2; i++) this.gaze[i] += (clamp(this.gazeTgt[i] + this.gazeBias[i], -1, 1) - this.gaze[i]) * 0.30;
      if (this.blink > 0) this.blink = Math.max(0, this.blink - dt * 8.5);
      else if (t >= this.blinkAt) { if (asleep) this.blinkAt = t + 6; else { this.blink = 1; this.blinkAt = t + (thinking ? 5.5 : 3.4) + 3.1 * Math.random(); } }

      if (speaking) { if (t >= this.gestAt) { this.gestTgt = rnd(0.0, 1.0); this.gestAt = t + 0.7 + 1.6 * Math.random(); } } else this.gestTgt = 0;
      this.gest += (this.gestTgt - this.gest) * 0.06;

      if (this.salT >= 0) { this.salT += dt; const s = this.salT; this.salAmt = s < 0.7 ? ease(s / 0.7) : s < 2.3 ? 1 : s < 3.0 ? 1 - ease((s - 2.3) / 0.7) : 0; if (s >= 3.0) { this.salT = -1; this.salAmt = 0; } }

      const amp = speaking ? out : st === "LISTENING" ? mic * 0.8 : 0;
      this.glow += (amp - this.glow) * (amp > this.glow ? 0.35 : 0.1);
      this.scan += dt * (0.55 + 1.5 * this.glow); if (this.scan > 1.35) this.scan = -1.75;
    }

    _posedHead() {          // jaw drop + brow lift applied to the face mesh, then mapped onto the body
      const m = this.m, h = this.head, V0 = this.V0, rest = m.rest, [, py, pz] = m.pivot, mj = this.mouth * m.jawMax;
      const lift = this.brow * 0.14, jawOn = this.mouth > 0.004;
      for (let i = 0; i < h.n; i++) {
        let x = rest[i * 3], y = rest[i * 3 + 1] + m.brow[i] * lift, z = rest[i * 3 + 2];
        if (jawOn && m.jaw[i]) { const a = m.jaw[i] * mj, ca = Math.cos(a), sa = Math.sin(a), dy = y - py, dz = z - pz; y = py + dy * ca - dz * sa; z = pz + dy * sa + dz * ca; }
        const j = (h.base + i) * 3;
        V0[j] = x * HS; V0[j + 1] = HY + (y + 1.0) * HS; V0[j + 2] = (z + 0.1) * HS;
      }
    }

    _transforms() {
      const t = this.t, s = this.salAmt, g = this.gest, P = this.parts, W = {};
      const breath = 0.012 * Math.sin(t * 1.6), sw = Math.sin(this.sway * 0.5);
      const chest = [1, 0, 0, 0, 1 + breath, 0, 0, 0, 1 + breath * 1.4];
      const local = {
        torso: about(mm(mm(Ry(Math.sin(this.sway * 0.4) * 0.03), Rz(0.012 * sw)), chest), P.torso.pivot),
        head: about(mm(Ry(this.headYaw), mm(Rx(this.headPitch), Rz(0.025 * sw))), P.head.pivot),
        uaR: about(Rz(-0.70 * s + 0.03 * (1 - s)), P.uaR.pivot),
        faR: about(Rz(2.83 * s), P.faR.pivot),
        uaL: about(mm(Rz(0.07 + 0.10 * g), Rx(-0.35 * g)), P.uaL.pivot),
        faL: about(Rx(-0.55 * g - 0.05 - 0.03 * Math.sin(t * 1.6)), P.faL.pivot),
        legR: about(Rz(-0.02 + sw * 0.012), P.legR.pivot),
        legL: about(Rz(0.02 + sw * 0.012), P.legL.pivot),
      };
      const yaw = 0.18 * Math.sin(this.sway * 0.31) + 0.06 * Math.sin(this.sway * 0.73 + 1.3);
      const G = about(mm(Ry(yaw), Rx(0.02 * Math.sin(this.sway * 0.23 + 0.7))), [0, -0.15, 0]);
      for (const n of this.order) { const par = P[n].parent; W[n] = compose(par ? W[par] : G, local[n] || I()); }
      return W;
    }

    _lutBuild() {
      const [br, bg, bb] = this.bg, [pr, pg, pb] = this.primary; this.lut = [];
      for (let i = 0; i < LUT_N; i++) { const f = (i + 0.5) / LUT_N; this.lut.push(`rgb(${Math.round(br + (pr - br) * f)},${Math.round(bg + (pg - bg) * f)},${Math.round(bb + (pb - bb) * f)})`); }
    }
    _rgba(c, a) { return `rgba(${c[0]},${c[1]},${c[2]},${clamp(a, 0, 1)})`; }
    _mix(base, a) { const [pr, pg, pb] = this.primary; return `rgb(${Math.round(base[0] + (pr - base[0]) * a)},${Math.round(base[1] + (pg - base[1]) * a)},${Math.round(base[2] + (pb - base[2]) * a)})`; }

    _draw() {
      const cv = this.cv, ctx = this.ctx, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      if (!this.ready) return;
      if (!this.lut) this._lutBuild();
      const amp = this.glow, SPAN = 2.40;
      const r = Math.min(H * 0.96 / SPAN, W * 0.5), cx = W / 2, cy = H * 0.02 + r * 1.07;

      this._posedHead();
      const TT = this._transforms(), V0 = this.V0, V = this.V;
      for (const n of this.order) {
        const p = this.parts[n], M = TT[n];
        for (let i = p.v0; i < p.v1; i++) {
          const x = V0[i * 3], y = V0[i * 3 + 1], z = V0[i * 3 + 2];
          V[i * 3] = M[0] * x + M[1] * y + M[2] * z + M[9];
          V[i * 3 + 1] = M[3] * x + M[4] * y + M[5] * z + M[10];
          V[i * 3 + 2] = M[6] * x + M[7] * y + M[8] * z + M[11];
        }
      }
      const xs = this.xs, ys = this.ys;
      for (let i = 0; i < this.nV; i++) { const w = Math.max(0.35, CAM_D - V[i * 3 + 2]), k = (CAM_D / w) * r; xs[i] = cx + V[i * 3] * k; ys[i] = cy - V[i * 3 + 1] * k; }

      // aura
      const ar = r * 1.9, g = ctx.createRadialGradient(cx, cy + r * 0.1, 0, cx, cy + r * 0.1, ar);
      g.addColorStop(0, this._rgba(this.primary, (30 + 60 * amp) / 255)); g.addColorStop(0.4, this._rgba(this.primary, (16 + 34 * amp) / 255)); g.addColorStop(1, this._rgba(this.primary, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy + r * 0.1, ar, 0, Math.PI * 2); ctx.fill();

      // floor rings under the boots
      [[0.62, 0.55, 1], [0.86, 0.35, -1]].forEach(([rad, al, dir], ri) => {
        ctx.strokeStyle = this._rgba(this.primary, al * (0.55 + 0.6 * amp)); ctx.lineWidth = 1.2;
        ctx.setLineDash(ri ? [6, 9] : []); ctx.lineDashOffset = -this.t * 18 * dir;
        ctx.beginPath();
        for (let i = 0; i <= 48; i++) {
          const a = (i / 48) * Math.PI * 2, X = Math.cos(a) * rad, Z = Math.sin(a) * rad, kk = (CAM_D / Math.max(0.35, CAM_D - Z)) * r;
          const px = cx + X * kk, py = cy - (-1.31 - Z * 0.0) * kk; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // faces: cull (winding was fixed at build), light, depth-sort
      const vis = [];
      for (const f of this.F) {
        const idx = f.idx; let nx = 0, ny = 0, nz = 0, mx = 0, my = 0, mz = 0;
        for (let i = 0; i < idx.length; i++) {
          const a = idx[i], b = idx[(i + 1) % idx.length];
          const ax = V[a * 3], ay = V[a * 3 + 1], az = V[a * 3 + 2], bx = V[b * 3], by = V[b * 3 + 1], bz = V[b * 3 + 2];
          nx += (ay - by) * (az + bz); ny += (az - bz) * (ax + bx); nz += (ax - bx) * (ay + by);
          mx += ax; my += ay; mz += az;
        }
        const l = Math.hypot(nx, ny, nz) || 1e-9; nx /= l; ny /= l; nz /= l;
        if (nz <= 0.012) continue;
        vis.push([mz / idx.length, f, nx, ny, nz, my / idx.length]);
      }
      vis.sort((p, q) => p[0] - q[0]);

      ctx.lineJoin = "round";
      for (const [, f, nx, ny, nz, my] of vis) {
        const idx = f.idx;
        ctx.beginPath(); idx.forEach((a, i) => i ? ctx.lineTo(xs[a], ys[a]) : ctx.moveTo(xs[a], ys[a])); ctx.closePath();
        if (f.emit) { ctx.fillStyle = this._rgba(this.accent, 0.35 + 0.5 * (this.state === "STANDBY" ? 0.3 : 1)); ctx.fill(); continue; }
        const fres = Math.pow(clamp(1 - nz, 0, 2), 1.7), lam = clamp(nx * -0.55 + ny * 0.50 + nz * 0.52, 0, 1);
        const d = (my - this.scan) / 0.14;
        const bright = (0.24 + 0.20 * fres + 0.66 * Math.pow(lam, 1.05)) * (0.88 + 0.24 * amp) + 0.14 * Math.exp(-d * d);
        const col = this.lut[clamp(Math.floor(bright * LUT_N), 0, LUT_N - 1)];
        ctx.fillStyle = col; ctx.fill();
        ctx.strokeStyle = f.head ? this._rgba(this.primary, 0.10 + 0.22 * fres + 0.30 * Math.exp(-d * d)) : this._rgba(this.primary, 0.28 + 0.30 * fres + 0.35 * Math.exp(-d * d));
        ctx.lineWidth = f.head ? 0.7 : 1; ctx.stroke();
      }
      this._features(ctx, amp);
    }

    /* eyes, brows and the mouth opening, painted on the face landmarks (as in the Jarvis head) */
    _features(ctx, amp) {
      if (!this.m) return;
      const lm = this.m.lm, hb = this.head.base, xs = this.xs, ys = this.ys, V = this.V;
      // only when the face is turned towards the camera: use the nose-tip depth vs the head centre
      const nose = hb + 1, faceDir = V[nose * 3 + 2] - V[(hb + 9) * 3 + 2];
      const face = clamp(faceDir * 14, 0, 1); if (face < 0.05) return;
      const vis = Math.min(1 - this.blink, this.lids), P = this.primary, A = this.accent, BG = this.bg;
      const poly = (idx, close, ysc, my) => {
        ctx.beginPath();
        idx.forEach((i0, k) => { const i = hb + i0, y = ysc === undefined ? ys[i] : my + (ys[i] - my) * ysc; if (k) ctx.lineTo(xs[i], y); else ctx.moveTo(xs[i], y); });
        if (close) ctx.closePath();
      };
      for (const key of ["eye_l", "eye_r"]) {
        const idx = lm[key]; let sy = 0; for (const i of idx) sy += ys[hb + i]; const my = sy / idx.length, ysc = Math.max(0.04, vis);
        poly(idx, true, ysc, my); ctx.fillStyle = this._mix(BG, 22 / 255); ctx.fill();
        ctx.strokeStyle = this._rgba(P, 0.8 * face); ctx.lineWidth = 1.1; ctx.stroke();
        if (vis > 0.35) {
          let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
          for (const i0 of idx) { const i = hb + i0, y = my + (ys[i] - my) * ysc; x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
          const bw = x1 - x0, bh = y1 - y0, gx = (x0 + x1) / 2 + this.gaze[0] * bw * 0.16, gy = (y0 + y1) / 2 + this.gaze[1] * bh * 0.20, rad = Math.min(bh * 0.62, bw * 0.20);
          ctx.fillStyle = this._rgba(A, (0.27 + 0.23 * amp) * face * vis); ctx.beginPath(); ctx.ellipse(gx, gy, rad, Math.max(0.4, rad * vis), 0, 0, 7); ctx.fill();
          ctx.fillStyle = this._rgba(A, 0.96 * face * vis); ctx.beginPath(); ctx.ellipse(gx, gy, rad * 0.45, Math.max(0.3, rad * 0.45 * vis), 0, 0, 7); ctx.fill();
        }
      }
      ctx.lineWidth = 1.3; ctx.strokeStyle = this._rgba(P, 0.55 * face);
      for (const key of ["brow_l", "brow_r"]) { poly(lm[key], false); ctx.stroke(); }
      const inner = lm.lips_in; let y0 = 1e9, y1 = -1e9; for (const i of inner) { y0 = Math.min(y0, ys[hb + i]); y1 = Math.max(y1, ys[hb + i]); }
      if (this.mouth > 0.02) {
        poly(inner, true); ctx.fillStyle = this._mix(BG, (16 + 26 * this.mouth) / 255); ctx.fill();
        const up = this.lipUp, th = (y1 - y0) * 0.30;
        ctx.beginPath(); up.forEach((i0, k) => { const i = hb + i0; if (k) ctx.lineTo(xs[i], ys[i]); else ctx.moveTo(xs[i], ys[i]); });
        for (let k = up.length - 1; k >= 0; k--) { const i = hb + up[k]; ctx.lineTo(xs[i], ys[i] + th); }
        ctx.closePath(); ctx.fillStyle = this._mix(BG, (150 + 60 * this.mouth) / 255); ctx.fill();
      }
      poly(inner, true); ctx.lineWidth = 1.1; ctx.strokeStyle = this._rgba(P, (0.6 + 0.3 * this.mouth) * face); ctx.stroke();
      poly(lm.lips_out, true); ctx.lineWidth = 1; ctx.strokeStyle = this._rgba(P, 0.45 * face); ctx.stroke();
    }

    _loop(now) {
      const dt = (now - this._last) / 1000; this._last = now;
      if (this.ready) { try { this._step(dt); this._draw(); } catch (e) { console.error("soldier", e); this.ready = false; } }
      requestAnimationFrame(this._loop);
    }
  }
  window.HoloSoldier = HoloSoldier;
})();
