import pytest

from footnotes import parse_footnote_block, is_running_header


@pytest.mark.parametrize(
    "line, expected",
    [
        ("Australian Radiofrequency Spectrum Plan 2021", True),
        ("AUSTRALIAN RADIOFREQUENCY SPECTRUM PLAN 2021", True),
        ("Part 3   Australian Footnotes", True),
        ("107", True),                                # bare page number
        ("AUS1A", False),                             # real footnote start
        ("53", False),                                # real footnote start (intl)
        ("Some footnote body text", False),
    ],
)
def test_is_running_header(line, expected):
    assert is_running_header(line) == expected


def test_parse_australian_block():
    lines = [
        "Part 3   Australian Footnotes",
        "AUS1A    In the band 1 260–1 300 MHz it is intended to accommodate",
        "         radionavigation–satellite systems on a shared basis.",
        "Australian Radiofrequency Spectrum Plan 2021",
        "107",
        "AUS3     The use of the band 1 435–1 535 MHz by the aeronautical",
        "         mobile service for telemetry has priority.",
    ]
    result = parse_footnote_block(lines, is_australian=True, page=107)
    assert result == [
        {
            "ref": "AUS1A",
            "text": "In the band 1 260–1 300 MHz it is intended to accommodate radionavigation–satellite systems on a shared basis.",
            "page": 107,
        },
        {
            "ref": "AUS3",
            "text": "The use of the band 1 435–1 535 MHz by the aeronautical mobile service for telemetry has priority.",
            "page": 107,
        },
    ]


def test_parse_international_block_with_alpha_suffix():
    lines = [
        "54A   Use of the 8.3–11.3 kHz frequency band is limited to passive use only.",
        "54B   Additional allocation in Algeria.",
    ]
    result = parse_footnote_block(lines, is_australian=False, page=120)
    assert [r["ref"] for r in result] == ["54A", "54B"]


def test_continuation_collapses_internal_whitespace():
    lines = [
        "AUS1A   First sentence.",
        "        Second sentence.",
    ]
    result = parse_footnote_block(lines, is_australian=True, page=107)
    assert result[0]["text"] == "First sentence. Second sentence."
