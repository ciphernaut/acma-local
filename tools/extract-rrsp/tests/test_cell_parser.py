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
