"""จัดเวลาเนื้อร้องกับเสียงร้อง (vocal stem) ด้วย CTC forced alignment

ขั้นตอน:
1. VAD พลังงาน (RMS) บน vocal stem -> ช่วงที่มีเสียงร้อง -> แบ่งเป็นก้อน <= 25 วิ (ใช้ร่วมกับ ASR)
2. emission log-prob ต่อเฟรม 20 ms จาก wav2vec2 CTC (ไทย: airesearch/wav2vec2-large-xlsr-53-th)
   เฉพาะก้อนที่มีเสียง — เฟรมเงียบถือเป็น blank
3. Viterbi เขียนเอง (numpy) บน trellis ที่มี "garbage state" ระหว่างบรรทัด และกระโดดข้ามบรรทัดได้
   -> บรรทัดที่ไม่ได้ร้องจริง (เช่นเนื้อท่อนที่เพลงตัดทิ้ง) ถูกข้าม แทนที่จะยัดทุกบรรทัดลงเวลา
   ตัวอักษรที่ไม่อยู่ใน vocab (ละติน/ตัวเลข/สัญลักษณ์) -> token wildcard ไม่ทำให้บรรทัดพัง
4. ถ้าเพลงยาวจน trellis ใหญ่เกิน -> หาแบบหยาบ (รวมเฟรม) ก่อน แล้วละเอียดทีละบรรทัดในหน้าต่างของมัน
5. เวลาตัวอักษร -> เวลาพยางค์ (ต้นพยางค์ = spike ตัวแรก, ท้าย = ต้นพยางค์ถัดไป/สิ้นเสียง)

ไม่ใช้ torchaudio.functional.forced_align (deprecated/ถูกถอด) — DP ทั้งหมดอยู่ในไฟล์นี้
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

from .thai_text import LyricLine

SR = 16000
HOP = 320  # 20 ms ต่อเฟรม = stride ของ wav2vec2
FRAME_SEC = HOP / SR
NEG = -1.0e9  # ค่าแทน -inf (กัน nan จาก inf - inf)
WILD = -1  # token wildcard (อักษรที่โมเดลไม่รู้จัก)

# ค่าปรับของ DP (หน่วย nat ต่อเฟรม/ต่อบรรทัด) — ปรับจากเพลงทดสอบ ดู tests/test_lyrics_align.py
GARBAGE_PEN = 3.0  # garbage แพงกว่าตัวอักษรที่ดีที่สุดเท่านี้ ในเฟรมที่ไม่ใช่ blank
WILD_PEN = 1.0  # wildcard แพงกว่าตัวอักษรที่ดีที่สุดเท่านี้
SKIP_PEN = 4.0  # ค่าข้ามบรรทัดหนึ่งบรรทัด (ยิ่งมากยิ่งพยายามวางทุกบรรทัด)
# ค่าอยู่ใน blank "ภายใน" บรรทัดต่อเฟรม — กันบรรทัดยืดข้ามช่วงเงียบ/ดนตรียาว ๆ (garbage ไม่เสียค่านี้)
INLINE_PEN_VOICED = 0.005  # ลากเสียงยาว 2 วิ เสีย 0.5 — แทบไม่มีผล
INLINE_PEN_SILENT = 0.04  # เงียบ 1 วิ กลางบรรทัด เสีย 2 — บรรทัดจะไปรอใน garbage แทน
MAX_CELLS = 300_000_000  # T x S สูงสุดก่อนต้องรวมเฟรม (backpointer 1 byte/ช่อง ~300 MB)
KEEP_SILENT = 6  # เฟรมเงียบที่เก็บไว้ต่อช่วงเงียบหนึ่งช่วง (ต้น 3 + ท้าย 3) ตอนบีบ trellis


# ================================================================ เสียง / VAD


def to_mono_16k(vocals, sr: int) -> np.ndarray:
    """numpy float mono/stereo ที่ sr ใดก็ได้ -> float32 mono 16 kHz ช่วง [-1, 1]"""
    x = np.asarray(vocals, dtype=np.float32)
    if x.ndim == 2:  # (ch, n) หรือ (n, ch) — เฉลี่ยตามแกนที่สั้นกว่า
        x = x.mean(axis=0 if x.shape[0] <= x.shape[1] else 1)
    elif x.ndim != 1:
        raise ValueError("vocals must be 1-D or 2-D")
    sr = int(sr)
    if sr <= 0:
        raise ValueError("bad sample rate")
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    np.clip(x, -1.0, 1.0, out=x)
    if sr != SR and x.size:
        from scipy.signal import resample_poly

        g = math.gcd(SR, sr)
        x = resample_poly(x, SR // g, sr // g).astype(np.float32)
    return np.ascontiguousarray(x, dtype=np.float32)


def frame_db(wav: np.ndarray) -> np.ndarray:
    """RMS (dB) ต่อเฟรม 20 ms (หน้าต่าง 40 ms) — จำนวนเฟรม = ceil(len/HOP)"""
    n = max(1, int(math.ceil(len(wav) / HOP)))
    pad = np.zeros(n * HOP + HOP, dtype=np.float32)
    pad[HOP // 2 : HOP // 2 + len(wav)] = wav
    sq = pad.astype(np.float64) ** 2
    a = sq[: n * HOP].reshape(n, HOP).sum(1)
    b = sq[HOP : HOP + n * HOP].reshape(n, HOP).sum(1)
    rms = np.sqrt((a + b) / (2 * HOP))
    return (20.0 * np.log10(rms + 1e-10)).astype(np.float32)


def voiced_mask(db: np.ndarray, rel_db: float = 28.0, floor_db: float = -55.0) -> np.ndarray:
    """เฟรมที่มีเสียงร้อง: สูงกว่า (percentile 95 - rel_db) และสูงกว่า floor; ปิดช่องสั้น/ตัดชิ้นสั้น"""
    live = db[db > -100.0]
    if live.size == 0:
        return np.zeros(db.shape, dtype=bool)
    ref = float(np.percentile(live, 95))
    thr = max(ref - rel_db, floor_db)
    m = db > thr
    m = _close_gaps(m, 12)  # ช่องเงียบ <= 0.24 วิ ถือว่าต่อเนื่อง (หายใจ/พยัญชนะ)
    m = _drop_short(m, 8)  # ชิ้น < 0.16 วิ ทิ้ง (เสียงหลุดจากการแยก stem)
    return _dilate(m, 5)  # เผื่อต้น/ท้าย 0.1 วิ


def _runs(m: np.ndarray) -> list[tuple[int, int]]:
    """ช่วง True ต่อเนื่อง [a, b) ของ mask"""
    if m.size == 0:
        return []
    d = np.diff(np.concatenate([[0], m.astype(np.int8), [0]]))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1)
    return list(zip(starts.tolist(), ends.tolist()))


def _close_gaps(m: np.ndarray, n: int) -> np.ndarray:
    m = m.copy()
    runs = _runs(m)
    for (a0, a1), (b0, _b1) in zip(runs, runs[1:]):
        if b0 - a1 <= n:
            m[a1:b0] = True
    return m


def _drop_short(m: np.ndarray, n: int) -> np.ndarray:
    m = m.copy()
    for a, b in _runs(m):
        if b - a < n:
            m[a:b] = False
    return m


def _dilate(m: np.ndarray, n: int) -> np.ndarray:
    out = m.copy()
    for a, b in _runs(m):
        out[max(0, a - n) : b + n] = True
    return out


def voiced_regions(mask: np.ndarray) -> list[tuple[int, int]]:
    return _runs(mask)


def plan_chunks(
    mask: np.ndarray,
    db: np.ndarray,
    max_sec: float = 25.0,
    max_gap_sec: float = 3.0,
) -> list[tuple[int, int]]:
    """รวมช่วงมีเสียงเป็นก้อน [f0, f1) ยาว <= max_sec — ตัดที่ช่องเงียบ; ช่วงยาวเกินตัดที่เฟรมเบาสุด"""
    max_f = max(10, int(max_sec / FRAME_SEC))
    gap_f = int(max_gap_sec / FRAME_SEC)
    pieces: list[tuple[int, int]] = []
    for a, b in voiced_regions(mask):
        pieces.extend(_split_long(a, b, db, max_f))
    chunks: list[tuple[int, int]] = []
    for a, b in pieces:
        if chunks and a - chunks[-1][1] <= gap_f and b - chunks[-1][0] <= max_f:
            chunks[-1] = (chunks[-1][0], b)
        else:
            chunks.append((a, b))
    return chunks


def _split_long(a: int, b: int, db: np.ndarray, max_f: int) -> list[tuple[int, int]]:
    if b - a <= max_f:
        return [(a, b)]
    lo = a + max_f // 2
    hi = min(b - 10, a + max_f)
    if hi <= lo:
        cut = a + max_f
    else:
        # เฟรมเบาสุด (เฉลี่ย 5 เฟรม) ในครึ่งหลังของหน้าต่าง — มักเป็นช่วงหายใจระหว่างวรรค
        w = db[lo:hi].astype(np.float64)
        if w.size >= 5:
            w = np.convolve(w, np.ones(5) / 5, mode="same")
        cut = lo + int(np.argmin(w))
    return [(a, cut)] + _split_long(cut, b, db, max_f)


# ================================================================ โมเดล CTC


@dataclass
class CtcVocab:
    ids: dict[str, int]
    blank: int
    delimiter: int | None
    upper: bool  # vocab ตัวพิมพ์ใหญ่ล้วน (โมเดลอังกฤษ) -> map ตัวเล็กเป็นใหญ่

    @classmethod
    def from_dir(cls, path: Path) -> "CtcVocab":
        vocab = json.loads((path / "vocab.json").read_text(encoding="utf-8"))
        if not isinstance(vocab, dict) or not vocab:
            raise ValueError("bad vocab.json")
        cfg = {}
        try:
            cfg = json.loads((path / "config.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        blank = cfg.get("pad_token_id")
        if not isinstance(blank, int):
            blank = vocab.get("[PAD]", vocab.get("<pad>", 0))
        letters = [k for k in vocab if len(k) == 1 and k.isalpha()]
        upper = bool(letters) and all(not k.islower() for k in letters)
        return cls(ids={k: int(v) for k, v in vocab.items()}, blank=int(blank), delimiter=vocab.get("|"), upper=upper)

    @property
    def size(self) -> int:
        return max(self.ids.values()) + 1

    def char_id(self, ch: str) -> int | None:
        if self.upper:
            ch = ch.upper()
        i = self.ids.get(ch)
        if i is None or i == self.blank or i == self.delimiter or len(ch) != 1:
            return None
        return i


class CtcModel:
    """ห่อ Wav2Vec2ForCTC: โหลดครั้งเดียว คำนวณ emission ทีละก้อน แล้ว close() คืนหน่วยความจำ GPU"""

    def __init__(self, path: Path, device: str = "cpu", dtype=None):
        import torch
        from transformers import Wav2Vec2ForCTC

        self.path = Path(path)
        self.vocab = CtcVocab.from_dir(self.path)
        self.device = device
        self.dtype = dtype or torch.float32
        try:
            pre = json.loads((self.path / "preprocessor_config.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pre = {}
        self.do_normalize = bool(pre.get("do_normalize", True))
        self.model = Wav2Vec2ForCTC.from_pretrained(str(self.path), dtype=self.dtype).to(device).eval()

    def emissions(
        self,
        wav: np.ndarray,
        chunks: Sequence[tuple[int, int]],
        progress: Callable[[float], None] | None = None,
        cancelled: Callable[[], bool] | None = None,
        pad_frames: int = 12,
    ) -> np.ndarray | None:
        """log-prob (T, V) ทั้งเพลง — เฟรมนอกก้อนเป็น blank; คืน None ถ้าถูกยกเลิก"""
        import torch

        n_frames = max(1, int(math.ceil(len(wav) / HOP)))
        V = int(self.model.config.vocab_size)
        out = np.full((n_frames, V), -20.0, dtype=np.float32)
        out[:, self.vocab.blank] = 0.0
        total = sum(b - a for a, b in chunks) or 1
        done = 0
        for a, b in chunks:
            if cancelled and cancelled():
                return None
            f0 = max(0, a - pad_frames)
            f1 = min(n_frames, b + pad_frames)
            seg = wav[f0 * HOP : f1 * HOP]
            if len(seg) < 800:
                continue
            seg = seg.astype(np.float32)
            if self.do_normalize:
                seg = (seg - seg.mean()) / math.sqrt(float(seg.var()) + 1e-7)
            with torch.inference_mode():
                x = torch.from_numpy(seg)[None].to(self.device, self.dtype)
                logits = self.model(x).logits[0].float()
                lp = torch.log_softmax(logits, dim=-1).cpu().numpy()
            # เขียนเฉพาะส่วนในก้อน (ไม่รวม padding ที่ขอบเสีย)
            lo, hi = a - f0, min(b - f0, lp.shape[0])
            if hi > lo:
                out[a : a + (hi - lo), : lp.shape[1]] = lp[lo:hi]
            done += b - a
            if progress:
                progress(done / total)
        return out

    def close(self) -> None:
        release(self.model)
        self.model = None


def release(*objs) -> None:
    """ปล่อยโมเดลจาก VRAM (del + gc + empty_cache)"""
    import gc

    for o in objs:
        try:
            if o is not None and hasattr(o, "to"):
                o.to("cpu")
        except Exception:  # noqa: BLE001
            pass
    del objs
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def merge_delimiter_into_blank(logp: np.ndarray, vocab: CtcVocab) -> np.ndarray:
    """'|' (คั่นคำ) ถือเป็นความเงียบ: p(blank) += p(|) — ไม่ต้องใส่ '|' ในลำดับ token"""
    if vocab.delimiter is None or vocab.delimiter >= logp.shape[1]:
        return logp
    lp = logp.copy()
    lp[:, vocab.blank] = np.logaddexp(lp[:, vocab.blank], lp[:, vocab.delimiter])
    lp[:, vocab.delimiter] = -30.0
    return lp


# ================================================================ token ของบรรทัด


@dataclass
class LineTokens:
    ids: list[int]  # vocab id หรือ WILD
    syl: list[int]  # index พยางค์ของแต่ละ token


def line_tokens(line: LyricLine, vocab: CtcVocab) -> LineTokens:
    ids: list[int] = []
    syl: list[int] = []
    for si, s in enumerate(line.syllables):
        got = []
        if s.kind != "other":
            for ch in s.text:
                i = vocab.char_id(ch)
                if i is not None:
                    got.append(i)
        if not got:  # ละตินกับโมเดลไทย / ตัวเลข / อักษรนอก vocab -> wildcard 1 ตัวต่อพยางค์
            got = [WILD]
        ids.extend(got)
        syl.extend([si] * len(got))
    return LineTokens(ids, syl)


# ================================================================ Viterbi


@dataclass
class _Trellis:
    emit_id: np.ndarray  # vocab id (token/blank), WILD (-1), หรือ -2 (garbage)
    allow2: np.ndarray  # อนุญาต s-2 -> s
    g_index: np.ndarray  # index ของ garbage state G_j (j = 0..L)
    g_line: np.ndarray  # state -> j ถ้าเป็น G_j ไม่งั้น -1
    tok_state: list[np.ndarray]  # ต่อบรรทัด: state ของแต่ละ token
    S: int = 0


def _build(lines: Sequence[LineTokens], blank: int) -> _Trellis:
    emit: list[int] = []
    allow2: list[bool] = []
    g_index: list[int] = []
    tok_state: list[np.ndarray] = []
    for lt in lines:
        g_index.append(len(emit))
        emit.append(-2)  # G_j
        allow2.append(False)
        states = []
        prev_id = None
        for k, tid in enumerate(lt.ids):
            emit.append(blank)
            allow2.append(False)
            states.append(len(emit))
            emit.append(tid)
            # ข้าม blank ได้ถ้าเป็น token แรก (จาก G) หรือ token ต่างจากตัวก่อน (wildcard ต่างกันเสมอ)
            allow2.append(k == 0 or tid != prev_id or tid == WILD)
            prev_id = tid
        emit.append(blank)
        allow2.append(False)
        tok_state.append(np.array(states, dtype=np.int64))
    g_index.append(len(emit))
    emit.append(-2)  # G_L
    # G_{j+1} รับจาก token สุดท้ายของบรรทัด j ได้โดยตรง (s-2) ถ้าบรรทัดมี token
    allow2.append(bool(lines) and len(lines[-1].ids) > 0)
    emit_a = np.array(emit, dtype=np.int64)
    allow2_a = np.array(allow2, dtype=bool)
    for j in range(1, len(g_index) - 1):
        allow2_a[g_index[j]] = len(lines[j - 1].ids) > 0
    g_line = np.full(len(emit), -1, dtype=np.int64)
    g_line[np.array(g_index)] = np.arange(len(g_index))
    return _Trellis(emit_a, allow2_a, np.array(g_index, dtype=np.int64), g_line, tok_state, len(emit))


@dataclass
class LinePath:
    placed: bool
    tok_frames: list[tuple[int, int]] = field(default_factory=list)  # (เฟรมแรก, เฟรมสุดท้าย) ของแต่ละ token


def viterbi(
    logp: np.ndarray,
    lines: Sequence[LineTokens],
    blank: int,
    allow_skip: bool = True,
    garbage_pen: float = GARBAGE_PEN,
    wild_pen: float = WILD_PEN,
    skip_pen: float = SKIP_PEN,
    inline_pen: np.ndarray | float = INLINE_PEN_VOICED,
) -> list[LinePath]:
    """Viterbi บน trellis หลายบรรทัด + garbage ระหว่างบรรทัด (+ ข้ามบรรทัดถ้า allow_skip)

    logp: (T, V) log-prob ต่อเฟรม (รวม '|' เข้า blank แล้ว)
    inline_pen: ค่าอยู่ใน blank ภายในบรรทัดต่อเฟรม (สเกลาร์ หรือ array ยาว T)
    คืน LinePath ต่อบรรทัด — placed=False คือบรรทัดนั้นถูกข้าม (ไม่ได้ร้อง/หาไม่เจอ)
    """
    L = len(lines)
    if L == 0:
        return []
    T0 = int(logp.shape[0])
    # ต่อเฟรมเงียบท้าย 1 เฟรม -> path จบที่ G_L เสมอ
    silent = np.full((1, logp.shape[1]), -30.0, dtype=np.float32)
    silent[0, blank] = 0.0
    lp = np.concatenate([logp.astype(np.float32, copy=False), silent], axis=0)
    T = T0 + 1
    tr = _build(lines, blank)
    S = tr.S
    pen = np.zeros(T, dtype=np.float64)
    pen[:T0] = inline_pen

    nb = lp.copy()
    nb[:, blank] = NEG
    maxnb = nb.max(axis=1)
    garb = np.maximum(lp[:, blank], maxnb - garbage_pen)
    wild = maxnb - wild_pen

    tok_mask = tr.emit_id >= 0
    tok_cols = np.where(tok_mask, tr.emit_id, 0)
    is_wild = tr.emit_id == WILD
    is_garb = tr.emit_id == -2
    is_blank = tr.emit_id == blank
    G = tr.g_index
    nG = len(G)
    gidx = np.arange(nG, dtype=np.float64)

    bp = np.zeros((T, S), dtype=np.int8)
    gsrc = np.zeros((T, nG), dtype=np.int32) if allow_skip else None
    # สถานะก่อนเฟรมแรก: อยู่ที่ G_0 เท่านั้น
    alpha = np.full(S, NEG, dtype=np.float64)
    alpha[G[0]] = 0.0
    cand = np.empty((3, S), dtype=np.float64)
    ar = np.arange(S)
    no2 = ~tr.allow2
    for t in range(T):
        row = lp[t]
        e = np.where(tok_mask, row[tok_cols], 0.0)
        e = np.where(is_wild, wild[t], e)
        e = np.where(is_garb, garb[t], e)
        if pen[t]:
            e = e - np.where(is_blank, pen[t], 0.0)
        cand[0] = alpha
        cand[1, 0] = NEG
        cand[1, 1:] = alpha[:-1]
        cand[2, :2] = NEG
        cand[2, 2:] = alpha[:-2]
        cand[2, no2] = NEG
        choice = cand.argmax(axis=0)
        alpha = cand[choice, ar] + e
        bp[t] = choice
        if allow_skip and nG > 1:
            gv = alpha[G]
            v = gv + skip_pen * gidx
            run = np.maximum.accumulate(v)
            better = run - skip_pen * gidx > gv + 1e-9
            if better.any():
                src = np.maximum.accumulate(np.where(v >= run, np.arange(nG), 0))
                alpha[G[better]] = (run - skip_pen * gidx)[better]
                bp[t, G[better]] = 3
                gsrc[t, better] = src[better]
        np.maximum(alpha, NEG, out=alpha)

    # backtrack จาก G_L ที่เฟรมสุดท้าย
    if alpha[G[-1]] <= NEG / 2:
        return [LinePath(False) for _ in lines]
    states = np.empty(T, dtype=np.int64)
    s = int(G[-1])
    for t in range(T - 1, -1, -1):
        c = int(bp[t, s])
        if c == 3:
            s = int(G[gsrc[t, tr.g_line[s]]])
            c = int(bp[t, s])
        states[t] = s
        s -= c
    states = states[:T0]
    first = np.full(S, -1, dtype=np.int64)
    last = np.full(S, -1, dtype=np.int64)
    u, fi = np.unique(states, return_index=True)
    first[u] = fi
    u2, li = np.unique(states[::-1], return_index=True)
    last[u2] = T0 - 1 - li

    out: list[LinePath] = []
    for j in range(L):
        ts = tr.tok_state[j]
        if ts.size == 0 or (first[ts] < 0).any():
            out.append(LinePath(False))
            continue
        out.append(LinePath(True, [(int(a), int(b)) for a, b in zip(first[ts], last[ts])]))
    return out


def pool_frames(logp: np.ndarray, k: int) -> np.ndarray:
    """รวม k เฟรมเป็นหนึ่ง (เฉลี่ยในโดเมนความน่าจะเป็น) — ใช้ตอนหาตำแหน่งบรรทัดแบบหยาบ"""
    if k <= 1:
        return logp
    T, V = logp.shape
    n = int(math.ceil(T / k))
    pad = np.full((n * k - T, V), -30.0, dtype=np.float32)
    x = np.concatenate([logp, pad], axis=0).reshape(n, k, V)
    m = x.max(axis=1, keepdims=True)
    return (m[:, 0] + np.log(np.exp(x - m).mean(axis=1))).astype(np.float32)


# ================================================================ จัดเวลาทั้งเพลง


@dataclass
class AlignParams:
    allow_skip: bool = True
    garbage_pen: float = GARBAGE_PEN
    wild_pen: float = WILD_PEN
    skip_pen: float = SKIP_PEN
    max_cells: int = MAX_CELLS


def align_lines(
    logp: np.ndarray,
    lines: Sequence[LyricLine],
    vocab: CtcVocab,
    voiced: np.ndarray | None = None,
    params: AlignParams | None = None,
    frame_offset: int = 0,
    cancelled: Callable[[], bool] | None = None,
) -> list[dict | None]:
    """จัดเวลาบรรทัดทั้งหมดใน logp (หน้าต่างเฟรมเดียว) — คืน dict บรรทัดตาม schema หรือ None ถ้าข้าม

    frame_offset: เฟรมแรกของหน้าต่างนี้ในเพลง (ใช้แปลงเป็นวินาที)
    voiced: mask เฟรมมีเสียงของหน้าต่างเดียวกัน (ใช้ตัดท้ายพยางค์ตอนเงียบ)
    """
    p = params or AlignParams()
    lp = merge_delimiter_into_blank(logp, vocab)
    toks = [line_tokens(ln, vocab) for ln in lines]
    T = lp.shape[0]
    if voiced is None:
        voiced = np.ones(T, dtype=bool)
    voiced = np.asarray(voiced, dtype=bool)[:T]
    if voiced.size < T:
        voiced = np.concatenate([voiced, np.zeros(T - voiced.size, dtype=bool)])
    # บีบช่วงเงียบยาว ๆ (อินโทร/ดนตรีคั่น) เหลือไม่กี่เฟรม -> trellis เล็กลงมาก และบรรทัดข้ามช่วงเงียบได้ใน
    # ไม่กี่เฟรม (ค่า inline_pen จึงไม่ลงโทษการหยุดหายใจยาวระหว่างวรรคเกินจริง)
    keep = _keep_frames(voiced)
    lpc = lp[keep]
    inline = np.where(voiced[keep], INLINE_PEN_VOICED, INLINE_PEN_SILENT)
    Tc = lpc.shape[0]
    S = sum(2 * len(t.ids) + 2 for t in toks) + 1
    k = max(1, int(math.ceil(Tc * S / max(1, p.max_cells))))
    kw = dict(allow_skip=p.allow_skip, garbage_pen=p.garbage_pen, wild_pen=p.wild_pen, skip_pen=p.skip_pen)
    if k == 1:
        paths = viterbi(lpc, toks, vocab.blank, inline_pen=inline, **kw)
    else:  # ใหญ่เกินจริง ๆ (เพลงยาว + เนื้อยาวมาก) -> หยาบก่อนแล้วละเอียดทีละบรรทัด
        inl_pooled = inline[: (Tc // k) * k].reshape(-1, k).mean(1) if Tc >= k else inline[:1]
        inl_p = np.resize(inl_pooled, int(math.ceil(Tc / k)))
        coarse = viterbi(pool_frames(lpc, k), toks, vocab.blank, inline_pen=inl_p, **kw)
        paths = _refine(lpc, toks, vocab.blank, coarse, k, p, inline, cancelled)
    for pth in paths:  # เฟรมในช่วงที่บีบ -> เฟรมจริง
        if pth.placed:
            pth.tok_frames = [(int(keep[a]), int(keep[b])) for a, b in pth.tok_frames]
    out: list[dict | None] = []
    placed_idx = [i for i, pth in enumerate(paths) if pth.placed]
    next_start = {}
    for a, b in zip(placed_idx, placed_idx[1:]):
        next_start[a] = paths[b].tok_frames[0][0]
    for i, (ln, lt, pth) in enumerate(zip(lines, toks, paths)):
        if not pth.placed:
            out.append(None)
            continue
        out.append(_line_times(ln, lt, pth, voiced, next_start.get(i, T), frame_offset))
    return out


def _keep_frames(voiced: np.ndarray, keep_silent: int = KEEP_SILENT) -> np.ndarray:
    """index เฟรมที่เก็บไว้: เฟรมมีเสียงทั้งหมด + ต้น/ท้ายของแต่ละช่วงเงียบอย่างละ keep_silent/2"""
    T = voiced.size
    keep = voiced.copy()
    h = max(1, keep_silent // 2)
    for a, b in _runs(~voiced):
        keep[a : min(b, a + h)] = True
        keep[max(a, b - h) : b] = True
    idx = np.flatnonzero(keep)
    return idx if idx.size else np.arange(T)


def _refine(lp, toks, blank, coarse: list[LinePath], k: int, p: AlignParams, inline, cancelled) -> list[LinePath]:
    """ละเอียดทีละบรรทัดในหน้าต่างรอบตำแหน่งหยาบ (±0.5 วิ ไม่ล้ำบรรทัดข้างเคียง)"""
    T = lp.shape[0]
    spans = [(c.tok_frames[0][0] * k, (c.tok_frames[-1][1] + 1) * k) if c.placed else None for c in coarse]
    out: list[LinePath] = []
    margin = int(0.5 / FRAME_SEC)
    prev_end = 0
    for i, sp in enumerate(spans):
        if sp is None:
            out.append(LinePath(False))
            continue
        if cancelled and cancelled():
            out.append(LinePath(False))
            continue
        nxt = next((s[0] for s in spans[i + 1 :] if s is not None), T)
        w0 = max(prev_end, sp[0] - margin, 0)
        w1 = min(nxt, sp[1] + margin, T)
        if w1 - w0 < 2 * len(toks[i].ids) + 2:
            w0, w1 = max(0, sp[0] - margin), min(T, sp[1] + margin)
        r = viterbi(
            lp[w0:w1], [toks[i]], blank, allow_skip=False,
            garbage_pen=p.garbage_pen, wild_pen=p.wild_pen, inline_pen=inline[w0:w1],
        )[0]
        if r.placed:
            r.tok_frames = [(a + w0, b + w0) for a, b in r.tok_frames]
            prev_end = r.tok_frames[-1][1] + 1
            out.append(r)
        else:  # ละเอียดไม่ได้ -> ใช้ตำแหน่งหยาบ
            c = coarse[i]
            tf = [(a * k, b * k + k - 1) for a, b in c.tok_frames]
            prev_end = tf[-1][1] + 1
            out.append(LinePath(True, tf))
    return out


def _voiced_end(voiced: np.ndarray, f: int, limit: int) -> int:
    """เฟรมแรกหลัง f ที่เงียบ (ไม่เกิน limit)"""
    limit = min(limit, len(voiced))
    if f >= limit:
        return limit
    seg = voiced[f:limit]
    off = np.flatnonzero(~seg)
    return f + int(off[0]) if off.size else limit


MAX_TAIL_SEC = 1.2  # พยางค์สุดท้ายของบรรทัดลากยาวได้ไม่เกินนี้หลัง spike สุดท้าย (ถ้ายังมีเสียง)


def _line_times(ln: LyricLine, lt: LineTokens, pth: LinePath, voiced, next_line_start: int, off: int) -> dict:
    n = len(ln.syllables)
    starts = [None] * n
    lasts = [None] * n
    for (a, b), si in zip(pth.tok_frames, lt.syl):
        if starts[si] is None:
            starts[si] = a
        lasts[si] = b
    syls = []
    for si in range(n):
        a = starts[si]
        nxt = next((starts[j] for j in range(si + 1, n) if starts[j] is not None), None)
        if nxt is None:
            limit = min(next_line_start, lasts[si] + 1 + int(MAX_TAIL_SEC / FRAME_SEC))
        else:
            limit = nxt
        end = _voiced_end(voiced, lasts[si] + 1, limit)
        end = max(end, lasts[si] + 1, a + 1)
        if nxt is not None:
            end = min(end, nxt) if nxt > a else a + 1
        syls.append({"t0": _sec(a + off), "t1": _sec(end + off), "text": ln.syllables[si].text})
    # บังคับเวลาเรียงและไม่ซ้อน
    for i in range(1, len(syls)):
        if syls[i]["t0"] < syls[i - 1]["t0"]:
            syls[i]["t0"] = syls[i - 1]["t0"]
        if syls[i - 1]["t1"] > syls[i]["t0"]:
            syls[i - 1]["t1"] = syls[i]["t0"]
    for s in syls:
        if s["t1"] <= s["t0"]:
            s["t1"] = round(s["t0"] + FRAME_SEC, 3)
    d = {"t0": syls[0]["t0"], "t1": syls[-1]["t1"], "text": ln.text, "syllables": syls}
    if ln.section:
        d["section"] = ln.section
    return d


def _sec(f: int) -> float:
    return round(f * FRAME_SEC, 3)
