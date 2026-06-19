"""Unit tests for tr_export.py's detail-extraction heuristics.

These are the part of the Trade Republic sync most sensitive to TR/pytr changes: the
keyword/number heuristics that pull shares/fees/tax/FX/venue/price out of a real
`timelineDetailV2` payload. The Node side (`pytr-mapper.test.ts`) only ever sees the
ALREADY-normalized shape, so without these the extraction layer had zero coverage and a
mismatched row title would silently yield null.

Run: `.venv-pytr/bin/python -m pytest services/api/python` (after installing
requirements-dev.txt). tr_export imports pytr only inside main(), so importing the
helpers here needs no network/credentials.

NOTE ON FIDELITY: the fixtures below are authored to the documented TR detail shape
(`sections[].data[] = {title, detail:{text}}`). They pin the parsing/regex/keyword
behaviour and guard against regressions, but they only prove self-consistency. The
acceptance criterion is reconciliation against a REAL payload — drop one captured
`timelineDetailV2` response into REAL_DETAIL_SAMPLE below during live validation and the
xfail test will start exercising it. See `tr_export.py --probe-instrument`.
"""

import tr_export as tx


# --- number parsing -------------------------------------------------------------------


class TestNum:
    def test_european_money_formatting(self):
        assert tx._num("1.234,56 €") == 1234.56
        assert tx._num("10,18 €") == 10.18
        assert tx._num("0,84492 €") == 0.84492

    def test_bare_and_signed_integers(self):
        assert tx._num("-25") == -25.0
        assert tx._num("113") == 113.0
        assert tx._num("-0,37 €") == -0.37

    def test_unparseable(self):
        assert tx._num("n/a") is None
        assert tx._num("") is None


class TestShareNum:
    def test_comma_decimal(self):
        assert tx._share_num("9,826228") == 9.826228

    def test_dot_decimal(self):
        assert tx._share_num("12.000000") == 12.0
        assert tx._share_num("0.000897") == 0.000897

    def test_dot_thousands_comma_decimal(self):
        # Whichever separator comes last is the decimal point.
        assert tx._share_num("1.234,5") == 1234.5

    def test_reads_only_the_first_token(self):
        # An 'n x price' row must yield the share count, not the price.
        assert tx._share_num("9,826228 x 10,18 €") == 9.826228

    def test_unparseable(self):
        assert tx._share_num("x") is None


# --- row walking ----------------------------------------------------------------------


class TestWalkRows:
    def test_yields_lowercased_title_text_pairs_from_nested(self):
        detail = {
            "sections": [
                {"data": [{"title": "Anteile", "detail": {"text": "10"}}]},
                {"data": [{"title": "Gebühr", "detail": "1,00 €"}]},  # detail as plain str
            ]
        }
        rows = dict(tx._walk_rows(detail))
        assert rows["anteile"] == "10"
        assert rows["gebühr"] == "1,00 €"


# --- realistic fixtures ---------------------------------------------------------------

# A domestic (EUR) buy with an explicit fee.
BUY_DETAIL = {
    "sections": [
        {"type": "table", "title": "Übersicht", "data": [
            {"title": "Status", "detail": {"text": "Ausgeführt"}},
        ]},
        {"type": "table", "title": "Transaktion", "data": [
            {"title": "Anteile", "detail": {"text": "10"}},
            {"title": "Aktienkurs", "detail": {"text": "100,00 €"}},
            {"title": "Gebühr", "detail": {"text": "1,00 €"}},
            {"title": "Handelsplatz", "detail": {"text": "Lang & Schwarz Exchange"}},
            {"title": "Gesamt", "detail": {"text": "1.001,00 €"}},
        ]},
        {"type": "documents", "data": [
            {"id": "doc-1", "postboxType": "SECURITIES_SETTLEMENT", "detail": "01.03.2026"},
        ]},
    ],
}

# A foreign (USD) dividend: per-share payout, FX rate, withheld tax.
DIV_DETAIL = {
    "sections": [
        {"type": "table", "title": "Geschäft", "data": [
            {"title": "Dividende je Aktie", "detail": {"text": "0,25 $"}},
            {"title": "Anteile", "detail": {"text": "9,826228"}},
            {"title": "Wechselkurs", "detail": {"text": "1 $ 0,84492 €"}},
            {"title": "Steuern", "detail": {"text": "-0,37 €"}},
            {"title": "Gesamt", "detail": {"text": "1,71 €"}},
        ]},
    ],
}

# An aggregate buy (saveback/round-up) whose only share clue is the 'n x price' Transaktion row.
AGGREGATE_DETAIL = {
    "sections": [
        {"type": "table", "data": [
            {"title": "Aktienkurs", "detail": {"text": "72,614 €"}},
            {"title": "Transaktion", "detail": {"text": "1,3358 x 72,614 €"}},
        ]},
    ],
}


class TestFieldExtractors:
    def test_fees_from_gebuehr(self):
        assert tx._field(BUY_DETAIL, ["fee", "gebühr", "provision"]) == 1.0

    def test_shares_from_labelled_row(self):
        assert tx._extract_shares(BUY_DETAIL) == 10.0
        assert tx._extract_shares(DIV_DETAIL) == 9.826228

    def test_shares_skips_price_rows_and_falls_back_to_transaktion(self):
        # 'Aktienkurs' carries 'aktien' but must not be read as a share count; the only
        # real clue is the 'n x price' Transaktion row.
        assert tx._extract_shares(AGGREGATE_DETAIL) == 1.3358

    def test_price_from_aktienkurs(self):
        assert tx._extract_price(BUY_DETAIL) == 100.0

    def test_tax_from_steuern(self):
        assert tx._extract_tax(DIV_DETAIL) == -0.37

    def test_fx_from_wechselkurs(self):
        # '1 $ 0,84492 €' → the EUR-per-foreign rate, ignoring the leading '1 $'.
        assert tx._extract_fx(DIV_DETAIL) == 0.84492

    def test_venue_exact_title_match(self):
        assert tx._extract_venue(BUY_DETAIL) == "Lang & Schwarz Exchange"
        # No venue row → None (rather than a false-positive substring match).
        assert tx._extract_venue(DIV_DETAIL) is None

    def test_documents(self):
        assert tx._extract_documents(BUY_DETAIL) == [
            {"id": "doc-1", "type": "SECURITIES_SETTLEMENT", "date": "01.03.2026"},
        ]
        assert tx._extract_documents(DIV_DETAIL) is None


class TestExtractSavingsPlanId:
    def test_from_nested_action_payload(self):
        # The id lives only in the detail (nested under the Sparplan section), never on
        # the top-level event — exactly as seen on a real TRADING_SAVINGSPLAN_EXECUTED.
        details = {
            "sections": [
                {"type": "table", "title": "Sparplan", "data": [
                    {"detail": {"action": {"payload": {"savingsPlanId": "sp-abc"}}}},
                ]},
            ],
        }
        assert tx._extract_savings_plan_id(details) == "sp-abc"

    def test_none_when_absent(self):
        assert tx._extract_savings_plan_id(BUY_DETAIL) is None
        assert tx._extract_savings_plan_id({}) is None


class TestExtractIsin:
    def test_from_icon(self):
        assert tx._extract_isin({"icon": "logos/DE0007164600/v2"}) == "DE0007164600"

    def test_from_details_json_when_no_icon(self):
        ev = {"details": {"sections": [{"data": [{"title": "ISIN", "detail": {"text": "US5949181045"}}]}]}}
        assert tx._extract_isin(ev) == "US5949181045"

    def test_none_when_absent(self):
        assert tx._extract_isin({"icon": "", "details": {}}) is None


class TestNormalize:
    def test_domestic_buy(self):
        ev = {
            "id": "evt-buy",
            "timestamp": "2026-03-01T10:00:00.000Z",
            "eventType": "ORDER_EXECUTED",
            "title": "SAP",
            "icon": "logos/DE0007164600/v2",
            "amount": {"value": -1001.0, "currency": "EUR"},
            "status": "EXECUTED",
            "details": BUY_DETAIL,
        }
        out = tx._normalize(ev, {"DE0007164600": "716460"})
        assert out["isin"] == "DE0007164600"
        assert out["wkn"] == "716460"  # threaded in from the instrument-detail channel
        assert out["amount"] == -1001.0
        assert out["currency"] == "EUR"
        assert out["shares"] == 10.0
        assert out["fees"] == 1.0
        assert out["executedPrice"] == 100.0
        assert out["venue"] == "Lang & Schwarz Exchange"
        assert out["status"] == "EXECUTED"
        assert out["documentRefs"] == [
            {"id": "doc-1", "type": "SECURITIES_SETTLEMENT", "date": "01.03.2026"},
        ]

    def test_foreign_dividend(self):
        ev = {
            "id": "evt-div",
            "timestamp": "2026-03-02T10:00:00.000Z",
            "eventType": "CREDIT",
            "title": "Realty Income",
            "icon": "logos/US7561091049/v2",
            "amount": {"value": 1.71, "currency": "EUR"},
            "details": DIV_DETAIL,
        }
        out = tx._normalize(ev)
        assert out["isin"] == "US7561091049"
        assert out["amount"] == 1.71
        assert out["shares"] == 9.826228
        assert out["tax"] == -0.37
        assert out["fxRate"] == 0.84492
        assert out["fees"] is None

    def test_wkn_absent_when_isin_not_in_map(self):
        ev = {
            "id": "evt-buy",
            "timestamp": "2026-03-01T10:00:00.000Z",
            "eventType": "ORDER_EXECUTED",
            "icon": "logos/DE0007164600/v2",
            "amount": {"value": -1001.0, "currency": "EUR"},
            "details": BUY_DETAIL,
        }
        # No map entry → wkn stays null (the mapper passes through whatever Python emits).
        assert tx._normalize(ev, {})["wkn"] is None
        assert tx._normalize(ev)["wkn"] is None

    def test_missing_amount_defaults_to_zero(self):
        out = tx._normalize({"id": "x", "eventType": "MYSTERY"})
        assert out["amount"] == 0
        assert out["currency"] == "EUR"
        assert out["isin"] is None
        assert out["wkn"] is None


class TestCollectWkns:
    def test_skips_synthetic_crypto_isins(self):
        import asyncio

        class FailTr:
            async def instrument_details(self, isin):  # pragma: no cover - must not run
                raise AssertionError(f"instrument_details called for {isin}")

        # A synthetic crypto ISIN has no instrument record; querying it would block to the
        # recv timeout, so it must be skipped without any call.
        out = asyncio.run(tx._collect_wkns(FailTr(), ["XF000BTC0017"]))
        assert out == {}


# --- real-payload reconciliation (acceptance criterion) -------------------------------

# A REAL TRADING_SAVINGSPLAN_EXECUTED captured via `--probe-timeline` (2026-06-16),
# sanitised: the AWS-signed S3 document URLs and the account/support identifiers are
# stripped, but every row that drives extraction is verbatim from the live payload —
# the nested Transaktion infoPage (Aktienkurs/Aktien/Summe), "Gebühr: Kostenlos", and the
# savingsPlanId buried in the Sparplan section's action payload. This is the row shape the
# heuristics must keep working against; it is what caught the savingsPlanId silent-loss.
REAL_DETAIL_SAMPLE = {
    "event": {
        "id": "9a09f7fe-4e2e-452c-87a9-4aa69415a228",
        "timestamp": "2026-06-16T14:13:36.079+0000",
        "eventType": "TRADING_SAVINGSPLAN_EXECUTED",
        "title": "Core S&P 500 USD (Acc)",
        "icon": "",  # ISIN is not on the top-level icon here — it comes from the detail
        "amount": {"value": -50.0, "currency": "EUR"},
        "status": "EXECUTED",
        "details": {
            "id": "9a09f7fe-4e2e-452c-87a9-4aa69415a228",
            "sections": [
                {"type": "header", "title": "Du hast 50,00 € gespart", "data": {
                    "icon": {"asset": "logos/IE00B5BMR087/v2"}, "status": "executed"}},
                {"type": "table", "title": "Übersicht", "data": [
                    {"title": "Sparplan", "detail": {"text": "Ausgeführt", "type": "status"}},
                    {"title": "Transaktion", "detail": {
                        "text": "0,071387 ×  700,40 €",
                        "action": {"payload": {"sections": [
                            {"title": "Transaktion", "type": "title"},
                            {"type": "table", "data": [
                                {"title": "Aktienkurs", "detail": {"text": "700,40 €"}},
                                {"title": "Aktien", "detail": {"text": "0,071387"}},
                                {"title": "Summe", "detail": {"text": "50,00 €"}},
                            ]},
                        ]}}, "type": "text"}},
                    {"title": "Gebühr", "detail": {"text": "Kostenlos", "type": "text"}},
                    {"title": "Summe", "detail": {"text": "50,00 €", "type": "text"}},
                ]},
                {"type": "table", "title": "Sparplan", "data": [
                    {"detail": {
                        "amount": "50,00 €",
                        "action": {"payload": {"savingsPlanId": "REDACTED-PLAN-ID"},
                                   "type": "openSavingsPlanOverview"},
                        "type": "embeddedTimelineItem"}},
                ]},
                {"type": "documents", "title": "Dokumente", "data": [
                    {"title": "Abrechnungsausführung", "id": "d1c98a74-083f-4a4f-b70f-2dedbed49139",
                     "postboxType": "SECURITIES_SETTLEMENT_SAVINGS_PLAN"},
                ]},
            ],
        },
    },
    "expect": {
        "isin": "IE00B5BMR087",
        "shares": 0.071387,
        "executedPrice": 700.4,
        "fees": None,  # "Kostenlos" → no number → null → mapper renders "0"
        "savingsPlanId": "REDACTED-PLAN-ID",  # the bug: nested in detail, was dropped
        "amount": -50.0,
        "currency": "EUR",
    },
}


import pytest  # noqa: E402


@pytest.mark.xfail(REAL_DETAIL_SAMPLE is None, reason="no captured real payload yet", strict=False)
def test_against_real_payload():
    assert REAL_DETAIL_SAMPLE is not None, "drop a real timelineDetailV2 sample in to validate"
    out = tx._normalize(REAL_DETAIL_SAMPLE["event"])
    for key, want in REAL_DETAIL_SAMPLE["expect"].items():
        assert out[key] == want, f"{key}: got {out[key]!r}, expected {want!r}"
