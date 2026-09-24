"""เพลงสังเคราะห์ที่รู้คอร์ด/จังหวะ/ทำนองแน่นอน (numpy ล้วน ไม่ใช้เพลงมีลิขสิทธิ์)

ใช้ทั้งใน pytest (สั้น) และวัดความแม่นยำคอร์ดแบบ majmin (python tests/synth.py out.wav --eval result.json)
"""
from __future__ import annotations

import json
import sys

import numpy as np

NAMES = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7,
         "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}
QUAL = {"": [0, 4, 7], "m": [0, 3, 7], "7": [0, 4, 7, 10], "m7": [0, 3, 7, 10], "maj7": [0, 4, 7, 11]}

# Gm (คีย์เดียวกับเพลงทดสอบ) — 2 ห้องต่อคอร์ด
DEFAULT_PROG = ["Gm", "Eb", "Bb", "F", "Cm", "D7", "Gm", "Gm", "Eb", "F", "Bb", "Gm", "Cm", "F", "D7", "Gm"]


def parse(label):
    if label is None:
        return None
    root = label[:2] if len(label) > 1 and label[1] in "#b" else label[:1]
    q = label[len(root):].split("/")[0]
    return NAMES[root], q


def majmin(label):
    """label → (root_pc, 'maj'|'min') หรือ None (N.C.) — แบบ MIREX majmin (7→maj, m7→min, อื่น ๆ ตามตัว m)"""
    p = parse(label)
    if p is None:
        return None
    pc, q = p
    minor = q.startswith("m") and not q.startswith("maj")
    return pc, "min" if minor else "maj"


def _tone(f0, dur, sr, harmonics, decay, attack=0.005, vibrato=0.0, seed=0):
    n = int(dur * sr)
    t = np.arange(n) / sr
    ph_mod = 0.0
    if vibrato:
        ph_mod = vibrato * np.sin(2 * np.pi * 5.5 * t) / 5.5
    rng = np.random.default_rng(seed)
    y = np.zeros(n)
    for h, amp in enumerate(harmonics, start=1):
        if f0 * h > sr * 0.45:
            break
        y += amp * np.sin(2 * np.pi * f0 * h * (t + ph_mod) + rng.uniform(0, 6.28))
    env = np.minimum(1.0, t / max(attack, 1e-4)) * np.exp(-decay * t)
    return y * env


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


def make_song(prog=None, bpm=96.0, sr=44100, beats_per_chord=8, melody=True, seed=7, lead_in=0.5):
    """คืน (stereo [2, n] float32, sr, truth) — truth = {'chords': [(t0,t1,label)], 'beats', 'downbeats', 'notes'}"""
    prog = prog or DEFAULT_PROG
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    total = lead_in + len(prog) * beats_per_chord * beat + 1.0
    n = int(total * sr)
    L = np.zeros(n)
    R = np.zeros(n)

    def add(sig, t0, pan=0.0, gain=1.0):
        s0 = int(t0 * sr)
        e = min(n, s0 + len(sig))
        if e <= s0:
            return
        L[s0:e] += sig[: e - s0] * gain * (1 - pan) / 2 * 2
        R[s0:e] += sig[: e - s0] * gain * (1 + pan) / 2 * 2

    truth_chords, beats, downbeats, notes = [], [], [], []
    for ci, lab in enumerate(prog):
        pc, q = parse(lab)
        c0 = lead_in + ci * beats_per_chord * beat
        truth_chords.append((round(c0, 4), round(c0 + beats_per_chord * beat, 4), lab))
        tones = [48 + ((pc + iv) % 12) + (12 if (pc + iv) % 12 < 5 else 0) for iv in QUAL[q]]
        # pad: ทั้งคอร์ดยาวตลอด 2 ห้อง (สร้างใหม่ทุกห้อง)
        for bar in range(beats_per_chord // 4):
            t_bar = c0 + bar * 4 * beat
            for k, m in enumerate(tones):
                add(_tone(midi_hz(m), 4 * beat + 0.05, sr, [1, .5, .33, .25, .2, .15], 0.35, attack=0.04, seed=k),
                    t_bar, pan=(-0.4 + 0.25 * k), gain=0.10)
        for b in range(beats_per_chord):
            tb = c0 + b * beat
            beats.append(round(tb, 4))
            if b % 4 == 0:
                downbeats.append(round(tb, 4))
            # bass: root octave 2 ทุกครึ่งจังหวะ
            for h in (0, 0.5):
                add(_tone(midi_hz(36 + pc), beat * 0.48, sr, [1, .6, .3, .1], 5.0, attack=0.004), tb + h * beat,
                    gain=0.35)
            # drums
            if b % 2 == 0:  # kick
                kt = np.arange(int(0.18 * sr)) / sr
                kick = np.sin(2 * np.pi * (50 + 70 * np.exp(-kt * 30)) * kt) * np.exp(-kt * 18)
                add(kick, tb, gain=0.8)
            else:  # snare
                st = np.arange(int(0.15 * sr)) / sr
                sn = rng.standard_normal(len(st)) * np.exp(-st * 25) * 0.5 + np.sin(2 * np.pi * 190 * st) * np.exp(-st * 30)
                add(sn, tb, gain=0.35)
            for h in (0, 0.5):  # hat
                ht = np.arange(int(0.04 * sr)) / sr
                hat = np.diff(rng.standard_normal(len(ht) + 1)) * np.exp(-ht * 90)
                add(hat, tb + h * beat, pan=0.3, gain=0.08)
        if melody:
            # ทำนอง: โน้ตในคอร์ด (octave 4–5) ครั้งละ 1 beat, เว้นทุก beat ที่ 4
            for b in range(beats_per_chord):
                if b % 4 == 3:
                    continue
                m = 60 + ((pc + QUAL[q][b % len(QUAL[q])]) % 12)
                if m < 64:
                    m += 12
                t0 = c0 + b * beat
                d = beat * 0.9
                add(_tone(midi_hz(m), d, sr, [1, .45, .3, .2, .12, .08, .05], 0.8, attack=0.03, vibrato=0.004),
                    t0, gain=0.22)
                notes.append((round(t0, 4), round(t0 + d, 4), m))
    y = np.stack([L, R])
    y = y / (np.max(np.abs(y)) + 1e-9) * 0.9
    return y.astype(np.float32), sr, {"chords": truth_chords, "beats": beats, "downbeats": downbeats,
                                      "notes": notes, "bpm": bpm}


def majmin_accuracy(truth_chords, pred_chords, hop=0.01):
    """สัดส่วนเวลาที่ (root, maj/min) ตรงกัน เทียบเฉพาะช่วงที่ truth มีคอร์ด"""
    if not truth_chords:
        return None
    end = max(t1 for _, t1, _ in truth_chords)
    ok = tot = 0
    for k in range(int(end / hop)):
        t = (k + 0.5) * hop
        tl = next((lab for a, b, lab in truth_chords if a <= t < b), None)
        if tl is None:
            continue
        tot += 1
        pl = next((c["label"] for c in pred_chords if c["t0"] <= t < c["t1"]), None)
        if majmin(pl) == majmin(tl):
            ok += 1
    return ok / tot if tot else None


def write_wav(path, y, sr):
    import soundfile as sf
    sf.write(path, y.T, sr, subtype="PCM_16")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--eval", help="TranscriptionResult JSON to score against the truth of this synth")
    a = ap.parse_args()
    y, sr, truth = make_song()
    write_wav(a.out, y, sr)
    with open(a.out + ".truth.json", "w", encoding="utf-8") as f:
        json.dump(truth, f)
    print(f"wrote {a.out} ({y.shape[1] / sr:.1f}s) chords={len(truth['chords'])} bpm={truth['bpm']}")
    if a.eval:
        res = json.load(open(a.eval, encoding="utf-8"))
        acc = majmin_accuracy(truth["chords"], res.get("chords", []))
        print(json.dumps({"majminAccuracy": None if acc is None else round(acc, 4), "key": res.get("key"),
                          "tempo": res.get("tempo")}))
    sys.exit(0)
