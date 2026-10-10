/* Holographic head - a browser port of Mark-LIII's core/avatar.py (same mesh, same lighting, same face animation). */
(function () {
  const CAM_D = 4.6, LUT_N = 192, BUCKETS = 4, MIN_ALPHA = 0.05, BROW_LIFT = 0.14;
  const TAU_OPEN = 0.022, TAU_SHUT = 0.012, TAU_REST = 0.055;
  const rate = (dt, tau) => 1 - Math.exp(-dt / tau);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rnd = (a, b) => a + Math.random() * (b - a);

  class HoloAvatar {
    /**
     * @param canvas      target <canvas>
     * @param getLevel    () => 0..1 loudness of the assistant's own voice (drives the jaw)
     * @param getMic      () => 0..1 loudness of the microphone (drives the glow while listening)
     */
    constructor(canvas, getLevel, getMic) {
      this.cv = canvas; this.ctx = canvas.getContext("2d");
      this.getLevel = getLevel || (() => 0); this.getMic = getMic || (() => 0);
      this.primary = [0, 200, 235]; this.accent = [45, 215, 255]; this.bg = [2, 12, 20];
      this.state = "STANDBY";
      this.t = 0; this.sway = 0; this.yaw = 0; this.pitch = 0;
      this.mouth = 0; this.glow = 0; this.scan = -1.6; this.blink = 0; this.blinkAt = 3;
      this.vPeak = 0.18; this.ampSlow = 0; this.expr = 0; this.exprTgt = 0; this.exprAt = 0; this.brow = 0; this.emph = 0;
      this.gaze = [0, 0]; this.gazeTgt = [0, 0]; this.gazeAt = 0;
      this.gazeBias = [0, 0]; this.biasTgt = [0, 0]; this.biasAt = 0; this.lids = 0.22; this.browBias = 0;
      this.ready = false;
      this.lut = null;
      fetch("/static/head.json").then(r => r.json()).then(m => this._init(m));
      this._last = performance.now();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    _init(m) {
      const n = m.verts.length;
      this.n = n;
      this.v0 = Float32Array.from(m.verts.flat());
      this.n0 = Float32Array.from(m.normals.flat());
      this.jawW = Float32Array.from(m.jaw); this.browW = Float32Array.from(m.brow); this.lipsW = Float32Array.from(m.lips);
      this.fade = Float32Array.from(m.fade);
      this.faces = Int32Array.from(m.faces.flat()); this.nf = m.faces.length;
      this.fgroup = Int32Array.from(m.face_group);
      this.edges = Int32Array.from(m.edges.flat()); this.ne = m.edges.length;
      this.lipC = m.lip_centre; this.jawMax = m.jaw_max; this.pivot = m.jaw_pivot;
      this.lm = m.landmarks;
      const li = m.landmarks.lips_in;
      this.lipUp = li.slice(10).concat(li.slice(0, 1));
      this.span = m.span ? m.span[0] - m.span[1] : 2.322;
      this.v = new Float32Array(n * 3); this.nv = new Float32Array(n * 3);
      this.xs = new Float32Array(n); this.ys = new Float32Array(n);
      this.fOrder = [];
      this.ready = true;
    }

    setState(s) { this.state = (s || "STANDBY").toUpperCase(); }

    /* ---------- animation (port of HoloAvatar.step) ---------- */
    _step(dt) {
      dt = clamp(dt, 0.001, 0.1);
      this.t += dt; const t = this.t;
      const st = this.state;
      const outLv = this.getLevel(), micLv = this.getMic();
      const speaking = st === "SPEAKING" || outLv > 0.03;
      const asleep = st === "STANDBY", thinking = st === "THINKING";

      this.sway += dt * (speaking ? 1.25 : 1.0);
      const s = this.sway;
      this.yaw = 0.26 * Math.sin(s * 0.31) + 0.09 * Math.sin(s * 0.73 + 1.3);
      this.pitch = 0.060 * Math.sin(s * 0.23 + 0.7) + 0.024 * Math.sin(s * 0.61);

      // jaw: driven by the real loudness of the voice being played
      let target = 0;
      if (speaking) {
        this.vPeak = Math.max(outLv, this.vPeak - dt * 0.55);
        const ref = Math.max(0.18, this.vPeak);
        const q = (outLv - 0.10 * ref) / (ref * 0.90);
        target = Math.min(1, Math.pow(Math.max(0, Math.min(1, q)), 0.85));
      }
      const tau = target > this.mouth ? TAU_OPEN : (speaking ? TAU_SHUT : TAU_REST);
      this.mouth += (target - this.mouth) * rate(dt, tau);
      if (this.mouth < 0.002) this.mouth = 0;

      this.emph += (this.mouth - this.emph) * rate(dt, this.mouth > this.emph ? 0.055 : 0.32);
      this.pitch -= this.emph * 0.028;
      this.yaw += 0.018 * Math.sin(t * 1.7) * this.emph;

      const env = speaking ? outLv : 0;
      this.ampSlow += (env - this.ampSlow) * rate(dt, env > this.ampSlow ? 0.16 : 0.36);
      if (speaking) {
        if (t >= this.exprAt) { this.exprTgt = rnd(-0.35, 1.0); this.exprAt = t + 1.1 + 2.0 * Math.random(); }
      } else { this.exprTgt = 0; this.exprAt = t + 0.8; }
      this.expr += (this.exprTgt - this.expr) * 0.075;
      const browT = 0.55 * this.ampSlow + 0.60 * this.expr + this.browBias;
      this.brow += (clamp(browT, -0.4, 1.2) - this.brow) * 0.20;

      let browBias, lidTgt;
      if (thinking) {
        if (t >= this.biasAt) {
          this.biasTgt = [(Math.random() < 0.5 ? -1 : 1) * rnd(0.45, 0.8), rnd(0.25, 0.55)];
          this.biasAt = t + 1.4 + 1.6 * Math.random();
        }
        browBias = -0.28; lidTgt = 0.94;
      } else if (asleep) { this.biasTgt = [0, -0.25]; browBias = -0.05; lidTgt = 0.22; }
      else { this.biasTgt = [0, 0]; this.biasAt = 0; browBias = st === "LISTENING" ? 0.10 : 0; lidTgt = 1.0; }
      for (let i = 0; i < 2; i++) this.gazeBias[i] += (this.biasTgt[i] - this.gazeBias[i]) * 0.06;
      this.lids += (lidTgt - this.lids) * 0.08;
      this.browBias += (browBias - this.browBias) * 0.06;

      if (t >= this.gazeAt) {
        const reach = speaking ? 0.9 : thinking ? 0.35 : 0.55;
        this.gazeTgt = [rnd(-1, 1) * reach, rnd(-1, 1) * reach * 0.55];
        this.gazeAt = t + (speaking ? 0.55 + 1.7 * Math.random() : thinking ? 1.8 + 2.4 * Math.random() : 1.3 + 2.8 * Math.random());
      }
      for (let i = 0; i < 2; i++) this.gaze[i] += (clamp(this.gazeTgt[i] + this.gazeBias[i], -1, 1) - this.gaze[i]) * 0.30;

      const amp = speaking ? outLv : (st === "LISTENING" ? micLv * 0.8 : 0);
      this.glow += (amp - this.glow) * (amp > this.glow ? 0.35 : 0.10);
      this.scan += dt * (0.55 + 1.5 * this.glow);
      if (this.scan > 1.35) this.scan = -1.75;

      if (this.blink > 0) this.blink = Math.max(0, this.blink - dt * 8.5);
      else if (t >= this.blinkAt) {
        if (asleep) this.blinkAt = t + 6.0;
        else { this.blink = 1.0; this.blinkAt = t + (thinking ? 5.5 : 3.4) + 3.1 * Math.random(); }
      }
    }

    /* ---------- posing ---------- */
    _pose() {
      const n = this.n, v = this.v, nv = this.nv, v0 = this.v0, n0 = this.n0;
      v.set(v0);
      if (Math.abs(this.brow) > 0.004) {
        const k = this.brow * BROW_LIFT;
        for (let i = 0; i < n; i++) v[i * 3 + 1] += this.browW[i] * k;
      }
      if (this.mouth > 0.004) {
        const [, py, pz] = this.pivot, mj = this.mouth * this.jawMax;
        for (let i = 0; i < n; i++) {
          const w = this.jawW[i]; if (!w) continue;
          const ang = w * mj, ca = Math.cos(ang), sa = Math.sin(ang);
          const dy = v[i * 3 + 1] - py, dz = v[i * 3 + 2] - pz;
          v[i * 3 + 1] = py + dy * ca - dz * sa;
          v[i * 3 + 2] = pz + dy * sa + dz * ca;
        }
      }
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      const m00 = cy, m01 = 0, m02 = sy, m10 = sp * sy, m11 = cp, m12 = -sp * cy, m20 = -cp * sy, m21 = sp, m22 = cp * cy;
      for (let i = 0; i < n; i++) {
        const j = i * 3, x = v[j], y = v[j + 1], z = v[j + 2];
        v[j] = m00 * x + m01 * y + m02 * z; v[j + 1] = m10 * x + m11 * y + m12 * z; v[j + 2] = m20 * x + m21 * y + m22 * z;
        const a = n0[j], b = n0[j + 1], c = n0[j + 2];
        nv[j] = m00 * a + m01 * b + m02 * c; nv[j + 1] = m10 * a + m11 * b + m12 * c; nv[j + 2] = m20 * a + m21 * b + m22 * c;
      }
    }

    _lutBuild() {
      const [br, bg_, bb] = this.bg, [pr, pg, pb] = this.primary;
      this.lut = [];
      for (let i = 0; i < LUT_N; i++) {
        const f = (i + 0.5) / LUT_N;
        this.lut.push(`rgb(${Math.round(br + (pr - br) * f)},${Math.round(bg_ + (pg - bg_) * f)},${Math.round(bb + (pb - bb) * f)})`);
      }
    }
    _mix(base, a) {  // primary at alpha a (0..1) pre-mixed onto base [r,g,b]
      const [pr, pg, pb] = this.primary;
      return `rgb(${Math.round(base[0] + (pr - base[0]) * a)},${Math.round(base[1] + (pg - base[1]) * a)},${Math.round(base[2] + (pb - base[2]) * a)})`;
    }
    _rgba(c, a) { return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a))})`; }

    /* ---------- drawing ---------- */
    _draw() {
      const cv = this.cv, ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!this.ready) return;
      if (!this.lut) this._lutBuild();

      const amp = this.glow;
      // fit: crown at the top, neck at the bottom
      const r = Math.min(H * 0.94 / this.span, W * 0.46);
      const cx = W / 2, cy = H * 0.03 + r * 1.0;
      this._pose();
      const v = this.v, nv = this.nv, xs = this.xs, ys = this.ys, n = this.n;

      // aura
      const ar = r * 1.95;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, ar);
      g.addColorStop(0, this._rgba(this.primary, (34 + 66 * amp) / 255));
      g.addColorStop(0.38, this._rgba(this.primary, (20 + 40 * amp) / 255));
      g.addColorStop(1, this._rgba(this.primary, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, ar, 0, Math.PI * 2); ctx.fill();

      for (let i = 0; i < n; i++) {
        const w = Math.max(0.35, CAM_D - v[i * 3 + 2]), k = (CAM_D / w) * r;
        xs[i] = cx + v[i * 3] * k; ys[i] = cy - v[i * 3 + 1] * k;
      }
      this._surface(ctx, amp);
      this._wire(ctx, amp);
      this._features(ctx, r, amp);
    }

    _surface(ctx, amp) {
      const f = this.faces, v = this.v, nv = this.nv, xs = this.xs, ys = this.ys, fade = this.fade;
      const vis = [];
      for (let t = 0; t < this.nf; t++) {
        const a = f[t * 3], b = f[t * 3 + 1], c = f[t * 3 + 2];
        const ux = v[b * 3] - v[a * 3], uy = v[b * 3 + 1] - v[a * 3 + 1], uz = v[b * 3 + 2] - v[a * 3 + 2];
        const wx = v[c * 3] - v[a * 3], wy = v[c * 3 + 1] - v[a * 3 + 1], wz = v[c * 3 + 2] - v[a * 3 + 2];
        let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nzz = ux * wy - uy * wx;
        const l = Math.hypot(nx, ny, nzz) || 1e-9; nx /= l; ny /= l; nzz /= l;
        const dot = nx * (nv[a * 3] + nv[b * 3] + nv[c * 3]) + ny * (nv[a * 3 + 1] + nv[b * 3 + 1] + nv[c * 3 + 1]) + nzz * (nv[a * 3 + 2] + nv[b * 3 + 2] + nv[c * 3 + 2]);
        if (dot < 0) { nx = -nx; ny = -ny; nzz = -nzz; }
        if (nzz <= 0.015) continue;
        const area = Math.abs((xs[b] - xs[a]) * (ys[c] - ys[a]) - (xs[c] - xs[a]) * (ys[b] - ys[a]));
        if (area <= 3.0) continue;
        const fres = Math.pow(Math.min(2, Math.max(0, 1 - nzz)), 1.7);
        const lam = Math.max(0, Math.min(1, nx * -0.55 + ny * 0.50 + nzz * 0.52));
        let bright = 0.26 + 0.20 * fres + 0.66 * Math.pow(lam, 1.05);
        bright *= (fade[a] + fade[b] + fade[c]) / 3;
        bright *= 0.88 + 0.24 * amp;
        const idx = Math.max(0, Math.min(LUT_N - 1, Math.floor(bright * LUT_N)));
        const fz = (v[a * 3 + 2] + v[b * 3 + 2] + v[c * 3 + 2]) / 3;
        vis.push([this.fgroup[t] * 1000 + fz, a, b, c, idx]);
      }
      vis.sort((p, q) => p[0] - q[0]);
      ctx.lineWidth = 0.7; ctx.lineJoin = "round";
      for (const [, a, b, c, idx] of vis) {
        const col = this.lut[idx];
        ctx.fillStyle = col; ctx.strokeStyle = col;
        ctx.beginPath(); ctx.moveTo(xs[a], ys[a]); ctx.lineTo(xs[b], ys[b]); ctx.lineTo(xs[c], ys[c]); ctx.closePath();
        ctx.fill(); ctx.stroke();   // stroke in the same colour hides anti-aliasing seams between facets
      }
    }

    _wire(ctx, amp) {
      const nv = this.nv, v = this.v, n = this.n, xs = this.xs, ys = this.ys;
      const va = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const nz = nv[i * 3 + 2];
        if (nz > -0.05) {
          const fres = Math.pow(Math.abs(1 - Math.abs(nz)), 1.5);
          const d = (v[i * 3 + 1] - this.scan) / 0.13;
          va[i] = (0.10 + 0.42 * fres + 0.30 * Math.exp(-d * d)) * this.fade[i] * (0.80 + 0.45 * amp);
        }
      }
      const buckets = Array.from({length: BUCKETS}, () => []);
      for (let e = 0; e < this.ne; e++) {
        const a = this.edges[e * 2], b = this.edges[e * 2 + 1];
        const ea = 0.5 * (va[a] + va[b]);
        if (ea <= MIN_ALPHA) continue;
        buckets[Math.max(0, Math.min(BUCKETS - 1, Math.floor(ea * BUCKETS)))].push(a, b);
      }
      const skin = [Math.round(this.bg[0] + (this.primary[0] - this.bg[0]) * 0.52), Math.round(this.bg[1] + (this.primary[1] - this.bg[1]) * 0.52), Math.round(this.bg[2] + (this.primary[2] - this.bg[2]) * 0.52)];
      ctx.lineWidth = 1;
      for (let bi = 0; bi < BUCKETS; bi++) {
        const list = buckets[bi]; if (!list.length) continue;
        ctx.strokeStyle = this._mix(skin, Math.min(1, (bi + 0.5) / BUCKETS) * 0.75);
        ctx.beginPath();
        for (let i = 0; i < list.length; i += 2) { ctx.moveTo(xs[list[i]], ys[list[i]]); ctx.lineTo(xs[list[i + 1]], ys[list[i + 1]]); }
        ctx.stroke();
      }
    }

    _poly(idx, close, yscale, my) {
      const ctx = this.ctx, xs = this.xs, ys = this.ys;
      ctx.beginPath();
      idx.forEach((i, k) => {
        const y = yscale === undefined ? ys[i] : my + (ys[i] - my) * yscale;
        if (k) ctx.lineTo(xs[i], y); else ctx.moveTo(xs[i], y);
      });
      if (close) ctx.closePath();
    }

    _features(ctx, r, amp) {
      const face = Math.pow(Math.max(0, Math.cos(this.yaw) * Math.cos(this.pitch)), 2);
      if (face < 0.02) return;
      const lm = this.lm, xs = this.xs, ys = this.ys;
      const vis = Math.min(1 - this.blink, this.lids);
      const P = this.primary, A = this.accent, BG = this.bg;

      for (const key of ["eye_l", "eye_r"]) {
        const idx = lm[key];
        let sumy = 0; for (const i of idx) sumy += ys[i];
        const my = sumy / idx.length, ysc = Math.max(0.04, vis);
        this._poly(idx, true, ysc, my);
        ctx.fillStyle = this._mix(BG, 22 / 255); ctx.fill();
        ctx.strokeStyle = this._rgba(P, 210 * face / 255); ctx.lineWidth = 1.3; ctx.stroke();
        if (vis > 0.35) {
          let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
          for (const i of idx) { const y = my + (ys[i] - my) * ysc; x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
          const bw = x1 - x0, bh = y1 - y0;
          const gx = (x0 + x1) / 2 + this.gaze[0] * bw * 0.16, gy = (y0 + y1) / 2 + this.gaze[1] * bh * 0.20;
          const rad = Math.min(bh * 0.62, bw * 0.20);
          ctx.fillStyle = this._rgba(A, (70 + 60 * amp) * face * vis / 255);
          ctx.beginPath(); ctx.ellipse(gx, gy, rad, Math.max(0.5, rad * vis), 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = this._rgba(A, 245 * face * vis / 255);
          ctx.beginPath(); ctx.ellipse(gx, gy, rad * 0.42, Math.max(0.3, rad * 0.42 * vis), 0, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.lineWidth = 1.7; ctx.strokeStyle = this._rgba(P, 150 * face / 255);
      for (const key of ["brow_l", "brow_r"]) { this._poly(lm[key], false); ctx.stroke(); }

      const inner = lm.lips_in;
      let y0 = 1e9, y1 = -1e9; for (const i of inner) { y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]); }
      const openH = y1 - y0;
      if (this.mouth > 0.02) {
        this._poly(inner, true); ctx.fillStyle = this._mix(BG, (16 + 26 * this.mouth) / 255); ctx.fill();
        const up = this.lipUp, th = openH * 0.30;
        ctx.beginPath();
        up.forEach((i, k) => { if (k) ctx.lineTo(xs[i], ys[i]); else ctx.moveTo(xs[i], ys[i]); });
        for (let k = up.length - 1; k >= 0; k--) ctx.lineTo(xs[up[k]], ys[up[k]] + th);
        ctx.closePath(); ctx.fillStyle = this._mix(BG, (150 + 60 * this.mouth) / 255); ctx.fill();
        this._poly(inner, true); ctx.fillStyle = this._rgba(A, 40 * this.mouth * face / 255); ctx.fill();
      }
      this._poly(inner, true); ctx.lineWidth = 1.3; ctx.strokeStyle = this._rgba(P, (150 + 70 * this.mouth) * face / 255); ctx.stroke();
      this._poly(lm.lips_out, true); ctx.lineWidth = 1.1; ctx.strokeStyle = this._rgba(P, 110 * face / 255); ctx.stroke();
    }

    _loop(now) {
      const dt = (now - this._last) / 1000; this._last = now;
      if (this.ready) { try { this._step(dt); this._draw(); } catch (e) { console.error("avatar", e); this.ready = false; } }
      requestAnimationFrame(this._loop);
    }
  }
  window.HoloAvatar = HoloAvatar;
})();
