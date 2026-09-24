"""ข้อความเนื้อเพลง (ไทยเป็นหลัก) — เตรียมเนื้อที่ผู้ใช้วาง/ข้อความจาก ASR ให้พร้อมจัดเวลา

หน้าที่ของไฟล์นี้ (ไม่มีโมเดล ไม่มี torch — ทดสอบได้เร็ว):
- ตัด tag ท่อน [Verse]/[Chorus]/(ท่อนฮุก)/"Chorus:" ออก แต่จำไว้เป็น hint ของท่อน
- ยุบช่องว่าง, ขยาย "ๆ" เป็นคำซ้ำ (เด็กๆ -> เด็กเด็ก), ตัวเลข -> คำอ่านไทย, ตัด ฯลฯ / ฯ
- คำละติน (อังกฤษ) เก็บไว้ในข้อความแต่ติดธง kind='latin' — โมเดล CTC ไทยไม่มีอักษรละติน
  ตัวจัดเวลาจะใช้ token wildcard แทน (ไม่ทำให้ทั้งบรรทัดพัง)
- ตัดพยางค์ไทยด้วย pythainlp syllable_tokenize (engine han_solo ถ้าใช้ได้, สำรอง dict)

ข้อความแสดงผล (LyricLine.text) = ตามที่ผู้ใช้เขียน (คง ๆ / ตัวเลข) ส่วนพยางค์ (Syllable.text)
= สิ่งที่ร้องจริงหลัง normalise — ใช้ใต้โน้ตและจัดเวลา
"""
from __future__ import annotations

import re
import threading
import unicodedata
from dataclasses import dataclass, field

# ---------------------------------------------------------------- ชนิดข้อมูล


@dataclass
class Syllable:
    text: str  # พยางค์ที่ร้องจริง (หลังขยาย ๆ / ตัวเลข)
    kind: str  # 'thai' | 'latin' | 'other'


@dataclass
class LyricLine:
    index: int  # ลำดับในเนื้อที่ใช้ได้ (0..n-1)
    text: str  # ข้อความแสดงผล (ตัด tag/ยุบช่องว่างแล้ว)
    spoken: str  # ข้อความที่ร้องจริง (ไม่มีวรรคตอน)
    syllables: list[Syllable]
    section: str | None = None  # hint ท่อนจาก tag เช่น 'verse', 'chorus'
    stanza: int = 0  # บล็อกที่คั่นด้วยบรรทัดว่าง

    @property
    def alignable(self) -> bool:
        return any(s.kind == "thai" for s in self.syllables)


@dataclass
class Lyrics:
    lines: list[LyricLine] = field(default_factory=list)

    @property
    def text(self) -> str:
        return "\n".join(ln.text for ln in self.lines)


# ---------------------------------------------------------------- ค่าคงที่

_THAI_DIGITS = str.maketrans("๐๑๒๓๔๕๖๗๘๙", "0123456789")
_THAI_RANGE = "ก-๎"  # ก..๎ (ไม่รวมเลขไทย ๐-๙ และ ๏ ๚ ๛)
_RE_THAI_CHAR = re.compile(f"[{_THAI_RANGE}]")
_RE_LATIN_CHAR = re.compile(r"[A-Za-z]")

# คำระบุท่อน -> label มาตรฐาน (ภาษาอังกฤษตัวเล็ก เหมือน sections[] ใน TranscriptionResult)
_SECTION_WORDS = [
    (r"pre[\s-]?chorus|pre[\s-]?hook|ก่อนฮุก|ก่อนท่อนฮุก", "pre-chorus"),
    (r"post[\s-]?chorus", "post-chorus"),
    (r"chorus|hook|refrain|ท่อนฮุก|ฮุก|ท่อนสร้อย|สร้อย|คอรัส", "chorus"),
    (r"verse|ท่อนแรก|ท่อนที่\s*\d+|ท่อน\s*\d+|เวิร์ส", "verse"),
    (r"bridge|ท่อนแยก|ท่อนเชื่อม|บริดจ์", "bridge"),
    (r"intro|อินโทร|เกริ่น", "intro"),
    (r"outro|ending|coda|เอาท์โทร|ท่อนจบ|ตอนจบ", "outro"),
    (r"interlude|break|instrumental|solo|ดนตรี|โซโล่|โซโล", "instrumental"),
    (r"spoken|speech|rap|แร็พ|พูด", "spoken"),
]
_RE_SECTION = [(re.compile(rf"^(?:{p})(?:\s*\d+)?$", re.IGNORECASE), lab) for p, lab in _SECTION_WORDS]
# เครื่องหมายสั่งซ้ำที่ไม่ได้ร้อง: (ซ้ำ), ซ้ำ *, (*), x2, ×2, *2, (ซ้ำท่อน **)
_RE_REPEAT = re.compile(
    r"^(?:\(?\s*(?:ซ้ำ(?:ท่อน)?\s*\**\s*\d*|\*+|[x×]\s*\d+|\*\s*\d+|repeat(?:\s*x?\s*\d+)?)\s*\)?)$",
    re.IGNORECASE,
)
_RE_BRACKET_TAG_LINE = re.compile(r"^\s*\[\s*([^\]]{1,60}?)\s*\]\s*[:：]?\s*$")
_RE_LEADING_BRACKET_TAG = re.compile(r"^\s*\[\s*([^\]]{1,60}?)\s*\]\s*[:：]?\s*(.+)$")
_RE_PAREN_LINE = re.compile(r"^\s*[\(（【{<]\s*([^\)）】}>]{1,60}?)\s*[\)）】}>]\s*[:：]?\s*$")
_RE_KEYWORD_LINE = re.compile(r"^\s*([^\s:：.][^:：]{0,30}?)\s*[:：.]?\s*$")
_RE_LEADING_MARKERS = re.compile(r"^\s*(?:\*+|#+|-+|•+|>+)\s*")
_RE_TRAILING_REPEAT = re.compile(r"\s*[\(（]\s*(?:ซ้ำ[^\)）]{0,12}|[x×]\s*\d+|\*+)\s*[\)）]\s*$", re.IGNORECASE)
# วรรคตอน/สัญลักษณ์ที่ไม่ออกเสียง — ใช้ตัดออกจากข้อความที่ร้อง
_RE_PUNCT = re.compile(r"[\"“”„‘’'`´.,!?;:()\[\]{}<>《》「」『』…\-–—~/\\|*#@&%^_=+♪♫♬♩•·、。，！？：；]")
_RE_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
_RE_TOKEN = re.compile(rf"[{_THAI_RANGE}]+|[A-Za-z]+(?:['’][A-Za-z]+)*|\d+|\S")

_MAX_LINE_CHARS = 400  # บรรทัดยาวผิดปกติ (วางข้อความทั้งก้อน) — ตัดเก็บไว้แค่นี้กัน DP ระเบิด


# ---------------------------------------------------------------- pythainlp


_engine_lock = threading.Lock()
_engine: str | None = None


def syllable_engine() -> str:
    """engine ตัดพยางค์ที่ใช้ได้จริงบนเครื่องนี้ — han_solo (ต้องมี python-crfsuite) ไม่งั้น dict"""
    global _engine
    with _engine_lock:
        if _engine is None:
            from pythainlp.tokenize import syllable_tokenize

            try:
                if syllable_tokenize("ทดสอบ", engine="han_solo"):
                    _engine = "han_solo"
            except Exception:  # noqa: BLE001 — ไม่มี crfsuite/โมเดลเสีย -> ใช้ dict
                _engine = None
            if _engine is None:
                _engine = "dict"
        return _engine


def thai_syllables(run: str) -> list[str]:
    """ตัดพยางค์ข้อความไทยล้วน (ไม่มีช่องว่าง) — คืนลิสต์พยางค์ที่ต่อกันได้ข้อความเดิม"""
    from pythainlp.tokenize import syllable_tokenize

    run = run.strip()
    if not run:
        return []
    try:
        parts = syllable_tokenize(run, engine=syllable_engine())
    except Exception:  # noqa: BLE001
        parts = syllable_tokenize(run, engine="dict")
    parts = [p for p in parts if p and not p.isspace()]
    # กันกรณี engine คืนข้อความไม่ครบ (ไม่ควรเกิด) — ใช้ทั้งก้อนเป็นพยางค์เดียวแทนการทิ้งตัวอักษร
    if "".join(parts) != run:
        return [run]
    return parts


def _last_word(prev: str) -> str:
    """คำสุดท้ายก่อน ๆ — ใช้ตัดคำ newmm กับช่วงไทยท้ายสุด"""
    prev = prev.rstrip()
    if not prev:
        return ""
    m = re.search(rf"[{_THAI_RANGE}]+$", prev)
    if not m:
        m2 = re.search(r"\S+$", prev)
        return m2.group(0) if m2 else ""
    tail = m.group(0)
    try:
        from pythainlp.tokenize import word_tokenize

        toks = [t for t in word_tokenize(tail, engine="newmm", keep_whitespace=False) if t.strip()]
    except Exception:  # noqa: BLE001
        toks = []
    return toks[-1] if toks else tail


def expand_mai_yamok(s: str) -> str:
    """เด็กๆ -> เด็กเด็ก, ช้า ๆ -> ช้าช้า (ช่องว่างหน้า ๆ ถูกกลืน); ๆ ลอย ๆ ต้นบรรทัดถูกทิ้ง"""
    if "ๆ" not in s:
        return s
    buf = ""
    for ch in s:
        if ch == "ๆ":
            prev = buf.rstrip()
            word = _last_word(prev)
            buf = prev + word
        else:
            buf += ch
    return buf


def _read_digits(d: str) -> str:
    from pythainlp.util import num_to_thaiword

    return "".join(num_to_thaiword(int(c)) for c in d)


def number_to_thai(num: str) -> str:
    """'100' -> 'หนึ่งร้อย', '1,000' -> 'หนึ่งพัน', '3.5' -> 'สามจุดห้า', '007' -> 'ศูนย์ศูนย์เจ็ด'"""
    from pythainlp.util import num_to_thaiword

    num = num.translate(_THAI_DIGITS)
    if re.fullmatch(r"\d{1,3}(?:,\d{3})+", num):
        num = num.replace(",", "")
    if "," in num:  # 1,2,3 — อ่านทีละกลุ่ม
        return "".join(number_to_thai(p) for p in num.split(",") if p)
    if "." in num:
        parts = [p for p in num.split(".") if p]
        if len(parts) == 2:
            return number_to_thai(parts[0]) + "จุด" + _read_digits(parts[1])
        return "".join(number_to_thai(p) for p in parts)
    if len(num) > 1 and num.startswith("0") or len(num) > 15:
        return _read_digits(num)
    return num_to_thaiword(int(num))


def _normalize_thai(s: str) -> str:
    """จัดลำดับวรรณยุกต์/สระซ้อนที่พิมพ์ผิดลำดับ + NFC"""
    s = unicodedata.normalize("NFC", s)
    s = s.replace("ํา", "ำ")  # ํ + า -> ำ
    try:
        from pythainlp.util import normalize

        s = normalize(s)
    except Exception:  # noqa: BLE001
        pass
    return s


# ---------------------------------------------------------------- tag ท่อน


def _section_label(tag: str) -> str | None:
    t = re.sub(r"\s+", " ", tag.strip().strip("*").strip()).lower()
    t = re.sub(r"[\s:：.]+$", "", t)
    if not t:
        return None
    for rx, lab in _RE_SECTION:
        if rx.match(t):
            return lab
    return None


def _classify_line(raw: str) -> tuple[str, str | None, str]:
    """คืน (ชนิด, section, ข้อความ) ชนิด = 'blank' | 'tag' | 'repeat' | 'text'"""
    s = raw.strip()
    if not s:
        return "blank", None, ""
    m = _RE_BRACKET_TAG_LINE.match(s)
    if m:  # [Verse] / [Chorus 2] / [ดนตรี] — วงเล็บเหลี่ยมทั้งบรรทัด = tag เสมอ
        return "tag", _section_label(m.group(1)) or _clean_tag(m.group(1)), ""
    m = _RE_PAREN_LINE.match(s)
    if m:  # (Chorus) = tag, (ซ้ำ *) = คำสั่งซ้ำ, (โอ้ โอ้) = เสียงประสานที่ร้องจริง
        inner = m.group(1)
        lab = _section_label(inner)
        if lab:
            return "tag", lab, ""
        if _RE_REPEAT.match(inner.strip()):
            return "repeat", None, ""
        return "text", None, inner
    if _RE_REPEAT.match(s):
        return "repeat", None, ""
    m = _RE_KEYWORD_LINE.match(s)
    if m and (s.endswith((":", "：")) or len(s) <= 24):
        lab = _section_label(m.group(1))
        if lab:  # "Chorus:", "ท่อนฮุก", "Verse 2"
            return "tag", lab, ""
    m = _RE_LEADING_BRACKET_TAG.match(s)
    if m:  # "[Chorus] รถทัวร์..." — tag นำหน้าบรรทัดที่มีเนื้อ
        return "text", _section_label(m.group(1)) or _clean_tag(m.group(1)), m.group(2)
    return "text", None, s


def _clean_tag(tag: str) -> str | None:
    t = re.sub(r"\s+", " ", tag).strip().lower()
    t = re.sub(r"[^\w\s\-]", "", t).strip()
    return t[:30] or None


# ---------------------------------------------------------------- บรรทัด -> พยางค์


def clean_display(s: str) -> str:
    """ข้อความแสดงผล: ตัดเครื่องหมายนำบรรทัด/คำสั่งซ้ำท้ายบรรทัด ยุบช่องว่าง ตัด control char"""
    s = "".join(ch for ch in s if ch in "\t " or unicodedata.category(ch)[0] != "C")
    s = _RE_LEADING_MARKERS.sub("", s)
    s = _RE_TRAILING_REPEAT.sub("", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:_MAX_LINE_CHARS]


def spoken_form(display: str, language: str = "th") -> str:
    """ข้อความที่ร้องจริง: ตัด ฯลฯ/ฯ, ตัวเลข -> คำไทย, ขยาย ๆ, ตัดวรรคตอน"""
    s = display.translate(_THAI_DIGITS)
    s = s.replace("ฯลฯ", " ").replace("ฯ", "")
    has_thai = bool(_RE_THAI_CHAR.search(s))
    if has_thai or language == "th":
        s = _RE_NUMBER.sub(lambda m: " " + number_to_thai(m.group(0)) + " ", s)
    s = expand_mai_yamok(s)
    s = _RE_PUNCT.sub(" ", s)
    s = _normalize_thai(s)
    return re.sub(r"\s+", " ", s).strip()


def syllabify(spoken: str) -> list[Syllable]:
    out: list[Syllable] = []
    for tok in _RE_TOKEN.findall(spoken):
        if _RE_THAI_CHAR.match(tok):
            out.extend(Syllable(p, "thai") for p in thai_syllables(tok))
        elif _RE_LATIN_CHAR.match(tok):
            out.append(Syllable(tok, "latin"))
        elif tok.strip():
            out.append(Syllable(tok, "other"))
    return out


def make_line(index: int, display: str, language: str = "th", section: str | None = None, stanza: int = 0) -> LyricLine | None:
    display = clean_display(display)
    if not display:
        return None
    spoken = spoken_form(display, language)
    syls = syllabify(spoken)
    if not syls:
        return None
    return LyricLine(index=index, text=display, spoken=spoken, syllables=syls, section=section, stanza=stanza)


def parse_lyrics(text: str, language: str = "th", max_lines: int = 400) -> Lyrics:
    """เนื้อที่ผู้ใช้วาง -> Lyrics (ตัด tag ท่อน/คำสั่งซ้ำ/บรรทัดว่าง, จำ hint ท่อน + stanza)"""
    if not isinstance(text, str):
        return Lyrics()
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines: list[LyricLine] = []
    section: str | None = None
    stanza = 0
    prev_blank = True
    for raw in text.split("\n"):
        kind, sec, body = _classify_line(raw)
        if kind == "blank":
            if not prev_blank:
                stanza += 1
            prev_blank = True
            continue
        if kind == "tag":
            section = sec
            if not prev_blank:
                stanza += 1
            prev_blank = True
            continue
        if kind == "repeat":
            continue
        if sec:
            section = sec
        ln = make_line(len(lines), body, language, section, stanza)
        if ln is None:
            continue
        lines.append(ln)
        prev_blank = False
        if len(lines) >= max_lines:
            break
    return Lyrics(lines)


def split_long_text(text: str, max_chars: int = 48) -> list[str]:
    """ตัดข้อความยาว (เช่นผล ASR ทั้งช่วง) เป็นบรรทัด: ตามขึ้นบรรทัดใหม่ก่อน แล้วตามช่องว่าง"""
    out: list[str] = []
    for para in re.split(r"\n+", text or ""):
        words = para.split()
        cur = ""
        for w in words:
            if cur and len(cur) + 1 + len(w) > max_chars:
                out.append(cur)
                cur = w
            else:
                cur = f"{cur} {w}" if cur else w
        if cur:
            out.append(cur)
    return out


def script_of(text: str) -> str:
    """'th' ถ้าอักษรไทยมากกว่าละติน, 'en' ถ้าละตินมากกว่า, '' ถ้าไม่มีทั้งคู่"""
    th = len(_RE_THAI_CHAR.findall(text or ""))
    la = len(_RE_LATIN_CHAR.findall(text or ""))
    if th == 0 and la == 0:
        return ""
    return "th" if th >= la else "en"


def compact(text: str) -> str:
    """ข้อความสำหรับวัด CER: ตัดช่องว่าง/วรรคตอน/tag, ขยาย ๆ และตัวเลข"""
    parts = [ln.spoken for ln in parse_lyrics(text).lines]
    return re.sub(r"\s+", "", "".join(parts))
