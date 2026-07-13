# Where My Ebay Packages Have Travelled

An interactive map built from real sales data from North Shore Nostalgia, my eBay business. I have been selling games for a few years, and this project turns that history into a public portfolio story: where packages went, how far the games travelled from Salem, Massachusetts, and how a small used-game shop reaches across the map.

![Where My Ebay Packages Have Travelled portfolio preview](public/social-preview.png)

## What makes this portfolio-ready

- A designed, responsive Leaflet experience rather than a default pin map
- Package and game counts, combined distance, regional reach, search, and time/place filters
- Real generalized sales data from North Shore Nostalgia
- One package per eBay order, with multi-item orders grouped correctly
- City-centroid geocoding and approximate great-circle distance calculations
- A hard privacy boundary enforced in code and tests
- An optional eBay API sync every six hours through GitHub Actions

## Privacy model

The private source may contain names, usernames, email addresses, street addresses, ZIP/postal codes, phone numbers, order IDs, payment details, and tracking numbers. None of those fields are written to the web dataset.

The public file contains only:

- destination city/town, state/region, and country;
- the city centroid rounded to five decimal places;
- sale month (never the exact day);
- game title and quantity;
- approximate city-to-city distance; and
- an opaque ID derived only from already-public generalized fields.

The raw eBay export and API response belong in `private/`, which is gitignored. `scripts/build_map_data.py` uses an allow-list for every public package field, and the test suite verifies that representative PII never crosses the boundary.

## Run locally

Python 3.11+ is recommended.

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt

python scripts/build_map_data.py `
  --input "C:\path\to\ebay-all-orders-report.csv" `
  --origin "Salem, Massachusetts, United States"

python -m http.server 8000 --directory public
```

Open `http://localhost:8000`. The first build geocodes each unique city through OpenStreetMap Nominatim at a deliberately conservative rate and caches the results in `data/city-cache.json`. Later builds reuse the cache. Set `GEOCODER_EMAIL` to a contact address when running a substantial batch.

To rebuild without any network geocoding:

```powershell
python scripts/build_map_data.py --input "C:\path\to\orders.csv" --offline
```

## Automatic eBay updates

The scheduled workflow uses the eBay Fulfillment API with its read-only scope. It refreshes a short-lived user access token, retrieves the API's recent rolling order window, generalizes the records, merges them into the safe history, tests the result, and commits only the public JSON and city cache.

1. Create production application keys in the eBay Developers Program.
2. Complete eBay's authorization-code consent flow with this scope:
   `https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly`
3. Add repository secrets named `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, and `EBAY_REFRESH_TOKEN`.
4. Optionally add `GEOCODER_EMAIL` for Nominatim identification.
5. In **Settings → Pages**, choose **GitHub Actions** as the publishing source. The included deployment workflow tests the privacy boundary and publishes `public/` on every relevant push.

The refresh workflow runs at minute 17 every six hours and can also be triggered manually. It fetches, generalizes, tests, commits safe changes, and deploys the refreshed Pages artifact in the same run. This last detail is intentional: GitHub does not start another workflow or Pages build from a commit pushed with the default `GITHUB_TOKEN`. Credentials and raw responses are never committed.

Official references: [eBay Fulfillment API](https://developer.ebay.com/develop/api/sell/fulfillment_api), [eBay OAuth authorization](https://developer.ebay.com/develop/guides-v2/authorization), and [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/).

## Tests

```powershell
pytest -q
```

The tests cover package grouping, approximate distance, safe-history merging, the checked-in output schema, and representative PII exclusion.

## Projection and distance note

Coordinates are stored in WGS 84 (EPSG:4326) and displayed by Leaflet in Web Mercator (EPSG:3857), the web-mapping standard. Distances use a great-circle calculation on latitude/longitude, which is appropriate for an approximate national flow map. They are not road mileage or carrier routes.
