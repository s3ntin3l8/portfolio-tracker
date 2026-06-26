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

import asyncio

import tr_export as tx


# --- concurrent detail-fetch dispatcher -----------------------------------------------
# These tests drive _attach_details against a fake TR stub to prove that the single-reader
# dispatcher correctly routes responses by subscription-id even when they arrive
# out of order — the exact failure mode of the old multi-recv design.


class _ErrorPayload:
    """Sentinel that makes FakeTr.recv() raise an exception for a specific subscription."""
    def __init__(self, sub_id: str):
        self.sub_id = sub_id


class FakeTr:
    """Minimal TR WebSocket stub for _attach_details tests.

    Works entirely without a live websocket or pytr installation.  Responses are
    delivered via an asyncio.Queue; call enqueue_response()/enqueue_error() *after*
    all subscriptions have been registered (use the event returned by expect_count()).
    """

    def __init__(self):
        self._next_sub_id = 0
        self._sub_to_event: dict = {}
        self._queue: asyncio.Queue = asyncio.Queue()
        self._ready: "asyncio.Event | None" = None
        self._ready_at: int = 0

    def expect_count(self, n: int) -> "asyncio.Event":
        """Return an asyncio.Event that fires once n subscriptions have been registered."""
        self._ready_at = n
        self._ready = asyncio.Event()
        return self._ready

    async def timeline_detail_v2(self, event_id: str) -> str:
        sub_id = str(self._next_sub_id)
        self._next_sub_id += 1
        self._sub_to_event[sub_id] = event_id
        if self._ready is not None and len(self._sub_to_event) == self._ready_at:
            self._ready.set()
        return sub_id

    async def unsubscribe(self, sub_id: str) -> None:  # noqa: ARG002
        pass

    async def recv(self) -> tuple:
        item = await self._queue.get()
        if isinstance(item, _ErrorPayload):
            # Mimics pytr.TradeRepublicError: first arg is the subscription_id string.
            raise Exception(item.sub_id, "simulated subscription error")
        sub_id, payload = item
        return sub_id, {"type": "timelineDetailV2"}, payload

    def enqueue_response(self, sub_id: str, payload: dict) -> None:
        self._queue.put_nowait((sub_id, payload))

    def enqueue_error(self, sub_id: str) -> None:
        self._queue.put_nowait(_ErrorPayload(sub_id))


class TestAttachDetails:
    @staticmethod
    def _events(n: int) -> list:
        return [{"id": f"evt-{i}", "eventType": "ORDER_EXECUTED"} for i in range(n)]

    def test_empty_events_returns_immediately_without_touching_tr(self):
        """_attach_details with an empty event list must not call recv() or subscribe."""
        class NeverCallTr:
            async def timeline_detail_v2(self, _):
                raise AssertionError("timeline_detail_v2 must not be called for empty events")
            async def recv(self):
                raise AssertionError("recv() must not be called for empty events")
            async def unsubscribe(self, _):
                raise AssertionError("unsubscribe() must not be called for empty events")

        async def _run():
            result = await tx._attach_details(NeverCallTr(), [])
            assert result == []

        asyncio.run(_run())

    def test_responses_in_order_populate_all_details(self):
        """Happy path: responses arrive in the same order as subscriptions."""
        async def _run():
            N = 3
            events = self._events(N)
            tr = FakeTr()
            ready = tr.expect_count(N)

            async def injector():
                await ready.wait()
                for sub_id, event_id in tr._sub_to_event.items():
                    tr.enqueue_response(sub_id, {"event_id": event_id, "shares": 5.0})

            result, _ = await asyncio.gather(
                tx._attach_details(tr, events, concurrency=N),
                injector(),
            )
            for ev in result:
                assert ev["details"] is not None, f"details missing for {ev['id']}"
                assert ev["details"]["event_id"] == ev["id"]

        asyncio.run(_run())

    def test_out_of_order_responses_routed_to_correct_events(self):
        """Critical regression: responses arrive in REVERSE sub-id order.

        In the old code, all N coroutines called tr.recv() directly.  Each would discard
        messages intended for the others (matching by event-id failed, triggering
        'continue'), so every event timed out with details=None.  The new single-reader
        dispatcher routes each response to the correct Future by subscription-id,
        regardless of arrival order.
        """
        async def _run():
            N = 5
            events = self._events(N)
            tr = FakeTr()
            ready = tr.expect_count(N)

            async def injector():
                await ready.wait()
                # Enqueue in REVERSE subscription order (4,3,2,1,0).
                sub_ids = list(tr._sub_to_event.keys())
                for sub_id in reversed(sub_ids):
                    event_id = tr._sub_to_event[sub_id]
                    tr.enqueue_response(sub_id, {"event_id": event_id, "n": int(sub_id)})

            result, _ = await asyncio.gather(
                tx._attach_details(tr, events, concurrency=N),
                injector(),
            )
            for ev in result:
                assert ev["details"] is not None, f"details missing for {ev['id']}"
                assert ev["details"]["event_id"] == ev["id"], (
                    f"wrong details routed to {ev['id']}: got {ev['details']['event_id']!r}"
                )

        asyncio.run(_run())

    def test_subscription_error_fails_only_that_event_others_still_resolve(self):
        """A subscription-level error (TradeRepublicError-like) is routed to its waiter.

        The single reader must NOT tear down on a per-subscription error — it should fail
        that one Future, let _fetch_one catch it (setting details=None), and continue
        serving the remaining subscriptions.
        """
        async def _run():
            N = 4
            FAILING = 2  # sub-id index that will receive a simulated subscription error
            events = self._events(N)
            tr = FakeTr()
            ready = tr.expect_count(N)

            async def injector():
                await ready.wait()
                sub_ids = list(tr._sub_to_event.keys())
                for i, sub_id in enumerate(sub_ids):
                    if i == FAILING:
                        tr.enqueue_error(sub_id)
                    else:
                        event_id = tr._sub_to_event[sub_id]
                        tr.enqueue_response(sub_id, {"event_id": event_id, "shares": 1.0})

            result, _ = await asyncio.gather(
                tx._attach_details(tr, events, concurrency=N),
                injector(),
            )
            failed = [ev for ev in result if ev["details"] is None]
            succeeded = [ev for ev in result if ev["details"] is not None]
            assert len(failed) == 1, f"expected 1 failed event, got {len(failed)}"
            assert len(succeeded) == N - 1
            for ev in succeeded:
                assert ev["details"]["event_id"] == ev["id"]

        asyncio.run(_run())


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

    def test_tax_date_guard_rejects_booking_date(self):
        # A 'Steuer' section sometimes carries a Buchungsdatum (e.g. '19.12.2024') before
        # the actual tax amount. Without the guard, _num('19.12.2024') = 19122024.
        details_with_date = {"sections": [{"type": "table", "data": [
            {"title": "Steuer", "detail": {"text": "19.12.2024"}},
            {"title": "Steuer", "detail": {"text": "-2,50 €"}},
        ]}]}
        assert tx._extract_tax(details_with_date) == -2.50

    def test_tax_date_only_returns_none(self):
        # If the only 'Steuer' row has a date text, return None rather than a giant integer.
        details_date_only = {"sections": [{"type": "table", "data": [
            {"title": "Steuern", "detail": {"text": "19.12.2024"}},
        ]}]}
        assert tx._extract_tax(details_date_only) is None

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


# --- feed paging, positions snapshot, and the multi-feed event census -----------------

import contextlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402


class FakeFeedTr:
    """Stub for the feed-paging + subscription helpers (no websocket / pytr needed).

    `feeds` maps a subscription type to an ordered list of page responses; a page with a
    `cursors.after` value triggers another fetch, a page without one ends the feed. `snapshots`
    maps a one-shot subscription type (e.g. compactPortfolioByType) to its single response.
    Each feed/snapshot call enqueues a `(sub_id, {"type": ...}, response)` tuple that recv()
    then returns FIFO — exactly what `_await_subscription` consumes.
    """

    def __init__(self, feeds=None, snapshots=None):
        self._feeds = feeds or {}
        self._snapshots = snapshots or {}
        self._queue: list = []
        self._next = 0
        self._cursor: dict = {}

    def _enqueue(self, sub_type, response):
        sub_id = str(self._next)
        self._next += 1
        self._queue.append((sub_id, {"type": sub_type}, response))

    async def _page(self, sub_type):
        idx = self._cursor.get(sub_type, 0)
        pages = self._feeds.get(sub_type, [])
        self._cursor[sub_type] = idx + 1
        self._enqueue(sub_type, pages[idx] if idx < len(pages) else {"items": []})

    async def timeline_transactions(self, after=None):  # noqa: ARG002
        await self._page("timelineTransactions")

    async def timeline_activity_log(self, after=None):  # noqa: ARG002
        await self._page("timelineActivityLog")

    async def timeline(self, after=None):  # noqa: ARG002
        await self._page("timeline")

    async def compact_portfolio(self):
        self._enqueue("compactPortfolioByType", self._snapshots.get("compactPortfolioByType", {}))

    async def recv(self):
        return self._queue.pop(0)

    async def unsubscribe(self, sub_id):  # noqa: ARG002
        pass

    async def _get_ws(self):
        class _WS:
            async def close(self):
                pass

        return _WS()


class TestFetchPositions:
    def test_flattens_categories_and_normalises_isin(self):
        # New compactPortfolioByType shape: positions grouped under categories[].positions,
        # keyed by `isin` (not the old flat `positions` array with `instrumentId`).
        snapshot = {
            "categories": [
                {"positions": [
                    {"isin": "IE00B5BMR087", "netSize": "12.5"},
                    {"isin": "US0378331005", "netSize": "0"},   # zero → dropped
                ]},
                {"positions": [
                    {"isin": "DE0007236101", "netSize": "3"},
                    {"netSize": "9"},                            # no isin → dropped
                ]},
            ]
        }
        tr = FakeFeedTr(snapshots={"compactPortfolioByType": snapshot})
        out = asyncio.run(tx._fetch_positions(tr))
        assert out == [
            {"isin": "IE00B5BMR087", "qty": "12.5"},
            {"isin": "DE0007236101", "qty": "3"},
        ]

    def test_falls_back_to_instrument_id_field(self):
        # Defensive: tolerate the legacy `instrumentId` field if TR ever serves the old key.
        snapshot = {"categories": [{"positions": [{"instrumentId": "US0378331005", "netSize": "1"}]}]}
        tr = FakeFeedTr(snapshots={"compactPortfolioByType": snapshot})
        assert asyncio.run(tx._fetch_positions(tr)) == [{"isin": "US0378331005", "qty": "1"}]

    def test_missing_categories_yields_empty(self):
        tr = FakeFeedTr(snapshots={"compactPortfolioByType": {}})
        assert asyncio.run(tx._fetch_positions(tr)) == []


class TestCollectFeed:
    def test_pages_until_cursor_exhausted_and_dedups_by_id(self):
        feeds = {
            "timelineTransactions": [
                {"items": [{"id": "a"}, {"id": "b"}], "cursors": {"after": "p2"}},
                {"items": [{"id": "b", "v": 2}, {"id": "c"}]},  # no after → stop; b dedups
            ]
        }
        tr = FakeFeedTr(feeds=feeds)
        out = asyncio.run(
            tx._collect_feed(tr, lambda after=None: tr.timeline_transactions(after), "timelineTransactions")
        )
        assert set(out) == {"a", "b", "c"}
        assert out["b"]["v"] == 2  # last page wins on duplicate id


class TestProbeEvents:
    def test_census_across_feeds_with_overlap_and_null_eventtype(self):
        feeds = {
            "timelineTransactions": [
                {"items": [
                    {"id": "t1", "eventType": "CREDIT", "amount": {"value": 5.0}},
                    {"id": "shared", "eventType": "ORDER_EXECUTED", "amount": {"value": -10.0}},
                ]},
            ],
            # Activity log carries the cash-neutral transfer (eventType null → keyed by
            # subtitle) AND re-lists the shared id from the transactions feed.
            "timelineActivityLog": [
                {"items": [
                    {"id": "a1", "eventType": None, "subtitle": "Aktien erhalten", "title": "BAT"},
                    {"id": "shared", "eventType": "ORDER_EXECUTED", "amount": {"value": -10.0}},
                ]},
            ],
            "timeline": [{"items": []}],
        }
        tr = FakeFeedTr(feeds=feeds)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = asyncio.run(tx._probe_events(tr))
        assert rc == 0
        out = json.loads(buf.getvalue())

        tx_feed = out["feeds"]["timelineTransactions"]
        assert tx_feed["total"] == 2
        assert tx_feed["byType"]["CREDIT"]["count"] == 1

        # Null-eventType transfer is grouped under its subtitle so it is not lost.
        act = out["feeds"]["timelineActivityLog"]["byType"]
        assert "(null:subtitle=Aktien erhalten)" in act

        # Shared id is reported so merge-by-id is provably safe (no double-count).
        overlap = out["idOverlap"]["timelineTransactions ∩ timelineActivityLog"]
        assert overlap["shared"] == 1
        assert overlap["only_timelineActivityLog"] == 1


class TestTransfers:
    def test_transfer_event_type_recognition(self):
        assert tx._transfer_event_type({"eventType": "TRANSFER_OUT"}) == "TRANSFER_OUT"
        # #359's incoming-transfer type normalises to TRANSFER_IN.
        assert tx._transfer_event_type({"eventType": "SSP_SECURITIES_TRANSFER_INCOMING"}) == "TRANSFER_IN"
        # eventType-less subtitle form (the shape TR actually serves on the activity log).
        assert tx._transfer_event_type({"eventType": None, "subtitle": "Aktien erhalten"}) == "TRANSFER_IN"
        assert tx._transfer_event_type({"eventType": None, "subtitle": "Aktien übertragen"}) == "TRANSFER_OUT"
        # Non-transfers are not matched.
        assert tx._transfer_event_type({"eventType": None, "subtitle": "Zinsen"}) is None
        assert tx._transfer_event_type({"eventType": "ORDER_EXECUTED"}) is None

    def test_extract_status_from_detail_header(self):
        executed = {"sections": [{"type": "header", "data": {"status": "executed"}}]}
        canceled = {"sections": [{"type": "header", "data": {"status": "canceled"}}]}
        assert tx._extract_status(executed) == "EXECUTED"
        assert tx._extract_status(canceled) == "CANCELED"
        assert tx._extract_status({"sections": []}) is None
        assert tx._extract_status(None) is None

    def test_collect_transactions_merges_only_transfers_from_activity_log(self):
        feeds = {
            "timelineTransactions": [{"items": [{"id": "t1", "eventType": "ORDER_EXECUTED"}]}],
            "timelineActivityLog": [
                {"items": [
                    {"id": "tr1", "eventType": None, "subtitle": "Aktien erhalten", "title": "BAT"},
                    {"id": "tr2", "eventType": "SSP_SECURITIES_TRANSFER_INCOMING"},
                    {"id": "noise", "eventType": None, "subtitle": "Some notification"},
                    {"id": "t1", "eventType": None, "subtitle": "Aktien erhalten"},  # dup id
                ]},
            ],
        }
        tr = FakeFeedTr(feeds=feeds)
        out = asyncio.run(tx._collect_transactions(tr))
        by_id = {e["id"]: e for e in out}
        # Transfers merged with a synthesised eventType the mapper understands.
        assert by_id["tr1"]["eventType"] == "TRANSFER_IN"
        assert by_id["tr2"]["eventType"] == "TRANSFER_IN"
        # Non-transfer activity-log noise is NOT merged (cash stays untouched).
        assert "noise" not in by_id
        # A dup id keeps the richer transactions-feed copy (activity-log copy ignored).
        assert by_id["t1"]["eventType"] == "ORDER_EXECUTED"

    def test_normalize_transfer_extracts_isin_shares_status_and_is_cash_neutral(self):
        # Shaped to the real transfer_in payload: ISIN in `icon`, shares in the "Aktien" row,
        # status in the header; no top-level amount → cash-neutral.
        event = {
            "id": "c511",
            "timestamp": "2024-06-14T16:40:07.424+0000",
            "eventType": "TRANSFER_IN",  # synthesised by _collect_transactions
            "title": "British American Tobacco",
            "icon": "logos/GB0002875804/v2",
            "details": {
                "sections": [
                    {"type": "header", "title": "Du hast Aktien erhalten", "data": {"status": "executed"}},
                    {"type": "table", "title": "Übersicht", "data": [
                        {"title": "Aktien", "detail": {"text": "1.0"}},
                    ]},
                ],
            },
        }
        out = tx._normalize(event, {})
        assert out["eventType"] == "TRANSFER_IN"
        assert out["isin"] == "GB0002875804"
        assert out["shares"] == 1.0
        assert out["status"] == "EXECUTED"
        assert out["amount"] == 0  # cash-neutral

    def test_normalize_reads_cancelled_status_from_header(self):
        event = {
            "id": "x",
            "eventType": "TRANSFER_OUT",
            "details": {"sections": [{"type": "header", "data": {"status": "canceled"}}]},
        }
        # A cancelled transfer carries no top-level status — must come from the header so the
        # Node mapper skips it (and un-imports it if a prior sync confirmed it).
        assert tx._normalize(event, {})["status"] == "CANCELED"
