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
   isin?, shares?, fees?, savingsPlanId?, status?}
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

    First a labelled row (Anteile/Aktien/Shares/Anzahl/Stück); failing that, the
    'Transaktion' row that aggregate buys (round-up, saveback) carry as '<shares> x
    <price>' — distinguished from a plain cash 'transaction' amount by the ' x '/'×'.
    """
    for title, text in _walk_rows(details or {}):
        if any(k in title for k in ("anteile", "aktien", "shares", "anzahl", "stück")) and (
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
    match = ISIN_RE.search(event.get("icon") or "")
    if match:
        return match.group(1)
    match = ISIN_RE.search(json.dumps(event.get("details") or {}))
    return match.group(1) if match else None


def _normalize(event):
    """Flatten a raw timeline event into the shape the Node mapper consumes.

    Extraction of shares/fees from the detail sections is best-effort and the part most
    sensitive to TR/pytr changes; refine the keyword/number heuristics during live
    validation.
    """
    amount = event.get("amount") or {}
    details = event.get("details")
    return {
        "id": event.get("id"),
        "timestamp": event.get("timestamp"),
        "eventType": event.get("eventType"),
        "title": event.get("title"),
        "amount": amount.get("value", 0) or 0,
        "currency": amount.get("currency") or "EUR",
        "isin": _extract_isin(event),
        "shares": _extract_shares(details),
        "fees": _field(details, ["fee", "gebühr", "provision"]),
        "savingsPlanId": event.get("savingsPlanId"),
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


async def _run(tr) -> int:
    events = await _collect_transactions(tr)
    events = await _attach_details(tr, events)
    for event in events:
        sys.stdout.write(json.dumps(_normalize(event)) + "\n")
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
        return asyncio.run(_run(tr))
    except Exception as exc:  # noqa: BLE001
        print(f"export failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
