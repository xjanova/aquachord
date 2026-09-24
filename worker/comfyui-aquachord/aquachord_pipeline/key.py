"""คีย์รวมของเพลง (Krumhansl-Kessler บน chroma + ตัดสินด้วยคอร์ด) และการสะกดชื่อโน้ต b/# ตามคีย์

กติกาการสะกด (ตรงกับ music.js ของ AquaChord):
- คีย์แฟลต F Bb Eb Ab Db Gb และ minor คู่ขนาน Dm Gm Cm Fm Bbm Ebm → ใช้ชื่อแฟลต
- คีย์ชาร์ป G D A E B F# (+ Em Bm F#m C#m G#m) → ใช้ชื่อชาร์ป
- C / Am (ไม่มีเครื่องหมาย) → แบบที่นักดนตรีเขียนทั่วไป: C# Eb F# Ab Bb
"""
from __future__ import annotations

import numpy as np

SHARP = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
FLAT = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
NEUTRAL = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")

# ชื่อคีย์ที่ใช้ (major / minor) ต่อ pitch class ของโทนิก
MAJOR_KEY_NAMES = ("C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
MINOR_KEY_NAMES = ("Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "Bbm", "Bm")

FLAT_KEYS = frozenset({"F", "Bb", "Eb", "Ab", "Db", "Gb", "Dm", "Gm", "Cm", "Fm", "Bbm", "Ebm"})
NEUTRAL_KEYS = frozenset({"C", "Am"})

PC_OF = {"C": 0, "C#": 1, "DB": 1, "D": 2, "D#": 3, "EB": 3, "E": 4, "FB": 4, "E#": 5, "F": 5, "F#": 6,
         "GB": 6, "G": 7, "G#": 8, "AB": 8, "A": 9, "A#": 10, "BB": 10, "B": 11, "CB": 11, "B#": 0}

# Krumhansl & Kessler (1982)
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# คอร์ดไดอาโทนิก (ช่วงจากโทนิก, ชนิด triad) — minor รวม harmonic (V, vii°)
_DIATONIC_MAJOR = {(0, "maj"), (2, "min"), (4, "min"), (5, "maj"), (7, "maj"), (9, "min"), (11, "dim")}
_DIATONIC_MINOR = {(0, "min"), (2, "dim"), (3, "maj"), (5, "min"), (7, "min"), (7, "maj"), (8, "maj"),
                   (10, "maj"), (11, "dim")}


def pc_of(name: str) -> int | None:
    return PC_OF.get(name.strip().upper()) if name else None


def key_name(tonic_pc: int, minor: bool) -> str:
    return (MINOR_KEY_NAMES if minor else MAJOR_KEY_NAMES)[tonic_pc % 12]


def parse_key(key: str | None) -> tuple[int, bool] | None:
    if not key:
        return None
    k = key.strip()
    minor = k.endswith("m") and not k.endswith("maj")
    root = k[:-1] if minor else k
    pc = pc_of(root)
    return None if pc is None else (pc, minor)


def names_for_key(key: str | None):
    if key in FLAT_KEYS:
        return FLAT
    if key is None or key in NEUTRAL_KEYS:
        return NEUTRAL
    return SHARP


def spell_pc(pc: int, key: str | None) -> str:
    return names_for_key(key)[pc % 12]


def triad_class(quality: str) -> str:
    """คุณภาพ AquaChord → กลุ่ม triad สำหรับตัดสินคีย์"""
    if quality.startswith("m7b5") or quality.startswith("dim"):
        return "dim"
    if quality.startswith("maj"):
        return "maj"
    if quality.startswith("m"):
        return "min"
    if quality.startswith("aug"):
        return "aug"
    if quality.startswith("sus") or quality == "7sus4":
        return "sus"
    return "maj"


def chroma_from_cqt(cqt_mag: np.ndarray, fmin_pc: int = 6, bins_per_semitone: int = 3) -> np.ndarray:
    """CQT magnitude [frames, bins] (เริ่มที่ F#0, 36 bin/octave เหมือน lv-chordia) → โปรไฟล์ 12 มิติ"""
    if cqt_mag is None or cqt_mag.size == 0:
        return np.zeros(12)
    x = np.log1p(np.asarray(cqt_mag, dtype=np.float64) * 100.0)
    per_bin = x.mean(axis=0)
    prof = np.zeros(12)
    for b, v in enumerate(per_bin):
        semi = int(round(b / bins_per_semitone))
        prof[(fmin_pc + semi) % 12] += v
    return prof


def chroma_from_audio(y: np.ndarray, sr: int) -> np.ndarray:
    import librosa
    c = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=4096)
    return np.log1p(c * 10.0).mean(axis=1)


def _corr(a, b) -> float:
    a = a - a.mean()
    b = b - b.mean()
    d = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / d) if d > 0 else 0.0


def detect_key(chroma: np.ndarray | None, chords: list[tuple[float, int, str]] | None,
               chord_weight: float = 1.0) -> tuple[str | None, float, dict]:
    """chroma: 12 มิติ (อาจ None) · chords: [(duration, root_pc, triad_class)] → (ชื่อคีย์, ความมั่นใจ 0–1, debug)

    คะแนน = corr(chroma, KK profile) + chord_weight × (สัดส่วนเวลาที่คอร์ดเป็นไดอาโทนิก
            + 0.6 × สัดส่วนเวลาของคอร์ดโทนิก + 0.15 ถ้าคอร์ดแรก/สุดท้ายเป็นโทนิก)
    ส่วนโทนิกช่วยแยกคีย์คู่ขนาน (Bb vs Gm) ที่ chroma แทบเหมือนกัน
    """
    have_chroma = chroma is not None and np.asarray(chroma).sum() > 0
    chords = [c for c in (chords or []) if c[0] > 0]
    total = sum(c[0] for c in chords)
    if not have_chroma and total <= 0:
        return None, 0.0, {}
    scores = {}
    for tonic in range(12):
        for minor in (False, True):
            s = 0.0
            if have_chroma:
                prof = np.roll(KK_MINOR if minor else KK_MAJOR, tonic)
                s += _corr(np.asarray(chroma, dtype=np.float64), prof)
            if total > 0:
                dia = _DIATONIC_MINOR if minor else _DIATONIC_MAJOR
                tonic_q = "min" if minor else "maj"
                fit = sum(d for d, r, q in chords if ((r - tonic) % 12, q) in dia) / total
                ton = sum(d for d, r, q in chords if (r - tonic) % 12 == 0 and q == tonic_q) / total
                edge = 0.0
                for d, r, q in (chords[0], chords[-1]):
                    if (r - tonic) % 12 == 0 and q == tonic_q:
                        edge += 0.075
                s += chord_weight * (fit + 0.6 * ton + edge)
            scores[key_name(tonic, minor)] = s
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    best, s1 = ranked[0]
    s2 = ranked[1][1] if len(ranked) > 1 else s1 - 1.0
    conf = float(np.clip((s1 - s2) * 4.0, 0.0, 1.0))
    return best, conf, {"ranked": ranked[:4]}
