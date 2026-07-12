import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_map_data import (  # noqa: E402
    PUBLIC_PACKAGE_KEYS,
    build_payload,
    group_packages,
    haversine_miles,
    merge_existing,
    public_records,
    read_ebay_api_json,
    read_ebay_csv,
    validate_public,
)


class FakeResolver:
    def resolve(self, city, region, country_code):
        return {"Boston": (42.3601, -71.0589), "Portland": (45.5152, -122.6784)}.get(city)


def write_export(path: Path):
    rows = [
        ["eBay report generated for testing"],
        ["Order Number", "Buyer Name", "Buyer Email", "Ship To Address 1", "Ship To City", "Ship To State", "Ship To Zip", "Ship To Country", "Item Title", "Quantity", "Sale Date", "Tracking Number"],
        ["private-order-1", "Private Person", "private@example.test", "1 Secret St", "Boston", "MA", "02108", "United States", "The Legend of Zelda", "1", "Mar-15-26", "private-tracking"],
        ["private-order-1", "Private Person", "private@example.test", "1 Secret St", "Boston", "MA", "02108", "United States", "Mario Kart", "2", "Mar-15-26", "private-tracking"],
        ["private-order-2", "Another Person", "other@example.test", "2 Hidden Rd", "Portland", "OR", "97201", "United States", "Metroid Prime", "1", "03/16/2026", "other-tracking"],
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerows(rows)


def test_csv_is_grouped_by_package_and_private_fields_are_dropped(tmp_path):
    source = tmp_path / "orders.csv"
    write_export(source)
    packages = group_packages(read_ebay_csv(source))
    records = public_records(packages, FakeResolver(), (42.5195, -70.8967))
    validate_public(records)
    assert len(records) == 2
    assert sum(record["gameCount"] for record in records) == 4
    assert all(set(record) == PUBLIC_PACKAGE_KEYS for record in records)
    serialized = json.dumps(build_payload(records, "Salem, Massachusetts", (42.5195, -70.8967)))
    for secret in ("Private Person", "private@example.test", "1 Secret St", "02108", "private-order-1", "private-tracking"):
        assert secret not in serialized


def test_distance_is_reasonable():
    salem = (42.5195, -70.8967)
    portland_or = (45.5152, -122.6784)
    assert 2500 < haversine_miles(salem, portland_or) < 2600


def test_current_ebay_api_contact_schema_is_generalized(tmp_path):
    source = tmp_path / "api-orders.json"
    source.write_text(json.dumps({"orders": [{
        "orderId": "private-api-order",
        "creationDate": "2026-07-10T12:34:56.000Z",
        "fulfillmentStartInstructions": [{"shippingStep": {"shipTo": {
            "fullName": "Private Buyer",
            "email": "buyer@example.test",
            "primaryPhone": {"phoneNumber": "555-555-5555"},
            "contactAddress": {
                "addressLine1": "1 Private Street",
                "city": "Boston",
                "stateOrProvince": "MA",
                "postalCode": "02108",
                "countryCode": "US"
            }
        }}}],
        "lineItems": [{"title": "Mario Kart 8 Deluxe", "quantity": 1}]
    }]}), encoding="utf-8")

    items = read_ebay_api_json(source)
    records = public_records(group_packages(items), FakeResolver(), (42.5195, -70.8967))
    validate_public(records)
    serialized = json.dumps(records)
    assert len(records) == 1
    assert records[0]["city"] == "Boston"
    assert records[0]["month"] == "2026-07"
    for secret in ("Private Buyer", "buyer@example.test", "555-555-5555", "1 Private Street", "02108", "private-api-order"):
        assert secret not in serialized


def test_existing_safe_history_is_retained_without_duplicates(tmp_path):
    old = {key: None for key in PUBLIC_PACKAGE_KEYS}
    old.update({"id": "journey-old-1", "city": "Boston", "region": "MA", "country": "United States", "lat": 42.36, "lng": -71.06, "month": "2025-01", "distanceMiles": 15, "gameCount": 1, "titles": ["Old Game"]})
    existing = tmp_path / "existing.json"
    existing.write_text(json.dumps({"packages": [old]}), encoding="utf-8")
    assert merge_existing([old], existing) == [old]


def test_checked_in_dataset_respects_public_schema():
    payload = json.loads((ROOT / "public" / "data" / "shipments.json").read_text(encoding="utf-8"))
    validate_public(payload["packages"])
    assert payload["packages"], "The deployed portfolio must contain real generalized journeys"
    assert payload["summary"]["packages"] == len(payload["packages"])
    assert payload["summary"]["games"] == sum(item["gameCount"] for item in payload["packages"])
    assert payload["summary"]["miles"] == sum(item["distanceMiles"] for item in payload["packages"])
    assert payload["summary"]["regions"] == len({(item["country"], item["region"]) for item in payload["packages"]})


def test_pages_workflows_deploy_both_pushes_and_scheduled_refreshes():
    deploy = (ROOT / ".github" / "workflows" / "deploy-pages.yml").read_text(encoding="utf-8")
    refresh = (ROOT / ".github" / "workflows" / "update-map.yml").read_text(encoding="utf-8")
    for workflow in (deploy, refresh):
        assert "actions/upload-pages-artifact@v4" in workflow
        assert "actions/deploy-pages@v4" in workflow
        assert "pages: write" in workflow
        assert "id-token: write" in workflow
    assert 'cron: "17 */6 * * *"' in refresh
    assert "EBAY_REFRESH_TOKEN" in refresh
