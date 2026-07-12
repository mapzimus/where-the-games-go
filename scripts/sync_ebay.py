#!/usr/bin/env python3
"""Fetch the recent rolling order window from eBay's read-only Fulfillment API."""

from __future__ import annotations

import argparse
import base64
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

SCOPE = "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly"


def required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def access_token(client_id: str, client_secret: str, refresh_token: str) -> str:
    credentials = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    response = requests.post(
        "https://api.ebay.com/identity/v1/oauth2/token",
        headers={"Authorization": f"Basic {credentials}", "Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token", "refresh_token": refresh_token, "scope": SCOPE},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"]


def fetch_orders(token: str, days: int = 89) -> list[dict]:
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days)
    stamp = lambda value: value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    orders: list[dict] = []
    offset = 0
    while True:
        response = requests.get(
            "https://api.ebay.com/sell/fulfillment/v1/order",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            params={"filter": f"creationdate:[{stamp(start)}..{stamp(now)}]", "limit": 200, "offset": offset},
            timeout=45,
        )
        response.raise_for_status()
        payload = response.json()
        batch = payload.get("orders") or []
        orders.extend(batch)
        offset += len(batch)
        if not batch or offset >= int(payload.get("total", 0)):
            break
    return orders


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("private/ebay_api_orders.json"))
    parser.add_argument("--days", type=int, default=89)
    args = parser.parse_args()
    token = access_token(required("EBAY_CLIENT_ID"), required("EBAY_CLIENT_SECRET"), required("EBAY_REFRESH_TOKEN"))
    orders = fetch_orders(token, args.days)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"orders": orders}), encoding="utf-8")
    print(f"Fetched {len(orders)} recent orders into the gitignored private workspace.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

