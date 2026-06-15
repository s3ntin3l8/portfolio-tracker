#!/usr/bin/env python3
"""Vendored pytr entrypoint: Trade Republic web-login pairing (v2 push-approval).

Trade Republic deprecated the legacy ``/api/v1/auth/web/login`` (SMS-code) endpoint —
it now returns 405/426. The current flow is ``/api/v2/auth/web/login``: the client posts
phone+PIN with a device fingerprint, Trade Republic sends a **push to the mobile app**,
and the client polls the login process until the user approves it. There is no SMS code.

We *vendor* that v2 flow here as a thin subclass of pytr's ``TradeRepublicApi`` rather than
depend on an (unmerged) upstream fork: pytr 0.4.9 (the latest PyPI release) still does the
AWS-WAF minting, cookie/session jar and timeline export correctly, so we reuse all of that
and override only the broken login. ``requirements.txt`` therefore stays at ``pytr==0.4.9``
and the Docker image is unchanged. The v2 request shape (endpoint, headers, device-info)
mirrors pytr-org/pytr PR #355.

Contract (the Node runner in services/pytr/runner.ts depends on this exactly):
  argv:  pair --cookies-file PATH --waf-strategy {awswaf|playwright|token}
  env:   TR_PHONE, TR_PIN, (when strategy == token) TR_WAF_TOKEN,
         (optional) PYTR_DEVICE_ID_FILE — stable device id path (default ~/.pytr/device_id)
  flow:
    1. mint the AWS-WAF token and POST /api/v2/auth/web/login → a push is sent to the app
    2. print ONE JSON line to stdout: {"processId": "...", "status": "awaiting_approval"}
    3. poll the login process until the user approves the push in the TR mobile app
    4. on approval pytr saves the cookie session to --cookies-file
    5. exit 0 on success; exit 3 if the login is rejected/expired; exit 1 on any other
       failure (a human-readable reason is written to stderr)

NOTE: validated live against pytr==0.4.9 + this vendored v2 flow on 2026-06-15. TR's
private protocol (endpoint, headers, app version) can change; PYTR_TR_APP_VERSION /
PYTR_TR_USER_AGENT (read by pytr) and PYTR_DEVICE_ID_FILE allow overrides without a code
change.
"""

import argparse
import base64
import json
import os
import pathlib
import sys
import time

# Web app values captured from app.traderepublic.com (see PR #355); overridable via env.
TR_WEB_APP_VERSION = os.environ.get("PYTR_TR_APP_VERSION", "15.7.0")
TR_WEB_LOGIN_PATH = "/api/v2/auth/web/login"
APPROVAL_TIMEOUT_S = int(os.environ.get("PYTR_APPROVAL_TIMEOUT_S", "180"))
APPROVAL_POLL_INTERVAL_S = float(os.environ.get("PYTR_APPROVAL_POLL_INTERVAL_S", "2.0"))


def _device_id_file() -> pathlib.Path:
    override = os.environ.get("PYTR_DEVICE_ID_FILE")
    return pathlib.Path(override) if override else pathlib.Path.home() / ".pytr" / "device_id"


def _build_login_overlay(base_cls):
    """Build a TradeRepublicApi subclass that speaks the v2 web-login flow."""
    import uuid

    class TrV2WebLogin(base_cls):
        def _get_device_id(self) -> str:
            """Stable per-install device id (64 hex chars, like the web app)."""
            path = _device_id_file()
            try:
                return path.read_text().strip()
            except FileNotFoundError:
                path.parent.mkdir(parents=True, exist_ok=True)
                device_id = uuid.uuid4().hex + uuid.uuid4().hex
                path.write_text(device_id)
                return device_id

        def _build_device_info_header(self) -> str:
            """base64(JSON) x-tr-device-info payload the web app sends."""
            payload = {
                "stableDeviceId": self._get_device_id(),
                "model": "Apple Macintosh",
                "browser": "Chrome",
                "browserVersion": "148.0.0.0",
                "os": "Mac OS",
                "osVersion": "10.15.7",
                "timezone": "Europe/Amsterdam",
                "timezoneOffset": -120,
                "screen": "1800x1169x30",
                "preferredLanguages": ["en", "en-US"],
                "numberOfCores": 12,
                "deviceMemory": 16,
            }
            raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            return base64.b64encode(raw).decode("ascii")

        def _v2_auth_headers(self):
            headers = {
                "x-tr-platform": "web",
                "x-tr-app-version": TR_WEB_APP_VERSION,
                "x-tr-device-info": self._build_device_info_header(),
            }
            if self._waf_token:
                headers["x-aws-waf-token"] = self._waf_token
            return headers

        def initiate_v2_weblogin(self) -> str:
            """Mint the WAF token, POST the v2 login, return the processId. No polling."""
            if self._waf_token == "awswaf":
                self._waf_token = self._fetch_waf_token_awswaf()
            elif self._waf_token == "playwright":
                self._waf_token = self._fetch_waf_token_playwright()
            if self._waf_token:
                self._set_waf_cookie(self._waf_token)

            r = self._websession.post(
                f"{self._host}{TR_WEB_LOGIN_PATH}",
                json={"phoneNumber": self.phone_no, "pin": self.pin},
                headers=self._v2_auth_headers(),
            )
            r.raise_for_status()
            j = r.json()
            try:
                self._process_id = j["processId"]
            except KeyError:
                err = j.get("errors")
                raise ValueError(str(err) if err else "processId not in response")
            return self._process_id

        def await_v2_approval(
            self, timeout_s: int = APPROVAL_TIMEOUT_S, interval_s: float = APPROVAL_POLL_INTERVAL_S
        ) -> None:
            """Poll the login process until the app push is approved; then save cookies."""
            url = f"{self._host}{TR_WEB_LOGIN_PATH}/processes/{self._process_id}"
            deadline = time.time() + timeout_s
            while time.time() < deadline:
                r = self._websession.get(url, headers=self._v2_auth_headers())
                if r.status_code == 200:
                    try:
                        j = r.json()
                    except ValueError:
                        j = {}
                    state = str(j.get("state") or j.get("status") or "").upper()
                    if state in ("APPROVED", "COMPLETED", "SUCCESS", "OK", "DONE"):
                        self.save_websession()
                        return
                    if state in ("REJECTED", "DECLINED", "FAILED", "EXPIRED"):
                        raise PermissionError(f"login {state.lower()}")
                    # Some responses omit a terminal state but set the session cookie.
                    for c in self._websession.cookies:
                        if c.name == "tr_session" and c.value:
                            self.save_websession()
                            return
                elif r.status_code in (401, 403, 404, 410):
                    raise PermissionError(f"login process gone ({r.status_code})")
                time.sleep(interval_s)
            raise TimeoutError("push approval not received within timeout")

    return TrV2WebLogin


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

    # 'token' = use the literal AWS-WAF token from the environment (break-glass paste);
    # otherwise pass the strategy string through ('awswaf' | 'playwright') for pytr to mint.
    waf_token = args.waf_strategy
    if waf_token == "token":
        waf_token = os.environ.get("TR_WAF_TOKEN", "")
        if not waf_token:
            print("TR_WAF_TOKEN must be set for the token strategy", file=sys.stderr)
            return 1

    tr = _build_login_overlay(TradeRepublicApi)(
        phone_no=phone,
        pin=pin,
        save_cookies=True,
        cookies_file=args.cookies_file,
        waf_token=waf_token,
    )

    try:
        process_id = tr.initiate_v2_weblogin()
    except Exception as exc:  # noqa: BLE001 - surface any failure to the runner
        print(f"initiate_weblogin failed: {exc}", file=sys.stderr)
        return 1

    # Tell the runner the push has been sent; it flips the connection to 'awaiting_approval'.
    print(json.dumps({"processId": process_id, "status": "awaiting_approval"}), flush=True)

    try:
        tr.await_v2_approval()
    except PermissionError as exc:
        print(f"login not approved: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:  # noqa: BLE001
        print(f"await_approval failed: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
