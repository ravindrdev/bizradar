# BizRadar

Small-business audit tool. **Phase 1**: hotels only.

A user enters a hotel name and city, the server runs Layer 0 classification,
fetches Google Places data, evaluates the `hospitality.hotels_motels` profile
from BATCH13.pdf, and returns a plain HTML report with strengths and the top 3
ranked recommendations (cited to verified studies).

## Run locally

Requires Node.js 18+ (uses built-in `fetch`).

```bash
npm install
cp .env.example .env
# edit .env and set GOOGLE_PLACES_API_KEY=<your key>
npm start
```

Open <http://localhost:3000>, type `the edgewater hotel madison wi`, click
**Audit**.

## Layout

| File | Role |
| --- | --- |
| `server.js` | Express server, `/classify` endpoint, HTML report renderer |
| `server_layer0.js` | Layer 0 classifier (BATCH12 reference impl, CSV-parsing bug fixed) |
| `hotelsProfile.js` | Hardcoded `hospitality.hotels_motels` profile from BATCH13 p.12 |
| `triggerDsl.js` | 11-operator trigger DSL parser + evaluator (BATCH13 p.8) |
| `ranker.js` | Magnitude × evidence × ease scoring (BATCH13 p.6-7) |
| `googlePlaces.js` | Legacy Places Text Search + Details |
| `public/index.html` | Single-input form |
| `verifiedStudies.json` | 35 verified studies (input — not modified) |
| `classifierRegistry.json` | Layer 0 registry (input — not modified) |
| `keywordRouter.csv`, `naicsRouter.csv` | Routing tables (input — not modified) |
| `profileRegistry.json` | Profile stubs (input — not modified; hotels filled in code) |

## Phase-1 limitations

- Hotels only. Other NAICS render a "phase 1 only supports hotels" message.
- Top 3 recommendations only. No additional opportunities, no 360°
  categories, no Common Problems section, no 3-layer recommendation format.
- Citations are listed as plain text + links; no citation linter enforcement.
- No caching. Every request hits Google Places.
- Optional fields not derived: `responds_to_reviews`, `response_rate_estimated`,
  `years_in_business`, `competitor_density_5mi`. They stay unknown, which is
  what BATCH13 p.23 expects for the Edgewater example.
- **Phase-1 keyword patch**: `keywordRouter.csv` ships only multi-word hotel
  formats ("Boutique Hotel", "Pod Hotel", etc.), not bare "hotel". `server.js`
  contains a small post-Layer-0 override: if the input mentions `hotel` or
  `motel` as a word and Layer 0 didn't already resolve to a lodging NAICS, it
  reroutes to NAICS 721110 with confidence MEDIUM. Remove this block once a
  bare-`hotel` row is added to the registry.

## Known limitations

- Professional service firms using regional entity suffixes only (S.C., P.C., P.A.) without descriptive business-type keywords in their name may return UNSUPPORTED. Users can try adding their profession to the search input e.g. `Murphy Desmond law firm Madison WI`.

## Bug fixes in `server_layer0.js`

The reference implementation had two issues; both are fixed in this branch:

1. `loadKeywords()` used `String.split(',')`, which breaks on quoted CSV
   fields containing commas (e.g. `"Tech, Digital & Creative"`). Now uses
   `csv-parse/sync` with `columns: true`.
2. The destructure `[phrase, , naics, , confidence]` read column index 4 as
   `confidence`, but in the actual CSV header column 4 is `sector_profile_id`
   and `confidence` is column 5. Now the code reads named columns
   (`modern_label`, `closest_naics_6`, `confidence`) directly.
