#!/usr/bin/env python3
"""Turn private eBay records into a public, city-level shipment dataset.

Privacy boundary: this module reads private order fields, but its writer permits only
the explicitly allow-listed public schema defined in PUBLIC_PACKAGE_KEYS.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import requests

PUBLIC_PACKAGE_KEYS = {
    "id", "city", "region", "country", "lat", "lng", "month",
    "distanceMiles", "gameCount", "titles",
}
OPTIONAL_PUBLIC_PACKAGE_KEYS = {"via"}
PUBLIC_VIA_KEYS = {"city", "region", "country", "lat", "lng"}
FORBIDDEN_OUTPUT_TERMS = {
    "buyer", "address", "email", "phone", "zip", "postal", "tracking",
    "order", "username", "transaction", "tax", "payment",
}
COUNTRY_CODES = {
    "us": ("US", "United States"), "usa": ("US", "United States"),
    "united states": ("US", "United States"), "united states of america": ("US", "United States"),
    "pr": ("PR", "Puerto Rico"), "puerto rico": ("PR", "Puerto Rico"),
    "ca": ("CA", "Canada"), "canada": ("CA", "Canada"),
    "au": ("AU", "Australia"), "australia": ("AU", "Australia"),
    "cl": ("CL", "Chile"), "chile": ("CL", "Chile"),
    "ch": ("CH", "Switzerland"), "switzerland": ("CH", "Switzerland"),
    "gb": ("GB", "United Kingdom"), "uk": ("GB", "United Kingdom"),
    "united kingdom": ("GB", "United Kingdom"),
    "jp": ("JP", "Japan"), "japan": ("JP", "Japan"),
    "de": ("DE", "Germany"), "germany": ("DE", "Germany"),
    "fr": ("FR", "France"), "france": ("FR", "France"),
    "ie": ("IE", "Ireland"), "ireland": ("IE", "Ireland"),
    "it": ("IT", "Italy"), "italy": ("IT", "Italy"),
    "es": ("ES", "Spain"), "spain": ("ES", "Spain"),
    "nl": ("NL", "Netherlands"), "netherlands": ("NL", "Netherlands"),
    "nz": ("NZ", "New Zealand"), "new zealand": ("NZ", "New Zealand"),
    "mx": ("MX", "Mexico"), "mexico": ("MX", "Mexico"),
}

# Military mail is formatted as a domestic US address even when its physical
# destination is overseas. The retained FPO/AP record was manually verified as
# Okinawa and is generalized to an island-level point before publication.
MILITARY_DESTINATIONS = {
    ("FPO", "AP"): ("Okinawa", "Okinawa", "JP", "Japan"),
}

CITY_ALIASES = {
    ("cottonwd shrs", "TX", "US"): ("Cottonwood Shores", "TX", "US"),
}


@dataclass
class LineItem:
    private_order_key: str
    city: str
    region: str
    country_code: str
    country_name: str
    month: str
    title: str
    quantity: int = 1
    hub_city: str = ""
    hub_region: str = ""
    hub_country_code: str = ""
    hub_country_name: str = ""


@dataclass
class Package:
    city: str
    region: str
    country_code: str
    country_name: str
    month: str
    titles: list[str] = field(default_factory=list)
    game_count: int = 0
    hub_city: str = ""
    hub_region: str = ""
    hub_country_code: str = ""
    hub_country_name: str = ""


def clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def country(value: object) -> tuple[str, str]:
    raw = clean(value)
    return COUNTRY_CODES.get(raw.casefold(), (raw.upper()[:2], raw or "Unknown"))


def month_of(value: object) -> str:
    raw = clean(value)
    if not raw:
        return "Unknown"
    iso = re.match(r"(\d{4})-(\d{2})", raw)
    if iso:
        return f"{iso.group(1)}-{iso.group(2)}"
    for fmt in ("%b-%d-%y", "%b-%d-%Y", "%m/%d/%Y", "%m/%d/%y", "%d-%b-%y", "%b %d, %Y"):
        try:
            candidate = raw if fmt == "%b %d, %Y" else raw.split(" ")[0]
            return datetime.strptime(candidate, fmt).strftime("%Y-%m")
        except ValueError:
            pass
    return "Unknown"


def quantity_of(value: object) -> int:
    try:
        return max(1, int(float(clean(value) or "1")))
    except ValueError:
        return 1


def military_destination(city: object, region: object) -> tuple[str, str, str, str] | None:
    return MILITARY_DESTINATIONS.get((clean(city).upper(), clean(region).upper()))


def read_ebay_csv(path: Path) -> list[LineItem]:
    with path.open(encoding="utf-8-sig", errors="replace", newline="") as handle:
        rows = list(csv.reader(handle))
    header_index = next((i for i, row in enumerate(rows[:30]) if (
        ("Order Number" in row and "Ship To City" in row)
        or ("Transaction creation date" in row and "Order number" in row and "Ship to city" in row)
    )), None)
    if header_index is None:
        raise ValueError(f"Could not find the eBay order header in {path}")

    header = rows[header_index]
    if "Transaction creation date" in header:
        return read_transaction_rows(header, rows[header_index + 1:])

    result: list[LineItem] = []
    for index, values in enumerate(rows[header_index + 1:], start=1):
        row = dict(zip(header, values))
        ship_city = clean(row.get("Ship To City"))
        ship_region = clean(row.get("Ship To State"))
        title = clean(row.get("Item Title"))
        if not ship_city or not ship_region or not title:
            continue
        ship_code, ship_name = country(row.get("Ship To Country"))
        military = military_destination(ship_city, ship_region)
        is_ebay_international = clean(row.get("eBay International Shipping")).casefold() == "yes"
        buyer_city = clean(row.get("Buyer City"))
        buyer_region = clean(row.get("Buyer State"))
        buyer_code, buyer_country = country(row.get("Buyer Country"))
        has_final_destination = is_ebay_international and buyer_city and buyer_code and buyer_code != ship_code
        if military:
            city, region, code, name = military
        else:
            city = buyer_city if has_final_destination else ship_city
            code = buyer_code if has_final_destination else ship_code
            name = buyer_country if has_final_destination else ship_name
            region = (buyer_region or buyer_country) if has_final_destination else ship_region
        order_key = clean(row.get("Order Number") or row.get("Sales Record Number"))
        if not order_key:
            order_key = f"csv-row-{index}"
        result.append(LineItem(
            private_order_key=order_key,
            city=city,
            region=region,
            country_code=code,
            country_name=name,
            month=month_of(row.get("Sale Date") or row.get("Paid On Date")),
            title=title,
            quantity=quantity_of(row.get("Quantity")),
            hub_city=ship_city if has_final_destination else "",
            hub_region=ship_region if has_final_destination else "",
            hub_country_code=ship_code if has_final_destination else "",
            hub_country_name=ship_name if has_final_destination else "",
        ))
    return result


def read_transaction_rows(header: list[str], rows: list[list[str]]) -> list[LineItem]:
    """Read eBay transaction reports, which retain older city-level destinations."""
    result: list[LineItem] = []
    for values in rows:
        row = dict(zip(header, values))
        if clean(row.get("Type")).casefold() != "order":
            continue
        city = clean(row.get("Ship to city"))
        region = clean(row.get("Ship to province/region/state"))
        title = clean(row.get("Item title"))
        if not city or city == "--" or not region or region == "--" or not title or title == "--":
            continue
        code, name = country(row.get("Ship to country"))
        city, region, code = CITY_ALIASES.get((city.casefold(), region.upper(), code), (city, region, code))
        _, name = country(code)
        result.append(LineItem(
            private_order_key=clean(row.get("Order number")),
            city=city,
            region=region,
            country_code=code,
            country_name=name,
            month=month_of(row.get("Transaction creation date")),
            title=title,
            quantity=quantity_of(row.get("Quantity")),
        ))
    return result


def _shipping_addresses(order: dict) -> tuple[dict, dict]:
    instructions = order.get("fulfillmentStartInstructions") or []
    for instruction in instructions:
        ship_to = ((instruction.get("shippingStep") or {}).get("shipTo") or {})
        if ship_to:
            # The current Fulfillment API wraps Address in ExtendedContact.
            # Retaining the direct fallback also accepts older saved fixtures.
            hub_or_destination = ship_to.get("contactAddress") or ship_to
            final_destination = instruction.get("finalDestinationAddress") or {}
            return hub_or_destination, final_destination
    return {}, {}


def read_ebay_api_json(path: Path) -> list[LineItem]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    orders = payload.get("orders", payload if isinstance(payload, list) else [])
    result: list[LineItem] = []
    for index, order in enumerate(orders):
        address, final_destination = _shipping_addresses(order)
        city = clean(address.get("city"))
        region = clean(address.get("stateOrProvince"))
        code, name = country(address.get("countryCode"))
        if not city or not region:
            continue
        final_city = clean(final_destination.get("city"))
        final_code, final_country = country(final_destination.get("countryCode"))
        has_final_destination = final_city and final_code and final_code != code
        destination_city = final_city if has_final_destination else city
        destination_region = (clean(final_destination.get("stateOrProvince")) or final_country) if has_final_destination else region
        destination_code = final_code if has_final_destination else code
        destination_country = final_country if has_final_destination else name
        order_key = clean(order.get("orderId")) or f"api-row-{index}"
        for item in order.get("lineItems") or []:
            title = clean(item.get("title") or item.get("lineItemId") or "Game")
            result.append(LineItem(
                private_order_key=order_key,
                city=destination_city,
                region=destination_region,
                country_code=destination_code,
                country_name=destination_country,
                month=month_of(order.get("creationDate")),
                title=title,
                quantity=quantity_of(item.get("quantity")),
                hub_city=city if has_final_destination else "",
                hub_region=region if has_final_destination else "",
                hub_country_code=code if has_final_destination else "",
                hub_country_name=name if has_final_destination else "",
            ))
    return result


def load_line_items(paths: Iterable[Path]) -> list[LineItem]:
    items: list[LineItem] = []
    for path in paths:
        if path.suffix.casefold() == ".csv":
            items.extend(read_ebay_csv(path))
        elif path.suffix.casefold() == ".json":
            items.extend(read_ebay_api_json(path))
        else:
            raise ValueError(f"Unsupported input type: {path}")
    return items


def group_packages(items: Iterable[LineItem]) -> list[Package]:
    grouped: dict[str, Package] = {}
    seen_lines: set[tuple] = set()
    for item in items:
        line_key = (
            item.private_order_key, item.city.casefold(), item.region.casefold(),
            item.country_code, item.month, item.title.casefold(), item.quantity,
            item.hub_city.casefold(), item.hub_region.casefold(), item.hub_country_code,
        )
        if line_key in seen_lines:
            continue
        seen_lines.add(line_key)
        package = grouped.setdefault(item.private_order_key, Package(
            city=item.city, region=item.region, country_code=item.country_code,
            country_name=item.country_name, month=item.month,
            hub_city=item.hub_city, hub_region=item.hub_region,
            hub_country_code=item.hub_country_code, hub_country_name=item.hub_country_name,
        ))
        package.titles.extend([item.title] * item.quantity)
        package.game_count += item.quantity
    return list(grouped.values())


class CityResolver:
    def __init__(self, cache_path: Path, offline: bool = False, delay: float = 1.05):
        self.cache_path = cache_path
        self.offline = offline
        self.delay = delay
        self.session = requests.Session()
        self.requests_made = 0
        self.session.headers["User-Agent"] = os.getenv(
            "GEOCODER_USER_AGENT", "where-the-games-go/1.0 (personal portfolio map)"
        )
        self.cache: dict[str, dict] = {}
        if cache_path.exists():
            self.cache = json.loads(cache_path.read_text(encoding="utf-8"))

    @staticmethod
    def key(city: str, region: str, country_code: str) -> str:
        return "|".join((clean(city).casefold(), clean(region).casefold(), clean(country_code).upper()))

    def resolve(self, city: str, region: str, country_code: str) -> tuple[float, float] | None:
        key = self.key(city, region, country_code)
        cached = self.cache.get(key)
        if cached:
            return float(cached["lat"]), float(cached["lng"])
        if self.offline:
            return None
        self.requests_made += 1
        if self.requests_made == 1 or self.requests_made % 25 == 0:
            print(f"Geocoding city {self.requests_made}: {city}, {region}", flush=True)
        params = {"format": "jsonv2", "q": f"{city}, {region}, {country_code}", "limit": 1}
        email = os.getenv("GEOCODER_EMAIL")
        if email:
            params["email"] = email
        response = self.session.get("https://nominatim.openstreetmap.org/search", params=params, timeout=30)
        response.raise_for_status()
        results = response.json()
        time.sleep(self.delay)
        if not results:
            self.cache[key] = {"missing": True}
            self.save()
            return None
        coords = {"lat": round(float(results[0]["lat"]), 5), "lng": round(float(results[0]["lon"]), 5)}
        self.cache[key] = coords
        self.save()
        return coords["lat"], coords["lng"]

    def save(self) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_path.write_text(json.dumps(self.cache, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def haversine_miles(a: tuple[float, float], b: tuple[float, float]) -> int:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return round(3958.7613 * 2 * math.asin(math.sqrt(h)))


def safe_fingerprint(record: dict) -> str:
    safe = "|".join([
        record["city"].casefold(), record["region"].casefold(), record["country"].casefold(),
        record["month"], *sorted(title.casefold() for title in record["titles"]),
    ])
    return hashlib.sha256(safe.encode("utf-8")).hexdigest()[:12]


def public_records(packages: Iterable[Package], resolver: CityResolver, origin: tuple[float, float]) -> list[dict]:
    staged: list[dict] = []
    for package in packages:
        coords = resolver.resolve(package.city, package.region, package.country_code)
        if not coords:
            print(f"Skipping unresolved city: {package.city}, {package.region}, {package.country_code}", file=sys.stderr)
            continue
        record = {
            "city": package.city,
            "region": package.region,
            "country": package.country_name,
            "lat": coords[0],
            "lng": coords[1],
            "month": package.month,
            "distanceMiles": haversine_miles(origin, coords),
            "gameCount": package.game_count,
            "titles": sorted(package.titles, key=str.casefold),
        }
        if package.hub_city:
            hub_coords = resolver.resolve(package.hub_city, package.hub_region, package.hub_country_code)
            if hub_coords:
                record["via"] = {
                    "city": package.hub_city,
                    "region": package.hub_region,
                    "country": package.hub_country_name,
                    "lat": hub_coords[0],
                    "lng": hub_coords[1],
                }
        staged.append(record)

    occurrences: Counter[str] = Counter()
    for record in sorted(staged, key=lambda x: (x["month"], x["city"], x["titles"])):
        base = safe_fingerprint(record)
        occurrences[base] += 1
        record["id"] = f"journey-{base}-{occurrences[base]}"
    return staged


def merge_existing(new: list[dict], existing_path: Path | None) -> list[dict]:
    if not existing_path or not existing_path.exists():
        return new
    existing = json.loads(existing_path.read_text(encoding="utf-8")).get("packages", [])
    merged = {record["id"]: record for record in existing}
    for record in new:
        previous = merged.get(record["id"])
        if previous and previous.get("via") and not record.get("via"):
            record = {**record, "via": previous["via"]}
        merged[record["id"]] = record
    return list(merged.values())


def remove_superseded_hub_records(records: list[dict], replacements: list[dict]) -> list[dict]:
    """Remove the old hub-only form of a newly recovered multi-leg shipment."""
    superseded = Counter()
    for record in replacements:
        via = record.get("via")
        if not via:
            continue
        superseded[(
            via["city"].casefold(), via["region"].casefold(), via["country"].casefold(),
            record["month"], tuple(title.casefold() for title in record["titles"]), record["gameCount"],
        )] += 1

    kept: list[dict] = []
    for record in records:
        key = (
            record["city"].casefold(), record["region"].casefold(), record["country"].casefold(),
            record["month"], tuple(title.casefold() for title in record["titles"]), record["gameCount"],
        )
        if superseded[key] and not record.get("via"):
            superseded[key] -= 1
            continue
        kept.append(record)
    return kept


def validate_public(records: list[dict]) -> None:
    for record in records:
        keys = set(record)
        if not PUBLIC_PACKAGE_KEYS.issubset(keys) or keys - PUBLIC_PACKAGE_KEYS - OPTIONAL_PUBLIC_PACKAGE_KEYS:
            raise ValueError(f"Public package schema violation: {sorted(keys ^ PUBLIC_PACKAGE_KEYS)}")
        for key in keys:
            if any(term in key.casefold() for term in FORBIDDEN_OUTPUT_TERMS):
                raise ValueError(f"Forbidden public field: {key}")
        if "via" in record and set(record["via"]) != PUBLIC_VIA_KEYS:
            raise ValueError("Public via schema violation")


def build_payload(records: list[dict], origin_name: str, origin: tuple[float, float], highlights: dict | None = None) -> dict:
    records.sort(key=lambda x: (x["month"], x["city"], x["id"]))
    payload = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "origin": {"name": origin_name, "lat": origin[0], "lng": origin[1]},
        "summary": {
            "packages": len(records),
            "games": sum(record["gameCount"] for record in records),
            "miles": sum(record["distanceMiles"] for record in records),
            "regions": len({(record["country"], record["region"]) for record in records}),
        },
        "packages": records,
    }
    if highlights:
        payload["financialHighlights"] = highlights
    return payload


def parse_origin(value: str) -> tuple[str, str, str]:
    parts = [part.strip() for part in value.split(",")]
    if len(parts) < 3:
        raise ValueError("Origin must be 'City, State/Region, Country'")
    return parts[0], parts[1], ",".join(parts[2:]).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", action="append", required=True, type=Path, help="Private eBay CSV or API JSON; repeatable")
    parser.add_argument("--output", type=Path, default=Path("public/data/shipments.json"))
    parser.add_argument("--cache", type=Path, default=Path("data/city-cache.json"))
    parser.add_argument("--highlights", type=Path, default=Path("data/public-highlights.json"), help="Safe aggregate highlights with no dollar amounts")
    parser.add_argument("--existing", type=Path, help="Existing public dataset to merge for rolling API updates")
    parser.add_argument("--replace-hub-records", action="store_true", help="Replace matching hub-only records when final destinations are recovered")
    parser.add_argument("--origin", default="Salem, Massachusetts, United States")
    parser.add_argument("--offline", action="store_true", help="Use cached geocodes only")
    args = parser.parse_args()

    origin_city, origin_region, origin_country = parse_origin(args.origin)
    origin_code, _ = country(origin_country)
    resolver = CityResolver(args.cache, offline=args.offline)
    origin = resolver.resolve(origin_city, origin_region, origin_code)
    if not origin:
        raise SystemExit("Origin could not be geocoded; run once online to populate the cache.")

    items = load_line_items(args.input)
    new_records = public_records(group_packages(items), resolver, origin)
    records = merge_existing(new_records, args.existing)
    if args.replace_hub_records:
        records = remove_superseded_hub_records(records, new_records)
    validate_public(records)
    highlights = json.loads(args.highlights.read_text(encoding="utf-8")) if args.highlights.exists() else None
    payload = build_payload(records, f"{origin_city}, {origin_region}", origin, highlights)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Published {payload['summary']['packages']} packages / {payload['summary']['games']} games to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
