/* fx.js — ฉากหลัง (ดาว + ฟองอากาศ 2D) และ "กีตาร์น้ำ" 3D (ray-marched SDF ใน WebGL fragment shader ล้วน ไม่มีไลบรารี)
   ประหยัดเครื่อง: จำกัด DPR, ลดความละเอียดเองเมื่อเฟรมช้า, หยุดเมื่อมองไม่เห็น/แท็บซ่อน/ปิด Motion
   เครื่องที่ไม่มี WebGL → ภาพกีตาร์ CSS (.orb-fallback) แทน · ชื่อโมดูล Orb คงไว้ (เดิมเป็นลูกแก้ว) */
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
     Orb — กีตาร์น้ำ 3D: ตัว+คอ+หัว+สะพาน (SDF) · สาย 6 เส้นสั่นตอนดีด · เฟร็ต · ช่องเสียง · วงคลื่นเสียง
     ===================================================================== */
  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';
  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes; uniform float uTime; uniform float uEnergy; uniform float uPulse; uniform vec2 uRot;
uniform float uLean; uniform float uZoom;
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1.0,0.0,0.0)), f.x), mix(hash(i + vec3(0.0,1.0,0.0)), hash(i + vec3(1.0,1.0,0.0)), f.x), f.y),
             mix(mix(hash(i + vec3(0.0,0.0,1.0)), hash(i + vec3(1.0,0.0,1.0)), f.x), mix(hash(i + vec3(0.0,1.0,1.0)), hash(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float s = 0.0; float a = 0.5; for (int i = 0; i < 3; i++){ s += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float sdBox(vec3 p, vec3 b){ vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }
/* body: big lower bout + small upper bout blended into a waist, 0.15 thick */
float body2(vec2 p){ return smin(length(p - vec2(0.0, -0.30)) - 0.40, length(p - vec2(0.0, 0.16)) - 0.29, 0.20); }
float sdBody(vec3 p){ float d = body2(p.xy); vec2 w = vec2(d, abs(p.z) - 0.075); return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - 0.02; }
float sdNeck(vec3 p){ return sdBox(p - vec3(0.0, 0.82, 0.055), vec3(0.052, 0.42, 0.03)) - 0.008; }
float sdHead(vec3 p){ return sdBox(p - vec3(0.0, 1.37, 0.045), vec3(0.085, 0.14, 0.022)) - 0.012; }
float sdBridge(vec3 p){ return sdBox(p - vec3(0.0, -0.40, 0.10), vec3(0.11, 0.02, 0.012)); }
float mapG(vec3 p){ return min(min(sdBody(p), sdNeck(p)), min(sdHead(p), sdBridge(p))); }
mat3 rotX(float a){ float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rotY(float a){ float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotZ(float a){ float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y)) / uZoom;
  float spin = 0.85 * sin(uTime * 0.45) + uRot.x;
  mat3 R = rotX(-(0.16 + uRot.y)) * rotY(-spin) * rotZ(-uLean);
  vec3 ro = R * vec3(0.0, 0.0, 3.6);
  vec3 rd = R * normalize(vec3(uv, -2.75));
  ro.y += 0.395;
  vec3 C = vec3(0.0); float A = 0.0;
  float minD = 9.0, tHit = -1.0;
  vec3 oc = ro - vec3(0.0, 0.395, 0.0);
  float b = dot(oc, rd), h = b * b - (dot(oc, oc) - 1.69);
  if (h > 0.0) {
    float t = max(0.0, -b - sqrt(h)), tEnd = -b + sqrt(h);
    for (int i = 0; i < 80; i++) {
      float d = mapG(ro + rd * t);
      minD = min(minD, d);
      if (d < 0.0015) { tHit = t; break; }
      t += d * 0.9;
      if (t > tEnd) break;
    }
  }
  // aura around the guitar + sound ripple when a chord is played
  float aura = exp(-minD * 9.0) * (0.22 + 0.25 * uEnergy + 0.5 * uPulse);
  C += vec3(0.12, 0.85, 0.85) * aura; A += aura;
  float r = length(uv);
  float ring = exp(-pow((r - (0.55 + (1.0 - min(uPulse, 1.0)) * 0.95)) * 12.0, 2.0)) * min(uPulse, 1.0) * 0.45;
  C += vec3(0.25, 0.95, 0.9) * ring; A += ring;
  if (tHit > 0.0) {
    vec3 p = ro + rd * tHit;
    // world size of one pixel at the hit point -> anti-aliased strings/frets at any size
    float pix = (2.0 / (min(uRes.x, uRes.y) * uZoom)) * (tHit / 2.75);
    vec2 e = vec2(0.0015, -0.0015);
    vec3 n = normalize(e.xyy * mapG(p + e.xyy) + e.yyx * mapG(p + e.yyx) + e.yxy * mapG(p + e.yxy) + e.xxx * mapG(p + e.xxx));
    float dB = sdBody(p), dN = sdNeck(p), dH = sdHead(p), dBr = sdBridge(p);
    vec3 L = R * normalize(vec3(-0.5, 0.65, 0.6));
    vec3 V = -rd;
    vec3 base; vec3 emiss = vec3(0.0);
    float w = fbm(p * 3.5 + vec3(0.0, uTime * 0.06, 0.0));
    if (dB <= min(min(dN, dH), dBr) + 0.0005) {
      base = mix(vec3(0.04, 0.26, 0.38), vec3(0.14, 0.78, 0.80), smoothstep(0.3, 0.7, w));
      base = mix(base, vec3(0.42, 0.30, 0.95), (1.0 - smoothstep(-0.75, 0.05, p.y)) * 0.35);
      base *= mix(0.55, 1.0, smoothstep(0.3, 0.7, abs(n.z)));
      if (n.z < -0.3) base = vec3(0.10, 0.06, 0.28) + 0.15 * w;
      if (n.z > 0.5) {
        float hd = length(p.xy - vec2(0.0, 0.08));
        base = mix(base, vec3(0.005, 0.02, 0.05), 1.0 - smoothstep(0.100, 0.104, hd));
        emiss += vec3(0.25, 1.0, 0.85) * smoothstep(0.108, 0.112, hd) * (1.0 - smoothstep(0.128, 0.132, hd)) * (0.6 + 0.6 * uPulse);
        emiss += vec3(0.2, 0.9, 1.0) * (1.0 - smoothstep(0.0, 0.018, abs(body2(p.xy)))) * 0.45;
      }
    } else if (dN <= min(dH, dBr) + 0.0005) {
      base = vec3(0.03, 0.05, 0.10);
      if (n.z > 0.5) {
        float fd = 1.0;
        for (int k = 1; k <= 12; k++) fd = min(fd, abs(p.y - (1.24 - 1.6 * (1.0 - pow(2.0, -float(k) / 12.0)))));
        float fw = max(0.0035, pix * 0.8);
        emiss += vec3(0.6, 0.95, 1.0) * (1.0 - smoothstep(fw * 0.5, fw, fd)) * 0.55 * clamp(0.006 / fw, 0.25, 1.0);
      }
    } else if (dH <= dBr) {
      base = vec3(0.05, 0.08, 0.16);
      emiss += vec3(0.24, 0.96, 0.82) * (1.0 - smoothstep(0.018, 0.024, length(p.xy - vec2(0.0, 1.42)))) * step(0.3, n.z);
    } else {
      base = vec3(0.26, 0.30, 0.34);
    }
    // 6 strings (wider at the bridge than the nut), vibrating with energy/pulse
    if (n.z > 0.5 && p.y > -0.40 && p.y < 1.24) {
      float vib = (uEnergy * 0.003 + uPulse * 0.004) * sin(p.y * 60.0 + uTime * 55.0);
      float taper = mix(0.014, 0.0095, clamp((p.y + 0.40) / 1.64, 0.0, 1.0));
      float sd = 9.0;
      for (int i = 0; i < 6; i++) sd = min(sd, abs(p.x - (float(i) - 2.5) * taper - vib));
      float sw = max(0.0028, pix * 0.75);
      emiss += vec3(0.75, 1.0, 0.95) * (1.0 - smoothstep(sw * 0.4, sw, sd)) * (0.7 + 0.8 * uPulse) * clamp(0.0035 / sw, 0.3, 1.0);
    }
    float diff = max(dot(n, L), 0.0);
    float spec = pow(max(dot(reflect(-L, n), V), 0.0), 40.0);
    float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    vec3 col = base * (0.38 + 0.9 * diff) + vec3(0.9, 1.0, 1.0) * spec * 0.6 + vec3(0.2, 0.9, 1.0) * fres * (0.7 + 0.5 * uEnergy) + emiss;
    col *= 1.0 + 0.2 * uEnergy + 0.35 * uPulse;
    C = col; A = 1.0;
  }
  gl_FragColor = vec4(C, min(A, 1.0));
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
        ['uRes', 'uTime', 'uEnergy', 'uPulse', 'uRot', 'uLean', 'uZoom'].forEach((n) => { uni[n] = gl.getUniformLocation(prog, n); });
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
      // แถบกว้างเตี้ย (มือถือ) → วางกีตาร์แนวนอนและขยายให้เต็มแถบ · กรอบปกติ → ตั้งเอียงเล็กน้อย
      const asp = canvas.width / Math.max(1, canvas.height);
      gl.uniform1f(uni.uLean, asp > 1.5 ? -1.32 : -0.38);
      gl.uniform1f(uni.uZoom, asp > 1.5 ? Math.max(1, Math.min(2.3, asp * 0.78)) : 1);
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
