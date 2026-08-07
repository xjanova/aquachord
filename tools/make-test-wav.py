#!/usr/bin/env python3
"""make-test-wav.py — สร้างไฟล์เสียงทดสอบ (C–G–Am–F, 120 BPM) ให้ tools/e2e-lyrics.cjs
ใช้: python3 tools/make-test-wav.py [ไฟล์ปลายทาง]   (ค่าเริ่มต้น: /tmp/aquachord-test.wav)
ไม่ใช้เพลงมีลิขสิทธิ์ — สังเคราะห์คลื่นเสียงเองทั้งหมด"""
import math
import random
import struct
import sys
import wave

SR = 22050
BPM = 120
BEAT = 60 / BPM
PROG = [('C', [48, 52, 55], 36), ('G', [47, 50, 55], 31),
        ('Am', [45, 48, 52], 33), ('F', [45, 48, 53], 29)]


def main(out_path):
    random.seed(7)
    total = int((len(PROG) * 4 * BEAT + 0.5) * SR)
    buf = [0.0] * total

    def add(midi, t0, dur, amp):
        f0 = 440 * 2 ** ((midi - 69) / 12)
        s0 = int(t0 * SR)
        phases = [random.random() * 6.28 for _ in range(7)]
        for i in range(int(dur * SR)):
            idx = s0 + i
            if idx >= total:
                break
            t = i / SR
            env = math.exp(-2.0 * t) * min(1, t * 200)
            v = 0.0
            for h in range(1, 7):
                if f0 * h > SR * 0.45:
                    break
                v += math.sin(2 * math.pi * f0 * h * t + phases[h - 1]) / h
            buf[idx] += v * amp * env

    t = 0.25
    for _, notes, bass in PROG:
        for b in range(4):
            tb = t + b * BEAT
            add(bass, tb, BEAT * 1.6, 0.55)
            for i, n in enumerate(notes):
                add(n, tb + i * 0.014, BEAT * 1.3, 0.28)
        t += 4 * BEAT

    peak = max(abs(x) for x in buf) or 1.0
    with wave.open(out_path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b''.join(
            struct.pack('<h', int(max(-1, min(1, x / peak * 0.85)) * 32000)) for x in buf))
    print('เขียนไฟล์แล้ว: %s (%.1f วินาที)' % (out_path, total / SR))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '/tmp/aquachord-test.wav')
