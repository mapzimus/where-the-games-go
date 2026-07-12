import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import sync_ebay  # noqa: E402


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def test_refresh_token_request_uses_read_only_scope(monkeypatch):
    observed = {}

    def fake_post(url, headers, data, timeout):
        observed.update(url=url, headers=headers, data=data, timeout=timeout)
        return FakeResponse({"access_token": "short-lived-access-token"})

    monkeypatch.setattr(sync_ebay.requests, "post", fake_post)
    result = sync_ebay.access_token("client-id", "client-secret", "refresh-token")
    assert result == "short-lived-access-token"
    assert observed["data"]["grant_type"] == "refresh_token"
    assert observed["data"]["scope"].endswith("sell.fulfillment.readonly")
    assert observed["data"]["refresh_token"] == "refresh-token"
    assert observed["headers"]["Authorization"].startswith("Basic ")


def test_order_fetch_paginates_the_recent_window(monkeypatch):
    offsets = []

    def fake_get(url, headers, params, timeout):
        offsets.append(params["offset"])
        assert params["filter"].startswith("creationdate:[")
        assert params["limit"] == 200
        if params["offset"] == 0:
            return FakeResponse({"orders": [{"orderId": str(i)} for i in range(200)], "total": 201})
        return FakeResponse({"orders": [{"orderId": "200"}], "total": 201})

    monkeypatch.setattr(sync_ebay.requests, "get", fake_get)
    orders = sync_ebay.fetch_orders("access-token")
    assert len(orders) == 201
    assert offsets == [0, 200]

