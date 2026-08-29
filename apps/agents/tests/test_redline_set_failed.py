"""`_set_failed` must MERGE contract metadata, not replace it.

PATCH /contracts assigns `metadata` whole, so a status update that sends only
its own two keys wipes everything else on the column — `_typeFields`,
`_aiFindings`, org custom-field values, `_draftContext`, `_redlineHistory`.

The happy path in this module already GETs-and-merges. `_set_failed` did not,
and it is the path that runs when something has already gone wrong. Making BYOK
resolution fail closed (docs/39 Wave 0) turns it from rare into the normal
response to a provider outage, which is why this is pinned before that lands.

Run:  cd apps/agents && python -m pytest tests/ -q
"""
from __future__ import annotations

import pytest

from app.routes.redline import _set_failed


class _FakeResponse:
    def __init__(self, payload: dict | None, ok: bool = True) -> None:
        self._payload = payload
        self.is_success = ok

    def json(self) -> dict:
        if self._payload is None:
            raise ValueError("no body")
        return self._payload


class _FakeClient:
    """Records the PATCH body so the test can assert on what would be written."""

    def __init__(self, existing: dict | None, get_ok: bool = True, get_raises: bool = False) -> None:
        self._existing = existing
        self._get_ok = get_ok
        self._get_raises = get_raises
        self.patched: dict | None = None

    async def get(self, _url: str, **_kw):
        if self._get_raises:
            raise RuntimeError("network down")
        return _FakeResponse({"metadata": self._existing} if self._existing is not None else {}, self._get_ok)

    async def patch(self, _url: str, *, json: dict, **_kw):
        self.patched = json
        return _FakeResponse({}, True)


PRE_EXISTING = {
    "_typeFields": {"governingLaw": "NY"},
    "_aiFindings": [{"id": "f1"}],
    "_redlineHistory": [{"at": "2026-01-01"}],
    "customerRef": "ACME-123",
}


@pytest.mark.asyncio
async def test_preserves_every_pre_existing_metadata_key():
    client = _FakeClient(existing=dict(PRE_EXISTING))
    await _set_failed(client, "http://api", "con_1", {}, "boom")

    meta = client.patched["metadata"]
    for key, value in PRE_EXISTING.items():
        assert meta[key] == value, f"{key} was destroyed by a failure status update"
    assert meta["_redlineStatus"] == "FAILED"
    assert meta["_redlineError"] == "boom"


@pytest.mark.asyncio
async def test_status_keys_win_over_stale_ones():
    client = _FakeClient(existing={"_redlineStatus": "RUNNING", "_redlineError": "old", "keep": 1})
    await _set_failed(client, "http://api", "con_1", {}, "new reason")

    meta = client.patched["metadata"]
    assert meta["_redlineStatus"] == "FAILED"
    assert meta["_redlineError"] == "new reason"
    assert meta["keep"] == 1


@pytest.mark.asyncio
async def test_reason_is_truncated():
    client = _FakeClient(existing={})
    await _set_failed(client, "http://api", "con_1", {}, "x" * 900)
    assert len(client.patched["metadata"]["_redlineError"]) == 500


@pytest.mark.asyncio
async def test_an_unreadable_contract_still_records_the_failure():
    """A failed read must not stop the status being written.

    We lose the merge in this case — that is the least-bad option, and it is
    strictly better than never attempting one. Pinned so the fallback stays
    deliberate rather than becoming the default path again.
    """
    client = _FakeClient(existing=None, get_raises=True)
    await _set_failed(client, "http://api", "con_1", {}, "boom")
    assert client.patched["metadata"]["_redlineStatus"] == "FAILED"
