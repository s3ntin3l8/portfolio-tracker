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

Each emitted line is a raw timeline event: {id, timestamp, eventType, title, subtitle,
amount, ..., "details": <timelineDetailV2 payload>}. The Node mapper extracts ISIN /
shares / fees / taxes defensively — the exact detail-section keys vary by event type.

NOTE: validated live against pytr==0.4.10; TR's private protocol can change.
"""

import argparse
import asyncio
import json
import os
import sys

RECV_TIMEOUT_S = 30


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


async def _run(tr) -> int:
    events = await _collect_transactions(tr)
    events = await _attach_details(tr, events)
    for event in events:
        sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()
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
