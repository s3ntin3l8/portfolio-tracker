#!/usr/bin/env python3
"""Download Trade Republic postbox document bytes by re-fetching timeline_detail_v2.

For each (eventId, docId) pair fed on stdin, this script re-fetches the
`timeline_detail_v2` detail payload (which gives a fresh, short-lived presigned URL),
locates the matching documents-section row, resolves the download URL, GETs the bytes
via the authenticated websession, and writes them to `--out DIR/{docId}.pdf`.

Contract (consumed by services/pytr/runner.ts `downloadDocuments()`):
  argv:  --cookies-file PATH --out DIR
  stdin: NDJSON lines, each {"eventId": "...", "docId": "..."}
  stdout: NDJSON per pair:
            ok:  {"docId":"...","file":"...","mimeType":"...","ok":true}
            err: {"docId":"...","ok":false,"error":"..."}
  exit:  0 → processed all pairs (some may be ok:false — best-effort)
         2 → session expired (re-pairing required)
         1 → hard failure (Python error or pytr import failure)

Re-fetching the detail (rather than caching the URL from tr_export.py) gives a fresh
presigned URL, sidestepping the short-lived S3 expiry. The same pytr WebSocket session
(resumed from the cookies file) authorizes both the detail subscription and the HTTP GET.

NOTE: only called when portfolio.documentRetention=true. Future-synced events only —
incremental sync skips already-ledger'd events, so pre-retention transactions never get
their PDFs retroactively.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

RECV_TIMEOUT_S = 30
TR_BASE_URL = "https://api.traderepublic.com"


async def _await_subscription(tr, sub_type, match=None):
    """Recv on the WebSocket until the response for our subscription arrives.

    Mirrors the same helper in tr_export.py — same protocol contract.
    """
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


def _resolve_doc_url(payload):
    """Resolve the document download URL from an action.payload value.

    Trade Republic uses two URL forms in documents sections:
      1. A plain presigned S3 string → use directly.
      2. A dict {"path": "/api/v1/postbox/..."} → prefix with TR_BASE_URL.

    Returns the URL string, or None if the payload is unrecognised.
    """
    if isinstance(payload, str) and payload:
        return payload
    if isinstance(payload, dict):
        path = payload.get("path") or ""
        if path:
            return f"{TR_BASE_URL}/{path.lstrip('/')}"
    return None


def _find_doc_url(details, doc_id):
    """Locate the download URL for a specific doc id within a timelineDetailV2 payload.

    Scans all sections whose type is "documents", looking for a row whose "id" matches
    doc_id, then resolves its action.payload. Returns None if not found.
    """
    for section in (details or {}).get("sections", []) or []:
        if section.get("type") != "documents":
            continue
        data = section.get("data")
        rows = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
        for row in rows:
            if not isinstance(row, dict):
                continue
            if row.get("id") != doc_id:
                continue
            action = row.get("action")
            if not isinstance(action, dict):
                continue
            url = _resolve_doc_url(action.get("payload"))
            if url:
                return url
    return None


async def _download_one(tr, session, event_id, doc_id, out_dir):
    """Re-fetch the event detail, extract the URL, download, and save bytes.

    Returns (filename, mimeType) on success. Raises on any failure.
    """
    # Re-fetch detail for a fresh presigned URL.
    await tr.timeline_detail_v2(event_id)
    details = await _await_subscription(
        tr,
        "timelineDetailV2",
        match=lambda s: s.get("id") == event_id,
    )

    url = _find_doc_url(details, doc_id)
    if not url:
        raise ValueError(
            f"no download URL found for doc {doc_id!r} in event {event_id!r}"
        )

    # pytr's `_websession` is a synchronous `requests.Session` (api.py:100), not an
    # aiohttp session — so `.get()` returns a `requests.Response` directly: no
    # `async with`, `.status_code` (not `.status`), and `.content` (not `await .read()`).
    # The same session carries TR's auth cookies/headers, which a presigned S3 URL
    # ignores and a `{path}`-form TR postbox URL requires.
    resp = session.get(url)
    if resp.status_code != 200:
        raise OSError(f"HTTP {resp.status_code} fetching doc {doc_id!r}")
    body = resp.content
    # Content-Type may carry a charset suffix; take only the MIME part.
    mime = resp.headers.get("Content-Type", "application/pdf").split(";")[0].strip()

    filename = f"{doc_id}.pdf"
    out_path = Path(out_dir) / filename
    out_path.write_bytes(body)
    return filename, mime


async def _run(tr, pairs, out_dir):
    """Download all pairs, emitting one NDJSON result line per pair."""
    # Open the WebSocket connection (needed for timeline_detail_v2 subscriptions).
    # _websession is the aiohttp.ClientSession that carries the TR auth cookies.
    await tr._get_ws()
    session = tr._websession

    for event_id, doc_id in pairs:
        try:
            filename, mime = await _download_one(tr, session, event_id, doc_id, out_dir)
            line = {"docId": doc_id, "file": filename, "mimeType": mime, "ok": True}
        except Exception as exc:  # noqa: BLE001 — best-effort; one failure must not stop others
            line = {"docId": doc_id, "ok": False, "error": str(exc)}
            print(
                f"doc download failed {doc_id!r} (event {event_id!r}): {exc}",
                file=sys.stderr,
            )
        sys.stdout.write(json.dumps(line) + "\n")
        sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download TR postbox docs for given event/doc id pairs."
    )
    parser.add_argument("--cookies-file", required=True, help="pytr session cookie file")
    parser.add_argument("--out", required=True, metavar="DIR", help="output directory for downloaded bytes")
    args = parser.parse_args()

    phone = os.environ.get("TR_PHONE")
    pin = os.environ.get("TR_PIN")
    if not phone or not pin:
        print("TR_PHONE and TR_PIN must be set", file=sys.stderr)
        return 1

    # Read (eventId, docId) pairs from stdin as NDJSON.
    pairs = []
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            pairs.append((str(obj["eventId"]), str(obj["docId"])))
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            print(f"invalid stdin line {line!r}: {exc}", file=sys.stderr)
            return 1

    if not pairs:
        return 0  # nothing to do

    try:
        from pytr.api import TradeRepublicApi
    except ImportError as exc:  # pragma: no cover
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
        asyncio.run(_run(tr, pairs, args.out))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"documents download failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
