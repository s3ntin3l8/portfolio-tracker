#!/usr/bin/env python3
"""Vendored pytr entrypoint: export the Trade Republic timeline as NDJSON.

Read-only against Trade Republic. Resumes a saved cookie session (no 2FA, no WAF
token) and pages the full timeline of transaction events, enriching each with its
detail payload, then prints one JSON object per line to stdout.

Contract (consumed by services/pytr/runner.ts):
  argv:  --cookies-file PATH
  env:   TR_PHONE, TR_PIN (pytr's constructor needs them even to resume cookies)
  exit:  0 → NDJSON of events on stdout
         2 → session could not be resumed (re-pairing required; runner → 'expired')
         1 → any other failure (reason on stderr)

Each emitted line is the NORMALIZED event the Node mapper consumes:
  {id, timestamp, eventType, title, amount (signed), currency,
   isin?, wkn?, shares?, fees?, savingsPlanId?, status?, kind?, vorabBase?,
   trueDistributionDate?, originalAmount?, correctionAmount?, dateResolutionFailed?}
The WKN is fetched per distinct ISIN from the instrument-detail channel (timeline events
carry only an ISIN); everything else comes from the timeline list + its detail payload.
Extraction of isin/shares/fees from the timeline detail is best-effort and the part most
sensitive to pytr/TR changes; the raw detail is scanned defensively.

The trailing four fields are set only on a TR "Dividend correction" event (a same-day
cancel+reissue restating an earlier distribution, observed live for Realty Income —
1099-DIV recharacterization posted a year after the fact): trueDistributionDate/
originalAmount/correctionAmount resolve the restated event's true period + the
already-recognized-vs-genuinely-new amount split (see _extract_reclassification);
dateResolutionFailed is set only when that resolution fails, so the Node mapper can fall
back safely instead of silently mis-dating the booking.

`vorabBase` is set only on a Vorabpauschale accrual event (SSP_CORPORATE_ACTION_NO_CASH,
subtitle "Vorabpauschale" — the German advance lump-sum fund tax, §18(3) InvStG): the
taxable base extracted from the detail, gross (Teilfreistellung is applied by the Node
side's @portfolio/core, not here). `kind` is set to "vorabpauschale" on the same event so
the mapper can route it without re-deriving the detection signal. Unverified against a
captured real detail payload (see _extract_vorab_base) — a missing/unparseable base
degrades to a zero-effect booking rather than guessing.

NOTE: targets pytr pinned to an exact upstream commit (see requirements.txt) for TR's
June-2026 `compactPortfolioByType` rename; not yet validated against a live account. TR's
private protocol can change.
"""

import argparse
import asyncio
import json
import os
import re
import sys

RECV_TIMEOUT_S = 30
ISIN_RE = re.compile(r"\b([A-Z]{2}[A-Z0-9]{9}\d)\b")


async def _await_subscription(tr, sub_type, match=None):
    """Recv until the response for our subscription arrives, then unsubscribe it."""
    while True:
        sub_id, subscription, response = await asyncio.wait_for(
            tr.recv(), timeout=RECV_TIMEOUT_S
        )
        if subscription.get("type") != sub_type:
            continue
        if match and not match(subscription):
            continue
        await tr.unsubscribe(sub_id)
        return response


async def _collect_feed(tr, feed_method, sub_type):
    """Page one TR timeline feed to exhaustion; return {event_id: event}.

    Every TR timeline feed (`timelineTransactions`, `timelineActivityLog`, `timeline`) shares
    the same `{items, cursors.after}` paging shape, so one helper drives them all."""
    events = {}
    await feed_method()
    while True:
        response = await _await_subscription(tr, sub_type)
        for event in response.get("items", []):
            if event.get("id"):
                events[event["id"]] = event
        after = (response.get("cursors") or {}).get("after")
        if not after:
            break
        await feed_method(after)
    return events


# Securities transfers (Depotübertrag) are cash-neutral and live on the activity-log feed,
# NOT timelineTransactions. They are identified either by an explicit event type or — in the
# (older) form that carries no eventType — by their subtitle. We normalise both to a stable
# synthetic eventType the Node mapper understands.
_TRANSFER_SUBTITLES = {
    "aktien erhalten": "TRANSFER_IN",
    "aktien übertragen": "TRANSFER_OUT",
}
_TRANSFER_EVENT_TYPES = {
    "TRANSFER_IN": "TRANSFER_IN",
    "TRANSFER_OUT": "TRANSFER_OUT",
    "SSP_SECURITIES_TRANSFER_INCOMING": "TRANSFER_IN",
}

# In-kind crypto transfers (e.g. a deposit from an external wallet) surface only on the
# activity-log feed as CRYPTO_TRANSACTION_INCOMING — an unambiguous, already-explicit
# eventType (unlike the securities-transfer forms above, which need the subtitle to
# disambiguate). CRYPTO_TRANSACTION_OUTGOING is added defensively (not yet observed live);
# if TR uses a different name for the outbound leg, it will surface as an unmapped-event
# attention gap rather than being silently dropped. Unlike a securities transfer, these
# events carry NEITHER an isin NOR a shares field anywhere — only a "<qty> <TICKER>"
# subtitle (e.g. "0.026242 BTC") — resolved in _normalize via _crypto_isin_by_ticker.
_CRYPTO_TRANSFER_EVENT_TYPES = {
    "CRYPTO_TRANSACTION_INCOMING": "TRANSFER_IN",
    "CRYPTO_TRANSACTION_OUTGOING": "TRANSFER_OUT",
}
_TRANSFER_EVENT_TYPES.update(_CRYPTO_TRANSFER_EVENT_TYPES)

# A securities transfer (Depotübertrag) is the subtitle TR actually serves on the activity
# log: eventType ACCOUNT_TRANSFER_{INCOMING,OUTGOING} with subtitle "Wertpapiertransfer"
# (validated live, 2026-06). The eventType also maps to a cash deposit/withdrawal for
# *cash* transfers, so we only treat it as a securities transfer when this subtitle is set,
# taking the direction from the eventType.
_SECURITIES_TRANSFER_SUBTITLE = "wertpapiertransfer"


def _transfer_event_type(event):
    """Return the synthetic TRANSFER_IN/TRANSFER_OUT type for a securities-transfer event,
    or None if the event is not a transfer. Matches the explicit event type, the
    eventType-less "Aktien erhalten/übertragen" subtitle, and the "Wertpapiertransfer"
    subtitle (direction inferred from an INCOMING/OUTGOING event type)."""
    et = event.get("eventType") or ""
    if et in _TRANSFER_EVENT_TYPES:
        return _TRANSFER_EVENT_TYPES[et]
    sub = (event.get("subtitle") or "").strip().lower()
    if sub in _TRANSFER_SUBTITLES:
        return _TRANSFER_SUBTITLES[sub]
    if sub == _SECURITIES_TRANSFER_SUBTITLE:
        if "OUTGOING" in et or et.endswith("_OUT"):
            return "TRANSFER_OUT"
        return "TRANSFER_IN"  # default to inbound (ACCOUNT_TRANSFER_INCOMING, etc.)
    return None


async def _collect_transactions(tr):
    events = await _collect_feed(
        tr, lambda after=None: tr.timeline_transactions(after), "timelineTransactions"
    )
    # Merge ONLY securities-transfer events from the activity-log feed (deduped by id). They
    # are cash-neutral, so restricting the merge to them keeps cash derivation untouched —
    # even a dedup miss cannot double-count cash (and the DB's (portfolio, source, externalId)
    # unique index is a second guard). This is what makes transferred-in positions appear in
    # holdings at all; everything else on the activity log stays out until classified.
    try:
        activity = await _collect_feed(
            tr, lambda after=None: tr.timeline_activity_log(after), "timelineActivityLog"
        )
    except Exception as exc:  # noqa: BLE001 - best effort; transfers are additive
        print(f"activity-log fetch failed: {exc}", file=sys.stderr)
        activity = {}
    for event_id, event in activity.items():
        if event_id in events:
            continue
        transfer_type = _transfer_event_type(event)
        if transfer_type:
            events[event_id] = {**event, "eventType": transfer_type}
    return list(events.values())


async def _attach_details(tr, events, concurrency=8):
    """Enrich every event with its detail payload via a single-reader dispatcher.

    A semaphore limits how many subscriptions are in-flight; a single background reader
    task owns tr.recv() and routes each response to its waiter's Future by subscription-id.
    This avoids the message-stealing that the previous design suffered: when `concurrency`
    coroutines all called tr.recv() directly, each would discard messages intended for the
    others (via the 'continue' in _await_subscription), causing every event to time out
    with details=None and shares=null — making the Node mapper reject all security events
    as "without a share count".

    Serial fetching of ~900 events would exceed the 300s export timeout; bounded
    concurrency collapses that to ~90 batched round-trips while still attaching a detail
    to every event (reconcileCash re-maps the full timeline so skipping details would drop
    cash legs from the derived balance).
    """
    if not events:
        return events

    pending: dict = {}  # subscription_id -> asyncio.Future
    loop = asyncio.get_running_loop()

    async def _reader():
        """Sole owner of tr.recv().  Routes each arriving message to its registered Future."""
        while True:
            try:
                sub_id, _sub, resp = await tr.recv()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                # A subscription-level error (pytr's TradeRepublicError) carries the
                # subscription_id as exc.args[0]; route it to the correct waiter so the
                # rest of the session can continue.
                sub_err_id = (
                    exc.args[0]
                    if exc.args and isinstance(exc.args[0], str)
                    else None
                )
                fut = pending.get(sub_err_id) if sub_err_id else None
                if fut is not None and not fut.done():
                    fut.set_exception(exc)
                    continue
                # Unknown / socket-level error: fail every pending waiter and stop.
                for f in list(pending.values()):
                    if not f.done():
                        f.set_exception(exc)
                return
            fut = pending.get(sub_id)
            if fut is not None and not fut.done():
                fut.set_result(resp)

    reader_task = asyncio.create_task(_reader())
    sem = asyncio.Semaphore(concurrency)

    async def _fetch_one(event):
        event_id = event["id"]
        sub_id = None
        async with sem:
            try:
                sub_id = await tr.timeline_detail_v2(event_id)
                fut = loop.create_future()
                pending[sub_id] = fut
                event["details"] = await asyncio.wait_for(fut, RECV_TIMEOUT_S)
            except Exception as exc:  # noqa: BLE001 - details are best-effort
                event["details"] = None
                print(
                    f"detail fetch failed for {event_id} "
                    f"({event.get('eventType')}): {exc}",
                    file=sys.stderr,
                )
            finally:
                if sub_id is not None:
                    pending.pop(sub_id, None)
                    try:
                        await tr.unsubscribe(sub_id)
                    except Exception:  # noqa: BLE001
                        pass

    try:
        await asyncio.gather(*(_fetch_one(ev) for ev in events))
    finally:
        reader_task.cancel()
        try:
            await reader_task
        except asyncio.CancelledError:
            pass
    return events


def _walk_rows(obj):
    """Yield (lowercased title, text) pairs from a nested detail structure."""
    if isinstance(obj, dict):
        title = obj.get("title")
        detail = obj.get("detail")
        text = None
        if isinstance(detail, dict):
            text = detail.get("text")
        elif isinstance(detail, str):
            text = detail
        if title and text:
            yield (str(title).lower(), str(text))
        for value in obj.values():
            yield from _walk_rows(value)
    elif isinstance(obj, list):
        for item in obj:
            yield from _walk_rows(item)


def _num(text):
    """Parse a (possibly European-formatted) number out of a label, e.g. '1.234,56 €'.

    Monetary amounts in the TR timeline are consistently European (dot=thousands,
    comma=decimal). For share counts use _share_num instead — TR formats those with a
    mix of dot- and comma-decimals.
    """
    match = re.search(r"-?\d[\d.\s]*(?:,\d+)?", text)
    if not match:
        return None
    raw = match.group(0).replace(" ", "").replace(".", "").replace(",", ".")
    try:
        return float(raw)
    except ValueError:
        return None


def _share_num(text):
    """Parse a share count, tolerating both decimal conventions TR mixes in the timeline.

    Share counts appear as e.g. '9,826228' (comma-decimal), '0.000897' / '12.000000'
    (dot-decimal). Rule: whichever of '.'/',' appears last is the decimal separator; the
    other is a thousands group. Only the first numeric token is read (so 'n x price' rows
    yield the share count, not the price).
    """
    match = re.search(r"\d[\d.,]*", text)
    if not match:
        return None
    raw = match.group(0)
    last_dot, last_comma = raw.rfind("."), raw.rfind(",")
    if last_comma > last_dot:
        raw = raw.replace(".", "").replace(",", ".")
    else:
        raw = raw.replace(",", "")
    try:
        return float(raw)
    except ValueError:
        return None


def _field(details, keywords):
    for title, text in _walk_rows(details or {}):
        if any(k in title for k in keywords):
            value = _num(text)
            if value is not None:
                return value
    return None


def _extract_shares(details):
    """Share count for a trade-like event.

    First a labelled row (Anteile/Aktien/Shares/Anzahl/Stück); also covers corporate
    actions that carry received shares as 'Erhaltene Aktien' / 'erhaltene anteile' /
    'received shares'. Failing that, the 'Transaktion' row that aggregate buys
    (round-up, saveback) carry as '<shares> x <price>' — distinguished from a plain
    cash 'transaction' amount by the ' x '/'×'.
    """
    SHARE_KEYWORDS = (
        "anteile", "aktien", "shares", "anzahl", "stück",
        # Corporate-action variants for received shares (stock dividend / bonus issue):
        "erhaltene", "received",
    )
    for title, text in _walk_rows(details or {}):
        if any(k in title for k in SHARE_KEYWORDS) and (
            # 'aktienkurs' / 'share price' rows contain 'aktien' too — those are a price.
            not any(p in title for p in ("kurs", "preis", "price"))
        ):
            value = _share_num(text)
            if value is not None:
                return value
    for title, text in _walk_rows(details or {}):
        if ("transaktion" in title or "transaction" in title) and (
            " x " in text or "×" in text
        ):
            value = _share_num(text)
            if value is not None:
                return value
    return None


def _text_field(details, titles):
    """First detail row whose (lowercased) title EXACTLY matches one of `titles`. Exact —
    not substring — so 'an'/'von' don't match 'Anteile'/'Transaktion'."""
    wanted = set(titles)
    for title, text in _walk_rows(details or {}):
        if title in wanted and text:
            return text
    return None


def _extract_price(details):
    """The actual executed per-share price (Aktienkurs / Anteilspreis / Bezugspreis).

    Excludes 'Wechselkurs' (FX) and 'Aktienkurs'… wait — only true price rows. Returned
    so cost basis can lead with TR's figure instead of deriving it from the cash total.
    """
    return _field(details, ["aktienkurs", "anteilspreis", "bezugspreis", "share price"])


_DATE_RE = re.compile(r"^\d{1,2}\.\d{2}\.\d{4}$")


def _extract_tax(details):
    """Tax withheld/corrected (Steuer/Steuern/Steuerkorrektur), signed as TR shows it.

    Summed across every matching row rather than returning the first: a payout can
    legitimately carry more than one 'Steuer'-titled line (e.g. a foreign Quellensteuer
    row alongside a domestic Kapitalertragsteuer row), and only summing the first would
    silently drop the rest.

    Guard: reject rows whose text looks like a date (DD.MM.YYYY). `_num` would otherwise
    parse '19.12.2024' as 19122024 — stripping the dots yields an 8-digit integer that
    masquerades as a tax amount.
    """
    total = None
    for title, text in _walk_rows(details or {}):
        if "steuer" in title:
            stripped = text.strip()
            if _DATE_RE.match(stripped):
                continue  # skip date-like values (Buchungsdatum etc.)
            value = _num(stripped)
            if value is not None:
                total = value if total is None else total + value
    return total


def _extract_fx(details):
    """EUR-per-foreign-unit rate from a 'Wechselkurs' row, e.g. '1 $ 0,84492 €' → 0.84492."""
    for title, text in _walk_rows(details or {}):
        if "wechselkurs" in title or "devisenkurs" in title:
            match = re.search(r"([-\d.,]+)\s*€\s*$", text)
            if match:
                return _num(match.group(1))
    return None


def _extract_venue(details):
    """Execution venue (rarely present on TR — 'Börse'/'Handelsplatz'/'Ausführungsort')."""
    return _text_field(details, ["börse", "handelsplatz", "ausführungsort", "ausführungsplatz"])


def _extract_description(event, details):
    """Memo for cash/transfer rows: the transfer counterparty (name + IBAN) or card merchant.

    The instrument/merchant title is already carried as `title`; here we add the bits that
    would otherwise be lost — who the money went to/from and the IBAN.
    """
    party = _text_field(details, ["absender", "empfänger", "von", "an", "name", "händler"])
    iban = _text_field(details, ["iban"])
    bits = [b for b in (party, iban) if b]
    return " · ".join(bits) or None


def _extract_documents(details):
    """Document references from `documents` sections: {id, type, date}. The S3 URL itself
    is presigned/short-lived, so it's not persisted — re-fetched at download time."""
    out = []
    for section in (details or {}).get("sections", []) or []:
        if section.get("type") != "documents":
            continue
        data = section.get("data")
        rows = data if isinstance(data, list) else [data] if isinstance(data, dict) else []
        for row in rows:
            if not isinstance(row, dict):
                continue
            doc_id = row.get("id")
            if doc_id:
                out.append({
                    "id": doc_id,
                    "type": row.get("postboxType"),
                    "date": row.get("detail"),
                })
    return out or None


def _extract_isin(event):
    # The JSON-blob fallback can grab an UNRELATED ISIN embedded in the detail — e.g. a
    # CARD_TRANSACTION whose "Vorteile" preview the saveback/round-up of some ETF will
    # surface that ETF's ISIN. Benign downstream: the mapper books card spend as a
    # withdrawal (cash), which carries no instrument, so the stray ISIN is ignored.
    match = ISIN_RE.search(event.get("icon") or "")
    if match:
        return match.group(1)
    match = ISIN_RE.search(json.dumps(event.get("details") or {}))
    return match.group(1) if match else None


_CRYPTO_TRANSFER_SUBTITLE_RE = re.compile(r"^([\d.,]+)\s+([A-Za-z]{2,6})$")

# Maps a crypto instrument's TR display title to its ticker, so a transfer's "<qty>
# <TICKER>" subtitle can be cross-referenced against ISINs this account's own crypto
# trades already resolved (see _crypto_isin_by_ticker). Extend when a new coin shows up
# live — matches the codebase's existing pattern for small, explicit, live-validated maps
# (e.g. _TRANSFER_SUBTITLES above).
_CRYPTO_TICKER_BY_TITLE = {"bitcoin": "BTC", "ethereum": "ETH"}


def _crypto_transfer_qty_and_ticker(event):
    """Parse the qty+ticker a crypto position transfer carries only in its subtitle (e.g.
    "0.026242 BTC"), since these events have no amount/isin fields at all — unlike a
    securities transfer, whose shares/isin come from the detail payload via the normal
    _extract_shares/_extract_isin path.

    Checked against the event's CURRENT eventType (TRANSFER_IN/TRANSFER_OUT), not the raw
    CRYPTO_TRANSACTION_INCOMING/_OUTGOING type: by the time _normalize runs, the merge in
    _collect_transactions has already overwritten eventType with the synthetic transfer
    type (see `events[event_id] = {**event, "eventType": transfer_type}`), so the original
    is gone. Safe to key on subtitle *shape* here — a securities transfer's subtitle
    ("Wertpapiertransfer" / "Aktien erhalten") never matches "<number> <letters>".
    """
    if event.get("eventType") not in ("TRANSFER_IN", "TRANSFER_OUT"):
        return None
    match = _CRYPTO_TRANSFER_SUBTITLE_RE.match((event.get("subtitle") or "").strip())
    if not match:
        return None
    qty = _share_num(match.group(1))
    return (qty, match.group(2).upper()) if qty is not None else None


def _crypto_isin_by_ticker(events):
    """Derive {ticker: isin} for this account's own crypto holdings by cross-referencing
    already-resolved ISINs (from real crypto trades, which carry a real isin + title) against
    their known display title. Avoids hardcoding TR's synthetic ISIN digits (e.g. the
    "0017"/"0019" suffix), which aren't derivable from the ticker alone and may differ by
    account/region — see TR_CRYPTO_ISIN in mapper.ts. A ticker with no resolvable ISIN (e.g.
    a coin transferred in that was never separately traded on this account) is left unset;
    the Node mapper then surfaces it as a "without an ISIN" attention gap rather than
    guessing wrong."""
    by_ticker = {}
    for event in events:
        isin = _extract_isin(event)
        if not (isin and isin.startswith("XF000")):
            continue
        ticker = _CRYPTO_TICKER_BY_TITLE.get((event.get("title") or "").strip().lower())
        if ticker:
            by_ticker.setdefault(ticker, isin)
    return by_ticker


def _is_crypto_bonus(event):
    """True for a crypto "1% bonus" trade — a crypto buy funded by a TR reward, so the buy
    must be booked cash-neutral (the reward leg never appears on the timeline feed; only the
    transactions-export CSV books an offsetting credit).

    Identified by a synthetic crypto ISIN (XF000…) plus the bonus markers TR puts on the
    detail of these events (verified live, 2026-06): a bronze one-percent-bonus badge
    (`logos/timeline_one_percent_bronze/…` — locale-independent, matched first), a row titled
    "1% Bonus", and a "Du hast … € … erhalten" header (which pytr itself books as a
    cash-neutral deposit). We match those explicit markers rather than a loose "bonus"
    substring so an ordinary crypto trade (which carries "1%" for the spread, never "bonus")
    is never mis-tagged."""
    isin = _extract_isin(event)
    if not (isin and isin.startswith("XF000")):
        return False
    blob = json.dumps(event.get("details") or {}, ensure_ascii=False).lower()
    return "one_percent" in blob or "1% bonus" in blob or "1 % bonus" in blob


def _is_vorabpauschale(event):
    """True for a Vorabpauschale accrual event: SSP_CORPORATE_ACTION_NO_CASH with subtitle
    "Vorabpauschale" (the German advance lump-sum fund tax, §18(3) InvStG) — a non-cash
    booking on a specific fund holding, carrying no `amount` (unlike SSP_CORPORATE_ACTION_CASH
    dividends), only a taxable base in its detail (see _extract_vorab_base).

    Detection CONFIRMED against a real account's captured activity-log export (2026-07-10):
    id bc5b0f6b-c8c4-3a3f-9827-363dad949390, timestamped 2026-01-27T07:09:26.714+0000,
    eventType/subtitle match this function's check exactly. Only its summary line survives
    in that export though (the full `timelineDetail` payload was never captured) — so the
    base extraction below is unverified against real data and deliberately conservative
    (see _extract_vorab_base's docstring). Detection firing correctly does NOT guarantee
    extraction succeeds; the mapper flags a null base for review rather than assuming."""
    if event.get("eventType") != "SSP_CORPORATE_ACTION_NO_CASH":
        return False
    subtitle = (event.get("subtitle") or "").strip().lower()
    return subtitle == "vorabpauschale"


def _extract_vorab_base(details):
    """The Vorabpauschale taxable base (Bemessungsgrundlage) — the gross accrual amount
    before Teilfreistellung, which @portfolio/core applies itself (see mapper.ts / tax.ts).

    Best-guess keywords (bemessungsgrundlage / vorabpauschale row titles), mirroring
    _extract_price/_extract_tax's `_field` pattern. Unverified against a captured real
    detail payload — only the event's summary line survives in any local export. Returns
    None when no matching row is found; the mapper degrades that to a zero-effect booking
    rather than guessing."""
    return _field(details, ["bemessungsgrundlage", "vorabpauschale"])


_RECLASSIFICATION_SUBTITLES = {"bardividende korrigiert", "cash dividend corrected"}
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)


def _is_reclassification_correction(event):
    """True for a TR 'Dividend correction' event — one instrument's monthly distribution
    restated in a later period (observed live for Realty Income, March 2026: the prior
    year's REIT 1099-DIV recharacterization, posted as a same-day cancel+reissue pair).

    Two independent signals, both required (neither alone is proven stable enough on its
    own): a `type: "banner"` detail section — present ONLY on these restatement events,
    never on an ordinary dividend, so mere presence is a strong structural discriminator —
    and the event's own `subtitle` matching TR's "corrected" label, the exact marker
    pytr's own event.py subtitle table already distinguishes from plain "Bardividende".
    Deliberately narrower than "has a banner" alone, to avoid misfiring on some other,
    unrelated banner TR might one day attach to a normal dividend.
    """
    if (event.get("status") or "").upper() != "EXECUTED":
        return False
    details = event.get("details")
    if not isinstance(details, dict):
        return False
    has_banner = any(
        isinstance(s, dict) and s.get("type") == "banner"
        for s in details.get("sections", []) or []
    )
    if not has_banner:
        return False
    subtitle = (event.get("subtitle") or "").strip().lower()
    return subtitle in _RECLASSIFICATION_SUBTITLES


def _extract_correction_components(details):
    """('Original dividend', 'Correction') amounts a reclassification event's own detail
    names explicitly (e.g. '8,27 €' / '0,49 €' — TR's own breakdown of the restated total
    into an already-recognized-income portion and a genuinely-new delta). Either is None
    if the row isn't present (e.g. a differently-shaped correction TR introduces later)."""
    original = correction = None
    for title, text in _walk_rows(details or {}):
        if title in ("original dividend", "ursprüngliche dividende"):
            original = _num(text)
        elif title in ("correction", "korrektur"):
            correction = _num(text)
    return original, correction


def _extract_original_dividend_id(details):
    """The id of the event a reclassification event's 'Original dividend' row references
    (its `action.payload`, a UUID) — the only place the true restated event is identified;
    the row's own displayed amount is read separately via _extract_correction_components.
    Walks the nested detail structure for this specific key, mirroring
    _extract_savings_plan_id's pattern, rather than string-matching free text.
    """

    def walk(obj):
        if isinstance(obj, dict):
            title = (obj.get("title") or "").strip().lower()
            if title in ("original dividend", "ursprüngliche dividende"):
                detail = obj.get("detail")
                if isinstance(detail, dict):
                    payload = (detail.get("action") or {}).get("payload")
                    if isinstance(payload, str) and _UUID_RE.match(payload):
                        return payload
            for value in obj.values():
                found = walk(value)
                if found:
                    return found
        elif isinstance(obj, list):
            for item in obj:
                found = walk(item)
                if found:
                    return found
        return None

    return walk(details or {})


def _parse_doc_date_sortkey(date_str):
    """Parse TR's DD.MM.YYYY document-date string into a (year, month, day) tuple for
    chronological comparison. Returns None if unparseable — never sort/compare against a
    guessed value. Deliberately NOT a plain string comparison: "15.01.2025" < "14.02.2025"
    lexically but Jan 15 is chronologically BEFORE Feb 14, so string order silently picks
    the wrong document on some inputs even though it looks right on others."""
    m = _DATE_RE.match(date_str or "")
    if not m:
        return None
    day, month, year = date_str.split(".")
    try:
        return (int(year), int(month), int(day))
    except ValueError:
        return None


def _extract_reclassification(event, events_by_id):
    """For a 'Dividend correction' event, resolve the true distribution date + the
    Original/Correction amount split by looking up the referenced original in this
    account's already-collected event set — NOT a fresh API call. The canceled original
    lives on the same `timelineTransactions` feed `_collect_transactions` already pages,
    and `_attach_details` already fetched its detail as part of the normal batch, so a
    dict lookup is sufficient (confirmed empirically against real accounts before this was
    written: the canceled original for every observed correction was already present).

    Returns None if `event` isn't a reclassification correction at all. Otherwise a dict
    with `trueDistributionDate` (None if unresolved), `originalAmount`, `correctionAmount`
    (both read from the correction event's own detail, independent of resolution),  and
    `dateResolutionFailed` (True only on failure — omitted/None on success, since a wrong
    date must never be silently assumed).
    """
    if not _is_reclassification_correction(event):
        return None
    details = event.get("details")
    original_amount, correction_amount = _extract_correction_components(details)
    true_date = None
    resolution_failed = True
    current_id = _extract_original_dividend_id(details)
    seen = set()
    for _ in range(5):  # cap recursion for a correction-of-a-correction chain
        if not current_id or current_id in seen:
            break
        seen.add(current_id)
        referenced = events_by_id.get(current_id)
        if referenced is None:
            break  # not in this account's collected events; can't resolve further
        referenced_details = referenced.get("details")
        docs = _extract_documents(referenced_details) or []
        # The referenced (canceled) event's own "Dokumente" section can carry BOTH the
        # reissue document TR generates at cancellation time (dated the same day as the
        # correction we're resolving — observed live, always listed first) AND the
        # original distribution's own document (observed live, always listed second,
        # further back in time). Taking the array's first date silently picks the
        # reissue — the same day, providing zero backdating benefit. Take the
        # chronologically EARLIEST parseable date instead; verified live across 12
        # Realty Income correction events, all sharing this exact two-document shape.
        dated = [(d.get("date"), _parse_doc_date_sortkey(d.get("date"))) for d in docs if d.get("date")]
        dated = [(raw, key) for raw, key in dated if key is not None]
        if dated:
            true_date = min(dated, key=lambda pair: pair[1])[0]
            resolution_failed = False
            break
        current_id = _extract_original_dividend_id(referenced_details)
    return {
        "trueDistributionDate": true_date,
        "originalAmount": original_amount,
        "correctionAmount": correction_amount,
        "dateResolutionFailed": resolution_failed or None,
    }


def _extract_savings_plan_id(details):
    """The savings-plan id is carried only in the detail payload (a nested
    `openSavingsPlanOverview` action under the Sparplan section), NOT on the top-level
    timeline event — so read the first `savingsPlanId` value found anywhere in the detail.
    """
    def walk(obj):
        if isinstance(obj, dict):
            spid = obj.get("savingsPlanId")
            if isinstance(spid, str) and spid:
                return spid
            for value in obj.values():
                found = walk(value)
                if found:
                    return found
        elif isinstance(obj, list):
            for item in obj:
                found = walk(item)
                if found:
                    return found
        return None

    return walk(details or {})


def _normalize(event, wkn_by_isin=None, crypto_isin_by_ticker=None, events_by_id=None):
    """Flatten a raw timeline event into the shape the Node mapper consumes.

    Extraction of shares/fees from the detail sections is best-effort and the part most
    sensitive to TR/pytr changes; refine the keyword/number heuristics during live
    validation. `wkn_by_isin` maps each ISIN to its WKN (fetched separately from the
    instrument-detail channel, since timeline events carry only an ISIN). `events_by_id`
    maps every collected event's id to itself (details included) — used only to resolve a
    "Dividend correction" event's referenced original (see _extract_reclassification).
    """
    amount = event.get("amount") or {}
    details = event.get("details")
    isin = _extract_isin(event)
    shares = _extract_shares(details)
    # Crypto position transfers carry neither an isin nor a shares field anywhere (not even
    # in the detail payload) — only a "<qty> <TICKER>" subtitle. Fall back to that, resolving
    # the ISIN via this account's own crypto trades (see _crypto_isin_by_ticker). A ticker we
    # can't resolve (e.g. a coin never separately traded here) leaves isin unset, which the
    # Node mapper turns into a "without an ISIN" attention gap rather than a guess.
    crypto_transfer = _crypto_transfer_qty_and_ticker(event)
    if crypto_transfer is not None:
        qty, ticker = crypto_transfer
        if shares is None:
            shares = qty
        if isin is None:
            isin = (crypto_isin_by_ticker or {}).get(ticker)
    reclass = _extract_reclassification(event, events_by_id or {})
    return {
        "id": event.get("id"),
        "timestamp": event.get("timestamp"),
        "eventType": event.get("eventType"),
        "title": event.get("title"),
        "amount": amount.get("value", 0) or 0,
        "currency": amount.get("currency") or "EUR",
        "isin": isin,
        "wkn": (wkn_by_isin or {}).get(isin) if isin else None,
        "shares": shares,
        "fees": _field(details, ["fee", "gebühr", "provision"]),
        # Top-level first (older event shapes), else dig it out of the detail payload.
        "savingsPlanId": event.get("savingsPlanId") or _extract_savings_plan_id(details),
        # Enrichment from the timeline detail (best-effort; absent fields stay null).
        "executedPrice": _extract_price(details),
        "tax": _extract_tax(details),
        "fxRate": _extract_fx(details),
        "venue": _extract_venue(details),
        "documentRefs": _extract_documents(details),
        "description": _extract_description(event, details),
        # Booking status (EXECUTED / CANCELED / PENDING). Prefer the timeline list item's own
        # field; fall back to the detail header's status for events that carry none at the top
        # level (e.g. securities transfers, whose cancellation only shows in the header). Lets
        # the Node side skip non-executed events and un-import ones cancelled after a sync.
        "status": event.get("status") or _extract_status(details),
        # Acquisition kind hint the Node mapper can't infer from eventType alone. A crypto
        # "1% bonus" trade is a reward-funded purchase (cash-neutral) — flagged here from the
        # detail since the timeline gives no distinguishing event type. "vorabpauschale" flags
        # a Vorabpauschale accrual (see _is_vorabpauschale) so the mapper can route it to a
        # standalone tax booking without re-deriving the detection signal.
        "kind": (
            "vorabpauschale"
            if _is_vorabpauschale(event)
            else "crypto_bonus" if _is_crypto_bonus(event) else None
        ),
        # Vorabpauschale taxable base (gross); None on every other event. See
        # _extract_vorab_base — unverified against a captured real detail payload.
        "vorabBase": _extract_vorab_base(details) if _is_vorabpauschale(event) else None,
        # Present only on a "Dividend correction" event (see _extract_reclassification);
        # None for every ordinary event. trueDistributionDate is DD.MM.YYYY (TR's own
        # format, parsed by the Node mapper) or None if unresolved — dateResolutionFailed
        # then flags the fallback path rather than silently mis-dating the booking.
        "trueDistributionDate": reclass["trueDistributionDate"] if reclass else None,
        "originalAmount": reclass["originalAmount"] if reclass else None,
        "correctionAmount": reclass["correctionAmount"] if reclass else None,
        "dateResolutionFailed": reclass["dateResolutionFailed"] if reclass else None,
    }


def _extract_status(details):
    """Pull a booking status from the detail header section (`type == "header"`, `data.status`),
    upper-cased to match TR's top-level convention. Used for events (e.g. securities transfers)
    that carry no top-level status; a cancelled transfer only signals it here."""
    if not isinstance(details, dict):
        return None
    for section in details.get("sections", []):
        if isinstance(section, dict) and section.get("type") == "header":
            data = section.get("data")
            if isinstance(data, dict):
                status = data.get("status")
                if isinstance(status, str) and status:
                    return status.upper()
    return None


async def _collect_wkns(tr, isins):
    """Map each distinct ISIN to its WKN via TR's instrument-detail channel.

    Timeline events carry only an ISIN; the WKN (German security id) lives as a top-level
    field on the instrument detail. Fetched once per ISIN and best-effort — a failure
    (e.g. a synthetic crypto ISIN with no instrument record) just leaves the WKN absent.
    """
    out = {}
    for isin in isins:
        # TR books crypto under synthetic XF000… ISINs with no instrument record; querying
        # one just blocks until the recv timeout. They never carry a WKN — skip them.
        if isin.startswith("XF000"):
            continue
        try:
            await tr.instrument_details(isin)
            resp = await _await_subscription(
                tr, "instrument", match=lambda s: s.get("id") == isin
            )
            wkn = resp.get("wkn") if isinstance(resp, dict) else None
            if wkn:
                out[isin] = wkn
        except Exception:  # noqa: BLE001 - best effort; WKN is an optional enrichment
            pass
    return out


async def _fetch_cash(tr):
    """TR's reported cash balance per currency, for reconciliation against our derived cash.
    Shape mirrors pytr's own use: a list of {currencyId, amount}."""
    try:
        await tr.cash()
        resp = await _await_subscription(tr, "cash")
        return [
            {"currency": c.get("currencyId"), "amount": c.get("amount")}
            for c in resp
            if isinstance(c, dict) and c.get("currencyId")
        ]
    except Exception:  # noqa: BLE001 - best effort; reconciliation is optional
        return None


async def _fetch_positions(tr):
    """TR's reported position snapshot per ISIN (compactPortfolioByType), for reconciliation
    against our event-derived holdings. Returns [{isin, qty}] for non-zero positions.

    TR renamed this subscription `compactPortfolio` → `compactPortfolioByType` in June 2026
    (pytr #361); the response now groups positions under `categories[].positions` and uses
    `isin` where the old flat `positions` array used `instrumentId`. `tr.compact_portfolio()`
    (pytr ≥ e69aa2d) sends the new subscription type and resolves the securities-account
    number, but returns the raw response, so we flatten + normalise the field here."""
    try:
        await tr.compact_portfolio()
        resp = await _await_subscription(tr, "compactPortfolioByType")
        if isinstance(resp, dict):
            positions = [
                pos
                for cat in resp.get("categories", [])
                if isinstance(cat, dict)
                for pos in cat.get("positions", [])
            ]
        else:
            positions = []
        result = []
        for p in positions:
            if not isinstance(p, dict):
                continue
            isin = p.get("isin") or p.get("instrumentId")
            net_size = p.get("netSize")
            if not isin or net_size is None:
                continue
            try:
                if float(net_size) == 0:
                    continue
            except (ValueError, TypeError):
                continue
            result.append({"isin": isin, "qty": str(net_size)})
        return result
    except Exception:  # noqa: BLE001 - best effort; reconciliation is optional
        return None


async def _probe_instrument(tr, isin) -> int:
    """One-shot diagnostic: dump TR's instrument/stock detail for an ISIN.

    Used to decide where a WKN can be sourced from — TR's timeline events carry only an
    ISIN, so if a WKN exists at all it lives on the instrument-detail channel. Prints the
    raw payloads (no normalisation) so the field name can be read off directly. Not part
    of the sync path; invoked manually via `--probe-instrument <ISIN>`.
    """
    out = {"isin": isin}
    try:
        await tr.instrument_details(isin)
        out["instrument"] = await _await_subscription(tr, "instrument")
    except Exception as exc:  # noqa: BLE001 - diagnostic; report and continue
        out["instrument_error"] = str(exc)
    try:
        await tr.stock_details(isin)
        out["stockDetails"] = await _await_subscription(tr, "stockDetails")
    except Exception as exc:  # noqa: BLE001
        out["stockDetails_error"] = str(exc)
    sys.stdout.write(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    try:
        ws = await tr._get_ws()
        await ws.close()
    except Exception:  # noqa: BLE001 - cleanup only
        pass
    return 0


async def _probe_timeline(tr, limit) -> int:
    """One-shot diagnostic: dump the RAW `timeline_detail_v2` payload for a few security
    events alongside their normalised output.

    This is the payload the detail extractors (`_extract_shares/_extract_tax/_extract_fx/
    _extract_venue/_extract_price`) actually parse. Comparing `rawDetails` against
    `normalized` shows whether the keyword/number heuristics fire on real data — if a
    field is null in `normalized` but visibly present in `rawDetails`, a keyword list is
    wrong. Capture one and paste it into `REAL_DETAIL_SAMPLE` in test_tr_export.py to lock
    the extraction shape against reality. Not part of the sync path.
    """
    events = await _collect_transactions(tr)
    events = await _attach_details(tr, events)
    events_by_id = {e["id"]: e for e in events if e.get("id")}
    picked = [e for e in events if _extract_isin(e)][:limit]
    for e in picked:
        out = {
            "id": e.get("id"),
            "eventType": e.get("eventType"),
            "normalized": _normalize(e, {}, events_by_id=events_by_id),
            "rawDetails": e.get("details"),
        }
        sys.stdout.write(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    try:
        ws = await tr._get_ws()
        await ws.close()
    except Exception:  # noqa: BLE001 - cleanup only
        pass
    return 0


# Shared by --probe-events (all three, census) and --probe-feed (one, full raw dump).
_TIMELINE_FEEDS = (
    ("timelineTransactions", lambda tr: lambda after=None: tr.timeline_transactions(after)),
    ("timelineActivityLog", lambda tr: lambda after=None: tr.timeline_activity_log(after)),
    ("timeline", lambda tr: lambda after=None: tr.timeline(after)),
)


async def _probe_feed(tr, feed_name) -> int:
    """One-shot diagnostic: dump EVERY raw event on a single named timeline feed, verbatim.

    Unlike --probe-events (one sample per event type, across all feeds combined), this pages
    one feed to exhaustion and prints every event as-is — for isolating whether a specific
    feed (timeline / timelineTransactions / timelineActivityLog) is missing, malformed, or
    slow, without the other two feeds' traffic in the way. Not part of the sync path.
    """
    method_by_name = dict(_TIMELINE_FEEDS)
    if feed_name not in method_by_name:
        print(
            f"unknown feed {feed_name!r}; choose one of {', '.join(method_by_name)}",
            file=sys.stderr,
        )
        return 1
    feed_method = method_by_name[feed_name](tr)
    events = await _collect_feed(tr, feed_method, feed_name)
    for event in events.values():
        sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    print(f"{len(events)} events on {feed_name}", file=sys.stderr)
    try:
        ws = await tr._get_ws()
        await ws.close()
    except Exception:  # noqa: BLE001 - cleanup only
        pass
    return 0


async def _probe_events(tr) -> int:
    """One-shot diagnostic: census every raw event across ALL of TR's timeline feeds.

    The sync path subscribes only to `timelineTransactions` (money movements). Cash-neutral
    securities transfers and many informational events live on `timelineActivityLog` (and the
    legacy `timeline`) instead, so they never reach the mapper and never surface as import
    errors. This dumps a per-feed census grouped by event type (falling back to the subtitle
    when `eventType` is null, as the legacy transfer form is), with one sample per type, plus
    the id-overlap between feeds — so we can see which types exist, on which feed, and whether
    ids are shared (→ merge-by-id is safe) before changing the collector. Not part of sync.
    """
    feeds = tuple((name, factory(tr)) for name, factory in _TIMELINE_FEEDS)
    by_feed = {}
    for sub_type, method in feeds:
        try:
            by_feed[sub_type] = await _collect_feed(tr, method, sub_type)
        except Exception as exc:  # noqa: BLE001 - diagnostic; report and continue
            by_feed[sub_type] = {}
            print(f"feed {sub_type} failed: {exc}", file=sys.stderr)

    def _type_key(ev):
        return ev.get("eventType") or f"(null:subtitle={ev.get('subtitle')})"

    out = {"feeds": {}, "idOverlap": {}}
    for sub_type, events in by_feed.items():
        census = {}
        for ev in events.values():
            entry = census.setdefault(_type_key(ev), {"count": 0, "sample": None})
            entry["count"] += 1
            if entry["sample"] is None:
                entry["sample"] = {
                    "id": ev.get("id"),
                    "eventType": ev.get("eventType"),
                    "subtitle": ev.get("subtitle"),
                    "title": ev.get("title"),
                    "amount": (ev.get("amount") or {}).get("value"),
                    "hasIsin": bool(_extract_isin(ev)),
                }
        out["feeds"][sub_type] = {"total": len(events), "byType": census}

    # id-overlap drives the safe merge-by-id decision (shared ids → no double-count).
    ids = {sub_type: set(events) for sub_type, events in by_feed.items()}
    names = list(ids)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            out["idOverlap"][f"{a} ∩ {b}"] = {
                "shared": len(ids[a] & ids[b]),
                f"only_{a}": len(ids[a] - ids[b]),
                f"only_{b}": len(ids[b] - ids[a]),
            }

    sys.stdout.write(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    try:
        ws = await tr._get_ws()
        await ws.close()
    except Exception:  # noqa: BLE001 - cleanup only
        pass
    return 0


async def _run(tr) -> int:
    events = await _collect_transactions(tr)
    events = await _attach_details(tr, events)
    isins = {isin for isin in (_extract_isin(e) for e in events) if isin}
    wkn_by_isin = await _collect_wkns(tr, isins)
    crypto_isin_by_ticker = _crypto_isin_by_ticker(events)
    events_by_id = {e["id"]: e for e in events if e.get("id")}
    for event in events:
        sys.stdout.write(
            json.dumps(_normalize(event, wkn_by_isin, crypto_isin_by_ticker, events_by_id))
            + "\n"
        )
    # A trailing, clearly-tagged summary line (not an event) carrying TR's reported balances.
    cash = await _fetch_cash(tr)
    positions = await _fetch_positions(tr)
    sys.stdout.write(json.dumps({"__summary__": {"cash": cash, "positions": positions}}) + "\n")
    sys.stdout.flush()
    # Persist the rolling session so the next sync can resume without re-pairing.
    try:
        tr.save_websession()
    except Exception:  # noqa: BLE001 - best effort
        pass
    try:
        ws = await tr._get_ws()
        await ws.close()
    except Exception:  # noqa: BLE001 - cleanup only
        pass
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cookies-file", required=True)
    parser.add_argument(
        "--probe-instrument",
        metavar="ISIN",
        help="Diagnostic: dump TR instrument/stock detail for one ISIN and exit (no export).",
    )
    parser.add_argument(
        "--probe-timeline",
        type=int,
        metavar="N",
        help="Diagnostic: dump raw timeline_detail_v2 + normalised output for N security "
        "events and exit (no export). Used to validate the detail extractors vs reality.",
    )
    parser.add_argument(
        "--probe-events",
        action="store_true",
        help="Diagnostic: census every raw event across ALL timeline feeds "
        "(timelineTransactions/timelineActivityLog/timeline) with id-overlap, then exit. "
        "Reveals event types on feeds the sync path does not subscribe to.",
    )
    parser.add_argument(
        "--probe-feed",
        choices=[name for name, _ in _TIMELINE_FEEDS],
        metavar="FEED",
        help="Diagnostic: dump every raw event on ONE named feed verbatim (NDJSON), then "
        "exit. Choices: " + ", ".join(name for name, _ in _TIMELINE_FEEDS) + ".",
    )
    args = parser.parse_args()

    phone = os.environ.get("TR_PHONE")
    pin = os.environ.get("TR_PIN")
    if not phone or not pin:
        print("TR_PHONE and TR_PIN must be set", file=sys.stderr)
        return 1

    try:
        from pytr.api import TradeRepublicApi
    except ImportError as exc:  # pragma: no cover - import guard
        print(f"pytr not installed: {exc}", file=sys.stderr)
        return 1

    tr = TradeRepublicApi(
        phone_no=phone,
        pin=pin,
        save_cookies=True,
        cookies_file=args.cookies_file,
    )

    if not tr.resume_websession():
        print("session expired", file=sys.stderr)
        return 2

    try:
        if args.probe_instrument:
            return asyncio.run(_probe_instrument(tr, args.probe_instrument))
        if args.probe_timeline:
            return asyncio.run(_probe_timeline(tr, args.probe_timeline))
        if args.probe_events:
            return asyncio.run(_probe_events(tr))
        if args.probe_feed:
            return asyncio.run(_probe_feed(tr, args.probe_feed))
        return asyncio.run(_run(tr))
    except Exception as exc:  # noqa: BLE001
        print(f"export failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
