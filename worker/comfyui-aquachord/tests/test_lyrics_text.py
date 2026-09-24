"""thai_text: normalise เนื้อเพลง + ตัดพยางค์ (ไม่ต้องใช้โมเดล/torch)"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from aquachord_pipeline import thai_text as tt  # noqa: E402

ROT_TOUR = """[Verse]
จากทุ่งนามาไกลหลายร้อยโล
แบกปูนโบกตึกโตกลางเมืองหลวง

[Chorus]
รถทัวร์เที่ยวสุดท้าย พาพี่กลับบ้านนา
รถทัวร์เที่ยวสุดท้าย วิ่งไปให้ไวไว

[Outro]
รถทัวร์เที่ยวสุดท้าย พาพี่กลับบ้านนา"""


def spoken(s, lang="th"):
    return tt.spoken_form(tt.clean_display(s), lang)


def test_section_tags_are_stripped_and_remembered():
    doc = tt.parse_lyrics(ROT_TOUR)
    assert [ln.text for ln in doc.lines][0] == "จากทุ่งนามาไกลหลายร้อยโล"
    assert all("[" not in ln.text for ln in doc.lines)
    assert [ln.section for ln in doc.lines] == ["verse", "verse", "chorus", "chorus", "outro"]
    assert [ln.stanza for ln in doc.lines] == [0, 0, 1, 1, 2]
    assert len(doc.lines) == 5
    assert doc.text.splitlines()[2] == "รถทัวร์เที่ยวสุดท้าย พาพี่กลับบ้านนา"


@pytest.mark.parametrize(
    "raw,kind,section",
    [
        ("[Chorus 2]", "tag", "chorus"),
        ("(ท่อนฮุก)", "tag", "chorus"),
        ("Chorus:", "tag", "chorus"),
        ("ท่อนฮุก", "tag", "chorus"),
        ("Verse 1", "tag", "verse"),
        ("[Pre-Chorus]", "tag", "pre-chorus"),
        ("[ดนตรี]", "tag", "instrumental"),
        ("(ซ้ำ *)", "repeat", None),
        ("x2", "repeat", None),
        ("(*)", "repeat", None),
        ("(โอ้ โอ้)", "text", None),
        ("ฉันรักเธอ", "text", None),
    ],
)
def test_classify_line(raw, kind, section):
    k, sec, _ = tt._classify_line(raw)
    assert k == kind
    if kind == "tag":
        assert sec == section


def test_inline_tag_and_markers():
    doc = tt.parse_lyrics("[Chorus] รถทัวร์เที่ยวสุดท้าย\n* พาพี่กลับบ้านนา (ซ้ำ)\n(โอ้ โอ้)")
    assert [ln.text for ln in doc.lines] == ["รถทัวร์เที่ยวสุดท้าย", "พาพี่กลับบ้านนา", "โอ้ โอ้"]
    assert doc.lines[0].section == "chorus"


def test_mai_yamok_expands_previous_word():
    assert spoken("เด็กๆ เล่นกัน").replace(" ", "") == "เด็กเด็กเล่นกัน"
    assert spoken("ค่อย ๆ เดิน").replace(" ", "") == "ค่อยค่อยเดิน"
    assert spoken("ไวๆ") == "ไวไว"
    ln = tt.make_line(0, "เด็กๆ")
    assert ln.text == "เด็กๆ"  # ข้อความแสดงผลคงตามที่ผู้ใช้เขียน
    assert [s.text for s in ln.syllables] == ["เด็ก", "เด็ก"]
    assert spoken("ๆ").strip() == ""  # ๆ ลอย ๆ ต้นบรรทัดถูกทิ้ง


def test_numbers_to_thai_words():
    assert "หนึ่งร้อย" in spoken("หลาย 100 โล")
    assert "ยี่สิบ" in spoken("อายุ ๒๐ ปี")
    assert tt.number_to_thai("1,000") == "หนึ่งพัน"
    assert tt.number_to_thai("3.5") == "สามจุดห้า"
    assert tt.number_to_thai("007") == "ศูนย์ศูนย์เจ็ด"
    assert tt.number_to_thai("2567") == "สองพันห้าร้อยหกสิบเจ็ด"


def test_paiyannoi_removed():
    assert spoken("ไปกรุงเทพฯ") == "ไปกรุงเทพ"
    assert "ฯ" not in spoken("ผัก ผลไม้ ฯลฯ")


def test_english_mixed_kept_but_marked_unalignable():
    ln = tt.make_line(0, "I love you ที่รัก")
    kinds = [s.kind for s in ln.syllables]
    assert kinds[:3] == ["latin", "latin", "latin"]
    assert kinds[3:] == ["thai", "thai"]
    assert ln.text == "I love you ที่รัก"
    assert ln.alignable
    assert not tt.make_line(0, "baby baby oh").alignable


def test_punctuation_not_spoken_but_displayed():
    ln = tt.make_line(0, "  รักเธอ,   เสมอ!!  ")
    assert ln.text == "รักเธอ, เสมอ!!"
    assert "".join(s.text for s in ln.syllables) == "รักเธอเสมอ"


def test_syllable_engine_han_solo_available():
    # requirements-lyrics.txt ติดตั้ง python-crfsuite -> ต้องได้ han_solo
    assert tt.syllable_engine() == "han_solo"


@pytest.mark.parametrize(
    "text,expected",
    [
        ("จากทุ่งนามาไกลหลายร้อยโล", ["จาก", "ทุ่ง", "นา", "มา", "ไกล", "หลาย", "ร้อย", "โล"]),
        ("สงกรานต์ปีนี้", ["สง", "กรานต์", "ปี", "นี้"]),
        ("เหงื่อหยดลงดิน", ["เหงื่อ", "หยด", "ลง", "ดิน"]),
    ],
)
def test_syllable_segmentation(text, expected):
    assert tt.thai_syllables(text) == expected


def test_syllables_cover_spoken_text_exactly():
    doc = tt.parse_lyrics(ROT_TOUR)
    for ln in doc.lines:
        assert "".join(s.text for s in ln.syllables) == ln.spoken.replace(" ", "")


def test_garbage_input_is_safe():
    assert tt.parse_lyrics("").lines == []
    assert tt.parse_lyrics(None).lines == []  # type: ignore[arg-type]
    assert tt.parse_lyrics("\x00\x01\n\n   \n[Verse]\n").lines == []
    long_line = "ก" * 5000
    doc = tt.parse_lyrics(long_line)
    assert len(doc.lines) == 1 and len(doc.lines[0].text) <= 400
    many = "\n".join(["ลา"] * 1000)
    assert len(tt.parse_lyrics(many).lines) == 400


def test_split_long_text_and_script():
    parts = tt.split_long_text("รถทัวร์เที่ยวสุดท้าย พาพี่กลับบ้านนา สงกรานต์ปีนี้พี่จะมา ตามสัญญาที่ให้ไว้", 40)
    assert all(len(p) <= 40 for p in parts) and len(parts) == 2
    assert tt.script_of("hello ที่รัก") == "th"
    assert tt.script_of("hello my love") == "en"
    assert tt.script_of("123 !!") == ""


def test_compact_for_cer():
    assert tt.compact("[Verse]\nเด็กๆ 2 คน") == "เด็กเด็กสองคน"
