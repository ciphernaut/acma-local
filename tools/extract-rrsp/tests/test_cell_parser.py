import pytest

from cell_parser import parse_cell
from tests.fixtures import cells


def test_simple_primary():
    result = parse_cell(cells.SIMPLE_PRIMARY)
    assert result["services"] == [
        {"name": "METEOROLOGICAL AIDS", "primary": True, "inline_footnotes": ["54A"]}
    ]
    assert result["footnotes"] == []
    assert result["raw"] == cells.SIMPLE_PRIMARY


def test_primary_plus_secondary_with_cell_level_footnotes():
    result = parse_cell(cells.PRIMARY_PLUS_SECONDARY)
    assert result["services"] == [
        {"name": "FIXED", "primary": True, "inline_footnotes": []},
        {"name": "MARITIME MOBILE", "primary": True, "inline_footnotes": ["57"]},
    ]
    assert result["footnotes"] == ["56", "AUS101"]


def test_qualifier_attached_to_service():
    result = parse_cell(cells.QUALIFIER)
    assert result["services"] == [
        {
            "name": "MARITIME RADIONAVIGATION",
            "primary": True,
            "qualifier": "(radiobeacons)",
            "inline_footnotes": ["73"],
        }
    ]
    assert result["footnotes"] == []


def test_multi_ref_inline():
    result = parse_cell(cells.MULTI_REF_INLINE)
    assert result["services"][0]["inline_footnotes"] == ["79", "79A"]
    assert result["footnotes"] == []


def test_multi_ref_cell_level():
    result = parse_cell(cells.MULTI_REF_CELL_LEVEL)
    assert result["footnotes"] == ["64"]
    radio = next(s for s in result["services"] if s["name"] == "RADIONAVIGATION")
    assert radio["inline_footnotes"] == ["60"]


def test_secondary_basis_is_title_case():
    result = parse_cell(cells.SECONDARY_ONLY)
    assert all(not s["primary"] for s in result["services"])


def test_not_allocated_yields_no_services():
    result = parse_cell(cells.NOT_ALLOCATED)
    assert result["services"] == []
    assert result["footnotes"] == []


def test_empty_input():
    result = parse_cell(cells.EMPTY)
    assert result["services"] == []


def test_lowercase_aus_token_is_uppercased():
    result = parse_cell(cells.LOWERCASE_AUS_TOKEN)
    assert result["services"][0]["inline_footnotes"] == ["AUS49"]


# --- line joining (findings #1, #16) ---------------------------------------


def test_wrapped_name_rejoined_and_stays_primary():
    """The PDF wraps 'RADIONAVIGATION-SATELLITE' mid-word.  Generation 2 emitted
    'RADIONAVIGATION-' and 'SATELLITE (SPACE-TO-' as separate services and marked
    the second secondary, because it tested the case of a fragment."""
    result = parse_cell(
        "AERONAUTICAL\nRADIONAVIGATION\nRADIONAVIGATION–\n"
        "SATELLITE (space-to-\nEarth) (space-to-space)\n208B 328B"
    )
    assert result["services"] == [
        {"name": "AERONAUTICAL RADIONAVIGATION", "primary": True, "inline_footnotes": []},
        {
            "name": "RADIONAVIGATION-SATELLITE",
            "primary": True,
            "inline_footnotes": [],
            "qualifier": "(space-to-Earth) (space-to-space)",
        },
    ]
    assert result["footnotes"] == ["208B", "328B"]


def test_vocabulary_prefix_join():
    result = parse_cell("STANDARD FREQUENCY\nAND TIME SIGNAL")
    assert [s["name"] for s in result["services"]] == [
        "STANDARD FREQUENCY AND TIME SIGNAL"
    ]


def test_lowercase_continuation_is_not_a_new_service():
    result = parse_cell("MOBILE except aeronautical\nmobile")
    assert result["services"] == [
        {
            "name": "MOBILE",
            "primary": True,
            "inline_footnotes": [],
            "qualifier": "except aeronautical mobile",
        }
    ]


def test_parenthetical_line_attaches_as_qualifier():
    result = parse_cell("STANDARD FREQUENCY AND TIME SIGNAL\n(20 kHz)")
    assert len(result["services"]) == 1
    assert result["services"][0]["qualifier"] == "(20 kHz)"
    # The 20 in "(20 kHz)" is part of the qualifier, not a footnote reference.
    assert result["services"][0]["inline_footnotes"] == []
    assert result["footnotes"] == []


def test_second_direction_repeats_the_service_name():
    """FIXED-SATELLITE with two directions, split by a footnote continuation line."""
    result = parse_cell(
        "FIXED\nFIXED–SATELLITE\n(space-to-Earth) 484A\n517A 517B\n"
        "(Earth-to-space) 516\nMOBILE\nAUS87"
    )
    assert [(s["name"], s.get("qualifier")) for s in result["services"]] == [
        ("FIXED", None),
        ("FIXED-SATELLITE", "(space-to-Earth)"),
        ("FIXED-SATELLITE", "(Earth-to-space)"),
        ("MOBILE", None),
    ]
    assert result["services"][1]["inline_footnotes"] == ["484A", "517A", "517B"]
    assert result["services"][2]["inline_footnotes"] == ["516"]
    assert result["footnotes"] == ["AUS87"]


def test_unknown_name_is_recorded_not_silently_kept():
    from cell_parser import UNMATCHED

    before = UNMATCHED.copy()
    parse_cell("DEFINITELY NOT A SERVICE")
    assert UNMATCHED["DEFINITELY NOT A SERVICE"] == before["DEFINITELY NOT A SERVICE"] + 1
