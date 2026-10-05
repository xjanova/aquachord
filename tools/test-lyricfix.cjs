#!/usr/bin/env node
/* test-lyricfix.cjs — "ใส่เนื้อร้องที่ถูกต้อง → AI จัดให้ตรงเพลง" (site/assets/js/lyricfix.js)
   จำลองผล Whisper ที่ผิดแบบที่เจอจริงกับเพลงไทย: วรรณยุกต์ผิด · พยัญชนะเสียงเดียวกันสลับ (ศ/ส ธ/ท) · คำหาย ·
   คำเกิน · บรรทัดรวม/แยก · ข้อความหลอนต้นเพลง · ท่อนฮุกร้องสองรอบแต่เนื้อที่ผู้ใช้วางเขียนรอบเดียว + "(ซ้ำ *)"
   ตรวจ: เวลาบรรทัด (เส้นทาง chunk), ตำแหน่งคอร์ดบนพยางค์ (เส้นทางเขียนชีตใหม่), อัตราตรง, ความเร็ว */
'use strict';
const L = require('../site/assets/js/lyricfix.js');

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const G = (s) => L._test.graphemes(s);

/* ---------- เพลงทดสอบ (แต่งเอง) ---------- */
const V1 = ['เดินทางมาไกลแสนไกล', 'ใจยังคิดถึงบ้านเรา', 'ทุ่งนาเขียวขจีที่เคยเห็น', 'ยังอยู่ในใจไม่เคยลืม'];
const CH = ['กลับมาเถิดนะคนดี', 'ตรงนี้ยังมีที่ว่างให้เธอ', 'ความรักของเรายังคงเหมือนเดิม', 'ไม่ว่าจะนานสักเท่าไร'];
const V2 = ['สายฝนโปรยลงมาทุกครั้ง', 'ฉันนั่งนับวันรอเธอ', 'ศรัทธาในรักยังมั่นคง', 'ธรรมดาของคนที่รอ'];
// ลำดับที่ร้องจริง (ฮุกสองรอบ) + เวลา
const SUNG = [...V1, ...CH, ...V2, ...CH];
const truth = [];
{
  let t = 8.0;
  SUNG.forEach((line, k) => {
    if (k === 4 || k === 8 || k === 12) t += 6;  // ช่วงดนตรีคั่นท่อน
    const d = 1.2 + G(line).length * 0.17;
    truth.push({ t0: +t.toFixed(2), t1: +(t + d).toFixed(2), text: line });
    t += d + 0.6;
  });
}
// เนื้อที่ผู้ใช้วาง: เขียนฮุกรอบเดียว + ป้าย
const USER = ['[Verse 1]', ...V1, '', 'ท่อน *', ...CH, '', 'Verse 2', ...V2, '', '(ซ้ำ *)'].join('\n');

/* ---------- ทำให้ "เหมือน Whisper ถอดผิด" ---------- */
const TONES = ['่', '้', '๊', '๋'];
const HOMO_SWAP = { 'ส': 'ศ', 'ท': 'ธ', 'น': 'ณ', 'ศ': 'ส', 'ธ': 'ท' };
function corrupt(line, r) {
  let g = G(line);
  g = g.map((x) => {
    let y = x;
    if (r() < 0.15) y = y.replace(/[่้๊๋]/g, '') + (r() < 0.5 ? TONES[Math.floor(r() * 4)] : '');      // วรรณยุกต์ผิด
    if (r() < 0.10 && HOMO_SWAP[y[0]]) y = HOMO_SWAP[y[0]] + y.slice(1);                                // ตัวสะกดเสียงเดียวกัน
    return y;
  });
  if (g.length > 8 && r() < 0.4) { const i = 2 + Math.floor(r() * (g.length - 5)); if (!g.slice(i, i + 2).includes('')) g.splice(i, 2); } // คำหาย (ไม่ลบตัวทำเครื่องหมายของเทสต์)
  if (r() < 0.3) { const i = Math.floor(r() * g.length); g.splice(i, 0, ...G(r() < 0.5 ? 'นะ' : 'แล้ว')); } // คำเกิน
  return g.join('');
}
function asrChunks(seed) {
  const r = rng(seed);
  const out = [{ t0: 0.5, t1: 3.0, text: 'ขอบคุณที่รับชมนะครับ' }];  // หลอนต้นเพลง (ไม่ตรง JUNK เป๊ะ)
  for (let k = 0; k < truth.length; k++) {
    const c = truth[k];
    if (k + 1 < truth.length && r() < 0.2 && truth[k + 1].t0 - c.t1 < 1) {     // สองบรรทัดเป็น chunk เดียว
      const n = truth[k + 1];
      out.push({ t0: c.t0, t1: n.t1, text: corrupt(c.text, r) + ' ' + corrupt(n.text, r) });
      k++;
    } else out.push({ t0: c.t0, t1: c.t1, text: corrupt(c.text, r) });
  }
  return out;
}

/* ====================================================================== */
console.log('\n1) ทำความสะอาดเนื้อที่ผู้ใช้วาง');
{
  const lines = L.cleanUserLyrics(USER);
  ok(lines.length === 12, `ตัดป้าย [Verse 1]/ท่อน */Verse 2/(ซ้ำ *) เหลือ 12 บรรทัด (ได้ ${lines.length})`);
  const tricky = L.cleanUserLyrics('ท่อนนี้ฉันร้องให้เธอ\nซ้ำเติมใจ\nรักเธอ (ซ้ำ)\nlove [you] {x}\nmax2\nhello x2');
  ok(tricky.join('|') === 'ท่อนนี้ฉันร้องให้เธอ|ซ้ำเติมใจ|รักเธอ|love (you) x|max2|hello', 'คำที่ขึ้นต้นเหมือนป้ายไม่โดนตัด · [ ] { } ไม่ชน ChordPro: ' + tricky.join(' | '));
}

console.log('\n2) เส้นทาง chunk (มีเวลาจาก Whisper) — 20 เพลงสุ่มการถอดผิด');
{
  const errs = [], counts = [];
  let worst = 0, repeatsOk = 0, matchMin = 1;
  for (let seed = 1; seed <= 20; seed++) {
    const res = L.alignToChunks(USER, asrChunks(seed), { duration: truth[truth.length - 1].t1 + 10 });
    counts.push(res.chunks.length);
    matchMin = Math.min(matchMin, res.match);
    if (res.repeats >= 1) repeatsOk++;
    // จับคู่บรรทัดผลลัพธ์กับบรรทัดจริงตามลำดับ (ข้อความผู้ใช้ตรงตัวอักษร)
    let ti = 0;
    res.chunks.forEach((c) => {
      while (ti < truth.length && truth[ti].text !== c.text) ti++;
      if (ti >= truth.length) return;
      const e = Math.abs(c.t0 - truth[ti].t0);
      errs.push(e); worst = Math.max(worst, e); ti++;
    });
  }
  errs.sort((a, b) => a - b);
  const med = errs[Math.floor(errs.length / 2)], p90 = errs[Math.floor(errs.length * 0.9)];
  ok(counts.every((n) => n === 16), `ได้ครบ 16 บรรทัด (ฮุกซ้ำสองรอบ) ทุกเพลง — ${counts.join(',')}`);
  ok(repeatsOk === 20, `พบท่อนซ้ำ 20/20 (${repeatsOk})`);
  ok(med < 0.25 && p90 < 0.6, `เวลาเริ่มบรรทัดคลาด median ${med.toFixed(2)}s · p90 ${p90.toFixed(2)}s · แย่สุด ${worst.toFixed(2)}s`);
  ok(matchMin > 0.6, `อัตราตรงต่ำสุด ${(matchMin * 100).toFixed(0)}%`);
}

console.log('\n3) เส้นทางเขียนชีต ChordPro ใหม่ (เพลงที่มีเนื้อจาก AI อยู่แล้ว)');
{
  // ชีตจาก AI: บรรทัดเนื้อถอดผิด + คอร์ดบนพยางค์ที่รู้คำตอบ (พยางค์ที่ 0 และกลางบรรทัด) · มีกริดช่วงดนตรี/directive
  const PROG = { 0: ['C', 'G'], 1: ['Am', 'F'], 2: ['C', 'G'], 3: ['F', 'G'] };
  const r = rng(77);
  const sheet = ['{title: ทดสอบ}', '{key: C}', '', '{c: ⏱ 0:00}', '[C] [G] | [Am] [F]', ''];
  const expect = []; // {line text, chord, gIndex}
  SUNG.forEach((line, k) => {
    if (k === 4 || k === 8 || k === 12) sheet.push('', '{c: ⏱ 0:30}', '[F] | [G]', '');
    const g = G(line), mid = Math.floor(g.length / 2);
    const [c1, c2] = PROG[k % 4];
    expect.push({ text: line, occ: k, chords: [[c1, 0], [c2, mid]] });
    // คอร์ดที่สองวางบนพยางค์เดียวกันในข้อความที่ถอดผิด: แทรกก่อนถอดผิดด้วยเครื่องหมายชั่วคราว
    const marked = g.slice(0, mid).join('') + '\u0001' + g.slice(mid).join('');
    const bad = corrupt(marked, r);
    const [a, b] = bad.includes('\u0001') ? bad.split('\u0001') : [bad.slice(0, Math.floor(bad.length / 2)), bad.slice(Math.floor(bad.length / 2))];
    sheet.push(`[${c1}]${a}[${c2}]${b}`);
    if (process.env.V) console.log('     AI:', `[${c1}]${a}[${c2}]${b}`);
  });
  sheet.push('', '{c: 🎤 เนื้อร้องจาก AI (Beta)}', '{c: ⚠ ตรวจทานก่อนใช้}');
  const cp = sheet.join('\n');
  ok(L.lyricLineCount(cp) === 16, `นับบรรทัดเนื้อในชีตได้ 16 (${L.lyricLineCount(cp)})`);
  const res = L.rewriteChordPro(cp, USER, { replaceNote: ['เนื้อร้องจาก AI (Beta)', 'เนื้อร้องจากผู้ใช้'] });
  ok(!!res, 'เขียนชีตใหม่ได้');
  const outLines = res.chordpro.split('\n');
  const lyricOut = outLines.filter((l) => !/^\s*\{/.test(l) && l.replace(/\[[^\]]+\]/g, '').replace(/[|\s]/g, ''));
  const plain = lyricOut.map((l) => l.replace(/\[[^\]]+\]/g, ''));
  ok(plain.length === 16 && plain.every((p, k) => p === SUNG[k]), `บรรทัดเนื้อ = เนื้อผู้ใช้ครบตามลำดับที่ร้อง (ฮุกสองรอบ) — ${plain.length} บรรทัด`);
  // คอร์ดบนพยางค์ถูกตัว (±1 grapheme)
  let good = 0, total = 0;
  lyricOut.forEach((l, k) => {
    const want = expect[k]; if (!want) return;
    const got = []; let txt = '', last = 0, m; const re = /\[([^\]]+)\]/g;
    while ((m = re.exec(l)) !== null) { txt += l.slice(last, m.index); got.push([m[1], G(txt).length]); last = re.lastIndex; }
    want.chords.forEach(([c, gi]) => { total++; if (got.some(([gc, gg]) => gc === c && Math.abs(gg - gi) <= 1)) good++; else if (process.env.V) console.log('     พลาด', c, 'ต้องการ', gi, 'ได้', JSON.stringify(got), l); });
  });
  ok(good / total >= 0.95, `คอร์ดลงพยางค์เดิม (±1) ${good}/${total}`);
  const chordsIn = (cp.match(/\[[^\]]+\]/g) || []).length, chordsOut = (res.chordpro.match(/\[[^\]]+\]/g) || []).length;
  ok(chordsOut >= chordsIn - 2, `คอร์ดไม่หาย (เดิม ${chordsIn} → ใหม่ ${chordsOut})`);
  ok(res.chordpro.includes('{title: ทดสอบ}') && (res.chordpro.match(/\[F\] \| \[G\]/g) || []).length === 3 && res.chordpro.includes('{c: ⏱ 0:00}'), 'directive/กริดช่วงดนตรีคงเดิม');
  ok(res.chordpro.includes('{c: 🎤 เนื้อร้องจากผู้ใช้}'), 'เปลี่ยนหมายเหตุ "เนื้อจาก AI" เป็น "เนื้อจากผู้ใช้"');
  console.log('     ตัวอย่าง:\n       ' + lyricOut.slice(4, 7).join('\n       '));
}

console.log('\n4) เพลงอังกฤษ + เนื้อคนละเพลง');
{
  const EN = ['Walking down the empty road', 'Carry all the things I know', 'Every light is fading slow', 'Still I keep on letting go'];
  const asr = EN.map((l, k) => ({ t0: 5 + k * 4, t1: 8 + k * 4, text: l.toLowerCase().replace('things', 'thing').replace('empty', 'and empty') }));
  const res = L.alignToChunks(EN.join('\n'), asr, { duration: 30 });
  ok(res.chunks.length === 4 && res.chunks.every((c, k) => Math.abs(c.t0 - (5 + k * 4)) < 0.3), 'อังกฤษ: 4 บรรทัดเวลาตรง ' + res.chunks.map((c) => c.t0).join(','));
  ok(res.match > 0.9, `อังกฤษอัตราตรง ${(res.match * 100).toFixed(0)}%`);
  const other = L.alignToChunks('ฉันเป็นคนเหงา\nนั่งมองดวงดาว\nไม่มีใครเข้าใจ', asrChunks(3), { duration: 120 });
  ok(other.match < 0.5, `เนื้อคนละเพลงได้อัตราตรงต่ำ ${(other.match * 100).toFixed(0)}% (แอปเตือนผู้ใช้)`);
}

console.log('\n5) ไม่มีผลถอดเสียง → กระจายตามช่วงที่มีเสียงร้อง');
{
  const sr = 16000, pcm = new Float32Array(sr * 30);
  const voiced = [[4, 10], [14, 22], [25, 28]];
  const r = rng(5);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (r() - 0.5) * 0.002;
  voiced.forEach(([a, b]) => { for (let i = a * sr; i < b * sr; i++) pcm[i] += Math.sin(i * 0.05) * 0.3; });
  const regs = L.voicedRegions(pcm, sr);
  ok(regs.length === 3 && regs.every((g, k) => Math.abs(g.t0 - voiced[k][0]) < 0.2 && Math.abs(g.t1 - voiced[k][1]) < 0.5), 'หาช่วงมีเสียงร้อง ' + JSON.stringify(regs));
  const sp = L.spreadLines(V1.join('\n'), regs);
  ok(sp.chunks.length === 4 && sp.rough && sp.chunks[0].t0 >= 4 && sp.chunks[3].t1 <= 28.01, 'กระจาย 4 บรรทัดในช่วงร้อง ' + sp.chunks.map((c) => c.t0 + '-' + c.t1).join(' '));
}

console.log('\n6) ความเร็ว / ข้อความยาว / อินพุตแปลก');
{
  const big = []; for (let k = 0; k < 60; k++) big.push(...V1, ...CH, ...V2);
  const asr = big.map((l, k) => ({ t0: k * 3, t1: k * 3 + 2.5, text: corrupt(l, rng(k)) }));
  let t = Date.now();
  const r1 = L.alignToChunks(big.slice(0, 120).join('\n'), asr.slice(0, 120), { duration: 400 });
  const ms1 = Date.now() - t;
  ok(r1.chunks.length >= 118 && ms1 < 1500, `เพลงยาว 120 บรรทัด (~2,400 ตัวอักษร) ${ms1} ms`);
  t = Date.now();
  const r2 = L.alignToChunks(big.join('\n'), asr, { duration: 2200 });
  const ms2 = Date.now() - t;
  ok(r2.chunks.length >= 700 && ms2 < 6000, `ข้อความยาวมาก 720 บรรทัด (แบบแถบ) ${ms2} ms · ได้ ${r2.chunks.length} บรรทัด`);
  const weird = [L.alignToChunks('', asr), L.alignToChunks('abc', []), L.alignToChunks('!!!\n???', asr), L.rewriteChordPro('{title: x}\n[C] [G]', 'เนื้อ'), L.rewriteChordPro('', ''), L.spreadLines('x', [])];
  ok(weird[0].chunks.length === 0 && weird[1].chunks.length === 0 && weird[2].chunks.length === 0 && weird[3] === null && weird[4] === null && weird[5].chunks.length === 0, 'อินพุตว่าง/ไม่มีตัวอักษร/ชีตไม่มีเนื้อ ไม่พัง');
  const inj = L.rewriteChordPro('[C]สวัสดี[G]ครับ', '<img src=x onerror=alert(1)>\n{title: hack}\n[X]สวัสดีครับ');
  ok(inj && !/\{title: hack\}/.test(inj.chordpro) && !inj.chordpro.includes('[X]'), 'เนื้อผู้ใช้ไม่สร้าง directive/คอร์ดปลอมได้ (HTML escape ที่ตัวเรนเดอร์ ChordPro)');
}

console.log(fails ? `\n✗ ไม่ผ่าน ${fails} ข้อ` : '\n✓ lyricfix ผ่านทุกเกณฑ์');
process.exit(fails ? 1 : 0);
