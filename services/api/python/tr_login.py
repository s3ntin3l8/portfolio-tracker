#!/usr/bin/env python3
"""Vendored pytr entrypoint: Trade Republic web-login pairing.

This is the stateful half of pairing — `initiate_weblogin` and `complete_weblogin`
must run in the SAME process (the WebSocket/process-id state is not persisted), so the
Node runner keeps this process alive across the "awaiting 2FA" window and feeds the
code on stdin.

Contract (the Node runner in services/pytr/runner.ts depends on this exactly):
  argv:  pair --cookies-file PATH --waf-strategy {awswaf|playwright|token}
  env:   TR_PHONE, TR_PIN, and (when strategy == token) TR_WAF_TOKEN
  flow:
    1. print ONE JSON line to stdout: {"processId": "...", "countdown": N}
    2. read ONE line from stdin: the 4-digit 2FA code
    3. complete login; pytr saves the cookie session to --cookies-file
    4. exit 0 on success; exit 3 on a bad code; exit 1 on any other failure
       (a human-readable reason is written to stderr)

NOTE: validated live against pytr==0.4.10 during pairing; pytr's private TR protocol
can change between versions.
"""

import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    pair = sub.add_parser("pair")
    pair.add_argument("--cookies-file", required=True)
    pair.add_argument("--waf-strategy", default="awswaf")
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

    # 'token' means use the literal AWS-WAF token from the environment (break-glass
    # paste); otherwise the strategy string ('awswaf' | 'playwright') is passed through
    # to pytr, which knows how to mint a token that way.
    waf_token = args.waf_strategy
    if waf_token == "token":
        waf_token = os.environ.get("TR_WAF_TOKEN", "")
        if not waf_token:
            print("TR_WAF_TOKEN must be set for the token strategy", file=sys.stderr)
            return 1

    tr = TradeRepublicApi(
        phone_no=phone,
        pin=pin,
        save_cookies=True,
        cookies_file=args.cookies_file,
        waf_token=waf_token,
    )

    try:
        countdown = tr.initiate_weblogin()
    except Exception as exc:  # noqa: BLE001 - surface any failure to the runner
        print(f"initiate_weblogin failed: {exc}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {"processId": getattr(tr, "_process_id", ""), "countdown": countdown}
        ),
        flush=True,
    )

    code = sys.stdin.readline().strip()
    if not code:
        print("no 2FA code provided", file=sys.stderr)
        return 1

    try:
        # complete_weblogin calls save_websession() internally, writing --cookies-file.
        tr.complete_weblogin(code)
    except Exception as exc:  # noqa: BLE001
        print(f"complete_weblogin failed: {exc}", file=sys.stderr)
        return 3

    return 0


if __name__ == "__main__":
    sys.exit(main())
