"""คอร์ด: lv-chordia (MIT, large vocabulary) → segment → map เป็น grammar AquaChord (docs/04 §3)

ขั้นตอน: CQT (เหมือน CQTV2 ของ lv-chordia) → ChordNet ensemble 5 ตัว → HMM (XHMMDecoder, dict 'submission')
→ [(t0, t1, 'Eb:min7/b3', conf)] → parse_harte() → ChordSym(root_pc, quality, bass_pc) → ตัดสินคีย์ → spell()
→ clean_segments(): รวมป้ายซ้ำ, snap ขอบเข้าหา beat, ยุบ segment สั้นมาก

ไม่เรียก lv_chordia.chord_recognition() ตรง ๆ เพราะมันรับแค่ path ไฟล์, เลือก GPU เอง (cuda() ตรง ๆ),
และ print ลง stderr — เราเรียกชิ้นส่วนภายใน (ChordNet, XHMMDecoder) บน numpy array แทน
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from . import key as keymod

# ---------- grammar ของ AquaChord (docs/04 §3) ----------

QUALITIES = ("", "m", "7", "m7", "maj7", "m7b5", "dim", "dim7", "aug", "sus2", "sus4", "6", "m6", "9",
             "add9", "7sus4", "11", "13")
_Q_ALT = "|".join(sorted((re.escape(q) for q in QUALITIES if q), key=len, reverse=True))
CHORD_RE = re.compile(r"^([A-G])([#b]?)(" + _Q_ALT + r")?(?:/([A-G])([#b]?))?$")
KEY_RE = re.compile(r"^([A-G])([#b]?)(m?)$")


def is_valid_label(label) -> bool:
    """True ถ้า label parse ได้ตาม grammar docs/04 §3 (และ Music.parseChord รับได้)"""
    return isinstance(label, str) and CHORD_RE.match(label) is not None


def is_valid_key(k) -> bool:
    return isinstance(k, str) and KEY_RE.match(k) is not None


# ---------- Harte-like → สัญลักษณ์กลาง ----------

@dataclass(frozen=True)
class ChordSym:
    root_pc: int
    quality: str               # หนึ่งใน QUALITIES
    bass_pc: int | None = None
    bass_degree: int | None = None  # เลขขั้น (1–7) ของเบสเทียบ root — ใช้สะกดตัวอักษร
    root_name: str | None = None    # ชื่อ root จากต้นทาง (ใช้ไม่ได้ถ้าคีย์ไม่ตรง)


# Harte quality → (AquaChord quality, warning?)
HARTE_QUALITY = {
    "maj": ("", None), "": ("", None), "min": ("m", None), "7": ("7", None), "maj7": ("maj7", None),
    "min7": ("m7", None), "dim": ("dim", None), "dim7": ("dim7", None), "hdim7": ("m7b5", None),
    "aug": ("aug", None), "sus2": ("sus2", None), "sus4": ("sus4", None), "sus4(b7)": ("7sus4", None),
    "7sus4": ("7sus4", None), "maj6": ("6", None), "min6": ("m6", None), "9": ("9", None),
    "maj9": ("maj7", None), "min9": ("m7", None), "11": ("11", None), "13": ("13", None),
    "min11": ("m7", None), "min13": ("m7", None), "maj13": ("maj7", None),
    "minmaj7": ("m", "min(maj7) not in AquaChord grammar; wrote m"),
    "min(maj7)": ("m", "min(maj7) not in AquaChord grammar; wrote m"),
    "maj(9)": ("add9", None), "add9": ("add9", None), "5": ("", None), "1": ("", None),
    "aug(b7)": ("aug", None), "7(#9)": ("7", None), "7(b9)": ("7", None), "maj6(9)": ("6", None),
    "sus4(b7,9)": ("7sus4", None), "min(9)": ("m", None), "sus2(b7)": ("sus2", None),
}

# degree → (semitones, เลขขั้นตัวอักษร 1–7)
DEGREES = {
    "1": (0, 1), "b2": (1, 2), "2": (2, 2), "#2": (3, 2), "b3": (3, 3), "3": (4, 3), "b4": (4, 4),
    "4": (5, 4), "#4": (6, 4), "b5": (6, 5), "5": (7, 5), "#5": (8, 5), "b6": (8, 6), "6": (9, 6),
    "bb7": (9, 7), "b7": (10, 7), "7": (11, 7), "b9": (1, 2), "9": (2, 2), "#9": (3, 2), "11": (5, 4),
    "#11": (6, 4), "b13": (8, 6), "13": (9, 6),
}

_LETTERS = "CDEFGAB"
_NATURAL = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _base_quality(q: str) -> tuple[str, str | None]:
    """quality ที่ไม่รู้จัก → ตัดวงเล็บ extension แล้วลองใหม่ → ไม่งั้นเดาจากตัวอักษรนำ"""
    if q in HARTE_QUALITY:
        return HARTE_QUALITY[q]
    base = q.split("(", 1)[0]
    if base in HARTE_QUALITY:
        return HARTE_QUALITY[base][0], None
    if base.startswith("min") or base.startswith("m"):
        return "m", None
    if base.startswith("dim"):
        return "dim", None
    if base.startswith("aug"):
        return "aug", None
    if base.startswith("sus"):
        return "sus4", None
    return "", None


def parse_harte(label: str) -> tuple[ChordSym | None, str | None]:
    """'C:maj' / 'A:min' / 'G:7' / 'D:maj/3' / 'Bb:hdim7' / 'N' / 'X' → (ChordSym|None, คำเตือน|None)"""
    if not label:
        return None, None
    s = label.strip()
    if s in ("N", "X", "?", ""):
        return None, None
    root, _, rest = s.partition(":")
    pc = keymod.pc_of(root)
    if pc is None:
        return None, f"unknown chord label {label!r} treated as N.C."
    qual, _, bass = rest.partition("/")
    aq, warn = _base_quality(qual)
    bass_pc = bass_deg = None
    if bass:
        d = DEGREES.get(bass.strip())
        if d is not None and d[0] != 0:
            bass_pc = (pc + d[0]) % 12
            bass_deg = d[1]
    return ChordSym(pc, aq, bass_pc, bass_deg, root), warn


def _spell_bass(sym: ChordSym, root_name: str, keyname: str | None) -> str:
    """สะกดเบสด้วยตัวอักษรตามขั้น (D/3 → F#) · ถ้าได้ ## / bb / E# / B# / Cb / Fb ใช้ชื่อตามคีย์แทน"""
    if sym.bass_degree:
        letter = _LETTERS[(_LETTERS.index(root_name[0]) + sym.bass_degree - 1) % 7]
        diff = (sym.bass_pc - _NATURAL[letter]) % 12
        acc = {0: "", 1: "#", 11: "b"}.get(diff)
        if acc is not None:
            name = letter + acc
            if name not in ("E#", "B#", "Cb", "Fb"):
                return name
    return keymod.spell_pc(sym.bass_pc, keyname)


def spell(sym: ChordSym | None, keyname: str | None) -> str | None:
    """ChordSym → label ตาม grammar (root b/# ตามคีย์)"""
    if sym is None:
        return None
    root = keymod.spell_pc(sym.root_pc, keyname)
    out = root + sym.quality
    if sym.bass_pc is not None and sym.bass_pc != sym.root_pc:
        out += "/" + _spell_bass(sym, root, keyname)
    return out


def harte_to_label(label: str, keyname: str | None = None) -> tuple[str | None, str | None]:
    sym, warn = parse_harte(label)
    return spell(sym, keyname), warn


# ---------- ทำความสะอาด segment ----------

def _merge_same(segs: list[dict]) -> list[dict]:
    out: list[dict] = []
    for s in segs:
        if out and out[-1]["label"] == s["label"] and abs(out[-1]["t1"] - s["t0"]) < 1e-6:
            a, b = out[-1], s
            da, db = a["t1"] - a["t0"], b["t1"] - b["t0"]
            if a.get("conf") is not None and b.get("conf") is not None and da + db > 0:
                a["conf"] = (a["conf"] * da + b["conf"] * db) / (da + db)
            a["t1"] = b["t1"]
        else:
            out.append(dict(s))
    return out


def snap_to_beats(segs: list[dict], beats, tol: float | None = None) -> list[dict]:
    """ย้ายขอบระหว่าง segment ไปที่ beat ที่ใกล้ที่สุด ถ้าห่างไม่เกิน tol (ค่าเริ่มต้น min(0.2 s, 0.35×คาบ beat))"""
    if not segs or beats is None or len(beats) == 0:
        return segs
    b = np.asarray(sorted(beats), dtype=np.float64)
    if tol is None:
        period = float(np.median(np.diff(b))) if len(b) > 1 else 0.5
        tol = min(0.2, 0.35 * period)
    out = [dict(s) for s in segs]
    for i in range(len(out) - 1):
        edge = out[i]["t1"]
        j = int(np.argmin(np.abs(b - edge)))
        nb = float(b[j])
        if abs(nb - edge) <= tol and out[i]["t0"] < nb < out[i + 1]["t1"]:
            out[i]["t1"] = nb
            out[i + 1]["t0"] = nb
    return out


def merge_tiny(segs: list[dict], min_len: float) -> list[dict]:
    """ยุบ segment ที่สั้นกว่า min_len เข้าเพื่อนบ้าน (ป้ายเดียวกันก่อน ไม่งั้นตัวที่ยาวกว่า)"""
    segs = [dict(s) for s in segs]
    changed = True
    while changed and len(segs) > 1:
        changed = False
        # สั้นสุดก่อน — ผลไม่ขึ้นกับลำดับการวน
        order = sorted(range(len(segs)), key=lambda i: segs[i]["t1"] - segs[i]["t0"])
        for i in order:
            s = segs[i]
            if s["t1"] - s["t0"] >= min_len:
                break
            left = segs[i - 1] if i > 0 else None
            right = segs[i + 1] if i + 1 < len(segs) else None
            if left and right:
                if left["label"] == right["label"]:
                    target = "left"
                elif left["label"] == s["label"]:
                    target = "left"
                elif right["label"] == s["label"]:
                    target = "right"
                else:
                    target = "left" if (left["t1"] - left["t0"]) >= (right["t1"] - right["t0"]) else "right"
            else:
                target = "left" if left else "right"
            if target == "left":
                left["t1"] = s["t1"]
            else:
                right["t0"] = s["t0"]
            del segs[i]
            segs = _merge_same(segs)
            changed = True
            break
    return segs


def clean_segments(segs: list[dict], beats=None, duration: float | None = None,
                   min_len: float | None = None) -> list[dict]:
    """รวมป้ายซ้ำ → snap → ยุบสั้น → รวมซ้ำ → บังคับเรียง/ไม่ซ้อน/อยู่ใน [0, duration]"""
    segs = sorted((dict(s) for s in segs if s["t1"] > s["t0"]), key=lambda s: s["t0"])
    if not segs:
        return []
    # ต่อให้ติดกัน (ช่องว่างเล็ก ๆ ระหว่าง segment ถือว่าเป็นของ segment ก่อนหน้า)
    for a, b in zip(segs, segs[1:]):
        if b["t0"] < a["t1"]:
            b["t0"] = a["t1"]
        else:
            a["t1"] = b["t0"]
    segs = [s for s in segs if s["t1"] > s["t0"] + 1e-6]
    segs = _merge_same(segs)
    segs = snap_to_beats(segs, beats)
    if min_len is None:
        if beats is not None and len(beats) > 1:
            period = float(np.median(np.diff(np.asarray(sorted(beats)))))
            min_len = max(0.25, 0.45 * period)
        else:
            min_len = 0.3
    segs = merge_tiny(segs, min_len)
    segs = _merge_same(segs)
    if duration is not None and segs:
        segs = [s for s in segs if s["t0"] < duration]
        if segs:
            segs[-1]["t1"] = min(max(segs[-1]["t1"], segs[-1]["t0"]), duration)
    return [s for s in segs if s["t1"] > s["t0"]]


# ---------- lv-chordia inference บน array ----------

CHORD_SR = 22050
CHORD_HOP = 512
MODEL_NAME_FMT = "lv-chordia {ver} ({dict} dict, 5-model ensemble)"


def compute_cqt(y22: np.ndarray) -> np.ndarray:
    """เท่ากับ lv_chordia.extractors.cqt.CQTV2 (hop 512, 36 bin/oct, 288 bin เริ่ม F#0) — [frames, 288]"""
    import librosa
    c = librosa.hybrid_cqt(y22, sr=CHORD_SR, bins_per_octave=36, fmin=librosa.note_to_hz("F#0"), n_bins=288,
                           tuning=None, hop_length=CHORD_HOP).T
    return np.abs(c).astype(np.float32)


def _weight_dir():
    """ตำแหน่ง .sdict ที่ wheel ติดตั้ง (<prefix>/share/lv-chordia/cache_data) — ใช้ตัวแปรของแพ็กเกจเอง"""
    import os
    import lv_chordia.mir.common as c  # type: ignore
    d = getattr(c, "CACHE_DATA_PATH", None)
    if d and os.path.isdir(d):
        return d
    import site
    import sys
    for base in (sys.prefix, sys.base_prefix, getattr(site, "USER_BASE", "") or ""):
        p = os.path.join(base, "share", "lv-chordia", "cache_data")
        if os.path.isdir(p):
            return p
    raise FileNotFoundError("lv-chordia weights not found")


def run_lv_chordia(y22: np.ndarray, device: str, beats=None, chord_dict: str = "submission",
                   use_beats: bool = True, check_cancel=None, cqt: np.ndarray | None = None) -> dict:
    """คืน {'segments': [(t0, t1, harte, conf)], 'cqt': [frames, 288], 'model': str}"""
    import importlib.resources
    import os

    import torch
    import lv_chordia  # type: ignore
    from lv_chordia.chordnet_ismir_naive import ChordNet  # type: ignore
    from lv_chordia.chord_recognition import MODEL_NAMES  # type: ignore
    from lv_chordia.extractors.xhmm_ismir import XHMMDecoder  # type: ignore

    class _Net(ChordNet):
        # ต้นฉบับใช้ .cuda() ตายตัว — ให้ hidden state อยู่ device เดียวกับน้ำหนัก
        def init_hidden(self, batch_size, hidden_dim):
            dev = next(self.parameters()).device
            z = torch.zeros(2, batch_size, hidden_dim // 2, device=dev)
            return (z, z.clone())

    if cqt is None:
        cqt = compute_cqt(y22)
    wdir = _weight_dir()
    x = torch.from_numpy(cqt)
    probs = None
    for name in MODEL_NAMES:
        if check_cancel:
            check_cancel()
        net = _Net(None)
        net.use_gpu = str(device).startswith("cuda")
        sd = torch.load(os.path.join(wdir, f"{name}.sdict"), map_location="cpu", weights_only=True)
        net.load_state_dict(sd["net"])
        del sd
        net.to(device).eval()
        with torch.no_grad():
            out = net.inference(x.to(device))
        probs = list(out) if probs is None else [p + o for p, o in zip(probs, out)]
        del net
    probs = [p / len(MODEL_NAMES) for p in probs]
    if str(device).startswith("cuda"):
        torch.cuda.empty_cache()

    tmpl = importlib.resources.files("lv_chordia.data") / f"{chord_dict}_chord_list.txt"
    with importlib.resources.as_file(tmpl) as tp:
        hmm = XHMMDecoder(template_file=str(tp))

    class _Prop:
        sr = CHORD_SR
        hop_length = CHORD_HOP

    class _Entry:
        prop = _Prop()
        beat = []

    n_frames = probs[0].shape[0]
    entry = _Entry()
    use_b = bool(use_beats and beats is not None and len(beats) > 2)
    if use_b:
        entry.beat = [(float(t), 1) for t in beats]
    beat_arr = hmm._XHMMDecoder__get_beat_arr(entry, n_frames, use_b, False)
    tags = hmm.decode(probs, beat_arr)
    # ความมั่นใจ = posterior เฉลี่ยของคอร์ดที่เลือกในช่วงนั้น (normalize logprob ของทุกคอร์ดต่อเฟรม)
    names, logp = hmm.get_chord_tag_obs(probs)
    logp = logp - logp.max(axis=1, keepdims=True)
    post = np.exp(logp)
    post /= post.sum(axis=1, keepdims=True)
    name_idx = {n: i for i, n in enumerate(names)}
    dt = CHORD_HOP / CHORD_SR
    segs = []
    start = 0
    for i in range(n_frames):
        if i + 1 == n_frames or tags[i + 1] != tags[i]:
            j = name_idx.get(tags[i])
            conf = float(post[start:i + 1, j].mean()) if j is not None else None
            segs.append((start * dt, (i + 1) * dt, tags[i], conf))
            start = i + 1
    return {
        "segments": segs,
        "cqt": cqt,
        "model": MODEL_NAME_FMT.format(ver=getattr(lv_chordia, "__version__", "?"), dict=chord_dict),
    }


def to_aquachord(raw_segments, keyname: str | None) -> tuple[list[dict], list[str]]:
    """[(t0, t1, harte, conf)] → [{'t0','t1','label','conf'}] + คำเตือน (ไม่ซ้ำ)"""
    out, warns = [], []
    for t0, t1, lab, conf in raw_segments:
        sym, w = parse_harte(lab)
        if w and w not in warns:
            warns.append(w)
        out.append({"t0": float(t0), "t1": float(t1), "label": spell(sym, keyname),
                    "conf": None if conf is None else float(conf)})
    return out, warns


def key_evidence(raw_segments) -> list[tuple[float, int, str]]:
    """[(duration, root_pc, triad_class)] สำหรับ key.detect_key (ข้าม N.C.)"""
    ev = []
    for t0, t1, lab, _conf in raw_segments:
        sym, _ = parse_harte(lab)
        if sym is None:
            continue
        ev.append((float(t1) - float(t0), sym.root_pc, keymod.triad_class(sym.quality)))
    return ev
