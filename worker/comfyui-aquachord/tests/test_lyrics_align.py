"""align: VAD + CTC Viterbi (เขียนเอง) บน emission สังเคราะห์ที่รู้คำตอบ"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
import pytest  # noqa: E402

from aquachord_pipeline import align as al  # noqa: E402
from aquachord_pipeline import thai_text as tt  # noqa: E402

CHARS = ["[PAD]", "ก", "า", "ข", "ม", "น", "|", "ร", "ล", "ี"]
VOCAB = al.CtcVocab(ids={c: i for i, c in enumerate(CHARS)}, blank=0, delimiter=6, upper=False)
V = len(CHARS)


def silence(T):
    lp = np.full((T, V), np.log(0.03 / (V - 1)), dtype=np.float32)
    lp[:, 0] = np.log(0.97)
    return lp


def spike(lp, f, ch, p=0.9):
    i = VOCAB.ids[ch]
    lp[f, :] = np.log((1 - p - 0.05) / (V - 2))
    lp[f, 0] = np.log(0.05)
    lp[f, i] = np.log(p)


def put(lp, start, chars, step=2):
    frames = []
    for k, ch in enumerate(chars):
        spike(lp, start + k * step, ch)
        frames.append(start + k * step)
    return frames


def toks(text):
    return al.line_tokens(tt.make_line(0, text), VOCAB)


def test_viterbi_recovers_known_path():
    lp = silence(60)
    fa = put(lp, 10, "กามา")
    paths = al.viterbi(lp, [toks("กามา")], VOCAB.blank)
    assert paths[0].placed
    assert [a for a, _ in paths[0].tok_frames] == fa
    # token ยาวแค่เฟรม spike เดียว (ที่เหลือเป็น blank)
    assert all(a == b for a, b in paths[0].tok_frames)


def test_repeated_char_needs_blank_between():
    lp = silence(40)
    spike(lp, 10, "ก")
    spike(lp, 11, "ก")  # ติดกัน — CTC ต้องมี blank คั่น token ซ้ำ
    paths = al.viterbi(lp, [al.LineTokens([1, 1], [0, 0])], VOCAB.blank)
    (a0, b0), (a1, _) = paths[0].tok_frames
    assert a1 >= b0 + 2


def test_unsung_line_is_skipped_not_forced():
    lp = silence(120)
    fa = put(lp, 10, "กามา")
    put(lp, 40, "รลรล")  # ร้องอย่างอื่นที่ไม่ใช่บรรทัด B
    fc = put(lp, 80, "ลามา")
    paths = al.viterbi(lp, [toks("กามา"), toks("ขาน"), toks("ลามา")], VOCAB.blank)
    assert [p.placed for p in paths] == [True, False, True]
    assert [a for a, _ in paths[0].tok_frames] == fa
    assert [a for a, _ in paths[2].tok_frames] == fc


def test_no_skip_mode_forces_every_line():
    lp = silence(120)
    put(lp, 10, "กามา")
    put(lp, 80, "ลามา")
    paths = al.viterbi(lp, [toks("กามา"), toks("ขาน"), toks("ลามา")], VOCAB.blank, allow_skip=False)
    assert all(p.placed for p in paths)
    ends = [p.tok_frames[-1][1] for p in paths]
    starts = [p.tok_frames[0][0] for p in paths]
    assert starts[1] > ends[0] and starts[2] > ends[1]


def test_wildcard_for_latin_word_does_not_break_line():
    lp = silence(60)
    spike(lp, 10, "ก")
    spike(lp, 12, "า")
    spike(lp, 16, "ร")  # "hello" ฟังเป็นอักษรไทยมั่ว ๆ
    spike(lp, 18, "ล")
    spike(lp, 24, "ม")
    spike(lp, 26, "า")
    ln = tt.make_line(0, "กา hello มา")
    assert [s.kind for s in ln.syllables] == ["thai", "latin", "thai"]
    out = al.align_lines(lp, [ln], VOCAB)
    d = out[0]
    assert d is not None
    t = [s["t0"] for s in d["syllables"]]
    assert t[0] == pytest.approx(10 * al.FRAME_SEC)
    assert t[2] == pytest.approx(24 * al.FRAME_SEC)
    assert t[0] < t[1] < t[2]


def test_out_of_vocab_chars_become_wildcards():
    ln = tt.make_line(0, "กา 12 X")
    lt = al.line_tokens(ln, VOCAB)
    # ตัวเลขถูกอ่านเป็นคำไทย (สิบสอง) ซึ่งอักษรไม่อยู่ใน vocab ทดสอบนี้ -> wildcard ต่อพยางค์
    assert al.WILD in lt.ids
    assert lt.ids[:2] == [VOCAB.ids["ก"], VOCAB.ids["า"]]
    assert len(set(lt.syl)) == len(ln.syllables)


def test_coarse_then_refine_matches_full_resolution():
    lp = silence(400)
    fa = put(lp, 50, "กามา", step=4)
    fc = put(lp, 300, "ลามา", step=4)
    lines = [tt.make_line(0, "กามา"), tt.make_line(1, "ขาน"), tt.make_line(2, "ลามา")]
    full = al.align_lines(lp, lines, VOCAB)
    pooled = al.align_lines(lp, lines, VOCAB, params=al.AlignParams(max_cells=6000))  # -> รวม 2 เฟรม
    assert full[1] is None and pooled[1] is None
    for got in (full, pooled):
        assert [s["t0"] for s in got[0]["syllables"]] == pytest.approx([fa[0] * al.FRAME_SEC, fa[2] * al.FRAME_SEC])
        assert [s["t0"] for s in got[2]["syllables"]] == pytest.approx([fc[0] * al.FRAME_SEC, fc[2] * al.FRAME_SEC])


def test_silence_compression_keeps_real_times():
    lp = silence(3000)  # 60 วิ ส่วนใหญ่เงียบ
    fa = put(lp, 200, "กามา")
    fc = put(lp, 2500, "ลามา")
    voiced = np.zeros(3000, dtype=bool)
    voiced[195:215] = True
    voiced[2495:2515] = True
    assert al._keep_frames(voiced).size < 100
    out = al.align_lines(lp, [tt.make_line(0, "กามา"), tt.make_line(1, "ลามา")], VOCAB, voiced)
    assert out[0]["syllables"][0]["t0"] == pytest.approx(fa[0] * al.FRAME_SEC)
    assert out[1]["syllables"][1]["t0"] == pytest.approx(fc[2] * al.FRAME_SEC)


def test_line_output_is_monotonic_and_bounded():
    lp = silence(200)
    put(lp, 20, "กามา")
    put(lp, 120, "ลามา")
    voiced = np.zeros(200, dtype=bool)
    voiced[18:40] = True
    voiced[118:140] = True
    out = al.align_lines(lp, [tt.make_line(0, "กามา"), tt.make_line(1, "ลามา")], VOCAB, voiced)
    prev = 0.0
    for d in out:
        assert d["t0"] < d["t1"]
        for s in d["syllables"]:
            assert s["t0"] >= prev and s["t1"] > s["t0"]
            prev = s["t0"]
    # พยางค์สุดท้ายหยุดที่สิ้นเสียง (เฟรม 40) ไม่ลากไปถึงบรรทัดถัดไป
    assert out[0]["t1"] <= 40 * al.FRAME_SEC + 1e-6


def test_delimiter_is_merged_into_blank():
    lp = silence(40)
    put(lp, 10, "กา")
    spike(lp, 14, "|", p=0.95)
    put(lp, 18, "มา")
    merged = al.merge_delimiter_into_blank(lp, VOCAB)
    assert merged[14, 0] > np.log(0.9)
    paths = al.viterbi(merged, [toks("กามา")], VOCAB.blank)
    assert [a for a, _ in paths[0].tok_frames] == [10, 12, 18, 20]


def test_empty_and_impossible_inputs():
    assert al.viterbi(silence(10), [], 0) == []
    # บรรทัดยาวกว่าจำนวนเฟรม -> วางไม่ได้ ไม่ crash
    paths = al.viterbi(silence(3), [toks("กามากามา")], VOCAB.blank)
    assert paths == [al.LinePath(False)]


# ---------------------------------------------------------------- เสียง / VAD


def tone(sec, sr=16000, amp=0.3, f=220.0):
    t = np.arange(int(sec * sr)) / sr
    return (amp * np.sin(2 * np.pi * f * t)).astype(np.float32)


def test_to_mono_16k_handles_stereo_nan_and_rates():
    x = np.stack([tone(1.0, 44100), tone(1.0, 44100)])  # (ch, n)
    x[0, 100] = np.nan
    y = al.to_mono_16k(x, 44100)
    assert y.dtype == np.float32 and y.ndim == 1
    assert abs(len(y) - 16000) <= 2
    assert np.isfinite(y).all()
    y2 = al.to_mono_16k(x.T, 44100)  # (n, ch)
    assert abs(len(y2) - 16000) <= 2
    with pytest.raises(ValueError):
        al.to_mono_16k(np.zeros((2, 2, 2)), 16000)
    with pytest.raises(ValueError):
        al.to_mono_16k(np.zeros(10), 0)


def test_vad_regions_and_chunk_plan():
    sil = np.zeros(16000 * 2, dtype=np.float32)
    wav = np.concatenate([sil, tone(3), sil, tone(4), sil])
    db = al.frame_db(wav)
    m = al.voiced_mask(db)
    regs = al.voiced_regions(m)
    assert len(regs) == 2
    (a0, a1), (b0, b1) = regs
    assert abs(a0 * al.FRAME_SEC - 2.0) < 0.2 and abs(a1 * al.FRAME_SEC - 5.0) < 0.2
    assert abs(b0 * al.FRAME_SEC - 7.0) < 0.2 and abs(b1 * al.FRAME_SEC - 11.0) < 0.2
    chunks = al.plan_chunks(m, db, max_sec=25.0, max_gap_sec=3.0)
    assert len(chunks) == 1  # ช่องว่าง 2 วิ < 3 วิ -> รวมเป็นก้อนเดียว


def test_long_region_is_split_under_limit():
    wav = tone(62.0)
    db = al.frame_db(wav)
    m = al.voiced_mask(db)
    chunks = al.plan_chunks(m, db, max_sec=25.0)
    assert len(chunks) >= 3
    assert all((b - a) * al.FRAME_SEC <= 25.0 + 1e-6 for a, b in chunks)
    assert chunks[0][0] == 0 and chunks[-1][1] == len(m)


def test_silence_has_no_regions():
    db = al.frame_db(np.zeros(16000 * 3, dtype=np.float32))
    assert not al.voiced_mask(db).any()
