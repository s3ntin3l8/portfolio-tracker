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
   isin?, wkn?, shares?, fees?, savingsPlanId?, status?}
The WKN is fetched per distinct ISIN from the instrument-detail channel (timeline events
carry only an ISIN); everything else comes from the timeline list + its detail payload.
Extraction of isin/shares/fees from the timeline detail is best-effort and the part most
sensitive to pytr/TR changes; the raw detail is scanned defensively.

NOTE: targets pytr==0.4.9 (the latest published release); not yet validated against a
live account. TR's private protocol can change.
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


async def _collect_transactions(tr):
    events = {}
    await tr.timeline_transactions()
    while True:
        response = await _await_subscription(tr, "timelineTransactions")
        for event in response.get("items", []):
            if event.get("id"):
                events[event["id"]] = event
        after = (response.get("cursors") or {}).get("after")
        if not after:
            break
        await tr.timeline_transactions(after)
    return list(events.values())


async def _attach_details(tr, events):
    for event in events:
        event_id = event["id"]
        try:
            await tr.timeline_detail_v2(event_id)
            event["details"] = await _await_subscription(
                tr,
                "timelineDetailV2",
                match=lambda s: s.get("id") == event_id,
            )
        except Exception:  # noqa: BLE001 - details are best-effort
            event["details"] = None
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


def _extract_tax(details):
    """Tax withheld/corrected (Steuer/Steuern/Steuerkorrektur), signed as TR shows it."""
    return _field(details, ["steuer"])  # matches Steuer, Steuern, Steuerkorrektur


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


def _normalize(event, wkn_by_isin=None):
    """Flatten a raw timeline event into the shape the Node mapper consumes.

    Extraction of shares/fees from the detail sections is best-effort and the part most
    sensitive to TR/pytr changes; refine the keyword/number heuristics during live
    validation. `wkn_by_isin` maps each ISIN to its WKN (fetched separately from the
    instrument-detail channel, since timeline events carry only an ISIN).
    """
    amount = event.get("amount") or {}
    details = event.get("details")
    isin = _extract_isin(event)
    return {
        "id": event.get("id"),
        "timestamp": event.get("timestamp"),
        "eventType": event.get("eventType"),
        "title": event.get("title"),
        "amount": amount.get("value", 0) or 0,
        "currency": amount.get("currency") or "EUR",
        "isin": isin,
        "wkn": (wkn_by_isin or {}).get(isin) if isin else None,
        "shares": _extract_shares(details),
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
        # Booking status (EXECUTED / CANCELED / PENDING). Read from the timeline list item
        # itself — no extra detail fetch — so the Node side can skip non-executed events and
        # un-import ones that were cancelled after a prior sync confirmed them.
        "status": event.get("status"),
    }


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
    picked = [e for e in events if _extract_isin(e)][:limit]
    for e in picked:
        out = {
            "id": e.get("id"),
            "eventType": e.get("eventType"),
            "normalized": _normalize(e, {}),
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


async def _run(tr) -> int:
    events = await _collect_transactions(tr)
    events = await _attach_details(tr, events)
    isins = {isin for isin in (_extract_isin(e) for e in events) if isin}
    wkn_by_isin = await _collect_wkns(tr, isins)
    for event in events:
        sys.stdout.write(json.dumps(_normalize(event, wkn_by_isin)) + "\n")
    # A trailing, clearly-tagged summary line (not an event) carrying TR's reported balances.
    cash = await _fetch_cash(tr)
    sys.stdout.write(json.dumps({"__summary__": {"cash": cash}}) + "\n")
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
        return asyncio.run(_run(tr))
    except Exception as exc:  # noqa: BLE001
        print(f"export failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
