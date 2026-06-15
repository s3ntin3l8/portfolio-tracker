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
   isin?, shares?, fees?, savingsPlanId?}
Extraction of isin/shares/fees from the timeline detail is best-effort and the part most
sensitive to pytr/TR changes; the raw detail is scanned defensively.

NOTE: validated live against pytr==0.4.10; TR's private protocol can change.
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
    """Parse a (possibly European-formatted) number out of a label, e.g. '1.234,56 €'."""
    match = re.search(r"-?\d[\d.\s]*(?:,\d+)?", text)
    if not match:
        return None
    raw = match.group(0).replace(" ", "").replace(".", "").replace(",", ".")
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
        "shares": _field(details, ["shares", "anteile", "anzahl"]),
        "fees": _field(details, ["fee", "gebühr", "provision"]),
        "savingsPlanId": event.get("savingsPlanId"),
    }


async def _run(tr) -> int:
    events = await _collect_transactions(tr)
    events = await _attach_details(tr, events)
    for event in events:
        sys.stdout.write(json.dumps(_normalize(event)) + "\n")
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
