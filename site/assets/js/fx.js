/* fx.js — ฉากหลัง (ดาว + ฟองอากาศ 2D) และ "ลูกแก้วน้ำ" 3D (WebGL fragment shader ล้วน ไม่มีไลบรารี)
   ประหยัดเครื่อง: จำกัด DPR, ลดความละเอียดเองเมื่อเฟรมช้า, หยุดเมื่อมองไม่เห็น/แท็บซ่อน/ปิด Motion
   เครื่องที่ไม่มี WebGL → ลูกแก้ว CSS (.orb-fallback) แทน */
(function () {
  /* =====================================================================
     Sky — ดาวกะพริบ + ฟองอากาศลอยขึ้น (parallax ตามการเลื่อน)
     ===================================================================== */
  const Sky = (function () {
    let cv, ctx, W = 0, H = 0, dpr = 1, stars = [], bubbles = [], raf = 0, motion = true, last = 0;
    const mkStar = () => ({ x: Math.random(), y: Math.random(), r: Math.random() < 0.85 ? 1 : 1.8, a: 0.25 + Math.random() * 0.6, sp: 0.6 + Math.random() * 2.2, ph: Math.random() * 6.3, d: 0.3 + Math.random() * 1.2, c: Math.random() < 0.7 ? 0 : 1 });
    const mkBubble = (spread) => {
      const r = 3 + Math.random() * 13;
      return { x: Math.random() * W, y: spread ? Math.random() * H : H + r * 2 + Math.random() * 120, r, sp: 0.12 + Math.random() * 0.45, ph: Math.random() * 6.3, wr: 0.4 + Math.random() * 1.2, a: 0.12 + Math.random() * 0.3 };
    };
    function resize() {
      if (!cv) return;
      const nw = innerWidth, nh = innerHeight;
      const big = Math.abs(nw - W) > 2 || Math.abs(nh - H) > 140 || !stars.length;
      dpr = Math.min(1.5, window.devicePixelRatio || 1);
      W = nw; H = nh;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (big) {
        stars = Array.from({ length: Math.min(190, Math.floor((W * H) / 6500)) }, mkStar);
        bubbles = Array.from({ length: Math.min(24, Math.max(8, Math.floor(W / 60))) }, () => mkBubble(true));
      }
      if (!motion) draw(performance.now(), true);
    }
    const COLORS = ['rgba(210,250,255,1)', 'rgba(140,240,220,1)'];
    function draw(now, still) {
      ctx.clearRect(0, 0, W, H);
      const sy = window.scrollY || 0;
      for (let k = 0; k < 2; k++) {
        ctx.fillStyle = COLORS[k];
        for (const s of stars) {
          if (s.c !== k) continue;
          const y = (((s.y * H - sy * s.d * 0.05) % H) + H) % H;
          ctx.globalAlpha = still ? s.a * 0.8 : s.a * (0.55 + 0.45 * Math.sin(now * 0.001 * s.sp + s.ph));
          ctx.fillRect(s.x * W, y, s.r, s.r);
        }
      }
      ctx.lineWidth = 1;
      for (const b of bubbles) {
        if (!still) {
          b.y -= b.sp; b.ph += 0.012;
          if (b.y < -b.r * 2) Object.assign(b, mkBubble(false));
        }
        const x = b.x + Math.sin(b.ph) * b.wr * 10;
        if (b.y > H + b.r) continue;
        ctx.globalAlpha = b.a;
        ctx.strokeStyle = 'rgba(94,234,212,1)';
        ctx.beginPath(); ctx.arc(x, b.y, b.r, 0, 6.2832); ctx.stroke();
        ctx.globalAlpha = Math.min(1, b.a * 1.4);
        ctx.fillStyle = 'rgba(220,255,250,1)';
        ctx.beginPath(); ctx.arc(x - b.r * 0.35, b.y - b.r * 0.35, Math.max(0.8, b.r * 0.18), 0, 6.2832); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    function loop(now) {
      raf = 0;
      if (!motion || document.hidden) return;
      if (now - last >= 32) { last = now; draw(now, false); }
      raf = requestAnimationFrame(loop);
    }
    function start() { if (!raf && motion && !document.hidden) raf = requestAnimationFrame(loop); }
    let deb;
    return {
      init(canvas, m) {
        cv = canvas; if (!cv || !cv.getContext) return;
        ctx = cv.getContext('2d');
        motion = !!m;
        resize();
        window.addEventListener('resize', () => { clearTimeout(deb); deb = setTimeout(resize, 120); });
        window.addEventListener('scroll', () => { if (!motion) draw(performance.now(), true); }, { passive: true });
        document.addEventListener('visibilitychange', start);
        if (motion) start(); else draw(performance.now(), true);
      },
      setMotion(on) {
        motion = !!on;
        if (!ctx) return;
        if (motion) start(); else { cancelAnimationFrame(raf); raf = 0; draw(performance.now(), true); }
      },
    };
  })();

  /* =====================================================================
     Orb — ลูกแก้วน้ำ 3D + วงแหวนคลื่น (ray-sphere ใน fragment shader)
     ===================================================================== */
  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes; uniform float uTime; uniform float uEnergy; uniform float uPulse; uniform vec2 uRot;
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1.0,0.0,0.0)), f.x), mix(hash(i + vec3(0.0,1.0,0.0)), hash(i + vec3(1.0,1.0,0.0)), f.x), f.y),
             mix(mix(hash(i + vec3(0.0,0.0,1.0)), hash(i + vec3(1.0,0.0,1.0)), f.x), mix(hash(i + vec3(0.0,1.0,1.0)), hash(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float s = 0.0; float a = 0.5; for (int i = 0; i < 4; i++){ s += a * noise(p); p = p * 2.02 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y));
  float R = 0.5; float t = uTime;
  float r = length(p);
  vec3 C = vec3(0.0); float A = 0.0;
  // ออร่ารอบลูกแก้ว
  float g = exp(-max(r - R, 0.0) * 5.5) * smoothstep(R * 0.92, R, r);
  float ga = g * (0.30 + 0.25 * uEnergy + 0.45 * uPulse);
  C = vec3(0.10, 0.80, 0.86) * ga; A = ga;
  // วงแหวน (วงรีเอียง)
  float ca = cos(-0.34); float sa = sin(-0.34);
  vec2 q = vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y);
  vec2 e = vec2(q.x, q.y / 0.25);
  float er = length(e) / R;
  float band = smoothstep(1.30, 1.36, er) * (1.0 - smoothstep(1.80, 1.90, er));
  float stripes = 0.55 + 0.25 * sin(er * 64.0) + 0.2 * sin(er * 21.0 + 1.3);
  float ang = atan(e.y, e.x);
  float spark = pow(max(0.0, sin(ang * 36.0 - t * (1.6 + 3.0 * uEnergy))), 24.0);
  vec3 rc = mix(vec3(0.22, 0.88, 0.92), vec3(0.60, 0.46, 1.0), smoothstep(1.35, 1.85, er));
  float ra = band * (0.28 + 0.32 * stripes + 0.55 * spark) * (0.85 + 0.3 * uPulse);
  ra = clamp(ra, 0.0, 1.0);
  if (q.y >= 0.0) { C = rc * ra + C * (1.0 - ra); A = ra + A * (1.0 - ra); }
  // ลูกแก้ว
  if (r < R) {
    float z = sqrt(R * R - r * r);
    vec3 n = normalize(vec3(p, z));
    float ay = t * 0.12 + uRot.x; float ax = 0.35 + uRot.y;
    mat3 ry = mat3(cos(ay), 0.0, -sin(ay), 0.0, 1.0, 0.0, sin(ay), 0.0, cos(ay));
    mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cos(ax), sin(ax), 0.0, -sin(ax), cos(ax));
    vec3 sp = ry * rx * n;
    float w1 = fbm(sp * 2.2 + vec3(0.0, t * 0.04, 0.0));
    float w = fbm(sp * 3.0 + vec3(w1 * 1.8) + vec3(t * 0.03));
    vec3 c = mix(vec3(0.02, 0.07, 0.18), vec3(0.03, 0.42, 0.55), smoothstep(0.30, 0.62, w));
    c = mix(c, vec3(0.30, 0.95, 0.82), smoothstep(0.58, 0.80, w) * 0.85);
    c = mix(c, vec3(0.40, 0.25, 0.85), (1.0 - smoothstep(-0.7, 0.1, sp.y)) * 0.45);
    float caust = pow(1.0 - abs(sin(w * 26.0 + t * 0.8)), 10.0);
    c += vec3(0.35, 1.0, 0.9) * caust * 0.22 * (0.6 + uEnergy);
    vec3 L = normalize(vec3(-0.55, 0.6, 0.65));
    c *= 0.35 + 0.85 * max(dot(n, L), 0.0);
    c += vec3(0.85, 1.0, 1.0) * pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 36.0) * 0.7;
    c += vec3(0.25, 0.92, 1.0) * pow(1.0 - n.z, 2.6) * (0.9 + 0.6 * uEnergy + 0.8 * uPulse);
    c *= 1.0 + 0.25 * uEnergy + 0.45 * uPulse;
    float s = 1.0 - smoothstep(R - 0.012, R, r);
    C = c * s + C * (1.0 - s); A = s + A * (1.0 - s);
  }
  if (q.y < 0.0) { C = rc * ra + C * (1.0 - ra); A = ra + A * (1.0 - ra); }
  gl_FragColor = vec4(C, A);
}`;

  const Orb = (function () {
    let canvas = null, gl = null, uni = {}, ok = null, host = null, ro = null, io = null;
    let visible = false, raf = 0, busy = false, energy = 0, pulse = 0;
    let rot = [0, 0], vel = 0, drag = null, tAcc = 0, last = 0, scale = 1, slow = 0, motion = true;

    function init() {
      canvas = document.createElement('canvas');
      canvas.className = 'orb-canvas';
      try {
        gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
      } catch (e) { gl = null; }
      if (!gl) { ok = false; return; }
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      try {
        const prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'p');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        ['uRes', 'uTime', 'uEnergy', 'uPulse', 'uRot'].forEach((n) => { uni[n] = gl.getUniformLocation(prog, n); });
        gl.clearColor(0, 0, 0, 0);
        ok = true;
      } catch (e) {
        if (window.console) console.warn('[orb] shader', e && e.message);
        ok = false; gl = null; return;
      }
      canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); ok = false; stop(); if (host) fallback(host); });
      // ลากเพื่อหมุน (แนวตั้งยังเลื่อนหน้าได้ — touch-action: pan-y)
      canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; vel = 0; try { canvas.setPointerCapture(e.pointerId); } catch (er) {} });
      canvas.addEventListener('pointermove', (e) => {
        if (!drag || drag.id !== e.pointerId) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        rot[0] += dx * 0.009; rot[1] = Math.max(-0.6, Math.min(0.6, rot[1] + dy * 0.004));
        vel = dx * 0.009;
        if (!motion) render(performance.now());
      });
      const end = () => { drag = null; };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
    }

    function fallback(el) {
      if (!el.querySelector('.orb-fallback')) el.insertAdjacentHTML('beforeend', '<div class="orb-fallback" aria-hidden="true"><i></i></div>');
      el.classList.add('no-webgl');
    }

    function resize() {
      if (!host || !gl) return;
      const r = host.getBoundingClientRect();
      const dpr = Math.min(1.5, window.devicePixelRatio || 1) * scale;
      const w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
      const k = Math.min(1, 900 / Math.max(w, h));
      canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (!motion || !raf) render(performance.now());
    }

    function render(now) {
      if (!gl) return;
      gl.uniform2f(uni.uRes, canvas.width, canvas.height);
      gl.uniform1f(uni.uTime, tAcc);
      gl.uniform1f(uni.uEnergy, energy);
      gl.uniform1f(uni.uPulse, pulse);
      gl.uniform2f(uni.uRot, rot[0], rot[1]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function frame(now) {
      raf = 0;
      if (!host || !visible || document.hidden || !motion) return;
      const dt = Math.min(0.1, last ? (now - last) / 1000 : 0.016);
      // เครื่องช้า (>34ms/เฟรม ติดกัน) → ลดความละเอียดลงทีละขั้น
      if (last && now - last > 34) { if (++slow > 40 && scale > 0.55) { scale = Math.max(0.55, scale * 0.82); slow = 0; resize(); } } else slow = Math.max(0, slow - 1);
      last = now;
      energy += ((busy ? 1 : 0) - energy) * Math.min(1, dt * 2.5);
      pulse *= Math.pow(0.04, dt);
      tAcc += dt * (1 + energy * 2.2 + pulse * 1.5);
      if (!drag) { rot[0] += vel; vel *= Math.pow(0.05, dt); rot[1] *= Math.pow(0.4, dt); }
      render(now);
      raf = requestAnimationFrame(frame);
    }
    function start() { if (!raf && ok && host && visible && motion && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } }
    function stop() { cancelAnimationFrame(raf); raf = 0; }

    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });

    return {
      mount(el) {
        if (!el) return;
        this.detach();
        host = el;
        if (ok === null) init();
        if (!ok) { fallback(el); return; }
        el.appendChild(canvas);
        if (!ro && 'ResizeObserver' in window) ro = new ResizeObserver(() => resize());
        if (ro) ro.observe(el);
        if (!io && 'IntersectionObserver' in window) io = new IntersectionObserver((ents) => { visible = ents[ents.length - 1].isIntersecting; if (visible) start(); else stop(); });
        if (io) io.observe(el); else visible = true;
        resize();
        render(performance.now());
        start();
      },
      detach() {
        stop();
        if (ro && host) ro.unobserve(host);
        if (io && host) io.unobserve(host);
        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        host = null; visible = false;
      },
      setBusy(b) { busy = !!b; },
      pulse() { pulse = Math.min(1.4, pulse + 1); if (!motion && host) render(performance.now()); },
      setMotion(on) { motion = !!on; if (motion) start(); else { stop(); if (host) render(performance.now()); } },
      get supported() { return ok; },
    };
  })();

  Orb.setMotion(document.documentElement.getAttribute('data-motion') === 'on');
  window.FX = { Sky, Orb };
})();
