"""Unit tests for tr_documents.py — the TR postbox document downloader.

Tests the URL-resolution and row-location helpers (pure functions, no network/TR
session required). The doc-download happy path and per-doc failure recovery require
async mocking; they are tested with asyncio.run() + lightweight fakes.

Run: `.venv-pytr/bin/python -m pytest services/api/python` (or via `npm run test:py`).
"""

import asyncio
import json
import sys
import io
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import tr_documents as td


# ---------------------------------------------------------------------------
# _resolve_doc_url
# ---------------------------------------------------------------------------


class TestResolveDocUrl:
    def test_plain_presigned_s3_string(self):
        url = "https://s3.amazonaws.com/tr-postbox/doc.pdf?X-Amz-Signature=abc"
        assert td._resolve_doc_url(url) == url

    def test_dict_path_form(self):
        payload = {"path": "/api/v1/postbox/docs/abc123.pdf"}
        assert td._resolve_doc_url(payload) == (
            "https://api.traderepublic.com/api/v1/postbox/docs/abc123.pdf"
        )

    def test_dict_path_without_leading_slash(self):
        payload = {"path": "api/v1/postbox/docs/abc123.pdf"}
        assert td._resolve_doc_url(payload) == (
            "https://api.traderepublic.com/api/v1/postbox/docs/abc123.pdf"
        )

    def test_empty_string_returns_none(self):
        assert td._resolve_doc_url("") is None

    def test_dict_missing_path_returns_none(self):
        assert td._resolve_doc_url({"other": "value"}) is None

    def test_none_returns_none(self):
        assert td._resolve_doc_url(None) is None

    def test_integer_returns_none(self):
        assert td._resolve_doc_url(42) is None


# ---------------------------------------------------------------------------
# _find_doc_url
# ---------------------------------------------------------------------------

# A realistic documents section from a timelineDetailV2 payload.
DETAIL_PAYLOAD = {
    "sections": [
        {
            "type": "header",
            "data": {"title": "Wertpapierabrechnung"},
        },
        {
            "type": "documents",
            "data": [
                {
                    "id": "doc-abc",
                    "postboxType": "SECURITIES_SETTLEMENT",
                    "detail": "2026-03-01",
                    "action": {
                        "payload": "https://s3.amazonaws.com/tr-postbox/doc-abc.pdf?sig=x"
                    },
                },
                {
                    "id": "doc-xyz",
                    "postboxType": "TAX_SETTLEMENT",
                    "detail": "2026-03-01",
                    "action": {
                        "payload": {"path": "/api/v1/postbox/docs/doc-xyz.pdf"}
                    },
                },
            ],
        },
    ]
}


class TestFindDocUrl:
    def test_finds_url_for_string_payload(self):
        url = td._find_doc_url(DETAIL_PAYLOAD, "doc-abc")
        assert url == "https://s3.amazonaws.com/tr-postbox/doc-abc.pdf?sig=x"

    def test_finds_url_for_dict_payload(self):
        url = td._find_doc_url(DETAIL_PAYLOAD, "doc-xyz")
        assert url == "https://api.traderepublic.com/api/v1/postbox/docs/doc-xyz.pdf"

    def test_returns_none_for_unknown_doc_id(self):
        assert td._find_doc_url(DETAIL_PAYLOAD, "doc-missing") is None

    def test_returns_none_for_empty_details(self):
        assert td._find_doc_url({}, "doc-abc") is None

    def test_returns_none_for_none_details(self):
        assert td._find_doc_url(None, "doc-abc") is None

    def test_single_dict_data_item(self):
        """data can be a single dict rather than a list."""
        payload = {
            "sections": [
                {
                    "type": "documents",
                    "data": {
                        "id": "doc-single",
                        "action": {"payload": "https://example.com/doc.pdf"},
                    },
                }
            ]
        }
        assert td._find_doc_url(payload, "doc-single") == "https://example.com/doc.pdf"

    def test_ignores_non_documents_sections(self):
        """Other section types must not be scanned."""
        payload = {
            "sections": [
                {
                    "type": "header",
                    "data": [{"id": "doc-abc", "action": {"payload": "https://trap.example.com/"}}],
                }
            ]
        }
        assert td._find_doc_url(payload, "doc-abc") is None


# ---------------------------------------------------------------------------
# _download_one — async unit tests with fakes
# ---------------------------------------------------------------------------


def _make_fake_tr(detail_payload):
    """Fake TR object whose recv() returns one detail response."""
    tr = MagicMock()

    # timeline_detail_v2 is async (pytr uses it with await)
    tr.timeline_detail_v2 = AsyncMock()
    tr.unsubscribe = AsyncMock()

    async def fake_recv():
        # Returns (sub_id, subscription, response) matching the _await_subscription loop.
        return (
            "sub-1",
            {"type": "timelineDetailV2", "id": "event-1"},
            detail_payload,
        )

    tr.recv = fake_recv
    return tr


class TestDownloadOne:
    def test_downloads_and_writes_bytes(self, tmp_path):
        """Happy path: fresh detail → URL → bytes written to out_dir."""
        pdf_bytes = b"%PDF-1.4 fake"

        fake_resp = MagicMock()
        fake_resp.status = 200
        fake_resp.headers = {"Content-Type": "application/pdf"}
        fake_resp.read = AsyncMock(return_value=pdf_bytes)
        fake_resp.__aenter__ = AsyncMock(return_value=fake_resp)
        fake_resp.__aexit__ = AsyncMock(return_value=False)

        fake_session = MagicMock()
        fake_session.get = MagicMock(return_value=fake_resp)

        tr = _make_fake_tr(DETAIL_PAYLOAD)

        filename, mime = asyncio.run(
            td._download_one(tr, fake_session, "event-1", "doc-abc", tmp_path)
        )

        assert filename == "doc-abc.pdf"
        assert mime == "application/pdf"
        assert (tmp_path / "doc-abc.pdf").read_bytes() == pdf_bytes

    def test_raises_when_doc_id_not_in_detail(self, tmp_path):
        """Missing doc id in the fetched detail must raise (caller catches → ok:false)."""
        tr = _make_fake_tr(DETAIL_PAYLOAD)
        fake_session = MagicMock()

        with pytest.raises(ValueError, match="no download URL found"):
            asyncio.run(
                td._download_one(tr, fake_session, "event-1", "doc-missing", tmp_path)
            )

    def test_raises_on_http_error(self, tmp_path):
        """A non-200 status must raise (caller catches → ok:false)."""
        fake_resp = MagicMock()
        fake_resp.status = 403
        fake_resp.headers = {}
        fake_resp.read = AsyncMock(return_value=b"")
        fake_resp.__aenter__ = AsyncMock(return_value=fake_resp)
        fake_resp.__aexit__ = AsyncMock(return_value=False)

        fake_session = MagicMock()
        fake_session.get = MagicMock(return_value=fake_resp)

        tr = _make_fake_tr(DETAIL_PAYLOAD)

        with pytest.raises(OSError, match="HTTP 403"):
            asyncio.run(
                td._download_one(tr, fake_session, "event-1", "doc-abc", tmp_path)
            )


# ---------------------------------------------------------------------------
# _run — best-effort: per-doc failure emits ok:false, does not abort others
# ---------------------------------------------------------------------------


class TestRun:
    def test_per_doc_failure_emits_ok_false_and_continues(self, tmp_path, capsys):
        """A failing doc must emit ok:false and not prevent subsequent docs from running."""
        pdf_bytes = b"%PDF-1.4"
        call_count = 0

        async def fake_detail_v2(event_id):
            pass

        async def fake_recv():
            nonlocal call_count
            call_count += 1
            # First call: doc-abc is present; second call: detail has no docs section
            if call_count == 1:
                return ("s1", {"type": "timelineDetailV2", "id": "event-1"}, DETAIL_PAYLOAD)
            return (
                "s2",
                {"type": "timelineDetailV2", "id": "event-2"},
                {"sections": []},  # no documents → _find_doc_url returns None
            )

        tr = MagicMock()
        tr.timeline_detail_v2 = AsyncMock(side_effect=fake_detail_v2)
        tr.unsubscribe = AsyncMock()
        tr.recv = fake_recv
        tr._get_ws = AsyncMock()

        fake_resp = MagicMock()
        fake_resp.status = 200
        fake_resp.headers = {"Content-Type": "application/pdf"}
        fake_resp.read = AsyncMock(return_value=pdf_bytes)
        fake_resp.__aenter__ = AsyncMock(return_value=fake_resp)
        fake_resp.__aexit__ = AsyncMock(return_value=False)

        fake_session = MagicMock()
        fake_session.get = MagicMock(return_value=fake_resp)
        tr._websession = fake_session

        output_lines = []

        def capture_write(data):
            output_lines.append(data)

        # Patch stdout to capture NDJSON output.
        with patch.object(sys.stdout, "write", side_effect=capture_write):
            asyncio.run(
                td._run(
                    tr,
                    [("event-1", "doc-abc"), ("event-2", "doc-missing")],
                    tmp_path,
                )
            )

        results = [json.loads(l) for l in output_lines if l.strip()]
        assert len(results) == 2

        ok_result = next(r for r in results if r["docId"] == "doc-abc")
        assert ok_result["ok"] is True
        assert ok_result["file"] == "doc-abc.pdf"

        err_result = next(r for r in results if r["docId"] == "doc-missing")
        assert err_result["ok"] is False
        assert "error" in err_result

        # The successful doc was written to disk.
        assert (tmp_path / "doc-abc.pdf").read_bytes() == pdf_bytes
