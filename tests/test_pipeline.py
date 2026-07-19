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
    remove_superseded_hub_records,
    validate_public,
)


class FakeResolver:
    def resolve(self, city, region, country_code):
        return {
            "Boston": (42.3601, -71.0589),
            "Portland": (45.5152, -122.6784),
            "Mooroopna": (-36.39, 145.36),
            "Okinawa": (26.47, 127.91),
            "Glendale Heights": (41.91, -88.08),
        }.get(city)


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


def test_international_csv_uses_final_city_and_keeps_only_safe_hub(tmp_path):
    source = tmp_path / "international.csv"
    rows = [
        ["Order Number", "Buyer Name", "Buyer Address 1", "Buyer City", "Buyer State", "Buyer Country", "Ship To Address 1", "Ship To City", "Ship To State", "Ship To Country", "Item Title", "Quantity", "Sale Date", "eBay International Shipping"],
        ["private-order", "Private Buyer", "1 Private Road", "Mooroopna", "VIC", "Australia", "2 Hub Street", "Glendale Heights", "IL", "United States", "Horizon Zero Dawn", "1", "May-25-26", "Yes"],
    ]
    with source.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerows(rows)

    item = read_ebay_csv(source)[0]
    assert (item.city, item.region, item.country_code) == ("Mooroopna", "VIC", "AU")
    assert (item.hub_city, item.hub_region, item.hub_country_code) == ("Glendale Heights", "IL", "US")

    class InternationalResolver:
        def resolve(self, city, region, country_code):
            return {"Mooroopna": (-36.39, 145.36), "Glendale Heights": (41.91, -88.08)}.get(city)

    record = public_records(group_packages([item]), InternationalResolver(), (42.5195, -70.8967))[0]
    validate_public([record])
    assert record["city"] == "Mooroopna"
    assert record["via"]["city"] == "Glendale Heights"
    serialized = json.dumps(record)
    for secret in ("Private Buyer", "1 Private Road", "2 Hub Street", "private-order"):
        assert secret not in serialized


def test_fpo_pacific_zip_is_generalized_to_okinawa(tmp_path):
    source = tmp_path / "military.csv"
    rows = [
        ["Order Number", "Ship To Address 1", "Ship To City", "Ship To State", "Ship To Zip", "Ship To Country", "Item Title", "Quantity", "Sale Date", "eBay International Shipping"],
        ["private-order", "Private Unit", "FPO", "AP", "private-postal", "United States", "Mario Party 7", "1", "Mar-26-24", "No"],
    ]
    with source.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerows(rows)

    item = read_ebay_csv(source)[0]
    assert (item.city, item.region, item.country_code, item.country_name) == ("Okinawa", "Okinawa", "JP", "Japan")
    record = public_records(group_packages([item]), FakeResolver(), (42.5195, -70.8967))[0]
    serialized = json.dumps(record)
    assert record["city"] == "Okinawa"
    assert record["country"] == "Japan"
    for secret in ("Private Unit", "private-postal", "private-order"):
        assert secret not in serialized


def test_transaction_report_recovers_older_city_level_orders(tmp_path):
    source = tmp_path / "transactions.csv"
    rows = [
        ["Transaction report"],
        ["Transaction creation date", "Type", "Order number", "Ship to city", "Ship to province/region/state", "Ship to country", "Item title", "Quantity"],
        ["Mar 29, 2023", "Order", "private-order", "Holland", "OH", "US", "Beatles 45", "1"],
        ["Mar 29, 2023", "Shipping label", "private-order", "--", "--", "--", "--", "--"],
    ]
    with source.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerows(rows)

    item = read_ebay_csv(source)[0]
    assert (item.city, item.region, item.country_code, item.month) == ("Holland", "OH", "US", "2023-03")
    assert item.title == "Beatles 45"


def test_current_ebay_api_contact_schema_is_generalized(tmp_path):
    source = tmp_path / "api-orders.json"
    source.write_text(json.dumps({"orders": [{
        "orderId": "private-api-order",
        "creationDate": "2026-07-10T12:34:56.000Z",
        "fulfillmentStartInstructions": [{
            "shippingStep": {"shipTo": {
                "fullName": "Private Buyer",
                "email": "buyer@example.test",
                "primaryPhone": {"phoneNumber": "555-555-5555"},
                "contactAddress": {
                    "addressLine1": "1 Private Street",
                    "city": "Glendale Heights",
                    "stateOrProvince": "IL",
                    "postalCode": "60139",
                    "countryCode": "US"
                }
            }},
            "finalDestinationAddress": {
                "addressLine1": "2 Final Private Street",
                "city": "Mooroopna",
                "stateOrProvince": "VIC",
                "postalCode": "3629",
                "countryCode": "AU"
            }
        }],
        "lineItems": [{"title": "Mario Kart 8 Deluxe", "quantity": 1}]
    }]}), encoding="utf-8")

    items = read_ebay_api_json(source)
    records = public_records(group_packages(items), FakeResolver(), (42.5195, -70.8967))
    validate_public(records)
    serialized = json.dumps(records)
    assert len(records) == 1
    assert records[0]["city"] == "Mooroopna"
    assert records[0]["via"]["city"] == "Glendale Heights"
    assert records[0]["month"] == "2026-07"
    for secret in ("Private Buyer", "buyer@example.test", "555-555-5555", "1 Private Street", "2 Final Private Street", "02108", "private-api-order"):
        assert secret not in serialized


def test_existing_safe_history_is_retained_without_duplicates(tmp_path):
    old = {key: None for key in PUBLIC_PACKAGE_KEYS}
    old.update({"id": "journey-old-1", "city": "Boston", "region": "MA", "country": "United States", "lat": 42.36, "lng": -71.06, "month": "2025-01", "distanceMiles": 15, "gameCount": 1, "titles": ["Old Game"]})
    existing = tmp_path / "existing.json"
    existing.write_text(json.dumps({"packages": [old]}), encoding="utf-8")
    assert merge_existing([old], existing) == [old]


def test_recovered_final_destination_replaces_old_hub_only_record():
    old = {"id": "journey-old", "city": "Glendale Heights", "region": "IL", "country": "United States", "lat": 41.91, "lng": -88.08, "month": "2026-05", "distanceMiles": 879, "gameCount": 1, "titles": ["Horizon Zero Dawn"]}
    recovered = {"id": "journey-new", "city": "Mooroopna", "region": "VIC", "country": "Australia", "lat": -36.39, "lng": 145.36, "month": "2026-05", "distanceMiles": 10500, "gameCount": 1, "titles": ["Horizon Zero Dawn"], "via": {"city": "Glendale Heights", "region": "IL", "country": "United States", "lat": 41.91, "lng": -88.08}}
    assert remove_superseded_hub_records([old, recovered], [recovered]) == [recovered]


def test_checked_in_dataset_respects_public_schema():
    payload = json.loads((ROOT / "public" / "data" / "shipments.json").read_text(encoding="utf-8"))
    validate_public(payload["packages"])
    assert payload["packages"], "The deployed portfolio must contain real generalized journeys"
    assert payload["summary"]["packages"] == len(payload["packages"])
    assert payload["summary"]["games"] == sum(item["gameCount"] for item in payload["packages"])
    assert payload["summary"]["miles"] == sum(item["distanceMiles"] for item in payload["packages"])
    assert payload["summary"]["regions"] == len({(item["country"], item["region"]) for item in payload["packages"]})
    assert payload["financialHighlights"]["topSpendingState"]["label"] == "Florida"
    assert "$" not in json.dumps(payload["financialHighlights"])


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
    assert "configured: ${{ steps.secrets.outputs.configured }}" in refresh
    assert "if: needs.refresh.outputs.configured == 'true'" in refresh


def test_maplibre_globe_assets_and_projection_are_pinned():
    html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
    javascript = (ROOT / "public" / "app.js").read_text(encoding="utf-8")
    assert 'href="https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css"' in html
    assert 'src="https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js"' in html
    assert 'style: "https://tiles.openfreemap.org/styles/dark"' in javascript
    assert 'map.setProjection({ type: "globe" })' in javascript
    assert 'map.setSky({' in javascript
    assert "function greatCircleGeometry" in javascript
    assert "function splitAntimeridian" in javascript
    assert "segments.push([[boundary * -1, crossingLat], current]);" in javascript


def test_north_shore_nostalgia_store_link_is_present():
    html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
    assert 'href="https://ebay.us/m/Wg29dT"' in html
    assert 'rel="noopener"' in html


def test_dashboard_includes_filter_aware_sales_records():
    html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
    javascript = (ROOT / "public" / "app.js").read_text(encoding="utf-8")
    for record_id in ("record-month", "record-year", "record-state", "record-city", "record-average", "record-median", "record-repeat", "record-longhaul", "record-spend-state", "record-profit-month", "record-intl-market"):
        assert f'id="{record_id}"' in html
    assert 'id="stat-cities"' in html
    assert "states, countries, provinces & territories" in html
    assert 'id="stat-games"' not in html
    assert 'id="play-timeline"' in html
    assert "function renderRecords(packages)" in javascript
    assert "renderRecords(packages);" in javascript
    assert "function toggleTimeline()" in javascript
    assert "window.setInterval(advanceTimeline, interval)" in javascript
    assert "timelineCumulative ? pkg.month <= month" in javascript
    assert 'California' in javascript
    assert 'id="reset-globe"' in html
    assert 'has("preview")' in javascript
    assert 'href="styles.css?v=globe-3"' in html
    assert 'src="app.js?v=globe-5"' in html
    assert 'id="international-status"' in html
    assert 'source: "onward-routes"' in javascript
    assert 'source: "highlight-routes"' in javascript
    assert 'source: "highlight-onward-routes"' in javascript
    assert 'fetch("data/shipments.json", { cache: "no-store" })' in javascript


def test_region_filter_can_highlight_or_isolate_and_reports_package_count():
    html = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
    javascript = (ROOT / "public" / "app.js").read_text(encoding="utf-8")
    for control_id in ("region-highlight", "region-isolate", "region-status"):
        assert f'id="{control_id}"' in html
    assert html.index('id="international-status"') < html.index('class="map-wrap"')
    assert 'regionViewMode === "isolate"' in javascript
    assert 'render(visiblePackages, region === "all" ? null : region);' in javascript
    assert '${regionLabel} · ${packageLabel(regionPackages.length)}' in javascript
