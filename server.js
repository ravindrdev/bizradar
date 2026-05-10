// override:true so .env wins over an empty/stale ANTHROPIC_API_KEY inherited
// from the parent shell. Without this, dotenv silently skips the key when the
// parent process exports it as an empty string.
require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const express = require('express');

const layer0 = require('./server_layer0');
const naicsRouter = require('./naicsRouter');
const profileResolver = require('./profileResolver');
const placesTypeMapper = require('./placesTypeMapper');
const places = require('./googlePlaces');
const dataFetchers = require('./dataFetchers');
const { scoreRecommendations, evaluateRedFlags } = require('./ranker');
const triggerDsl = require('./triggerDsl');
const claudeEnricher = require('./claudeEnricher');
const marketScorer = require('./marketScorer');
const claudeMarketAnalyst = require('./claudeMarketAnalyst');
const { verifyQuotes } = require('./provenance');
const studies = require('./verifiedStudies.json');
const sectorProblems = require('./sectorCommonProblems.json');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Server-Sent Events progress stream ─────────────────────────────
// Routes that take >1s emit progress events via sendProgress(sessionId).
// The frontend opens GET /progress/:sessionId BEFORE submitting the
// form so the live stream is connected by the time the POST starts.
const progressClients = new Map();
function sendProgress(sessionId, data) {
  if (!sessionId) return;
  const client = progressClients.get(sessionId);
  if (!client || client.writableEnded) return;
  try {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (_) { /* connection closed mid-write */ }
}
app.get('/progress/:sessionId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  // Initial "connected" tick so the client can confirm the channel is live.
  res.write('data: {"step":0,"total":0,"message":"connected","pct":0}\n\n');
  progressClients.set(req.params.sessionId, res);
  // 15s heartbeat so proxies don't kill an idle stream.
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { /* socket gone */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    progressClients.delete(req.params.sessionId);
  });
});

layer0.loadRegistries();
naicsRouter.load();
profileResolver.load();

app.post('/classify', async (req, res) => {
  const input = (req.body.query || '').trim();
  const sessionId = (req.body.sessionId || '').toString();
  if (!input) {
    res.status(400).send(renderError('Please enter a business name and city.'));
    return;
  }
  sendProgress(sessionId, { step: 1, total: 8, message: 'Finding your business on Google...', pct: 10 });

  let layer0Result;
  try {
    layer0Result = layer0.classifyInput(input);
  } catch (err) {
    res.status(500).send(renderError(`Classifier error: ${err.message}`));
    return;
  }

  // Phase-1 hotel keyword patch (kept as a fast-path; saves a Places call
  // when the input mentions "hotel"/"motel"/"inn" anywhere in the string
  // and Layer 0 didn't classify it. Word-boundary matching (\b) ensures
  // the keyword is matched as its own token in the full input — including
  // when surrounded by an address ("Holiday Inn, 100 Main St, Town, ST ZIP").
  // Note: CamelCase brands like "AmericInn" lack a word boundary inside
  // the token; those are caught by BRAND_CHAIN (Wyndham/Choice/etc.) at
  // Layer 0 instead.
  if (!layer0Result.naics6 && /\b(hotel|motel|inn)\b/i.test(input)) {
    layer0Result = {
      mode: 'niche_typed',
      confidence: 'MEDIUM',
      naics6: '721110',
      keyword: 'hotel',
      _phase1Patch: true,
    };
  }

  // Phase-3 fallback — when Layer 0 produced no NAICS, do an early Places
  // Text Search and try to derive NAICS from the result's types[] array.
  // If types[] is degenerate (no match in either pass), fall through to a
  // name-based pattern match against the Place's name field. We stash
  // placeStub so we don't double-call Places below.
  let placeStub = null;
  let typesFallback = null;
  let nameFallback = null;
  if (!layer0Result.naics6) {
    if (!API_KEY) {
      res.status(500).send(renderError(
        'GOOGLE_PLACES_API_KEY is not set. Copy .env.example to .env and add a key.'
      ));
      return;
    }
    try {
      placeStub = await places.findPlace(input, API_KEY);
    } catch (err) {
      res.status(502).send(renderError(`Google Places search failed: ${err.message}`));
      return;
    }
    if (!placeStub) {
      res.send(renderError(`No Google Places match for "${escapeHtml(input)}".`));
      return;
    }
    // Tier 1: name fallback — runs FIRST so brand/keyword signals override
    // misleading Google type tags (Phase 2 Session 9.5.1+):
    //   - breweries tagged 'bar' → brewery_winery_distillery wins
    //   - chiropractors tagged 'gym' → chiropractic wins
    //   - moving companies tagged 'storage' → moving_company wins
    //   - cleaning services tagged 'laundry' → cleaning wins (Honolulu maid)
    //
    // Match against TWO sources, in this order:
    //   1. Input business name (text before the street address) — captures
    //      user intent even when Google returns a truncated/different name
    //      ("Inglenook" instead of "Inglenook Winery", "1600 Glenarm Place"
    //      instead of "Greystar Real Estate").
    //   2. Google's returned place_name — fallback for inputs that don't
    //      have a parseable business-name prefix.
    //
    // The business-name prefix is extracted with the same regex as the
    // LOCATION mode in Layer 0: everything before the first comma whose
    // right-hand side starts with a street number.
    const inputNameMatch = input.match(/^(.+?),\s*\d+\s+/);
    const businessNameFromInput = inputNameMatch ? inputNameMatch[1].trim() : input;
    let named = placesTypeMapper.mapNameToNaics6(businessNameFromInput);
    let nameSource = 'input_business_name';
    if (!named && placeStub.name) {
      named = placesTypeMapper.mapNameToNaics6(placeStub.name);
      nameSource = 'place_name';
    }
    if (named) {
      console.log('[diag] name_fallback triggered:', JSON.stringify({
        source: nameSource,
        input_business_name: businessNameFromInput,
        place_name: placeStub.name,
        matched_token: named.matched_token,
        matched_category: named.matched_category,
        resulting_naics6: named.naics6,
      }));
      nameFallback = {
        source: nameSource,
        place_name: placeStub.name,
        matched_token: named.matched_token,
        matched_category: named.matched_category,
      };
      layer0Result = {
        mode: 'places_name_fallback',
        confidence: 'LOW',
        naics6: named.naics6,
        matched_token: named.matched_token,
        matched_category: named.matched_category,
        _nameFallback: true,
      };
    } else {
      // Tier 2: specific types (e.g. dentist, lawyer, supermarket)
      const specMatch = placesTypeMapper.mapSpecificType(placeStub.types);
      if (specMatch) {
        typesFallback = { matched_type: specMatch.matched_type, types: placeStub.types };
        layer0Result = {
          mode: 'places_types_fallback',
          confidence: 'MEDIUM',
          naics6: specMatch.naics6,
          matched_type: specMatch.matched_type,
          _typesFallback: true,
        };
      } else {
        // Tier 3: generic types (food, health, store, school, bar)
        const genMatch = placesTypeMapper.mapGenericType(placeStub.types);
        if (genMatch) {
          typesFallback = { matched_type: genMatch.matched_type, types: placeStub.types };
          layer0Result = {
            mode: 'places_types_fallback',
            confidence: 'LOW',
            naics6: genMatch.naics6,
            matched_type: genMatch.matched_type,
            _typesFallback: true,
          };
        }
      }
    }
  }

  // Diagnostic — Phase 3 instrumentation
  console.log('[diag] classify:', JSON.stringify({
    input,
    layer0_mode: layer0Result.mode,
    layer0_naics6: layer0Result.naics6 || null,
    places_types_fallback_fired: !!typesFallback,
    places_name_fallback_fired: !!nameFallback,
    google_types_returned: typesFallback ? typesFallback.types : (placeStub ? placeStub.types : null),
  }));

  // Diagnostic response headers — set before any res.send so all branches
  // (waitlist, unsupported, error, blocked, report) carry them. The test
  // harness reads these to capture Layer 0 mode without parsing HTML.
  res.setHeader('X-Layer0-Mode', layer0Result.mode || 'unknown');
  res.setHeader('X-Naics6', layer0Result.naics6 || '');
  res.setHeader('X-Place-Name', placeStub && placeStub.name ? encodeURIComponent(placeStub.name) : '');

  // OOS check via naicsRouter — short-circuits to waitlist for explicit
  // OUT_OF_SCOPE_NICHE / OUT_OF_SCOPE_REGULATED entries.
  const routedProfileId = naicsRouter.lookupProfileId(layer0Result.naics6);
  if (routedProfileId && routedProfileId.startsWith('OUT_OF_SCOPE_')) {
    logOosHit(input, layer0Result, routedProfileId);
    res.setHeader('X-Profile-Id', routedProfileId);
    res.setHeader('X-Status', 'oos_waitlist');
    res.send(renderWaitlist(input, layer0Result, routedProfileId));
    return;
  }

  let profile = profileResolver.resolveProfile(layer0Result.naics6);

  // Phase 5+ — Claude classification fallback. When Layer 0 + Phase-3
  // both failed to produce a profile-resolvable NAICS-6, ask Claude to
  // classify the business based on user input + Google place name + types.
  // One extra ~$0.002 call. Only fires here, not on every request.
  // After Claude responds, we re-run BOTH the OOS check and the profile
  // resolver on its NAICS so OOS variants (regulated, niche, 55, 92) still
  // route to the waitlist correctly.
  if (!profile) {
    // Make sure we have a placeStub to feed Claude. Phase-3 may have
    // already fetched one; if not, do a single Text Search now.
    if (!placeStub && API_KEY) {
      try {
        placeStub = await places.findPlace(input, API_KEY);
      } catch (err) {
        console.warn('[claude-classify] places fetch failed:', err.message);
      }
    }
    const claudeNaics = await claudeEnricher.classifyWithClaude(
      input,
      placeStub ? placeStub.name : null,
      placeStub ? placeStub.types : null
    );
    if (claudeNaics) {
      // Update layer0Result so downstream sees the new NAICS + a marker
      // for the report renderer (helpful in the header diagnostic line).
      layer0Result = {
        ...layer0Result,
        naics6: claudeNaics,
        mode: 'claude_classification',
        confidence: 'LOW',
        _claudeClassified: true,
      };
      // Re-run OOS check on Claude's NAICS — if it lands on an explicit
      // OUT_OF_SCOPE_* row, route to the waitlist exactly as we would
      // for a deterministic OOS hit.
      const claudeRoutedId = naicsRouter.lookupProfileId(claudeNaics);
      if (claudeRoutedId && claudeRoutedId.startsWith('OUT_OF_SCOPE_')) {
        logOosHit(input, layer0Result, claudeRoutedId);
        res.setHeader('X-Layer0-Mode', 'claude_classification');
        res.setHeader('X-Naics6', claudeNaics);
        res.setHeader('X-Profile-Id', claudeRoutedId);
        res.setHeader('X-Status', 'oos_waitlist');
        res.send(renderWaitlist(input, layer0Result, claudeRoutedId));
        return;
      }
      // Try the profile registry with the Claude NAICS.
      profile = profileResolver.resolveProfile(claudeNaics);
      if (profile) {
        console.log(`[claude-classify] resolved ${claudeNaics} → ${profile.id}`);
        res.setHeader('X-Layer0-Mode', 'claude_classification');
        res.setHeader('X-Naics6', claudeNaics);
      } else {
        console.warn(`[claude-classify] NAICS ${claudeNaics} did not resolve to any profile in registry`);
      }
    }
  }

  if (!profile) {
    res.setHeader('X-Profile-Id', '');
    res.setHeader('X-Status', 'unsupported');
    res.send(renderUnsupported(input, layer0Result));
    return;
  }
  res.setHeader('X-Profile-Id', profile.id);

  if (!API_KEY) {
    res.status(500).send(renderError(
      'GOOGLE_PLACES_API_KEY is not set. Copy .env.example to .env and add a key.'
    ));
    return;
  }

  // Reuse placeStub from the Phase-3 types fallback if we already fetched it.
  if (!placeStub) {
    try {
      placeStub = await places.findPlace(input, API_KEY);
    } catch (err) {
      res.status(502).send(renderError(`Google Places search failed: ${err.message}`));
      return;
    }
    if (!placeStub) {
      res.send(renderError(`No Google Places match for "${escapeHtml(input)}".`));
      return;
    }
  }

  sendProgress(sessionId, { step: 2, total: 8, message: `Found: ${placeStub.name || 'business'} — fetching details...`, pct: 20 });
  let detail;
  try {
    detail = await places.getDetails(placeStub.place_id, API_KEY);
  } catch (err) {
    res.status(502).send(renderError(`Google Places details failed: ${err.message}`));
    return;
  }
  sendProgress(sessionId, {
    step: 3, total: 8,
    message: `${(detail && detail.user_ratings_total) || 0} reviews loaded — scanning competitors...`,
    pct: 35,
  });

  const data = places.toInputFields(detail);
  data.is_chain = (layer0Result.mode === 'brand_chain');
  data.chain_name = layer0Result.chain || null;
  // BATCH16 — pass the raw review array through for the Common Problems
  // section's keyword-mining pass. Google's legacy Places Details API
  // returns up to 5 reviews; ample for a v1 keyword scan.
  data.sample_reviews = Array.isArray(detail.reviews) ? detail.reviews : [];

  // ════════════════════════════════════════════════════════════════════
  // BATCH14 — 360° signal expansion. Run all enrichment fetches in
  // parallel. Each fetch is wrapped in its own try/catch so a single
  // failure (Census API down, website returns 404, no Nearby competitors)
  // never blocks the rest of the report. Promise.allSettled ensures the
  // promise array always resolves regardless of individual rejections.
  //
  // Fields wired:
  //   FETCH 1 (Nearby Search) → competitor_count, competitor_median_rating,
  //                              competitor_median_review_count, competitors_top3
  //   FETCH 2 (Census ACS)    → median_household_income, total_population,
  //                              average_household_size
  //   FETCH 4 (Website HEAD)  → website_exists
  //
  // FETCHES 3 + 5 (review-response signals + hours completeness) are
  // already extracted synchronously inside places.toInputFields() since
  // the data is in the Places Details payload — no extra API call needed.
  // ════════════════════════════════════════════════════════════════════
  const nearbyType = places.pickNearbySearchType(data.google_types);
  const zip = dataFetchers.extractZipFromAddress(data.formatted_address);
  const websiteUrl = data.website;

  // Phase 5+ — extended to 5 parallel fetches: competitors, census,
  // website HEAD check, weather climatology (Open-Meteo), and location
  // signals (Overpass / OpenStreetMap). PageSpeed is run conditionally
  // AFTER this batch — only if the website check confirms the site loads
  // (per spec: "Only call if website_url is not null and website_exists
  // is true"). Each promise has its own try/catch + timeout, so one
  // failure never blocks the rest of the report.
  // City/state extracted once for fetchUpcomingEvents (and for any
  // future city/state-keyed source). Re-uses claudeEnricher.parseAddress
  // since it already handles the Google formatted_address shape.
  const addrParts = claudeEnricher.parseAddress(data.formatted_address || '');

  // Phase 5+ — derived fields the new sector-conditional fetchers need.
  // Stuff onto `data` (rather than separate locals) so the Claude bundle
  // and the renderer pick them up too.
  data.business_name = data.name || input;
  data.city = addrParts.city;
  data.state = addrParts.state;
  data.sector_naics2 = naics2FromNaics6(layer0Result.naics6);
  data.profile_id = profile.id;

  // Phase 5+ — sector-conditional promises. Skip (resolve to null)
  // when the business doesn't belong to the relevant NAICS-2 sector
  // or profile family — saves API budget and keeps the data bundle
  // free of fields that don't apply.
  const blsPromise = ['54','61','62','23','44-45'].includes(data.sector_naics2)
    ? dataFetchers.fetchBLSEmployment(data.sector_naics2)
    : Promise.resolve(null);
  const usdaPromise = data.sector_naics2 === '11'
    ? dataFetchers.fetchUSDANASS(data.state, 'CORN')
    : Promise.resolve(null);
  const fmcsaPromise = data.sector_naics2 === '48-49'
    ? dataFetchers.fetchFMCSA(data.business_name)
    : Promise.resolve(null);
  const npiPromise = data.sector_naics2 === '62'
    ? dataFetchers.fetchNPIRegistry(data.business_name, data.city, data.state)
    : Promise.resolve(null);
  const fmrPromise = data.sector_naics2 === '53'
    ? dataFetchers.fetchFairMarketRents(data.state)
    : Promise.resolve(null);
  const fdicPromise = (data.profile_id && (data.profile_id.includes('bank') || data.profile_id.includes('finance')))
    ? dataFetchers.fetchFDICData(data.business_name, data.state)
    : Promise.resolve(null);
  const cmsPromise = (data.profile_id && (data.profile_id.includes('hospital') || data.profile_id.includes('specialty_clinic')))
    ? dataFetchers.fetchCMSProviderData(data.business_name, data.state)
    : Promise.resolve(null);

  const [
    competitorRes, censusRes, websiteRes, weatherRes, locationRes, permitsRes, eventsRes,
    venuesRes, tripAdvisorRes,
    blsRes, usdaRes, fmcsaRes, npiRes, fmrRes, fdicRes, cmsRes,
  ] = await Promise.allSettled([
    places.fetchNearbyCompetitors({
      placeId: data.place_id,
      lat: data.latitude,
      lng: data.longitude,
      type: nearbyType,
      apiKey: API_KEY,
      city: data.city,
      state: data.state,
      subjectName: data.name,
      // ── New competitor-detection inputs (FIX 1/2/3) ──
      // buildCompetitorQuery uses naics6/naics2/googleTypes/businessName
      // to construct a Google Text Search query that's far more
      // category-accurate than the old type-filter Nearby Search.
      // getCompetitorRadius picks the right search distance based on
      // sector (hotels/healthcare/etc. need wider radii) and
      // population. T1 RULE: population is null here because Census
      // fires in the same Promise.allSettled batch — the helper
      // defaults to a rural-sized radius when population is unknown.
      businessName: data.name,
      naics6: layer0Result.naics6,
      naics2: data.sector_naics2,
      googleTypes: data.google_types,
      population: null,
    }),
    // FIX 1 — pass city + state so fetchCensusByZip's place-level branch
    // fires. Without these args, _fetchCensusPlacePopulation is skipped
    // and `total_population` falls back to the ZCTA-level number (which
    // overstates the city by ~50% for Dodgeville WI: ZCTA 7,397 vs
    // city 4,994). countyFIPS isn't known yet at this point in the
    // route — the building-permits fetcher resolves it later — so we
    // pass null and skip the county-income branch on /classify (income
    // for cities >200k pop only; not a /classify use case).
    dataFetchers.fetchCensusByZip(zip, addrParts.city, addrParts.state, null),
    dataFetchers.checkWebsiteExists(websiteUrl),
    dataFetchers.fetchWeather(data.latitude, data.longitude),
    dataFetchers.fetchLocationSignals(data.latitude, data.longitude),
    // HUD residential building permits — Census geocoder (FIPS lookup) +
    // HUD ArcGIS query in sequence. Two HTTP calls but only fires ~5s
    // worst-case via internal timeouts. Cached 30 days per county FIPS.
    dataFetchers.fetchBuildingPermitsByAddress(data.formatted_address),
    // Ticketmaster Discovery v2 — top 5 upcoming events within 10 miles.
    // Returns empty array gracefully when TICKETMASTER_API_KEY is unset
    // or the city/state has nothing in their catalog.
    dataFetchers.fetchUpcomingEvents(addrParts.city, addrParts.state),
    // Phase 5+ FETCH 10 — Foursquare v3 nearby venues (food/arts/outdoors).
    // Returns [] when no key is configured. Cached 24h per lat/lon@3dec.
    dataFetchers.fetchNearbyVenues(data.latitude, data.longitude),
    // Phase 5+ FETCH 11 — TripAdvisor Content API (search → details +
    // reviews). Three HTTP calls internally; returns null if any step
    // fails. Cached 24h per businessName + city.
    dataFetchers.fetchTripAdvisor(data.name || input, data.formatted_address),
    // Phase 5+ FETCH 12-18 — sector-conditional sources. Each was
    // resolved above to either a real fetch promise or Promise.resolve(null).
    blsPromise,
    usdaPromise,
    fmcsaPromise,
    npiPromise,
    fmrPromise,
    fdicPromise,
    cmsPromise,
  ]);
  sendProgress(sessionId, { step: 4, total: 8, message: 'Census, weather, permits loaded — running scoring engine...', pct: 50 });

  // FETCH 1 — competitor stats (or null on failure)
  if (competitorRes.status === 'fulfilled' && competitorRes.value) {
    data.competitor_count = competitorRes.value.competitor_count;
    data.competitor_median_rating = competitorRes.value.competitor_median_rating;
    data.competitor_median_review_count = competitorRes.value.competitor_median_review_count;
    data.competitors_top3 = competitorRes.value.competitors_top3;
    data.competitors_top5 = competitorRes.value.competitors_top5;
    data.search_radius_miles = competitorRes.value.search_radius_miles;
  } else {
    data.competitor_count = null;
    data.competitor_median_rating = null;
    data.competitor_median_review_count = null;
    data.competitors_top3 = null;
    data.competitors_top5 = null;
    data.search_radius_miles = null;
    if (competitorRes.status === 'rejected') {
      console.warn('[fetch1] nearby-search failed:', competitorRes.reason && competitorRes.reason.message);
    }
  }

  // FETCH 2 — Census ACS (or null on failure)
  if (censusRes.status === 'fulfilled' && censusRes.value) {
    data.median_household_income = censusRes.value.median_household_income;
    data.total_population = censusRes.value.total_population;
    data.average_household_size = censusRes.value.average_household_size;
    data.census_zip = censusRes.value.zip;
  } else {
    data.median_household_income = null;
    data.total_population = null;
    data.average_household_size = null;
    data.census_zip = zip;
    if (censusRes.status === 'rejected') {
      console.warn('[fetch2] census-acs failed:', censusRes.reason && censusRes.reason.message);
    }
  }

  // FETCH 4 — website HEAD check
  if (websiteRes.status === 'fulfilled') {
    data.website_url = websiteUrl || null;
    data.website_exists = websiteRes.value;
  } else {
    data.website_url = websiteUrl || null;
    data.website_exists = null;
    console.warn('[fetch4] website-check failed:', websiteRes.reason && websiteRes.reason.message);
  }

  // Phase 5+ FETCH 5 — Open-Meteo climatology
  // Top-level fields named per the user's trigger spec (peak_tourist_season,
  // has_cold_winter, etc.) so the trigger DSL can reference them directly.
  if (weatherRes.status === 'fulfilled' && weatherRes.value) {
    data.weather = weatherRes.value;
    data.peak_month = weatherRes.value.peak_month;
    data.peak_tourist_season = weatherRes.value.peak_tourist_season;
    data.has_cold_winter = weatherRes.value.has_cold_winter;
    data.has_hot_summer = weatherRes.value.has_hot_summer;
  } else {
    data.weather = null;
    data.peak_month = null;
    data.peak_tourist_season = null;
    data.has_cold_winter = null;
    data.has_hot_summer = null;
    if (weatherRes.status === 'rejected') {
      console.warn('[fetch5-weather] failed:', weatherRes.reason && weatherRes.reason.message);
    }
  }

  // Phase 5+ FETCH 6 — Overpass / OpenStreetMap location signals
  if (locationRes.status === 'fulfilled' && locationRes.value) {
    data.location_signals = locationRes.value;
    data.anchor_tenants = locationRes.value.anchor_tenants;
    data.anchor_tenant_count = locationRes.value.anchor_tenant_count;
    data.nearest_transit_meters = locationRes.value.nearest_transit_meters;
    data.has_transit_nearby = locationRes.value.has_transit_nearby;
  } else {
    data.location_signals = null;
    data.anchor_tenants = null;
    data.anchor_tenant_count = null;
    data.nearest_transit_meters = null;
    data.has_transit_nearby = null;
    if (locationRes.status === 'rejected') {
      console.warn('[fetch6-overpass] failed:', locationRes.reason && locationRes.reason.message);
    }
  }

  // Phase 5+ FETCH 7 — HUD residential building permits (Census geocoder
  // → HUD ArcGIS layer 24). Top-level fields named per user's spec so the
  // trigger DSL can reference them directly.
  if (permitsRes.status === 'fulfilled' && permitsRes.value) {
    const p = permitsRes.value;
    data.building_permits = p;
    data.building_permits_total = p.building_permits_total;
    data.building_permits_single_family = p.building_permits_single_family;
    data.building_permits_year = p.building_permits_year;
    data.building_permits_yoy_change = p.building_permits_yoy_change;
    data.county_fips = p.county_fips;
    data.county_name = p.county_name;
  } else {
    data.building_permits = null;
    data.building_permits_total = null;
    data.building_permits_single_family = null;
    data.building_permits_year = null;
    data.building_permits_yoy_change = null;
    data.county_fips = null;
    data.county_name = null;
    if (permitsRes.status === 'rejected') {
      console.warn('[fetch7-permits] failed:', permitsRes.reason && permitsRes.reason.message);
    }
  }

  // Phase 5+ FETCH 8 — Ticketmaster upcoming events (city/state)
  // Returns [] gracefully when no API key is set or the call fails.
  if (eventsRes.status === 'fulfilled' && Array.isArray(eventsRes.value)) {
    data.upcoming_events = eventsRes.value;
  } else {
    data.upcoming_events = [];
    if (eventsRes.status === 'rejected') {
      console.warn('[fetch8-events] failed:', eventsRes.reason && eventsRes.reason.message);
    }
  }

  // Phase 5+ FETCH 10 — Foursquare nearby venues (food/arts/outdoors)
  if (venuesRes.status === 'fulfilled' && Array.isArray(venuesRes.value)) {
    data.nearby_venues = venuesRes.value;
    data.nearby_venue_count = venuesRes.value.length;
  } else {
    data.nearby_venues = [];
    data.nearby_venue_count = 0;
    if (venuesRes.status === 'rejected') {
      console.warn('[fetch10-venues] failed:', venuesRes.reason && venuesRes.reason.message);
    }
  }

  // Phase 5+ FETCH 11 — TripAdvisor (search → details + reviews)
  // Top-level fields named per spec so the trigger DSL can reference them
  // directly (ta_rating, ta_review_count, ta_subratings, ta_value_gap_detected, …).
  if (tripAdvisorRes.status === 'fulfilled' && tripAdvisorRes.value) {
    const ta = tripAdvisorRes.value;
    data.tripadvisor = ta;
    data.ta_location_id = ta.ta_location_id;
    data.ta_rating = ta.ta_rating;
    data.ta_review_count = ta.ta_review_count;
    data.ta_ranking = ta.ta_ranking;
    data.ta_ranking_position = ta.ta_ranking_position;
    data.ta_ranking_out_of = ta.ta_ranking_out_of;
    data.ta_subratings = ta.ta_subratings;
    data.ta_awards = ta.ta_awards;
    data.ta_trip_types = ta.ta_trip_types;
    data.ta_recent_reviews = ta.ta_recent_reviews;
    // Synthetic boolean for the trigger DSL (no arithmetic in DSL grammar).
    data.ta_value_gap_detected = ta.ta_value_gap_detected;
  } else {
    data.tripadvisor = null;
    data.ta_location_id = null;
    data.ta_rating = null;
    data.ta_review_count = null;
    data.ta_ranking = null;
    data.ta_ranking_position = null;
    data.ta_ranking_out_of = null;
    data.ta_subratings = null;
    data.ta_awards = null;
    data.ta_trip_types = null;
    data.ta_recent_reviews = null;
    data.ta_value_gap_detected = false;
    if (tripAdvisorRes.status === 'rejected') {
      console.warn('[fetch11-tripadvisor] failed:', tripAdvisorRes.reason && tripAdvisorRes.reason.message);
    }
  }

  // Phase 5+ FETCH 12 — BLS sector employment level
  if (blsRes.status === 'fulfilled' && blsRes.value) {
    data.bls_employment = blsRes.value;
    data.bls_employment_level = blsRes.value.employment_level;
    data.bls_employment_year = blsRes.value.employment_year;
    data.bls_employment_period = blsRes.value.employment_period;
  } else {
    data.bls_employment = null;
    data.bls_employment_level = null;
    data.bls_employment_year = null;
    data.bls_employment_period = null;
    if (blsRes.status === 'rejected') {
      console.warn('[fetch12-bls] failed:', blsRes.reason && blsRes.reason.message);
    }
  }

  // Phase 5+ FETCH 13 — USDA NASS agriculture profile
  if (usdaRes.status === 'fulfilled' && usdaRes.value) {
    data.usda_nass = usdaRes.value;
    data.top_commodity = usdaRes.value.top_commodity;
    data.farm_count = usdaRes.value.farm_count;
    data.state_ag_profile = usdaRes.value.state_ag_profile;
  } else {
    data.usda_nass = null;
    data.top_commodity = null;
    data.farm_count = null;
    data.state_ag_profile = null;
    if (usdaRes.status === 'rejected') {
      console.warn('[fetch13-usda] failed:', usdaRes.reason && usdaRes.reason.message);
    }
  }

  // Phase 5+ FETCH 14 — FMCSA carrier safety
  if (fmcsaRes.status === 'fulfilled' && fmcsaRes.value) {
    data.fmcsa = fmcsaRes.value;
    data.dot_number = fmcsaRes.value.dot_number;
    data.safety_rating = fmcsaRes.value.safety_rating;
    data.allowed_to_operate = fmcsaRes.value.allowed_to_operate;
    data.total_drivers = fmcsaRes.value.total_drivers;
    data.total_trucks = fmcsaRes.value.total_trucks;
  } else {
    data.fmcsa = null;
    data.dot_number = null;
    data.safety_rating = null;
    data.allowed_to_operate = null;
    data.total_drivers = null;
    data.total_trucks = null;
    if (fmcsaRes.status === 'rejected') {
      console.warn('[fetch14-fmcsa] failed:', fmcsaRes.reason && fmcsaRes.reason.message);
    }
  }

  // Phase 5+ FETCH 15 — NPI Registry healthcare provider
  if (npiRes.status === 'fulfilled' && npiRes.value) {
    data.npi = npiRes.value;
    data.npi_number = npiRes.value.npi_number;
    data.npi_status = npiRes.value.status;
    data.npi_authorized = npiRes.value.authorized;
    data.provider_type = npiRes.value.provider_type;
  } else {
    data.npi = null;
    data.npi_number = null;
    data.npi_status = null;
    data.npi_authorized = null;
    data.provider_type = null;
    if (npiRes.status === 'rejected') {
      console.warn('[fetch15-npi] failed:', npiRes.reason && npiRes.reason.message);
    }
  }

  // Phase 5+ FETCH 16 — HUD Fair Market Rents
  if (fmrRes.status === 'fulfilled' && fmrRes.value) {
    data.hud_fmr = fmrRes.value;
    data.fmr_studio = fmrRes.value.fmr_studio;
    data.fmr_1br = fmrRes.value.fmr_1br;
    data.fmr_2br = fmrRes.value.fmr_2br;
    data.fmr_metro_name = fmrRes.value.metro_name;
    data.fmr_year = fmrRes.value.fmr_year;
  } else {
    data.hud_fmr = null;
    data.fmr_studio = null;
    data.fmr_1br = null;
    data.fmr_2br = null;
    data.fmr_metro_name = null;
    data.fmr_year = null;
    if (fmrRes.status === 'rejected') {
      console.warn('[fetch16-fmr] failed:', fmrRes.reason && fmrRes.reason.message);
    }
  }

  // Phase 5+ FETCH 17 — FDIC bank data
  if (fdicRes.status === 'fulfilled' && fdicRes.value) {
    data.fdic = fdicRes.value;
    data.fdic_bank_name = fdicRes.value.bank_name;
    data.fdic_total_deposits = fdicRes.value.total_deposits;
    data.fdic_total_assets = fdicRes.value.total_assets;
  } else {
    data.fdic = null;
    data.fdic_bank_name = null;
    data.fdic_total_deposits = null;
    data.fdic_total_assets = null;
    if (fdicRes.status === 'rejected') {
      console.warn('[fetch17-fdic] failed:', fdicRes.reason && fdicRes.reason.message);
    }
  }

  // Phase 5+ FETCH 18 — CMS Hospital General Information
  if (cmsRes.status === 'fulfilled' && cmsRes.value) {
    data.cms = cmsRes.value;
    data.cms_overall_rating = cmsRes.value.overall_rating;
    data.cms_patient_experience_rating = cmsRes.value.patient_experience_rating;
    data.cms_mortality_rating = cmsRes.value.mortality_rating;
    data.cms_safety_rating = cmsRes.value.safety_rating;
    data.cms_readmission_rating = cmsRes.value.readmission_rating;
    data.cms_timeliness_rating = cmsRes.value.timeliness_rating;
  } else {
    data.cms = null;
    data.cms_overall_rating = null;
    data.cms_patient_experience_rating = null;
    data.cms_mortality_rating = null;
    data.cms_safety_rating = null;
    data.cms_readmission_rating = null;
    data.cms_timeliness_rating = null;
    if (cmsRes.status === 'rejected') {
      console.warn('[fetch18-cms] failed:', cmsRes.reason && cmsRes.reason.message);
    }
  }

  // Phase 5+ FETCH 9 — Google PageSpeed Insights (mobile)
  // Conditional: only call if the website check passed. PSI takes 8-15s
  // even on healthy sites; we cap at 15s in the fetcher and fall through
  // to null fields on timeout. Report renders regardless.
  data.pagespeed = null;
  data.website_mobile_score = null;
  data.load_time_seconds = null;
  data.lcp_seconds = null;
  data.is_mobile_friendly = null;
  if (data.website_exists === true && data.website_url && API_KEY) {
    try {
      const ps = await dataFetchers.fetchPageSpeed(data.website_url);
      if (ps) {
        data.pagespeed = ps;
        data.website_mobile_score = ps.mobile_score;
        data.load_time_seconds = ps.load_time_seconds;
        data.lcp_seconds = ps.lcp_seconds;
        data.is_mobile_friendly = ps.is_mobile_friendly;
      }
    } catch (err) {
      console.warn('[fetch9-pagespeed] failed:', err.message);
    }
  }

  console.log('[diag] enrichment:', JSON.stringify({
    competitor_count: data.competitor_count,
    competitor_median_rating: data.competitor_median_rating,
    median_household_income: data.median_household_income,
    total_population: data.total_population,
    review_recency_days: data.review_recency_days,
    responds_to_reviews: data.responds_to_reviews,
    response_rate_estimated: data.response_rate_estimated,
    website_exists: data.website_exists,
    hours_complete: data.hours_complete,
    is_open_now: data.is_open_now,
    peak_tourist_season: data.peak_tourist_season,
    has_cold_winter: data.has_cold_winter,
    anchor_tenant_count: data.anchor_tenant_count,
    has_transit_nearby: data.has_transit_nearby,
    website_mobile_score: data.website_mobile_score,
    load_time_seconds: data.load_time_seconds,
    building_permits_total: data.building_permits_total,
    building_permits_yoy_change: data.building_permits_yoy_change,
    county_fips: data.county_fips,
    upcoming_events_count: Array.isArray(data.upcoming_events) ? data.upcoming_events.length : 0,
    nearby_venue_count: data.nearby_venue_count,
    ta_rating: data.ta_rating,
    ta_review_count: data.ta_review_count,
    ta_ranking_position: data.ta_ranking_position,
    ta_value_gap_detected: data.ta_value_gap_detected,
    sector_naics2: data.sector_naics2,
    bls_employment_level: data.bls_employment_level,
    top_commodity: data.top_commodity,
    fmcsa_safety_rating: data.safety_rating,
    npi_status: data.npi_status,
    fmr_2br: data.fmr_2br,
    fdic_total_deposits: data.fdic_total_deposits,
    cms_overall_rating: data.cms_overall_rating,
  }));

  const requiredMissing = profile.required_inputs.filter((f) => {
    if (f === 'google_review_count') return false;
    return data[f] === null || data[f] === undefined;
  });
  if (requiredMissing.length) {
    res.setHeader('X-Status', 'missing_fields');
    res.status(422).send(renderError(
      `Missing required fields from Google Places: ${requiredMissing.join(', ')}`
    ));
    return;
  }

  const redFlags = evaluateRedFlags(profile, data);
  const blocking = redFlags.find((r) => r.severity === 'critical' && r.blocks_report);
  if (blocking) {
    res.setHeader('X-Status', 'blocked');
    res.send(renderBlocked(profile, layer0Result, data, blocking));
    return;
  }
  res.setHeader('X-Status', 'report');

  const ranked = scoreRecommendations(profile, data, studies.studies);
  const strengths = computeStrengths(profile, data);
  sendProgress(sessionId, { step: 5, total: 8, message: 'Scoring complete — sending to Claude AI...', pct: 60 });

  // Phase 5 — Claude enrichment. Builds a deterministic data bundle from
  // the prior pipeline outputs and asks Claude for: enriched WHY-IT-WORKS
  // / WHY-YOUR-BUSINESS for the top 3 recs, 5 opportunity ideas (from 18
  // categories), and a local_context paragraph. On any failure (no key,
  // bad key, rate-limit, parse error, network) returns null and the
  // renderer shows the deterministic Phase-4 output with a small note.
  const dataBundle = claudeEnricher.buildDataBundle({
    data,
    profile,
    layer0Result,
    ranked,
    studies: studies.studies,
  });
  sendProgress(sessionId, { step: 6, total: 8, message: 'Claude is analyzing your report...', pct: 75 });
  const enriched = await claudeEnricher.enrichWithClaude(dataBundle);
  sendProgress(sessionId, { step: 7, total: 8, message: 'Building your report...', pct: 90 });

  const html = renderReport({
    input,
    layer0Result,
    profile,
    data,
    redFlags,
    strengths,
    ranked,
    enriched,
    studies: studies.studies,
  });

  // Citation linter (post-render, warn-only). Walk every cited study_id
  // referenced in the rendered report's top-10 recommendations and verify
  // it resolves in verifiedStudies.json. Bad references log a console
  // warning but do NOT block the response — the user wants visibility
  // during testing without breaking production reports.
  try {
    const claims = (ranked.top10 || []).flatMap((t) =>
      (t.rec.study_ids || []).map((sid) => ({
        studyId: sid,
        text: `[${profile.id}/${t.rec.id}] ${t.rec.claim || ''}`,
        tier3Disclosure: !!t.rec.tier3_disclosure_required,
      }))
    );
    const lintResult = layer0.lintReport({ claims });
    if (!lintResult.valid) {
      console.warn(
        `[lint] ${lintResult.errors.length} citation issue${lintResult.errors.length === 1 ? '' : 's'} on ${profile.id} report (${claims.length} claims, ${lintResult.sourceCount} unique sources):`
      );
      for (const err of lintResult.errors) console.warn('[lint]   ' + err);
    } else {
      console.log(
        `[lint] ${profile.id} report passes — ${claims.length} claims, ${lintResult.sourceCount} unique studies cited`
      );
    }
  } catch (err) {
    console.warn('[lint] linter execution failed:', err.message);
  }

  sendProgress(sessionId, { step: 8, total: 8, message: 'Done!', pct: 100 });
  res.send(html);
});

app.post('/market-analysis', async (req, res) => {
  const { city, state } = req.body;
  const sessionId = (req.body.sessionId || '').toString();
  console.log('[market-analysis] called for', city, state);

  // ── TIER 1 — Validation ─────────────────────────────────────────
  if (!city || !city.trim() || !state || !state.trim()) {
    return res.status(400).send(renderError('City and state are required.'));
  }
  if (!/^[A-Za-z]{2}$/.test(state.trim())) {
    return res.status(400).send(renderError('State must be a 2-letter code (e.g. WI).'));
  }

  // ── Progress events for /market-analysis ──────────────────────────
  // The actual work is wrapped inside claudeMarketAnalyst.analyzeCity()
  // which we don't modify (per spec). So we schedule the intermediate
  // milestones on a timer and clear the pending timeouts when
  // analyzeCity returns. The wall-clock offsets approximate observed
  // pipeline phase durations from prior runs.
  sendProgress(sessionId, { step: 1, total: 10, message: 'Geocoding your city...', pct: 5 });
  const SCHEDULE = [
    { step: 2,  message: 'Claude generating business types to evaluate...',     pct: 12, delayMs:   2000 },
    { step: 3,  message: 'Market agent: fetching events, weather, permits...',  pct: 22, delayMs:   6000 },
    { step: 4,  message: 'Demographics agent: Census data loading...',           pct: 32, delayMs:  12000 },
    { step: 5,  message: 'Competition agent: scanning 20 business types...',     pct: 45, delayMs:  18000 },
    { step: 6,  message: 'Cost agent: estimating startup feasibility...',        pct: 55, delayMs:  30000 },
    { step: 7,  message: 'Scoring engine: ranking all opportunities...',         pct: 65, delayMs:  42000 },
    { step: 8,  message: 'Claude writing deep dive analysis...',                 pct: 75, delayMs:  55000 },
    { step: 9,  message: 'Claude building personas and seasonal strategy...',    pct: 88, delayMs:  90000 },
  ];
  const timers = SCHEDULE.map((evt) => setTimeout(() => {
    sendProgress(sessionId, { step: evt.step, total: 10, message: evt.message, pct: evt.pct });
  }, evt.delayMs));
  const cancelTimers = () => { for (const t of timers) clearTimeout(t); };

  try {
    // ── TIER 2 → 5 — Orchestrate via claudeMarketAnalyst.analyzeCity
    // The analyzer pulls geocode + 4 parallel data agents + scoring +
    // why_this_city batch + deep dive on #1 — see the comments in
    // claudeMarketAnalyst.js for the full flow.
    const result = await claudeMarketAnalyst.analyzeCity(
      city.trim(),
      state.trim().toUpperCase(),
      {
        google: process.env.GOOGLE_PLACES_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
      }
    );

    // ── Provenance — verify every quote Claude emitted against the
    // exact review_snippets we shipped to it. Result is attached to
    // `result` so renderMarketReport can render colour-coded badges.
    if (result && result.deep_dive && result._provenance) {
      result._quote_verification = verifyQuotes(result.deep_dive, result._provenance);
      const total = result._quote_verification.length;
      const verified = result._quote_verification.filter((q) => q.verified === true).length;
      const failed = result._quote_verification.filter((q) => q.verified === false).length;
      console.log(
        `[provenance] ${verified}/${total} quotes verified`
        + (failed > 0 ? ` — ${failed} UNVERIFIED` : '')
      );
    }

    cancelTimers();
    sendProgress(sessionId, { step: 10, total: 10, message: 'Building your report...', pct: 98 });
    const html = renderMarketReport(result);
    sendProgress(sessionId, { step: 10, total: 10, message: 'Done!', pct: 100 });
    res.send(html);
  } catch (err) {
    cancelTimers();
    console.error('[market-analysis] error:', err);
    res.status(500).send(renderError(err.message || 'Something went wrong.'));
  }
});

// ── POST /market-chat — Tier 5c follow-up Q&A ──────────────────────
// Stateful: relies on the 24h MARKET_CACHE inside claudeMarketAnalyst.
// The front-end (renderMarketReport's embedded chat) submits city +
// state + question; we look up the cached analysis and pass it as
// context to a 1000-token Claude call.
app.post('/market-chat', async (req, res) => {
  const { city, state, question } = req.body || {};
  if (!city || !state || !question) {
    return res.status(400).json({ error: 'city, state, and question are required' });
  }
  if (!/^[A-Za-z]{2}$/.test(String(state).trim())) {
    return res.status(400).json({ error: 'State must be a 2-letter code' });
  }
  try {
    const result = await claudeMarketAnalyst.chatFollowUp(
      String(city).trim(),
      String(state).trim().toUpperCase(),
      String(question).trim()
    );
    res.json(result);
  } catch (err) {
    console.error('[market-chat] error:', err);
    res.status(500).json({ error: err.message || 'Chat failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`BizRadar listening on http://localhost:${PORT}`);
});

// BLS Business Employment Dynamics — survival rates for the 2013
// cohort tracked through 2023. Keyed by NAICS-2 (multi-prefix sectors
// use range form: 31-33, 44-45, 48-49). Source: BLS BED Table 7,
// "Survival of private-sector establishments by opening year." Used by
// the Industry survival outlook section in renderReport. No predecessor
// SBA_FAILURE_RATES table existed in this codebase to fall back from.
const BED2013 = {
  '11':    { y1: 0.749, y3: 0.557, y5: 0.443, y7: 0.368, y10: 0.291 },
  '21':    { y1: 0.752, y3: 0.548, y5: 0.402, y7: 0.321, y10: 0.228 },
  '22':    { y1: 0.814, y3: 0.672, y5: 0.566, y7: 0.489, y10: 0.399 },
  '23':    { y1: 0.764, y3: 0.630, y5: 0.539, y7: 0.461, y10: 0.367 },
  '31-33': { y1: 0.802, y3: 0.673, y5: 0.577, y7: 0.503, y10: 0.412 },
  '42':    { y1: 0.783, y3: 0.613, y5: 0.465, y7: 0.389, y10: 0.296 },
  '44-45': { y1: 0.798, y3: 0.673, y5: 0.583, y7: 0.510, y10: 0.421 },
  '48-49': { y1: 0.776, y3: 0.628, y5: 0.501, y7: 0.422, y10: 0.325 },
  '51':    { y1: 0.749, y3: 0.557, y5: 0.443, y7: 0.368, y10: 0.291 },
  '52':    { y1: 0.789, y3: 0.648, y5: 0.532, y7: 0.454, y10: 0.356 },
  '53':    { y1: 0.801, y3: 0.679, y5: 0.587, y7: 0.514, y10: 0.420 },
  '54':    { y1: 0.776, y3: 0.614, y5: 0.463, y7: 0.381, y10: 0.284 },
  '56':    { y1: 0.768, y3: 0.617, y5: 0.489, y7: 0.410, y10: 0.316 },
  '61':    { y1: 0.818, y3: 0.659, y5: 0.560, y7: 0.471, y10: 0.389 },
  '62':    { y1: 0.827, y3: 0.660, y5: 0.551, y7: 0.480, y10: 0.357 },
  '71':    { y1: 0.771, y3: 0.624, y5: 0.529, y7: 0.450, y10: 0.357 },
  '72':    { y1: 0.783, y3: 0.643, y5: 0.553, y7: 0.476, y10: 0.381 },
  '81':    { y1: 0.806, y3: 0.668, y5: 0.569, y7: 0.493, y10: 0.400 },
};

// Map a 6-digit NAICS to its 2-digit "sector" code. Most sectors are
// the literal first two digits, but NAICS uses three multi-prefix
// ranges (Manufacturing 31-33, Retail 44-45, Transportation 48-49).
// Returning the canonical range form lets the conditional sector
// fetchers (BLS, USDA, FMCSA, NPI, FMR, FDIC, CMS) match the user-spec
// keys exactly.
function naics2FromNaics6(naics6) {
  if (!naics6) return null;
  const p = String(naics6).slice(0, 2);
  if (p === '44' || p === '45') return '44-45';
  if (p === '48' || p === '49') return '48-49';
  if (p === '31' || p === '32' || p === '33') return '31-33';
  return p;
}

function computeStrengths(profile, data) {
  const b = profile.benchmarks || {};
  const out = [];
  if (typeof data.google_rating === 'number' && b.good_rating != null
      && data.google_rating > b.good_rating) {
    out.push(`rating ${data.google_rating} > ${b.good_rating}`);
  }
  if (typeof data.google_review_count === 'number' && b.good_review_count != null
      && data.google_review_count > b.good_review_count) {
    out.push(`${data.google_review_count} reviews > ${b.good_review_count}`);
  }
  if (typeof data.review_recency_days === 'number' && b.review_recency_target_days != null
      && data.review_recency_days < b.review_recency_target_days) {
    out.push(`recency ${data.review_recency_days}d < ${b.review_recency_target_days}d`);
  }
  if (typeof data.photo_count === 'number' && b.photo_count_good != null
      && data.photo_count > b.photo_count_good) {
    out.push(`${data.photo_count} photos > ${b.photo_count_good}`);
  }
  return out;
}

function overallStatus(strengths, ranked) {
  const measurableGaps = ranked.allTriggered.filter((t) => t.magnitudeFactor !== 0.5).length;
  if (measurableGaps === 0) return { label: 'HEALTHY', detail: `${strengths.length} of ${strengths.length} measured fields above benchmark` };
  if (measurableGaps <= 2) return { label: `GOOD with ${measurableGaps} gap${measurableGaps === 1 ? '' : 's'}`, detail: '' };
  return { label: 'NEEDS WORK', detail: `${measurableGaps} measurable gaps` };
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// PAGE_OPEN / PAGE_CLOSE — chrome shared by every render function
// (renderReport, renderMarketReport, renderError, renderUnsupported,
// renderWaitlist, renderBlocked). Two consumption paths:
//   1. Direct HTTP — full doc loads in browser
//   2. JS injection — landing page does `result.innerHTML = html`,
//      which strips doctype/html/body but keeps inner content +
//      <style> tag. Styles leak globally — that's fine because all
//      report classes are unique (.rec, .status, .impact, etc.) and
//      don't collide with the landing page's .lp-* / .result-* names.
//
// All colors mapped to the BizRadar brand tokens. Inter font from
// Google Fonts. Card chrome (white surface + subtle border + blue
// left-accent on .rec / emerald on .opportunity / navy on .mkt-card).
const PAGE_OPEN = `<!doctype html>
<html><head><meta charset="utf-8"><title>BizRadar report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --navy: #0F1729;
  --blue: #2563EB;
  --emerald: #10B981;
  --amber: #F59E0B;
  --bg: #F8FAFC;
  --surface: #FFFFFF;
  --surface-soft: #F1F5F9;
  --text: #1E293B;
  --muted: #64748B;
  --border: #E2E8F0;
  --danger: #DC2626;
  --danger-bg: #FEE2E2;
  --emerald-tint: #ECFDF5;
  --blue-tint: #EFF6FF;
  --amber-tint: #FEF3C7;
}
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; font-size: 14px; line-height: 1.6; color: var(--text); background: var(--surface); margin: 0; padding: 24px 16px; -webkit-font-smoothing: antialiased; }
@media (min-width: 720px) { body { max-width: 820px; margin: 16px auto; padding: 24px 8px; } }
h1 { font-size: 26px; font-weight: 700; color: var(--navy); margin: 0 0 6px 0; letter-spacing: -0.02em; line-height: 1.2; }
h2 { font-size: 18px; font-weight: 600; color: var(--navy); margin: 32px 0 12px; letter-spacing: -0.01em; padding: 0; border: 0; }
h3 { font-size: 15px; font-weight: 600; color: var(--navy); margin: 0 0 6px; }
p { margin: 0 0 10px; }
ul { padding-left: 20px; margin: 8px 0; }
ul li { margin: 4px 0; }
small { color: var(--muted); font-size: 12px; }
a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }
.meta { color: var(--muted); font-size: 13px; }
.cite { color: var(--muted); font-size: 13px; margin-top: 6px; }

/* ── Status pills (overall report status) ──────────────────────── */
.status { display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: 600; font-size: 13px; letter-spacing: 0.01em; }
.status.healthy { background: var(--emerald-tint); color: #065F46; }
.status.good    { background: var(--blue-tint);    color: #1E3A8A; }
.status.needs   { background: var(--amber-tint);   color: #92400E; }
.status.blocked { background: var(--danger-bg);    color: #991B1B; }

/* ── Priority action card (.rec) — blue left accent ─────────────── */
.rec { border: 1px solid var(--border); border-left: 4px solid var(--blue); padding: 16px 18px; margin: 12px 0; background: var(--surface); border-radius: 8px; }
.rec h3 { font-size: 15px; margin: 0 0 8px; }
.rec-high    { border-left-color: var(--emerald); }
.rec-medium  { border-left-color: var(--blue); }
.rec-low     { border-left-color: var(--amber); }
.rec-minimal { border-left-color: var(--muted); opacity: 0.85; }

/* ── Score / impact pills ──────────────────────────────────────── */
.impact { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 700; letter-spacing: 0.04em; vertical-align: middle; text-transform: uppercase; }
.impact-high    { background: var(--emerald); color: #FFFFFF; }
.impact-medium  { background: var(--blue);    color: #FFFFFF; }
.impact-low     { background: var(--amber);   color: #FFFFFF; }
.impact-minimal { background: var(--surface-soft); color: var(--muted); }

/* ── 3-layer rec rendering ─────────────────────────────────────── */
.layer { margin: 10px 0; }
.layer-label { display: inline-block; font-weight: 700; font-size: 10.5px; letter-spacing: 0.06em; color: var(--muted); padding: 2px 8px; background: var(--surface-soft); border: 1px solid var(--border); border-radius: 4px; margin-right: 6px; vertical-align: middle; text-transform: uppercase; }
.why-study { padding: 10px 14px; margin: 6px 0; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
.why-study p { margin: 4px 0; }
.honesty { padding: 8px 12px; margin: 6px 0; border-left: 3px solid var(--muted); background: var(--bg); font-size: 13px; border-radius: 4px; }
.honesty-verified              { border-left-color: var(--emerald); background: var(--emerald-tint); }
.honesty-reasonable-inference  { border-left-color: var(--blue);    background: var(--blue-tint); }
.honesty-customer-must-validate{ border-left-color: var(--amber);   background: var(--amber-tint); }
.hmark { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: var(--text); margin-right: 4px; }
.hmark-verified  { background: var(--emerald-tint); color: #065F46; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.hmark-inference { background: var(--blue-tint);    color: #1E3A8A; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.hmark-validate  { background: var(--amber-tint);   color: #92400E; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.tier3 { font-size: 11px; color: var(--amber); }

/* ── Misc tags / flags / money ─────────────────────────────────── */
.extra-tag { display: inline-block; font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 4px; vertical-align: middle; margin-left: 4px; letter-spacing: 0.02em; text-transform: uppercase; }
.extra-tag-hidden { background: var(--danger); color: #FFFFFF; }
.extra-tag-known  { background: var(--muted);  color: #FFFFFF; }
.money { padding: 12px 14px; margin: 10px 0; background: var(--emerald-tint); border-left: 3px solid var(--emerald); border-radius: 6px; font-size: 13px; }
.money-skip { color: var(--muted); font-size: 13px; }
.flag { padding: 10px 14px; margin: 8px 0; border-left: 3px solid var(--amber); background: var(--amber-tint); border-radius: 6px; }
.flag.critical { border-left-color: var(--danger); background: var(--danger-bg); color: #991B1B; }
.ai-badge { display: inline-block; background: var(--navy); color: #FFFFFF; font-size: 10.5px; font-weight: 700; padding: 2px 6px; border-radius: 4px; letter-spacing: 0.04em; vertical-align: middle; margin-left: 4px; }
.ai-fallback-note { color: var(--muted); margin: 6px 0; }
.classification-reason { font-size: 12px; margin-top: -2px; color: var(--muted); }

/* ── Common problems / coverage / callout ──────────────────────── */
.problem { padding: 14px 16px; margin: 10px 0; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.problem h3 { font-size: 15px; margin: 0 0 6px; }
.coverage { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
.coverage td { padding: 10px 12px; vertical-align: top; border-bottom: 1px solid var(--border); }
.coverage td:first-child { width: 38%; color: var(--muted); }
.coverage tr:last-child td { border-bottom: 0; }
.callout { padding: 14px 16px; margin: 14px 0; border: 1px solid var(--border); background: var(--blue-tint); border-radius: 8px; border-left: 4px solid var(--blue); }
.callout-label { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--blue); margin-bottom: 6px; text-transform: uppercase; }
.callout p { margin: 0; line-height: 1.55; }

/* ── Opportunity card (/classify) — emerald left accent ────────── */
.opportunity { padding: 16px 18px; margin: 12px 0; background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--emerald); border-radius: 8px; }
.opportunity h3 { margin: 4px 0 6px; font-size: 15px; }
.op-meta { display: flex; gap: 6px; margin-bottom: 4px; align-items: center; flex-wrap: wrap; }
.op-category { display: inline-block; background: var(--navy); color: #FFFFFF; font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 4px; letter-spacing: 0.04em; text-transform: uppercase; }
.op-novelty { display: inline-block; font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 4px; letter-spacing: 0.04em; text-transform: uppercase; }
.novelty-unique { background: var(--emerald); color: #FFFFFF; }
.novelty-rare   { background: var(--amber);   color: #FFFFFF; }
.novelty-common { background: var(--muted);   color: #FFFFFF; }

/* ── Market analysis card (/market-analysis) — navy left accent ── */
.mkt-card { padding: 18px 20px; margin: 14px 0; background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--navy); border-radius: 8px; }
.mkt-card h3 { font-size: 18px; font-weight: 700; color: var(--navy); margin: 0 0 4px; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mkt-rank { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--navy); color: #FFFFFF; font-size: 13px; font-weight: 700; flex-shrink: 0; }
.mkt-card .impact { font-size: 12px; padding: 3px 10px; }

/* The "← new search" link inside report content. The landing page
   wraps the report in its own .result-back top-level button, but
   direct-HTTP fetches still see this link. */
.back { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 16px; color: var(--muted); font-size: 13px; font-weight: 500; }
.back:hover { color: var(--blue); }
</style></head><body>`;
const PAGE_CLOSE = `</body></html>`;

function renderError(message) {
  return `${PAGE_OPEN}<a class="back" href="/">&larr; new search</a>
<h1>BizRadar</h1>
<div class="status blocked">Error</div>
<p>${escapeHtml(message)}</p>${PAGE_CLOSE}`;
}

/* OOS demand logging — every out-of-scope hit appended to oos_log.jsonl
   so we can prioritize sub-profile work based on what users actually type.
   appendFileSync flushes synchronously; failures fall back to console.error
   so a bad disk doesn't break the request. */
function logOosHit(input, layer0Result, oosVariant) {
  const entry = {
    ts: new Date().toISOString(),
    input,
    naics6: layer0Result.naics6,
    oos_variant: oosVariant,
    layer0_mode: layer0Result.mode,
  };
  try {
    fs.appendFileSync(
      path.join(__dirname, 'oos_log.jsonl'),
      JSON.stringify(entry) + '\n'
    );
  } catch (err) {
    console.error('OOS log write failed:', err.message);
  }
}

function renderWaitlist(input, layer0Result, profileId) {
  let heading, reason, waitlistFooter;
  switch (profileId) {
    case 'OUT_OF_SCOPE_REGULATED':
      heading = 'Regulated sector — waitlist';
      reason = 'This sector has industry-specific licensing or regulatory dynamics (e.g., DEA, state pharmacy/optical boards) that need a dedicated profile rather than the generalized retail/personal-care baseline.';
      waitlistFooter = 'Sub-profiles for this sector are on the roadmap. Add yourself to the waitlist (signup form coming in a later phase).';
      break;
    case 'OUT_OF_SCOPE_NICHE':
      heading = 'Niche sector — waitlist';
      reason = "This sector is a niche operation whose dynamics don't fit our generalized profiles. A future sub-profile will address it.";
      waitlistFooter = 'Sub-profiles for this sector are on the roadmap. Add yourself to the waitlist (signup form coming in a later phase).';
      break;
    case 'OUT_OF_SCOPE_55':
      heading = 'Out of scope — corporate / holding';
      reason = "BizRadar serves consumer-facing local businesses. Holding companies, regional managing offices, and corporate HQs don't fit that pattern.";
      waitlistFooter = 'No waitlist for this sector — BizRadar is intentionally not designed to serve this category.';
      break;
    case 'OUT_OF_SCOPE_92':
      heading = 'Out of scope — public administration';
      reason = 'BizRadar serves private-sector consumer-facing businesses. Government agencies have different operational frameworks.';
      waitlistFooter = 'No waitlist for this sector — BizRadar is intentionally not designed to serve this category.';
      break;
    default:
      heading = 'Out of scope';
      reason = 'This sector is currently outside BizRadar\'s scope.';
      waitlistFooter = 'See the BizRadar roadmap for sectors planned in later phases.';
  }
  return `${PAGE_OPEN}<a class="back" href="/">&larr; new search</a>
<h1>BizRadar — ${escapeHtml(heading)}</h1>
<div class="status blocked">${escapeHtml(profileId)}</div>
<p>${escapeHtml(reason)}</p>
<p class="meta">Your input "${escapeHtml(input)}" classified to NAICS ${escapeHtml(layer0Result.naics6)}.</p>
<p>${escapeHtml(waitlistFooter)}</p>${PAGE_CLOSE}`;
}

function renderUnsupported(input, layer0Result) {
  return `${PAGE_OPEN}<a class="back" href="/">&larr; new search</a>
<h1>BizRadar — phase 1</h1>
<p>This phase only supports hotels and motels. Try something like
<strong>"the edgewater hotel madison wi"</strong>.</p>
<p class="meta">Your input "${escapeHtml(input)}" was classified as
mode <code>${escapeHtml(layer0Result.mode)}</code>${
    layer0Result.naics6 ? ` (NAICS ${escapeHtml(layer0Result.naics6)})` : ''
  }.</p>${PAGE_CLOSE}`;
}

function renderBlocked(profile, layer0Result, data, blockingFlag) {
  return `${PAGE_OPEN}<a class="back" href="/">&larr; new search</a>
<h1>${escapeHtml(data.name || 'Business')}</h1>
<div class="status blocked">REPORT BLOCKED</div>
<div class="flag critical">${escapeHtml(blockingFlag.message)}</div>
<p class="meta">${escapeHtml(profile.name)} — NAICS ${escapeHtml(layer0Result.naics6)}</p>${PAGE_CLOSE}`;
}

// Render the Market Analysis (Mode 2) report. Takes an options object
// — { city, state, top5, analysis, census, age_profile, weather,
// permits, walk_score, county_density } — produced by the route
// pipeline. Re-uses the standard PAGE_OPEN chrome + back link so the
// page is visually consistent with renderReport / renderError.
function renderMarketReport(result) {
  // Tier 5 output renderer for the new 5-tier pipeline. Receives the
  // result object from claudeMarketAnalyst.analyzeCity() with shape:
  //   { city, state, location, top10[], deep_dive{}, raw{}, _agents{} }
  // Renders 5 sections: Header → Snapshot → Top 10 → Deep Dive → Chat.

  const r = result || {};
  const city = r.city || '';
  const state = r.state || '';
  const top10 = Array.isArray(r.top10) ? r.top10 : [];
  const dive = r.deep_dive || null;
  const raw = r.raw || {};
  const verifications = Array.isArray(r._quote_verification) ? r._quote_verification : [];

  const safeCity = escapeHtml(city);
  const safeState = escapeHtml(String(state || '').toUpperCase());

  // ── Quote-provenance helpers ───────────────────────────────────────
  // Look up a quote in the verification array by exact evidence string.
  // The verifier stores `quote: a.evidence` so a strict equality match
  // is reliable. Returns one of: 'verified' | 'fabricated' | 'unverified'.
  function quoteStatus(evidenceText) {
    if (!evidenceText || !verifications.length) return { tier: 'unverified' };
    const v = verifications.find((x) => x && x.quote === evidenceText);
    if (!v) return { tier: 'unverified' };
    if (v.verified === true) return {
      tier: 'verified',
      author: v.matched_author || null,
      time: v.matched_time || null,
      business: v.matched_business || null,
    };
    if (v.verified === false) return { tier: 'fabricated', reason: v.reason || null };
    return { tier: 'unverified', reason: v.reason || null };
  }
  // Render the per-quote badge. Verified = green with author/time;
  // fabricated = red warning; unverified = muted neutral.
  function quoteBadge(evidenceText) {
    const s = quoteStatus(evidenceText);
    if (s.tier === 'verified') {
      const meta = [s.author, s.time].filter(Boolean).join(', ');
      const label = meta ? `&#10003; REAL REVIEW &mdash; ${escapeHtml(meta)}` : '&#10003; REAL REVIEW';
      return `<span class="hmark hmark-verified">${label}</span>`;
    }
    if (s.tier === 'fabricated') {
      return `<span class="hmark" style="background:var(--danger-bg);color:#991B1B;padding:2px 8px;border-radius:4px;font-size:11px">&#9888; NOT FOUND IN FETCHED REVIEWS</span>`;
    }
    return `<span class="hmark" style="background:var(--surface-soft);color:var(--muted);padding:2px 8px;border-radius:4px;font-size:11px">REVIEW &mdash; unverified</span>`;
  }
  // Tier-driven wrapper class so the surrounding box colour matches
  // the badge (green for verified, red for fabricated, amber for the
  // ambiguous 'too short to verify' case).
  function quoteHonestyClass(evidenceText) {
    const s = quoteStatus(evidenceText);
    if (s.tier === 'verified') return 'honesty honesty-verified';
    if (s.tier === 'fabricated') return 'honesty';   // wrapper neutral; red is in the badge
    return 'honesty honesty-customer-must-validate';
  }

  // ─────────────────────────────────────────────────────────────────
  // SECTION 1 — HEADER
  // ─────────────────────────────────────────────────────────────────
  let healthBadge = '';
  let gradeBadge = '';
  if (dive && typeof dive.health_score === 'number') {
    const sc = dive.health_score;
    const tier = sc >= 70 ? 'high' : sc >= 40 ? 'medium' : 'low';
    healthBadge = `<span class="impact impact-${tier}" style="margin-left:8px">${sc}/100${dive.health_label ? ' · ' + escapeHtml(dive.health_label) : ''}</span>`;
  }
  if (dive && dive.market_grade) {
    gradeBadge = `<span class="impact impact-medium" style="margin-left:6px">Grade ${escapeHtml(dive.market_grade)}</span>`;
  }
  const execSummary = dive && dive.executive_summary
    ? `<div class="callout">
<div class="callout-label">Top opportunity for ${safeCity}, ${safeState}</div>
<p>${escapeHtml(dive.executive_summary)}</p>
</div>`
    : '';
  const sources = dive && Array.isArray(dive.data_sources_used) && dive.data_sources_used.length
    ? dive.data_sources_used
    : ['Google Places', 'US Census', 'BLS BED2013', 'HUD FMR', 'Open-Meteo', 'Wikipedia', 'Ticketmaster', 'Claude AI'];
  const sourcesHtml = `<p class="meta">Powered by: ${sources.map((s) => escapeHtml(s)).join(' · ')}</p>`;

  const headerHtml = `<a class="back" href="/">&larr; Start over</a>
<h1>Market Intelligence — ${safeCity}, ${safeState}${healthBadge}${gradeBadge}</h1>
${sourcesHtml}
${execSummary}`;

  // ─────────────────────────────────────────────────────────────────
  // SECTION 2 — MARKET SNAPSHOT (6 cards)
  // ─────────────────────────────────────────────────────────────────
  const fmtNum = (v) => (typeof v === 'number') ? v.toLocaleString('en-US') : 'N/A';
  const fmtUsd = (v) => (typeof v === 'number') ? '$' + v.toLocaleString('en-US') : 'N/A';
  const snapshotRows = [
    ['Population', fmtNum(raw.population)],
    ['Median income', fmtUsd(raw.median_income)],
    ['Age profile', escapeHtml(raw.age_profile || 'N/A')],
    ['Peak season', escapeHtml(raw.peak_month || 'N/A')],
    ['Permits YoY', (typeof raw.permits_yoy === 'number') ? `${raw.permits_yoy}% (${raw.growth_signal || 'stable'})` : 'N/A'],
    ['2BR FMR', raw.fmr_2br ? `$${raw.fmr_2br}/mo${raw.fmr_metro ? ' · ' + escapeHtml(raw.fmr_metro) : ''}` : 'N/A'],
  ];
  const snapshotHtml = `<h2>Market snapshot</h2>
<table class="coverage">${snapshotRows.map(
    ([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${v}</td></tr>`
  ).join('')}</table>`;

  // ─────────────────────────────────────────────────────────────────
  // SECTION 3 — TOP 10 BUSINESS IDEAS
  // Each card: rank badge + business type + score breakdown bars
  // (gap/feasibility/growth) + competitor count + novelty + cost +
  // 5-year survival + why_this_city paragraph.
  // ─────────────────────────────────────────────────────────────────
  const renderScoreBar = (label, val, color) => {
    const pct = Math.round((val || 0) * 100);
    return `<div style="margin:4px 0">
<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:2px"><span>${escapeHtml(label)}</span><span><strong style="color:var(--text)">${pct}%</strong></span></div>
<div style="background:var(--surface-soft);border-radius:4px;height:6px;overflow:hidden"><div style="background:${color};width:${pct}%;height:100%"></div></div>
</div>`;
  };
  // ── Tiered insight matchers (by rank, not array index, so a re-sort
  // upstream doesn't misalign cards). tier2_insights covers ranks 2-5;
  // tier3_insights covers ranks 6-10. If Claude returned the old format
  // these arrays will be empty and the per-card render gracefully omits
  // the extra block.
  const tier2Insights = (dive && Array.isArray(dive.tier2_insights)) ? dive.tier2_insights : [];
  const tier3Insights = (dive && Array.isArray(dive.tier3_insights)) ? dive.tier3_insights : [];
  function findTierInsight(rank, arr) {
    if (!Array.isArray(arr)) return null;
    return arr.find((t) => t && t.rank === rank) || null;
  }
  function styleTags(text) {
    return String(text || '')
      .replace(/\[VERIFIED\]/g, '<span class="hmark hmark-verified">[VERIFIED]</span>')
      .replace(/\[CUSTOMER MUST VALIDATE\]/g, '<span class="hmark hmark-validate">[CUSTOMER MUST VALIDATE]</span>')
      .replace(/\[REASONABLE INFERENCE\]/g, '<span class="hmark hmark-inference">[REASONABLE INFERENCE]</span>')
      .replace(/\[INDUSTRY BENCHMARK[^\]]*\]/g, '<span class="hmark hmark-inference">$&</span>')
      .replace(/\[SOURCE: [^\]]+\]/g, '<span class="hmark hmark-inference">$&</span>');
  }

  const top10Html = top10.length
    ? top10.map((s, i) => {
        const rank = s.rank || (i + 1);
        const finalPct = Math.round((s.final_score || 0) * 100);
        const tier = i === 0 ? 'high' : (i <= 2 ? 'medium' : 'low');
        const noveltyTier = s.novelty_score >= 8 ? 'novelty-unique'
                          : s.novelty_score >= 5 ? 'novelty-rare'
                                                  : 'novelty-common';
        const compText = s.competitor_count == null
          ? 'Places lookup unavailable'
          : (s.competitor_count === 0
              ? '<strong>ZERO competitors</strong> in this market'
              : `${s.competitor_count} ${s.competitor_count === 1 ? 'competitor' : 'competitors'} nearby`);
        const competitorList = (s.top_competitors || []).slice(0, 3)
          .map((c) => escapeHtml(c.name || ''))
          .filter(Boolean)
          .join(', ');
        const styledWhy = styleTags(s.why_this_city || '');

        const breakdown = s.score_breakdown || {};
        const bars = `
${renderScoreBar('Gap (40%)', breakdown.gap_score, 'var(--emerald)')}
${renderScoreBar('Feasibility (35%)', breakdown.feasibility_score, 'var(--blue)')}
${renderScoreBar('Growth (25%)', breakdown.growth_score, 'var(--amber)')}`;

        // ── Tier 1 winner card — gold border + scroll-link to deep dive
        const isWinner = rank === 1;
        const winnerStyle = isWinner
          ? ' style="border-left:6px solid var(--amber);box-shadow:0 0 0 2px var(--amber-tint)"'
          : '';
        const winnerLink = isWinner
          ? `<p style="margin:14px 0 0"><a href="#deep-dive-anchor" style="display:inline-block;padding:8px 16px;background:var(--amber);color:#fff;border-radius:6px;font-weight:600;text-decoration:none">&darr; Full deep dive below</a></p>`
          : '';

        // ── Tier 2 (ranks 2-5) — medium-depth block
        let tier2Block = '';
        if (rank >= 2 && rank <= 5) {
          const t2 = findTierInsight(rank, tier2Insights);
          if (t2) {
            const actions = Array.isArray(t2.top_3_actions) ? t2.top_3_actions : [];
            const steps = Array.isArray(t2.startup_steps) ? t2.startup_steps : [];
            tier2Block = `<div style="margin-top:14px;padding:12px 14px;background:var(--surface-soft);border-radius:6px">
${t2.why_now ? `<p style="margin:0 0 10px"><strong>Why now in ${safeCity}:</strong> ${styleTags(t2.why_now)}</p>` : ''}
${actions.length ? `<p style="margin:0 0 4px"><strong>First 3 actions:</strong></p>
<ol style="margin:0 0 10px;padding-left:22px">
${actions.slice(0, 3).map((a) => `<li>${escapeHtml(a.action || '—')} <span class="meta">— ${escapeHtml(a.cost || '$?')} · ${escapeHtml(a.timeline || 'TBD')}</span></li>`).join('')}
</ol>` : ''}
${steps.length ? `<p style="margin:0 0 4px"><strong>Startup steps:</strong></p>
<ol style="margin:0 0 10px;padding-left:22px">
${steps.slice(0, 3).map((step) => `<li>${escapeHtml(String(step))}</li>`).join('')}
</ol>` : ''}
${t2.key_risk ? `<p style="margin:0;color:var(--danger)"><strong>Key risk:</strong> ${styleTags(t2.key_risk)}</p>` : ''}
</div>`;
          }
        }

        // ── Tier 3 (ranks 6-10) — light block, muted
        let tier3Block = '';
        if (rank >= 6 && rank <= 10) {
          const t3 = findTierInsight(rank, tier3Insights);
          if (t3) {
            tier3Block = `<div style="margin-top:14px;padding:10px 12px;background:var(--surface-soft);border-radius:6px;font-size:13px">
${t3.why_now ? `<p style="margin:0 0 6px;color:var(--text)">${styleTags(t3.why_now)}</p>` : ''}
${t3.key_risk ? `<p style="margin:0;color:var(--muted)"><strong>Risk:</strong> ${styleTags(t3.key_risk)}</p>` : ''}
</div>`;
          }
        }

        return `<div class="mkt-card"${winnerStyle}>
<h3><span class="mkt-rank">${rank}</span> ${escapeHtml(s.business_type || 'Opportunity')} <span class="impact impact-${tier}">${finalPct}%</span> <span class="op-novelty ${noveltyTier}">novelty ${s.novelty_score || '?'}/10</span></h3>
${styledWhy ? `<p>${styledWhy}</p>` : ''}
<table class="coverage" style="margin-top:8px">
<tr><td>Competition</td><td>${compText}${competitorList ? ' <span class="meta">(' + competitorList + ')</span>' : ''}</td></tr>
<tr><td>Startup cost</td><td><strong>${escapeHtml(s.startup_cost_range || '—')}</strong></td></tr>
<tr><td>5-year survival</td><td><strong>${escapeHtml(s.survival_y5 || '—')}</strong>${s.naics2 ? ` <span class="meta">(NAICS ${escapeHtml(s.naics2)})</span>` : ''}</td></tr>
</table>
<div style="margin-top:10px">${bars}</div>
${tier2Block}
${tier3Block}
${winnerLink}
</div>`;
      }).join('')
    : '<p>No opportunities scored.</p>';

  const top10Section = `<h2>Top 10 business ideas</h2>
<p class="meta">Ranked by composite score: gap × 0.40 + feasibility × 0.35 + growth × 0.25.</p>
${top10Html}`;

  // ─────────────────────────────────────────────────────────────────
  // SECTION 4 — DEEP DIVE on #1
  // Pulls the merged Call-A + Call-B fields from analyzeCity's
  // generateDeepDive(). Each subsection renders only when present.
  // ─────────────────────────────────────────────────────────────────
  let deepDiveHtml = '';
  if (dive) {
    const top1Type = (top10[0] && top10[0].business_type) || 'top-ranked business';

    // SBA risk
    let sbaRiskHtml = '';
    if (dive.sba_risk) {
      const sr = dive.sba_risk;
      const riskTier = (sr.risk_level || '').toLowerCase() === 'low' ? 'high'
                     : (sr.risk_level || '').toLowerCase() === 'high' ? 'low'
                     : 'medium';
      sbaRiskHtml = `<h3>Sector survival outlook</h3>
<div class="rec rec-${riskTier}">
<h3>${escapeHtml(sr.best_sector || 'Top sector')} <span class="impact impact-${riskTier}">${escapeHtml(sr.risk_level || '—')} RISK</span></h3>
<table class="coverage">
  <tr><td>1-year survival</td><td><strong>${escapeHtml(sr.year1_survival || '—')}</strong></td></tr>
  <tr><td>3-year survival</td><td><strong>${escapeHtml(sr.year3_survival || '—')}</strong></td></tr>
  <tr><td>5-year survival</td><td><strong>${escapeHtml(sr.year5_survival || '—')}</strong></td></tr>
  <tr><td>10-year survival</td><td><strong>${escapeHtml(sr.year10_survival || '—')}</strong></td></tr>
</table>
${sr.context ? `<p>${escapeHtml(sr.context)}</p>` : ''}
<p class="meta"><small>Source: BLS Business Employment Dynamics, 2013 cohort tracked through 2023</small></p>
</div>`;
    }

    // Top opportunities (specific named launches for #1)
    let topOppsHtml = '';
    if (Array.isArray(dive.top_opportunities) && dive.top_opportunities.length) {
      topOppsHtml = `<h3>Top tactical opportunities</h3>
<p class="meta">Specific launches with named local sources.</p>` +
        dive.top_opportunities.map((o, i) => `
<div class="opportunity">
<div class="op-meta">
<span class="op-category">#${o.rank || (i + 1)}</span>
${typeof o.novelty_score === 'number' ? `<span class="op-novelty ${o.novelty_score >= 8 ? 'novelty-unique' : o.novelty_score >= 5 ? 'novelty-rare' : 'novelty-common'}">novelty ${o.novelty_score}/10</span>` : ''}
${typeof o.final_rank === 'number' ? `<span class="op-novelty novelty-common">rank ${o.final_rank}</span>` : ''}
</div>
<h3>${escapeHtml(o.title || 'Opportunity')}</h3>
${o.business_type ? `<p class="meta">${escapeHtml(o.business_type)}</p>` : ''}
${o.what_to_build ? `<p><strong>What to build:</strong> ${escapeHtml(o.what_to_build)}</p>` : ''}
${o.local_source ? `<p><strong>Local source:</strong> ${escapeHtml(o.local_source)}</p>` : ''}
${o.how_to_start ? `<p><strong>How to start:</strong> ${escapeHtml(o.how_to_start)}</p>` : ''}
<p class="meta">${o.cost_to_open ? 'Cost: <strong>' + escapeHtml(o.cost_to_open) + '</strong>' : ''}${o.monthly_revenue_est ? (o.cost_to_open ? ' · ' : '') + 'Revenue: <strong>' + escapeHtml(o.monthly_revenue_est) + '</strong>' : ''}</p>
${o.bed2013_risk ? `<p class="meta">Risk: ${escapeHtml(o.bed2013_risk)}</p>` : ''}
</div>`).join('');
    }

    // Quick wins
    let quickWinsHtml = '';
    if (Array.isArray(dive.quick_wins) && dive.quick_wins.length) {
      quickWinsHtml = `<h3>Quick wins — do these this week</h3>` + dive.quick_wins.map((q) => `
<div class="rec rec-medium">
<h3>${escapeHtml(q.action || 'Action')} <span class="impact impact-medium">${escapeHtml(q.timeline || 'Today')}</span></h3>
${q.why ? `<p>${escapeHtml(q.why)}</p>` : ''}
<p class="meta">Cost: <strong>${escapeHtml(q.cost || '$0')}</strong>${q.expected_result ? ` · Expected: ${escapeHtml(q.expected_result)}` : ''}</p>
</div>`).join('');
    }

    // Steal strategy
    let stealHtml = '';
    if (Array.isArray(dive.steal_strategy) && dive.steal_strategy.length) {
      stealHtml = `<h3>Steal strategy <span class="ai-badge">AI</span></h3>
<p class="meta">What's working for local businesses — with the actual review evidence.</p>` +
        dive.steal_strategy.map((s) => {
          const actions = Array.isArray(s.actions_to_steal) ? s.actions_to_steal : [];
          return `<div class="rec rec-high">
<h3>${escapeHtml(s.business_name || 'Business')} <span class="impact impact-${(s.confidence || '').toLowerCase() === 'high' ? 'high' : 'medium'}">${escapeHtml(s.confidence || '—')}</span></h3>
<p class="meta">${s.tenure ? 'Tenure: ' + escapeHtml(s.tenure) + ' · ' : ''}Trust weight: ${typeof s.trust_weight === 'number' ? s.trust_weight.toFixed(2) : '—'}</p>
${s.what_they_do_well ? `<p><strong>What they do well:</strong> ${escapeHtml(s.what_they_do_well)}</p>` : ''}
<ol style="margin:8px 0 0;padding-left:24px">
${actions.map((a) => `<li style="margin:8px 0">
<strong>${escapeHtml(a.action || 'Action')}</strong>
${a.evidence ? `<div class="${quoteHonestyClass(a.evidence)}" style="margin:4px 0">${quoteBadge(a.evidence)} <em>${escapeHtml(a.evidence)}</em></div>` : ''}
${a.how_to_implement ? `<p style="margin:4px 0">How: ${escapeHtml(a.how_to_implement)}</p>` : ''}
${a.cost ? `<p class="meta" style="margin:2px 0">Cost: ${escapeHtml(a.cost)}</p>` : ''}
</li>`).join('')}
</ol>
</div>`;
        }).join('');
    }

    // Hidden gaps (high priority — local-specific)
    let hiddenGapsHtml = '';
    if (Array.isArray(dive.hidden_gaps) && dive.hidden_gaps.length) {
      hiddenGapsHtml = `<h3>Hidden gaps — high priority</h3>
<p class="meta">Problems unique to ${safeCity} — not universal.</p>` + dive.hidden_gaps.map((h) => `
<div class="flag critical">
<h3>${escapeHtml(h.title || 'Gap')}</h3>
${h.evidence ? `<p class="meta">${quoteBadge(h.evidence)} ${escapeHtml(h.evidence)}</p>` : ''}
${h.why_hidden ? `<p>${escapeHtml(h.why_hidden)}</p>` : ''}
${h.business_to_open ? `<p><strong>Business to open:</strong> ${escapeHtml(h.business_to_open)}</p>` : ''}
<p class="meta">${h.timeline ? escapeHtml(h.timeline) + ' · ' : ''}Cost: ${escapeHtml(h.cost_to_open || '—')}</p>
</div>`).join('');
    }

    // Persona gap matrix
    let gapMatrixHtml = '';
    if (Array.isArray(dive.persona_gap_matrix) && dive.persona_gap_matrix.length) {
      gapMatrixHtml = `<h3>Persona gap matrix</h3>
<p class="meta">Customer segments mentioned in reviews but no business specifically targets.</p>
<table class="coverage">
<tr><td><strong>Segment</strong></td><td><strong>% of reviews</strong></td><td><strong>Serving them</strong></td><td><strong>Gap</strong></td><td><strong>Lost rev/mo</strong></td></tr>
${dive.persona_gap_matrix.map((g) => `<tr>
<td>${escapeHtml(g.segment || '—')}${g.confirmed ? ' <span class="hmark hmark-verified">CONFIRMED</span>' : ''}</td>
<td>${escapeHtml(g.review_mention_pct || '—')}</td>
<td>${typeof g.businesses_serving_them === 'number' ? g.businesses_serving_them : '—'}</td>
<td><strong>${typeof g.gap_points === 'number' ? g.gap_points + ' pts' : '—'}</strong></td>
<td>${escapeHtml(g.lost_revenue_est || '—')}</td>
</tr>`).join('')}
</table>` + dive.persona_gap_matrix.filter((g) => g.business_to_open || g.root_cause).map((g) => `
<div class="honesty honesty-reasonable-inference">
<p><strong>${escapeHtml(g.segment || '—')}:</strong> ${escapeHtml(g.root_cause || '')}</p>
${g.business_to_open ? `<p>→ <strong>Open:</strong> ${escapeHtml(g.business_to_open)}</p>` : ''}
</div>`).join('');
    }

    // Personas (4 cards)
    let personasHtml = '';
    if (Array.isArray(dive.personas) && dive.personas.length) {
      personasHtml = `<h3>Customer personas</h3>` + dive.personas.map((p) => `
<div class="rec rec-medium">
<h3>${escapeHtml(p.name || 'Persona')}</h3>
<p class="meta">${escapeHtml(p.profile || '—')}${p.gap_source ? ' · Gap source: ' + escapeHtml(p.gap_source) : ''}</p>
${p.review_source ? `<div class="${quoteHonestyClass(p.review_source)}" style="margin:6px 0">${quoteBadge(p.review_source)} ${escapeHtml(p.review_source)}</div>` : ''}
<table class="coverage">
${p.spend_trigger ? `<tr><td>Spend trigger</td><td>${escapeHtml(p.spend_trigger)}</td></tr>` : ''}
${p.five_star_trigger ? `<tr><td><span class="hmark hmark-verified">5-star trigger</span></td><td>${escapeHtml(p.five_star_trigger)}</td></tr>` : ''}
${p.word_of_mouth_trigger ? `<tr><td>Word-of-mouth</td><td>${escapeHtml(p.word_of_mouth_trigger)}</td></tr>` : ''}
${p.never_returns_if ? `<tr><td><span class="hmark" style="background:var(--danger-bg);color:#991B1B;padding:2px 8px;border-radius:4px">Never returns if</span></td><td>${escapeHtml(p.never_returns_if)}</td></tr>` : ''}
${p.searches ? `<tr><td>Searches</td><td><em>"${escapeHtml(p.searches)}"</em></td></tr>` : ''}
${p.ltv ? `<tr><td>LTV</td><td><strong>${escapeHtml(p.ltv)}</strong></td></tr>` : ''}
${p.reach_via ? `<tr><td>Reach via</td><td>${escapeHtml(p.reach_via)}</td></tr>` : ''}
</table>
</div>`).join('');
    }

    // Lost customer
    let lostCustomerHtml = '';
    if (dive.lost_customer && (dive.lost_customer.name || dive.lost_customer.fix)) {
      const lc = dive.lost_customer;
      lostCustomerHtml = `<h3>Who's driving past ${safeCity} right now</h3>
<div class="callout">
<div class="callout-label">${escapeHtml(lc.name || 'Customer')}</div>
${lc.profile ? `<p>${escapeHtml(lc.profile)}</p>` : ''}
${lc.gap_proof ? `<p class="meta"><span class="hmark hmark-verified">[GAP PROOF]</span> ${escapeHtml(lc.gap_proof)}</p>` : ''}
${lc.drives_to ? `<p class="meta">Drives to: <strong>${escapeHtml(lc.drives_to)}</strong></p>` : ''}
${lc.lost_revenue ? `<p class="meta">Lost revenue: <strong>${escapeHtml(lc.lost_revenue)}</strong></p>` : ''}
${lc.root_cause ? `<p><strong>Root cause:</strong> ${escapeHtml(lc.root_cause)}</p>` : ''}
${lc.fix ? `<p>→ <strong>Fix:</strong> ${escapeHtml(lc.fix)}</p>` : ''}
</div>`;
    }

    // Seasonal strategy (4 seasons)
    let seasonalHtml = '';
    if (dive.seasonal_strategy && typeof dive.seasonal_strategy === 'object') {
      const seasons = ['summer', 'fall', 'winter', 'spring'];
      const seasonCards = seasons
        .map((season) => dive.seasonal_strategy[season] && [season, dive.seasonal_strategy[season]])
        .filter(Boolean);
      if (seasonCards.length) {
        seasonalHtml = `<h3>Seasonal strategy</h3>` + seasonCards.map(([season, s]) => {
          const isZeroComp = s.opportunity_window && /zero competition/i.test(s.opportunity_window);
          const zeroBadge = isZeroComp ? ` <span class="impact impact-high">ZERO COMPETITION WINDOW</span>` : '';
          return `<div class="rec rec-medium">
<h3>${season.charAt(0).toUpperCase() + season.slice(1)}${s.dominant_persona ? ` <span class="meta">— ${escapeHtml(s.dominant_persona)}</span>` : ''}${zeroBadge}</h3>
${s.best_business_to_open ? `<p><strong>Business to open:</strong> ${escapeHtml(s.best_business_to_open)}</p>` : ''}
${s.marketing_message ? `<p><strong>Headline:</strong> "${escapeHtml(s.marketing_message)}"</p>` : ''}
${s.event_tie_in ? `<p><strong>Event tie-in:</strong> ${escapeHtml(s.event_tie_in)}</p>` : ''}
${s.local_partner ? `<p><strong>Local partner:</strong> ${escapeHtml(s.local_partner)}</p>` : ''}
${s.revenue_range ? `<p class="meta">Revenue: <strong>${escapeHtml(s.revenue_range)}</strong></p>` : ''}
${s.off_season_survival ? `<div class="honesty honesty-customer-must-validate"><p><strong>Off-season survival:</strong> ${escapeHtml(s.off_season_survival)}</p></div>` : ''}
</div>`;
        }).join('');
      }
    }

    // Hyper-local
    let hyperLocalHtml = '';
    if (dive.hyper_local && typeof dive.hyper_local === 'object') {
      const hl = dive.hyper_local;
      const renderArr = (arr, fmt) => Array.isArray(arr) && arr.length
        ? `<ul>${arr.map(fmt).join('')}</ul>`
        : '';
      // Producers may be strings or objects depending on Claude's output.
      const fmtProducer = (p) => typeof p === 'string'
        ? `<li>${escapeHtml(p)}</li>`
        : `<li><strong>${escapeHtml(p.name || '—')}</strong>${p.city ? ' (' + escapeHtml(p.city) + ')' : ''}${typeof p.distance_miles === 'number' ? ` — ${p.distance_miles} mi` : ''}: ${escapeHtml(p.product || '—')}${p.price ? ' · ' + escapeHtml(p.price) : ''}</li>`;
      const fmtAttract = (a) => typeof a === 'string'
        ? `<li>${escapeHtml(a)}</li>`
        : `<li><strong>${escapeHtml(a.name || '—')}</strong>${typeof a.distance_miles === 'number' ? ` — ${a.distance_miles} mi` : ''}${a.annual_visitors ? ': ' + escapeHtml(a.annual_visitors) : ''}</li>`;
      const fmtEvent = (e) => typeof e === 'string'
        ? `<li>${escapeHtml(e)}</li>`
        : `<li><strong>${escapeHtml(e.name || '—')}</strong>${e.timing ? ' (' + escapeHtml(e.timing) + ')' : ''}${e.attendance ? ': ' + escapeHtml(e.attendance) : ''}</li>`;
      const fmtPartner = (p) => typeof p === 'string'
        ? `<li>${escapeHtml(p)}</li>`
        : `<li><strong>${escapeHtml(p.name || '—')}</strong>${typeof p.rating === 'number' ? ` ${p.rating}★` : ''}${typeof p.distance_miles === 'number' ? ` · ${p.distance_miles} mi` : ''}: ${escapeHtml(p.angle || '—')}</li>`;
      const producersHtml = renderArr(hl.named_producers, fmtProducer);
      const attractionsHtml = renderArr(hl.named_attractions, fmtAttract);
      const eventsHtml = renderArr(hl.named_events, fmtEvent);
      const partnersHtml = renderArr(hl.partnership_targets, fmtPartner);

      if (hl.state_identity || hl.city_identity || producersHtml || attractionsHtml || eventsHtml || partnersHtml) {
        hyperLocalHtml = `<h3>Hyper-local intelligence</h3>
${hl.city_identity ? `<p><strong>${safeCity}:</strong> ${escapeHtml(hl.city_identity)}</p>` : ''}
${hl.state_identity ? `<p><strong>${safeState}:</strong> ${escapeHtml(hl.state_identity)}</p>` : ''}
${producersHtml ? `<h3 style="margin-top:1em;font-size:14px">Named producers (within 60 mi)</h3>${producersHtml}` : ''}
${attractionsHtml ? `<h3 style="margin-top:1em;font-size:14px">Named attractions</h3>${attractionsHtml}` : ''}
${eventsHtml ? `<h3 style="margin-top:1em;font-size:14px">Named events</h3>${eventsHtml}` : ''}
${partnersHtml ? `<h3 style="margin-top:1em;font-size:14px">Partnership targets</h3>${partnersHtml}` : ''}`;
      }
    }

    // Known gaps (bottom — universal)
    let knownGapsHtml = '';
    if (Array.isArray(dive.known_gaps) && dive.known_gaps.length) {
      knownGapsHtml = `<h3 style="opacity:0.7">Known gaps — universal complaints</h3>
<p class="meta">Common across most markets; address but don't lead.</p>
<ul style="opacity:0.85">${dive.known_gaps.map((k) =>
        `<li><strong>${escapeHtml(k.title || '—')}:</strong> ${escapeHtml(k.one_line_opportunity || '—')}</li>`
      ).join('')}</ul>`;
    }

    // Confidence footer
    let confidenceHtml = '';
    if (dive.confidence) {
      const c = dive.confidence;
      const tier = (c.level || '').toLowerCase() === 'high' ? 'high'
                 : (c.level || '').toLowerCase() === 'low' ? 'low'
                 : 'medium';
      confidenceHtml = `<p class="meta"><span class="impact impact-${tier}">${escapeHtml(c.level || '—')} CONFIDENCE</span>${typeof c.score === 'number' ? ` · score ${c.score.toFixed(2)}` : ''}${typeof c.sources_confirmed === 'number' ? ` · ${c.sources_confirmed} sources` : ''}${c.note ? ' · ' + escapeHtml(c.note) : ''}</p>`;
    }

    const legendBox = `<div class="rec rec-minimal" style="background:var(--surface-soft);font-size:13px;margin:12px 0">
<h3 style="font-size:13px;color:var(--muted);margin-bottom:8px">About this analysis</h3>
<p style="margin:4px 0"><span class="hmark hmark-verified">[VERIFIED]</span> &mdash; confirmed from live Google Places, U.S. Census, BLS, HUD, Open-Meteo, or Wikipedia data.</p>
<p style="margin:4px 0"><span class="hmark hmark-validate">[CUSTOMER MUST VALIDATE]</span> &mdash; our best intelligence; verify before acting.</p>
<p style="margin:4px 0"><span class="hmark hmark-verified">&#10003; REAL REVIEW</span> &mdash; quote substring-matched against the live Google Place Details review text we fetched for this city.</p>
<p style="margin:4px 0"><span class="hmark" style="background:var(--danger-bg);color:#991B1B;padding:2px 8px;border-radius:4px;font-size:11px">&#9888; NOT FOUND IN FETCHED REVIEWS</span> &mdash; quote could not be matched to any fetched review; treat as unverified.</p>
<p class="meta" style="margin:8px 0 0">Persona names are illustrative (fictional). Review quotes are verified live; failed verifications are flagged.</p>
</div>`;
    // ── Verification summary line — appended at the end of the deep dive
    const verifTotal = verifications.length;
    const verifPassed = verifications.filter((v) => v && v.verified === true).length;
    const verifFailed = verifications.filter((v) => v && v.verified === false).length;
    const verifSkipped = verifications.filter((v) => v && v.verified === null).length;
    const verifSummary = verifTotal > 0
      ? `<p class="meta" style="margin-top:18px;padding:10px 12px;background:var(--surface-soft);border-radius:6px"><strong>${verifPassed} of ${verifTotal}</strong> review quotes verified against live Google data.${verifFailed > 0 ? ` <span style="color:var(--danger);font-weight:600">${verifFailed} could not be verified.</span>` : ''}${verifSkipped > 0 ? ` <span class="meta">${verifSkipped} were too short to verify.</span>` : ''}</p>`
      : '';
    deepDiveHtml = `<h2 id="deep-dive-anchor">Deep dive — #1: ${escapeHtml(top1Type)}</h2>
${legendBox}
${sbaRiskHtml}
${topOppsHtml}
${quickWinsHtml}
${stealHtml}
${hiddenGapsHtml}
${gapMatrixHtml}
${personasHtml}
${lostCustomerHtml}
${seasonalHtml}
${hyperLocalHtml}
${knownGapsHtml}
${confidenceHtml}
${verifSummary}`;
  } else {
    deepDiveHtml = `<h2>Deep dive</h2>
<p class="ai-fallback-note">Deep dive analysis unavailable — Claude AI did not return a usable response. Top 10 ranking is still based on real data.</p>`;
  }

  // ─────────────────────────────────────────────────────────────────
  // SECTION 5 — FOLLOW-UP CHAT
  // Embedded form + inline JS that POSTs to /market-chat. Uses
  // data-* attributes to know which city|state to look up.
  // ─────────────────────────────────────────────────────────────────
  const cityAttr = city.replace(/"/g, '&quot;');
  const stateAttr = state.replace(/"/g, '&quot;');
  const chatHtml = `<h2>Ask a follow-up</h2>
<p class="meta">Ask anything about this analysis — Claude has the full data above in memory for the next 24 hours.</p>
<div id="market-chat-log" style="margin:8px 0"></div>
<form id="market-chat-form" data-city="${cityAttr}" data-state="${stateAttr}" style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
<input id="market-chat-input" type="text" placeholder="e.g. Why is the gap score lower for #5?" style="flex:1;min-width:240px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:14px" required>
<button type="submit" id="market-chat-btn" style="padding:10px 18px;background:var(--blue);color:#fff;border:0;border-radius:8px;font-weight:600;font-size:14px;cursor:pointer">Ask &rarr;</button>
</form>
<script>
(function () {
  var form = document.getElementById('market-chat-form');
  if (!form) return;
  var log = document.getElementById('market-chat-log');
  var input = document.getElementById('market-chat-input');
  var btn = document.getElementById('market-chat-btn');
  function bubble(text, who) {
    var d = document.createElement('div');
    d.style.cssText = 'margin:8px 0;padding:12px 14px;border-radius:8px;border:1px solid var(--border);background:' +
      (who === 'user' ? 'var(--blue-tint)' : 'var(--surface)') + ';';
    var label = document.createElement('div');
    label.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted);margin-bottom:4px';
    label.textContent = who === 'user' ? 'You' : 'BizRadar';
    var p = document.createElement('div');
    p.style.cssText = 'white-space:pre-wrap;line-height:1.5';
    p.textContent = text;
    d.appendChild(label);
    d.appendChild(p);
    log.appendChild(d);
    log.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
  form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var q = input.value.trim();
    if (!q) return;
    bubble(q, 'user');
    input.value = '';
    btn.disabled = true; btn.textContent = 'Thinking…';
    try {
      var res = await fetch('/market-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city: form.dataset.city,
          state: form.dataset.state,
          question: q,
        }),
      });
      var json = await res.json();
      if (!res.ok || json.error) {
        bubble('Error: ' + (json.error || 'request failed'), 'assistant');
      } else {
        bubble(json.answer || '(no answer returned)', 'assistant');
      }
    } catch (err) {
      bubble('Network error: ' + err.message, 'assistant');
    }
    btn.disabled = false; btn.textContent = 'Ask →';
    input.focus();
  });
})();
</script>`;

  // ── Final assembly ─────────────────────────────────────────────────
  return `${PAGE_OPEN}${headerHtml}
${snapshotHtml}
${top10Section}
${deepDiveHtml}
${chatHtml}
<p class="meta" style="margin-top:24px"><small>Generated ${new Date().toISOString()}</small></p>${PAGE_CLOSE}`;
}

function renderReport(ctx) {
  const { input, layer0Result, profile, data, redFlags, strengths, ranked, enriched, studies } = ctx;
  const status = overallStatus(strengths, ranked);
  const statusClass = status.label.startsWith('HEALTHY')
    ? 'healthy'
    : status.label.startsWith('GOOD')
    ? 'good'
    : 'needs';

  const allCitedIds = new Set();
  ranked.allTriggered.forEach((t) => t.rec.study_ids.forEach((id) => allCitedIds.add(id)));

  // ── Competitor radius-tier note (matches the 8-step 1/3/8/15/30/50/75/150
  // ladder in googlePlaces.js fetchNearbyCompetitors). Tier mapping:
  //   1-3 mi   → no callout (healthy local pool, no message needed)
  //   8-15 mi  → "Nearest competitors within X miles" (mild)
  //   30-50 mi → "Limited local competition" (warning)
  //   75 mi    → "Very limited competition — strong market position" (warning)
  //   150 mi   → "No nearby competitors — potential monopoly" (positive)
  function radiusTierNote() {
    const radiusMi = typeof data.search_radius_miles === 'number' ? data.search_radius_miles : null;
    if (radiusMi == null) return '';

    // Step 8 (150 mi) — ladder reached the end. Per spec, surface the
    // monopoly note. Note: the message says "No nearby competitors";
    // technically the ladder may have surfaced 1-4 competitors at 150
    // mi, but the spec wording calls this "potential monopoly in your
    // category in this region" regardless. If the rendered count
    // line below shows a non-zero number, the user has the actual count.
    if (radiusMi >= 150) {
      return `<div class="rec rec-high"><strong>&#9888; No nearby competitors found</strong> &mdash; potential monopoly in your category in this region. Nearest matches found within 150 miles.</div>`;
    }
    // Step 7 (75 mi).
    if (radiusMi >= 75) {
      return `<div class="flag">&#9888; Very limited competition &mdash; nearest within ${radiusMi} miles. Strong market position in your area.</div>`;
    }
    // Steps 5-6 (30 / 50 mi).
    if (radiusMi >= 30) {
      return `<div class="flag">&#9888; Limited local competition &mdash; nearest within ${radiusMi} miles.</div>`;
    }
    // Steps 3-4 (8 / 15 mi) — mild informational note, no warning icon.
    if (radiusMi >= 8) {
      return `<div class="meta" style="margin:8px 0">Nearest competitors within ${radiusMi} miles.</div>`;
    }
    // Steps 1-2 (1 / 3 mi) — healthy dense local market, no callout.
    return '';
  }

  const fallbackTag = layer0Result._phase1Patch
    ? ' <small>(phase-1 hotel keyword patch)</small>'
    : layer0Result._typesFallback
    ? ` <small>(places types fallback: matched <code>${escapeHtml(layer0Result.matched_type)}</code>)</small>`
    : layer0Result._nameFallback
    ? ` <small>(places name fallback: matched <code>${escapeHtml(layer0Result.matched_token)}</code> → ${escapeHtml(layer0Result.matched_category)})</small>`
    : '';
  const chainTag = data.is_chain
    ? ` <small>(chain: ${escapeHtml(data.chain_name || 'detected')})</small>`
    : '';
  const headerHtml = `<h1>${escapeHtml(data.name || input)}</h1>
<p class="meta">${escapeHtml(data.formatted_address || '')}<br>
${escapeHtml(profile.name)} — NAICS ${escapeHtml(layer0Result.naics6)}<br>
Layer 0: <code>${escapeHtml(layer0Result.mode)}</code> · confidence ${escapeHtml(layer0Result.confidence)}${fallbackTag}${chainTag}</p>`;

  const overallHtml = `<div class="status ${statusClass}">${escapeHtml(status.label)}</div>
${status.detail ? `<p class="meta">${escapeHtml(status.detail)}</p>` : ''}`;

  // Phase 5 — LOCAL MARKET CONTEXT callout (when Claude enrichment succeeded)
  // and the "AI insights unavailable" note (when it didn't).
  let localContextHtml = '';
  if (enriched && enriched.local_context) {
    localContextHtml = `<div class="callout local-context">
<div class="callout-label">LOCAL MARKET CONTEXT</div>
<p>${escapeHtml(enriched.local_context)}</p>
</div>`;
  } else if (!enriched) {
    localContextHtml = `<p class="ai-fallback-note"><small>AI insights unavailable — showing research-based recommendations.</small></p>`;
  }

  let redFlagsHtml = '';
  if (redFlags.length) {
    redFlagsHtml = `<h2>Red flags</h2>` + redFlags.map((rf) =>
      `<div class="flag ${rf.severity === 'critical' ? 'critical' : ''}">
<strong>${escapeHtml(rf.severity.toUpperCase())}:</strong> ${escapeHtml(rf.message)}</div>`
    ).join('');
  }

  let strengthsHtml = '';
  if (strengths.length) {
    strengthsHtml = `<h2>Strengths</h2><ul>${
      strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')
    }</ul>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Industry survival outlook — BED2013 cohort survival rates for the
  // business's NAICS-2 sector. Renders only when the sector has a row
  // in BED2013 (every NAICS-2 we currently classify maps to one).
  // ──────────────────────────────────────────────────────────────────
  let industrySurvivalHtml = '';
  const _bedNaics2 = naics2FromNaics6(layer0Result.naics6);
  const _bed = _bedNaics2 && BED2013[_bedNaics2];
  if (_bed) {
    const pct = (n) => `${(n * 100).toFixed(1)}%`;
    industrySurvivalHtml = `<h2>Industry survival outlook</h2>
<p>Establishments that opened in this sector (NAICS-${escapeHtml(_bedNaics2)}) in 2013 survived as follows:</p>
<table class="coverage">
  <tr><td><strong>1-year</strong></td><td>${pct(_bed.y1)}</td></tr>
  <tr><td><strong>3-year</strong></td><td>${pct(_bed.y3)}</td></tr>
  <tr><td><strong>5-year</strong></td><td>${pct(_bed.y5)}</td></tr>
  <tr><td><strong>7-year</strong></td><td>${pct(_bed.y7)}</td></tr>
  <tr><td><strong>10-year</strong></td><td>${pct(_bed.y10)}</td></tr>
</table>
<p class="meta"><small>Source: BLS Business Employment Dynamics, 2013 cohort tracked through 2023</small></p>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ — TripAdvisor Intelligence (rendered only when TA fetch hit)
  // Position: after Strengths, before Competitive context.
  // Surfaces: rating + review count, ranking, sub-ratings (with gap
  // detection at ≥0.4 spread), awards, trip-type mix, value-vs-overall
  // gap warning (synthetic ta_value_gap_detected bool from the fetcher).
  // ──────────────────────────────────────────────────────────────────
  let tripAdvisorHtml = '';
  if (data.tripadvisor && data.ta_rating != null) {
    const ratingStars = typeof data.ta_rating === 'number' ? data.ta_rating.toFixed(1) : '—';
    const reviewCt = typeof data.ta_review_count === 'number'
      ? data.ta_review_count.toLocaleString('en-US')
      : '—';

    // Ranking line — only when we successfully parsed "#X of Y"
    let rankingLine = '';
    if (data.ta_ranking_position && data.ta_ranking_out_of) {
      const pct = (data.ta_ranking_position / data.ta_ranking_out_of);
      const tier = pct <= 0.10 ? 'top 10%' : pct <= 0.25 ? 'top 25%' : pct <= 0.50 ? 'top 50%' : 'lower half';
      rankingLine = `<br>Ranked <strong>#${data.ta_ranking_position} of ${data.ta_ranking_out_of}</strong> locally (${tier}).`;
    } else if (data.ta_ranking) {
      rankingLine = `<br>${escapeHtml(data.ta_ranking)}`;
    }

    // Sub-ratings table + gap detection. Compute max-min spread; flag at ≥0.4.
    let subratingsHtml = '';
    let gapHtml = '';
    if (data.ta_subratings && typeof data.ta_subratings === 'object') {
      const entries = Object.entries(data.ta_subratings)
        .filter(([, v]) => Number.isFinite(v));
      if (entries.length) {
        const rows = entries.map(([k, v]) => {
          const label = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          return `<tr><td>${escapeHtml(label)}</td><td><strong>${v.toFixed(1)}</strong></td></tr>`;
        }).join('');
        subratingsHtml = `<p><strong>Sub-ratings:</strong></p>
<table class="coverage">${rows}</table>`;

        const vals = entries.map(([, v]) => v);
        const maxV = Math.max(...vals);
        const minV = Math.min(...vals);
        const spread = maxV - minV;
        if (spread >= 0.4) {
          const lowest = entries.find(([, v]) => v === minV);
          const highest = entries.find(([, v]) => v === maxV);
          gapHtml = `<div class="flag"><strong>Sub-rating gap detected:</strong> ${spread.toFixed(1)}-point spread between
your strongest dimension (${escapeHtml(highest[0].replace(/_/g, ' '))}: ${highest[1].toFixed(1)}) and weakest
(${escapeHtml(lowest[0].replace(/_/g, ' '))}: ${lowest[1].toFixed(1)}). Customers notice the inconsistency.</div>`;
        }
      }
    }

    // Value-vs-overall gap (synthetic field for the trigger DSL).
    let valueGapHtml = '';
    if (data.ta_value_gap_detected) {
      const v = data.ta_subratings && data.ta_subratings.value;
      valueGapHtml = `<div class="flag"><strong>Value perception gap:</strong> Your value sub-rating (${typeof v === 'number' ? v.toFixed(1) : '—'})
trails your overall rating (${ratingStars}) by more than 0.4. Customers like the experience but feel they overpaid —
look at price-to-perceived-quality (portion size, finish quality, included amenities).</div>`;
    }

    // Awards list
    let awardsHtml = '';
    if (Array.isArray(data.ta_awards) && data.ta_awards.length) {
      const items = data.ta_awards.map((a) => {
        const yr = a.year ? ` (${escapeHtml(String(a.year))})` : '';
        return `<li>${escapeHtml(a.type)}${yr}</li>`;
      }).join('');
      awardsHtml = `<p><strong>TripAdvisor awards:</strong></p><ul>${items}</ul>`;
    }

    // Trip types — show top 3 by share so the dominant segments are obvious.
    let tripTypesHtml = '';
    if (Array.isArray(data.ta_trip_types) && data.ta_trip_types.length) {
      const total = data.ta_trip_types.reduce((s, t) => s + (t.value || 0), 0);
      if (total > 0) {
        const top = [...data.ta_trip_types].sort((a, b) => b.value - a.value).slice(0, 3);
        const items = top.map((t) => {
          const pct = ((t.value / total) * 100).toFixed(0);
          return `<li>${escapeHtml(t.name)}: ${pct}% (${t.value})</li>`;
        }).join('');
        tripTypesHtml = `<p><strong>Customer trip-type mix:</strong></p><ul>${items}</ul>
<p class="meta"><small>Use to align messaging — promote the segment you want to grow, defend the one you depend on.</small></p>`;
      }
    }

    tripAdvisorHtml = `<h2>TripAdvisor intelligence</h2>
<p><strong>${ratingStars}★</strong> on TripAdvisor across ${reviewCt} review${reviewCt === '1' ? '' : 's'}.${rankingLine}</p>
${subratingsHtml}
${gapHtml}
${valueGapHtml}
${awardsHtml}
${tripTypesHtml}
<p class="meta"><small>Source: TripAdvisor Content API (location + details + reviews).</small></p>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ — Quality ratings (CMS Hospital Compare)
  // ──────────────────────────────────────────────────────────────────
  // Renders for hospitals / specialty clinics whose facility_name matches
  // a row in CMS's Hospital General Information dataset (xubh-q36u).
  let qualityRatingsHtml = '';
  if (data.cms) {
    const overall = data.cms_overall_rating;
    const stars = (overall !== null && overall !== undefined && overall !== '')
      ? `${escapeHtml(String(overall))}/5 stars`
      : 'unrated';
    const rows = [
      ['Patient experience', data.cms_patient_experience_rating],
      ['Mortality', data.cms_mortality_rating],
      ['Safety of care', data.cms_safety_rating],
      ['Readmission', data.cms_readmission_rating],
      ['Timeliness', data.cms_timeliness_rating],
    ]
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
      .join('');
    const facility = data.cms.facility_name ? escapeHtml(data.cms.facility_name) : 'This facility';
    qualityRatingsHtml = `<h2>Quality ratings</h2>
<p><strong>${facility}</strong> — CMS overall rating: <strong>${stars}</strong></p>
${rows ? `<table class="coverage">${rows}</table>` : ''}
<p class="meta"><small>Source: CMS Hospital General Information (national-comparison ratings).</small></p>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ — Compliance (FMCSA carrier safety)
  // ──────────────────────────────────────────────────────────────────
  // Renders for transportation/warehousing operators (NAICS-2 = 48-49)
  // when the business name matches a DOT-registered carrier. Surface
  // the safety rating as a flag when it's not "Satisfactory".
  let complianceHtml = '';
  if (data.fmcsa && data.dot_number) {
    const sr = data.safety_rating || '—';
    const srNotSat = data.safety_rating && !/^satisfactory$/i.test(data.safety_rating);
    const srFlag = srNotSat
      ? ` <span class="extra-tag extra-tag-hidden">NOT SATISFACTORY</span>`
      : '';
    const allowed = data.allowed_to_operate || '—';
    const drivers = data.total_drivers != null ? data.total_drivers.toLocaleString('en-US') : '—';
    const trucks = data.total_trucks != null ? data.total_trucks.toLocaleString('en-US') : '—';
    const op = data.fmcsa.carrier_operation || '—';
    complianceHtml = `<h2>Compliance</h2>
<p><strong>FMCSA Safety Rating:</strong> ${escapeHtml(String(sr))}${srFlag}<br>
DOT#: <strong>${escapeHtml(String(data.dot_number))}</strong><br>
Allowed to operate: <strong>${escapeHtml(String(allowed))}</strong><br>
Carrier operation: ${escapeHtml(String(op))}<br>
Total drivers: <strong>${escapeHtml(String(drivers))}</strong> · Total trucks: <strong>${escapeHtml(String(trucks))}</strong></p>
<p class="meta"><small>Source: FMCSA QCMobile carrier services API.</small></p>`;
  }

  // ──────────────────────────────────────────────────────────────────
  // BATCH14 — Competitive Context + Location & Market sections
  // (rendered only when the underlying fetches succeeded)
  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ — FDIC bank financial summary (banking / finance profiles).
  // Built up here so it can be appended to competitiveHtml whether or not
  // Google Nearby Search returned competitor data.
  let fdicBlock = '';
  if (data.fdic && (data.fdic_total_deposits != null || data.fdic_total_assets != null)) {
    // FDIC reports DEP / ASSET in $thousands. Convert to $M for display.
    const depM = data.fdic_total_deposits != null
      ? '$' + (data.fdic_total_deposits / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'M'
      : '—';
    const assetM = data.fdic_total_assets != null
      ? '$' + (data.fdic_total_assets / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'M'
      : '—';
    const bn = data.fdic_bank_name ? escapeHtml(data.fdic_bank_name) : 'this institution';
    fdicBlock = `<p><strong>FDIC profile (${bn}):</strong><br>
Total deposits: <strong>${depM}</strong><br>
Total assets: <strong>${assetM}</strong><br>
<small>Source: FDIC BankFind API (active institutions).</small></p>`;
  }

  let competitiveHtml = '';
  if (typeof data.competitor_count === 'number' && data.competitor_count > 0) {
    const yourRating = typeof data.google_rating === 'number' ? data.google_rating.toFixed(1) : '—';
    const medRating = typeof data.competitor_median_rating === 'number' ? data.competitor_median_rating.toFixed(1) : '—';
    const yourReviews = typeof data.google_review_count === 'number' ? data.google_review_count : '—';
    const medReviews = typeof data.competitor_median_review_count === 'number' ? data.competitor_median_review_count : '—';
    const ratingDelta = (typeof data.google_rating === 'number' && typeof data.competitor_median_rating === 'number')
      ? (data.google_rating - data.competitor_median_rating)
      : null;
    const reviewDelta = (typeof data.google_review_count === 'number' && typeof data.competitor_median_review_count === 'number')
      ? (data.google_review_count - data.competitor_median_review_count)
      : null;
    const ratingFlag = ratingDelta == null ? '' : ratingDelta >= 0 ? ` <small>(+${ratingDelta.toFixed(1)})</small>` : ` <small>(${ratingDelta.toFixed(1)})</small>`;
    const reviewFlag = reviewDelta == null ? '' : reviewDelta >= 0 ? ` <small>(+${reviewDelta})</small>` : ` <small>(${reviewDelta})</small>`;

    // ── Tier classification (per spec 2) ────────────────────────────
    // Each top-5 competitor is bucketed into 'threat' (real competitive
    // risk — render as a full card) or 'winning' (subject is meaningfully
    // outperforming — render as a muted one-liner). Logic lives in
    // googlePlaces.classifyCompetitorTier so the rule set can be reused.
    const top5ForTier = Array.isArray(data.competitors_top5) ? data.competitors_top5 : [];
    const tieredCompetitors = top5ForTier.map((c) => ({
      ...c,
      tier: places.classifyCompetitorTier(c, data.google_rating, data.google_review_count),
    }));
    const threats = tieredCompetitors.filter((c) => c.tier === 'threat');
    const winners = tieredCompetitors.filter((c) => c.tier === 'winning');
    const threatCount = threats.length;
    const winningCount = winners.length;

    // Summary line (per spec).
    const tierSummary = (threatCount + winningCount > 0)
      ? `<p class="meta"><strong>${threatCount}</strong> real competitor${threatCount === 1 ? '' : 's'} to watch &middot; <strong>${winningCount}</strong> competitor${winningCount === 1 ? '' : 's'} you're beating</p>`
      : '';

    // Tier 1 list — full info per the existing list-item style.
    const threatsHtml = threats.length
      ? `<p class="meta">Real competitors to watch:</p><ul>` + threats.map((c) => {
          const dist = typeof c.distance_meters === 'number'
            ? ` &middot; ${(c.distance_meters / 1609.34).toFixed(1)} mi`
            : (typeof c.distance_miles === 'number' ? ` &middot; ${c.distance_miles.toFixed(1)} mi` : '');
          const rating = typeof c.rating === 'number' ? c.rating.toFixed(1) : '—';
          return `<li><strong>${escapeHtml(c.name)}</strong> &mdash; ${rating}&#9733; (${c.review_count || 0} reviews)${dist}</li>`;
        }).join('') + `</ul>`
      : '';

    // Tier 2 list — muted "you're winning" lines (no detailed card).
    const winnersHtml = winners.length
      ? `<div style="margin-top:10px">` + winners.map((c) => {
          const rating = typeof c.rating === 'number' ? c.rating.toFixed(1) : '—';
          return `<p class="meta" style="margin:4px 0;color:var(--muted)">&#10003; You're outperforming <strong>${escapeHtml(c.name)}</strong> (${rating}&#9733;, ${c.review_count || 0} reviews) &mdash; no action needed</p>`;
        }).join('') + `</div>`
      : '';

    const reportedRadiusMi = typeof data.search_radius_miles === 'number' ? data.search_radius_miles : 15;
    competitiveHtml = `<h2>Competitive context</h2>
${radiusTierNote()}
${tierSummary}
<p>${data.competitor_count} same-type competitors within ${reportedRadiusMi} miles.<br>
Your rating: <strong>${yourRating}</strong> vs local median: <strong>${medRating}</strong>${ratingFlag}<br>
Your reviews: <strong>${yourReviews}</strong> vs local median: <strong>${medReviews}</strong>${reviewFlag}</p>
${threatsHtml}
${winnersHtml}
${fdicBlock}`;
  } else if (fdicBlock) {
    // Bank/finance with no Google competitors but FDIC data — still
    // render the section so the FDIC block has a home.
    competitiveHtml = `<h2>Competitive context</h2>${fdicBlock}`;
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 5+ — Competitor comparison (Claude-enriched, top 5 + analysis)
  // ──────────────────────────────────────────────────────────────────
  // Renders only when (a) the Nearby Search returned at least one
  // competitor AND (b) Claude returned a competitor_analysis object.
  // Includes a thin-market warning when the search had to expand
  // beyond the default 5-mile radius.
  let competitorComparisonHtml = '';
  const ca = enriched && enriched.competitor_analysis;
  const top5 = Array.isArray(data.competitors_top5) ? data.competitors_top5 : [];
  if (ca && top5.length) {
    // Reuse the centralized radius-tier note (matches the 15/30/75/150
    // ladder in googlePlaces.js fetchNearbyCompetitors). Returns '' for
    // the 15-mile default case so we don't duplicate the callout.
    const expansionNote = radiusTierNote();

    const better = Array.isArray(ca.what_they_do_better) ? ca.what_they_do_better : [];
    const win = Array.isArray(ca.what_you_can_win) ? ca.what_you_can_win : [];
    const summary = ca.summary || '';

    const betterHtml = better.length
      ? `<h3>What competitors are doing better than you</h3><ul>` + better.map((b) =>
          `<li><strong>${escapeHtml(b.competitor_name || '—')}:</strong> ${escapeHtml(b.advantage || '')}<br>
<span class="meta">Evidence: ${escapeHtml(b.evidence || '—')}</span><br>
<span class="meta">→ <strong>Your move:</strong> ${escapeHtml(b.your_action || '—')}</span></li>`
        ).join('') + `</ul>`
      : '';

    const winHtml = win.length
      ? `<h3>What you can do to win customers from them</h3><ul>` + win.map((w) =>
          `<li><strong>${escapeHtml(w.opportunity || '—')}</strong><br>
<span class="meta">Why you can win: ${escapeHtml(w.evidence || '—')}</span><br>
<span class="meta">→ <strong>Action:</strong> ${escapeHtml(w.action || '—')}</span></li>`
        ).join('') + `</ul>`
      : '';

    const summaryHtml = summary
      ? `<h3>Overall</h3><p>${escapeHtml(summary)}</p>`
      : '';

    competitorComparisonHtml = `<h2>Competitor comparison <span class="ai-badge" title="Enriched by Claude">AI</span></h2>
${expansionNote}
${betterHtml}
${winHtml}
${summaryHtml}`;
  }

  let marketHtml = '';
  // Phase 5+ — section also renders if USDA agriculture profile or HUD
  // Fair Market Rents are present (sector-conditional fetchers).
  if (
    typeof data.median_household_income === 'number'
    || typeof data.total_population === 'number'
    || data.usda_nass
    || data.hud_fmr
  ) {
    const income = typeof data.median_household_income === 'number'
      ? '$' + data.median_household_income.toLocaleString('en-US')
      : 'unavailable';
    const pop = typeof data.total_population === 'number'
      ? data.total_population.toLocaleString('en-US')
      : 'unavailable';
    const hh = typeof data.average_household_size === 'number'
      ? data.average_household_size.toFixed(2)
      : null;
    const hhLine = hh ? `<br>Average household size: <strong>${hh}</strong>` : '';

    // Phase 5+ — anchor tenants + transit (Overpass / OpenStreetMap)
    let anchorBlock = '';
    if (Array.isArray(data.anchor_tenants) && data.anchor_tenants.length) {
      anchorBlock = `<p><strong>Anchor tenants nearby:</strong> ${escapeHtml(data.anchor_tenants.join(', '))}<br>
<small>Anchor proximity lifts foot traffic 20-40% per Pashigian &amp; Gould (1998), study S044.</small></p>`;
    }
    let transitBlock = '';
    if (typeof data.nearest_transit_meters === 'number') {
      const mi = (data.nearest_transit_meters / 1609.34).toFixed(2);
      transitBlock = `<p><small>Nearest transit (bus stop / rail station): ${data.nearest_transit_meters}m (${mi} mi). ${data.has_transit_nearby ? 'Transit-served location ✓' : 'Car-dependent'}.</small></p>`;
    } else if (data.has_transit_nearby === false || data.location_signals) {
      transitBlock = `<p><small>No bus stop or rail station found within 800m — car-dependent location.</small></p>`;
    }

    // Phase 5+ — HUD residential building permits (Census BPS data)
    let permitsBlock = '';
    if (typeof data.building_permits_total === 'number' && data.building_permits_year) {
      const trendWord = data.building_permits_yoy_change == null
        ? 'trend unavailable'
        : data.building_permits_yoy_change > 5
        ? `<span style="color:#1b7c3a">growing</span> (+${data.building_permits_yoy_change}% YoY)`
        : data.building_permits_yoy_change < -5
        ? `<span style="color:#b32430">declining</span> (${data.building_permits_yoy_change}% YoY)`
        : `<span style="color:#666">stable</span> (${data.building_permits_yoy_change >= 0 ? '+' : ''}${data.building_permits_yoy_change}% YoY)`;
      const sf = typeof data.building_permits_single_family === 'number'
        ? ` (${data.building_permits_single_family} single-family)`
        : '';
      const cty = data.county_name ? `${escapeHtml(data.county_name)} County ` : '';
      permitsBlock = `<p><strong>${cty}construction activity (${escapeHtml(data.building_permits_year)}):</strong> ${data.building_permits_total} total residential permits${sf} — ${trendWord}<br>
<small>Source: U.S. Census Building Permits Survey via HUD (county FIPS ${escapeHtml(data.county_fips || '—')}).</small></p>`;
    }

    // Phase 5+ — USDA NASS agriculture profile (NAICS-2 = 11 only)
    let usdaBlock = '';
    if (data.usda_nass && data.top_commodity) {
      usdaBlock = `<p><strong>Dominant crop:</strong> ${escapeHtml(data.top_commodity)}<br>
<small>${escapeHtml(data.state_ag_profile || '')}</small><br>
<small>Source: USDA NASS QuickStats (2022, AREA HARVESTED).</small></p>`;
    }

    // Phase 5+ — HUD Fair Market Rents (NAICS-2 = 53 only)
    let fmrBlock = '';
    if (data.hud_fmr && (data.fmr_studio != null || data.fmr_1br != null || data.fmr_2br != null)) {
      const studio = data.fmr_studio != null ? '$' + data.fmr_studio.toLocaleString('en-US') : '—';
      const oneBr = data.fmr_1br != null ? '$' + data.fmr_1br.toLocaleString('en-US') : '—';
      const twoBr = data.fmr_2br != null ? '$' + data.fmr_2br.toLocaleString('en-US') : '—';
      const metro = data.fmr_metro_name ? escapeHtml(data.fmr_metro_name) : 'this metro';
      const yr = data.fmr_year ? escapeHtml(String(data.fmr_year)) : '—';
      fmrBlock = `<p><strong>Fair Market Rents (${metro}, ${yr}):</strong><br>
Studio: <strong>${studio}/mo</strong><br>
1BR: <strong>${oneBr}/mo</strong><br>
2BR: <strong>${twoBr}/mo</strong><br>
<small>Source: HUD User FMR API.</small></p>`;
    }

    marketHtml = `<h2>Location &amp; market</h2>
<p>Area median household income: <strong>${escapeHtml(income)}</strong><br>
Local population (ZIP ${escapeHtml(data.census_zip || '')}): <strong>${escapeHtml(pop)}</strong>${hhLine}</p>
<p class="meta">Source: U.S. Census Bureau ACS 5-Year Estimates (2018-2022) — study S037.</p>
${anchorBlock}
${transitBlock}
${permitsBlock}
${usdaBlock}
${fmrBlock}`;
  }

  // Operations / brand line — quick visibility on the smaller new signals
  const opsBits = [];
  if (data.hours_complete === true) opsBits.push('hours fully listed (7 days)');
  else if (data.hours_complete === false) opsBits.push('hours incomplete');
  if (data.is_open_now === true) opsBits.push('open now');
  else if (data.is_open_now === false) opsBits.push('closed now');
  if (data.website_exists === true) opsBits.push('website loads');
  else if (data.website_exists === false) opsBits.push('website returned error');
  else if (data.website_url && data.website_exists == null) opsBits.push('website check inconclusive');
  if (data.website_url == null) opsBits.push('no website on Google Business Profile');
  // FIX 4 — owner-response rate display logic. Google's legacy Places
  // Details API frequently omits the owner-reply field even when the
  // owner DID reply on the live GBP. With a sample of only 5 reviews
  // (the legacy max), a "0%" reading is much more often a measurement
  // gap than a real signal — show "insufficient data" instead.
  if (typeof data.response_rate_estimated === 'number') {
    const sampleSize = typeof data.reviews_sampled === 'number' ? data.reviews_sampled : 0;
    if (data.response_rate_estimated === 0 && sampleSize <= 5) {
      opsBits.push(`owner-response rate: insufficient data (sampled ${sampleSize} review${sampleSize === 1 ? '' : 's'} only)`);
    } else if (data.response_rate_estimated === 0) {
      opsBits.push(`owner-response rate: 0% — no responses detected (sample: ${sampleSize})`);
    } else {
      opsBits.push(`owner-response rate (sample of ${sampleSize}): ${(data.response_rate_estimated * 100).toFixed(0)}%`);
    }
  }
  // Phase 5+ — PageSpeed mobile signals
  if (typeof data.website_mobile_score === 'number') {
    const tier = data.website_mobile_score < 50
      ? 'NEEDS WORK'
      : data.website_mobile_score < 80
      ? 'GOOD'
      : 'STRONG';
    opsBits.push(`mobile score: ${data.website_mobile_score}/100 ${tier}`);
  }
  if (typeof data.load_time_seconds === 'number') {
    const flag = data.load_time_seconds > 3
      ? '⚠️ above 3-second abandonment threshold (S040)'
      : '✅ fast';
    opsBits.push(`load time: ${data.load_time_seconds}s ${flag}`);
  }
  // Phase 5+ — NPI license status (healthcare profiles only).
  if (data.npi) {
    const status = data.npi_authorized ? 'NPI Active ✅' : `NPI ${data.npi_status || '—'} ⚠️`;
    const num = data.npi_number ? ` (NPI ${escapeHtml(String(data.npi_number))})` : '';
    const ptype = data.provider_type ? ` · ${escapeHtml(String(data.provider_type))}` : '';
    opsBits.push(`${status}${num}${ptype}`);
  }
  const opsHtml = opsBits.length
    ? `<h2>Operations &amp; brand</h2><p>${opsBits.map(escapeHtml).join(' · ')}</p>`
    : '';

  // Phase 5+ — Demand & seasonality (Open-Meteo + Ticketmaster + BLS)
  let demandHtml = '';
  const seasonalityLines = [];
  if (data.peak_tourist_season) {
    seasonalityLines.push(`<strong>Peak season:</strong> ${escapeHtml(data.peak_tourist_season)}`);
  }
  if (data.has_cold_winter === true) {
    seasonalityLines.push('<strong>Cold winter market</strong> — plan an off-season strategy (one or more months average below 35°F).');
  }
  if (data.has_hot_summer === true) {
    seasonalityLines.push('<strong>Hot summer market</strong> — peak demand May-September (one or more months average above 85°F).');
  }
  // Phase 5+ — BLS sector employment level (only fires for the 5 wired
  // NAICS-2 sectors: 23, 44-45, 54, 61, 62).
  if (typeof data.bls_employment_level === 'number') {
    const periodPart = data.bls_employment_period ? `${escapeHtml(data.bls_employment_period)} ` : '';
    const yearPart = data.bls_employment_year ? escapeHtml(String(data.bls_employment_year)) : '';
    seasonalityLines.push(`<strong>Local employment (sector-wide):</strong> ${data.bls_employment_level.toLocaleString('en-US')} jobs (${periodPart}${yearPart}). <small>Source: BLS Public Data API.</small>`);
  }
  const events = Array.isArray(data.upcoming_events) ? data.upcoming_events : [];
  let eventsBlock = '';
  if (events.length) {
    const items = events.map((e) => {
      const venue = e.venue ? ` at ${escapeHtml(e.venue)}` : '';
      const when = e.date ? escapeHtml(e.date.replace('T', ' ').slice(0, 16)) : 'date TBA';
      return `<li>${escapeHtml(e.name)} — ${when}${venue}</li>`;
    }).join('');
    eventsBlock = `<p><strong>Upcoming events within 10km (next 90 days):</strong></p><ul>${items}</ul>
<p class="meta"><small>Source: Ticketmaster Discovery API v2.</small></p>`;
  }
  if (seasonalityLines.length || eventsBlock) {
    const seasonalityBlock = seasonalityLines.length
      ? `<p>${seasonalityLines.join('<br>')}</p>`
      : '';
    demandHtml = `<h2>Demand &amp; seasonality</h2>${seasonalityBlock}${eventsBlock}`;
  }

  // BATCH16 — top-10 ranking with impact labels.
  let priorityHtml = `<h2>Priority actions</h2>`;
  const top10 = ranked.top10 || [];
  if (!top10.length) {
    priorityHtml += `<p>No recommendations triggered for this business.</p>`;
  } else {
    const total = top10.length;
    const high = ranked.highImpactCount || 0;
    const summary = high > 0
      ? `Of these ${total} actions, focus on the ${high} HIGH IMPACT item${high === 1 ? '' : 's'} first. Lower-impact items are worth doing once the high-impact ones are handled.`
      : `Of these ${total} actions, none are HIGH IMPACT — this business is healthy on the dimensions we measure. Lower-impact polish wins are listed in priority order.`;
    priorityHtml += `<p class="meta">${escapeHtml(summary)}</p>`;
    // CHANGE 3 — classify each top-10 rec as HIDDEN / KNOWN / normal
    // and re-sort: HIDDEN at top regardless of score, KNOWN at bottom
    // with score capped at 0.30.
    classifyKnownHidden(top10, data);
    // CHANGE 6 — attach money estimate HTML where it qualifies.
    for (const t of top10) {
      t.moneyEstimateHtml = buildMoneyEstimate(t, data, profile, studies);
    }
    // Phase 5 — index Claude's enriched recs by id so the first 3 entries
    // can use them. Recs 4-10 keep the Phase-4 deterministic format.
    const enrichedById = new Map();
    if (enriched && Array.isArray(enriched.enriched_recommendations)) {
      for (const er of enriched.enriched_recommendations) {
        if (er && er.id) enrichedById.set(er.id, er);
      }
    }
    priorityHtml += top10.map((t, idx) => {
      const tags = [];
      if (t.classification === 'hidden') {
        tags.push({ cls: 'hidden', label: 'HIDDEN ISSUE — unique to your business' });
      } else if (t.classification === 'known') {
        tags.push({ cls: 'known', label: 'KNOWN ISSUE — common in your market' });
      }
      // Top 3 only get Claude's enriched layers (when available).
      const claudeRec = idx < 3 ? enrichedById.get(t.rec.id) : null;
      const html = renderRec3Layer(t, idx, data, studies, tags, claudeRec);
      // Append the classification reason as a small meta line just under the header.
      if (t.classificationReason) {
        return html.replace(
          /<\/h3>/,
          `</h3><p class="meta classification-reason">${escapeHtml(t.classificationReason)}</p>`
        );
      }
      return html;
    }).join('');
  }

  // BATCH16 — Common Problems Detected (review-mined themes)
  const cpAnalysis = analyzeCommonProblems(data.sample_reviews, profile.id);
  const commonProblemsHtml = renderCommonProblems(cpAnalysis);

  // ── FIX 3 — 90-day action plan ────────────────────────────────────
  // Renders when Claude enrichment returned a ninety_day_plan object.
  // Three cards (month 1 = blue, month 2 = amber, month 3 = green).
  // Month 1 has weekly granularity; months 2-3 have month-level focus.
  // Section is omitted entirely when enriched.ninety_day_plan is missing
  // — preserves backwards compat with reports that pre-date this fix.
  let ninetyDayPlanHtml = '';
  if (enriched && enriched.ninety_day_plan && typeof enriched.ninety_day_plan === 'object') {
    const plan = enriched.ninety_day_plan;
    const m1 = plan.month_1 || {};
    const m2 = plan.month_2 || {};
    const m3 = plan.month_3 || {};
    const m1Html = `<div class="rec rec-medium">
<h3>Month 1${m1.theme ? ` &mdash; ${escapeHtml(m1.theme)}` : ''}</h3>
${m1.week_1 ? `<p><strong>Week 1:</strong> ${escapeHtml(m1.week_1)}</p>` : ''}
${m1.week_2 ? `<p><strong>Week 2:</strong> ${escapeHtml(m1.week_2)}</p>` : ''}
${m1.week_3 ? `<p><strong>Week 3:</strong> ${escapeHtml(m1.week_3)}</p>` : ''}
${m1.week_4 ? `<p><strong>Week 4:</strong> ${escapeHtml(m1.week_4)}</p>` : ''}
${m1.goal ? `<p class="meta"><strong>Goal:</strong> ${escapeHtml(m1.goal)}</p>` : ''}
</div>`;
    const m2Html = `<div class="rec rec-low">
<h3>Month 2${m2.theme ? ` &mdash; ${escapeHtml(m2.theme)}` : ''}</h3>
${m2.focus ? `<p><strong>Focus:</strong> ${escapeHtml(m2.focus)}</p>` : ''}
${m2.goal ? `<p class="meta"><strong>Goal:</strong> ${escapeHtml(m2.goal)}</p>` : ''}
</div>`;
    const m3Html = `<div class="rec rec-high">
<h3>Month 3${m3.theme ? ` &mdash; ${escapeHtml(m3.theme)}` : ''}</h3>
${m3.focus ? `<p><strong>Focus:</strong> ${escapeHtml(m3.focus)}</p>` : ''}
${m3.goal ? `<p class="meta"><strong>Goal:</strong> ${escapeHtml(m3.goal)}</p>` : ''}
</div>`;
    ninetyDayPlanHtml = `<h2>90-day action plan <span class="ai-badge">AI</span></h2>
<p class="meta">Three months of progressive depth. Month 1 has weekly steps; months 2 and 3 have month-level focus and goals.</p>
${m1Html}
${m2Html}
${m3Html}`;
  }

  // ── FIX 6 — Seasonal strategy ─────────────────────────────────────
  // Four cards (Summer / Fall / Winter / Spring), rendered in order.
  // Winter renders an extra amber off-season-survival callout when
  // present (required for cold-winter markets per SYSTEM_PROMPT).
  let seasonalStrategyHtml = '';
  if (enriched && enriched.seasonal_strategy && typeof enriched.seasonal_strategy === 'object') {
    const ss = enriched.seasonal_strategy;
    const SEASON_ICONS = { summer: '☀️', fall: '🍂', winter: '❄️', spring: '🌸' };
    function renderSeasonCard(season, s) {
      if (!s || typeof s !== 'object') return '';
      const icon = SEASON_ICONS[season] || '';
      const title = `${icon} ${season.charAt(0).toUpperCase() + season.slice(1)}`;
      const offSeasonBlock = (season === 'winter' && s.off_season_survival)
        ? `<div class="honesty honesty-customer-must-validate"><strong>Off-season survival:</strong> ${escapeHtml(s.off_season_survival)}</div>`
        : '';
      return `<div class="rec rec-medium">
<h3>${title}${s.dominant_persona ? ` <span class="meta">&mdash; ${escapeHtml(s.dominant_persona)}</span>` : ''}</h3>
${s.what_to_add ? `<p><strong>What to add:</strong> ${escapeHtml(s.what_to_add)}</p>` : ''}
${s.marketing_message ? `<div class="callout"><div class="callout-label">Headline</div><p>"${escapeHtml(s.marketing_message)}"</p></div>` : ''}
${s.event_tie_in ? `<p><strong>Event tie-in:</strong> ${escapeHtml(s.event_tie_in)}</p>` : ''}
${s.local_partner ? `<p><strong>Local partner:</strong> ${escapeHtml(s.local_partner)}</p>` : ''}
${s.revenue_range ? `<p class="meta">Revenue: <strong>${escapeHtml(s.revenue_range)}</strong></p>` : ''}
${offSeasonBlock}
</div>`;
    }
    const cards = ['summer', 'fall', 'winter', 'spring']
      .map((season) => renderSeasonCard(season, ss[season]))
      .filter(Boolean)
      .join('');
    if (cards) {
      seasonalStrategyHtml = `<h2>Seasonal strategy <span class="ai-badge">AI</span></h2>
<p class="meta">Per-season playbook. Each season names a real local event tie-in and a real local partner from your competitor or nearby-venues data.</p>
${cards}`;
    }
  }

  // Phase 5 — OPPORTUNITIES NOBODY IN YOUR MARKET IS DOING
  // (only renders when Claude enrichment succeeded and produced opportunities)
  let opportunitiesHtml = '';
  if (enriched && Array.isArray(enriched.opportunities) && enriched.opportunities.length) {
    opportunitiesHtml = `<h2>Opportunities nobody in your market is doing</h2>
<p class="meta">${enriched.opportunities.length} location-specific ideas drawn from 18 opportunity categories. Each names real local entities — events, producers, landmarks. Validate cost and revenue against your own pipeline before committing budget.</p>` +
    enriched.opportunities.map((o) => {
      const novelty = o.novelty || '';
      const noveltyCls = /zero competitors|0 competitors/i.test(novelty)
        ? 'novelty-unique'
        : /rare/i.test(novelty)
        ? 'novelty-rare'
        : 'novelty-common';
      return `<div class="opportunity">
<div class="op-meta"><span class="op-category">${escapeHtml(o.category || '—')}</span><span class="op-novelty ${noveltyCls}">${escapeHtml(novelty)}</span></div>
<h3>${escapeHtml(o.title || '')}</h3>
<p>${escapeHtml(o.idea || '')}</p>
<p class="meta">
<strong>Cost:</strong> ${escapeHtml(o.cost || '—')} ·
<strong>Revenue potential:</strong> ${escapeHtml(o.revenue_potential || '—')} ·
<strong>Review-mention probability:</strong> ${escapeHtml(o.review_mention_probability || '—')}
</p>
</div>`;
    }).join('');
  }

  // ───── BATCH14 — Category coverage footer (C1-C7 with actual values) ─────
  const fmt = (v) => (v == null || (typeof v === 'number' && Number.isNaN(v))) ? 'unmeasured' : String(v);
  const c1Items = [];
  if (typeof data.google_rating === 'number') c1Items.push(`rating ${data.google_rating.toFixed(1)}`);
  if (typeof data.google_review_count === 'number') c1Items.push(`${data.google_review_count} reviews`);
  if (typeof data.review_recency_days === 'number') c1Items.push(`recency ${data.review_recency_days}d`);
  // FIX 4 — gate on sample size (same logic as the Ops & brand block).
  if (typeof data.response_rate_estimated === 'number') {
    const _ss = typeof data.reviews_sampled === 'number' ? data.reviews_sampled : 0;
    if (data.response_rate_estimated === 0 && _ss <= 5) {
      c1Items.push(`owner-response insufficient data (sample ${_ss})`);
    } else {
      c1Items.push(`owner-response ${(data.response_rate_estimated * 100).toFixed(0)}% (sample ${_ss})`);
    }
  }
  // Phase 5+ — TripAdvisor presence
  if (typeof data.ta_rating === 'number') {
    const reviews = typeof data.ta_review_count === 'number' ? `${data.ta_review_count.toLocaleString('en-US')} reviews` : '';
    const rank = (data.ta_ranking_position && data.ta_ranking_out_of)
      ? `, ranked #${data.ta_ranking_position} of ${data.ta_ranking_out_of}`
      : '';
    c1Items.push(`TA: ${data.ta_rating.toFixed(1)}★${reviews ? ` (${reviews})` : ''}${rank}`);
  }
  const c1Line = c1Items.length ? c1Items.join(', ') : 'data pending';

  const c2Items = [];
  if (typeof data.median_household_income === 'number') c2Items.push(`median income $${data.median_household_income.toLocaleString('en-US')}`);
  if (typeof data.total_population === 'number') c2Items.push(`pop ${data.total_population.toLocaleString('en-US')} (ZIP ${data.census_zip || '—'})`);
  if (typeof data.average_household_size === 'number') c2Items.push(`avg household ${data.average_household_size.toFixed(2)}`);
  // Phase 5+ — anchor tenants + transit (Overpass)
  if (typeof data.anchor_tenant_count === 'number' && data.anchor_tenant_count > 0) {
    c2Items.push(`${data.anchor_tenant_count} anchor tenant${data.anchor_tenant_count === 1 ? '' : 's'} within 500m`);
  } else if (data.anchor_tenant_count === 0) {
    c2Items.push('no anchor tenants within 500m');
  }
  if (data.has_transit_nearby === true) c2Items.push('transit ≤400m');
  else if (data.has_transit_nearby === false) c2Items.push('no transit within 800m');
  // Phase 5+ — county building permits (HUD/Census BPS)
  if (typeof data.building_permits_total === 'number' && data.building_permits_year) {
    const yoy = data.building_permits_yoy_change != null
      ? ` (${data.building_permits_yoy_change >= 0 ? '+' : ''}${data.building_permits_yoy_change}% YoY)`
      : '';
    c2Items.push(`${data.building_permits_total} county permits ${data.building_permits_year}${yoy}`);
  }
  // Phase 5+ — USDA NASS top crop (agriculture only)
  if (data.top_commodity) {
    c2Items.push(`top crop: ${data.top_commodity.toLowerCase()}`);
  }
  // Phase 5+ — HUD Fair Market Rents (real-estate only)
  if (typeof data.fmr_2br === 'number') {
    c2Items.push(`FMR 2BR: $${data.fmr_2br.toLocaleString('en-US')}/mo${data.fmr_metro_name ? ` (${data.fmr_metro_name})` : ''}`);
  }
  const c2Line = c2Items.length ? c2Items.join(', ') : 'data pending';

  const c3Items = [];
  if (typeof data.competitor_count === 'number') c3Items.push(`${data.competitor_count} competitors within 5 mi`);
  if (typeof data.competitor_median_rating === 'number') c3Items.push(`median ${data.competitor_median_rating.toFixed(1)}★`);
  if (typeof data.competitor_median_review_count === 'number') c3Items.push(`median ${Math.round(data.competitor_median_review_count)} reviews`);
  // Phase 5+ — FDIC bank deposit ranking (banking / finance only)
  if (typeof data.fdic_total_deposits === 'number') {
    const depM = (data.fdic_total_deposits / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 });
    c3Items.push(`FDIC deposits: $${depM}M`);
  }
  const c3Line = c3Items.length ? c3Items.join(', ') : 'data pending';

  // Phase 5+ — Open-Meteo climatology + Ticketmaster + BLS fill C4 Demand
  const c4Items = [];
  if (data.peak_tourist_season) c4Items.push(`peak season ${data.peak_tourist_season}`);
  if (data.has_cold_winter === true) c4Items.push('cold winter');
  if (data.has_hot_summer === true) c4Items.push('hot summer');
  const eventCount = Array.isArray(data.upcoming_events) ? data.upcoming_events.length : 0;
  if (eventCount > 0) c4Items.push(`${eventCount} upcoming event${eventCount === 1 ? '' : 's'} within 10km`);
  // Phase 5+ — BLS sector-wide employment level (5 sectors only)
  if (typeof data.bls_employment_level === 'number') {
    c4Items.push(`sector employment ${data.bls_employment_level.toLocaleString('en-US')} (${data.bls_employment_period || ''} ${data.bls_employment_year || ''})`);
  }
  const c4Line = c4Items.length
    ? c4Items.join(', ') + ' — Open-Meteo climatology + Ticketmaster Discovery v2 + BLS'
    : 'data pending (Google Trends + local events)';

  const c5Items = [];
  c5Items.push(data.hours_complete === true ? 'hours: complete (7 days)' : data.hours_complete === false ? 'hours: incomplete' : 'hours: unmeasured');
  c5Items.push(data.website_exists === true ? 'website: loads' : data.website_exists === false ? 'website: not loading / blocked' : (data.website_url ? 'website: check inconclusive' : 'website: not listed on GBP'));
  if (data.is_open_now === true) c5Items.push('open now');
  else if (data.is_open_now === false) c5Items.push('closed now');
  const c5Line = c5Items.join(', ');

  // Phase 5+ — PageSpeed Insights fills C6 Brand
  const c6Items = [];
  if (typeof data.website_mobile_score === 'number') c6Items.push(`mobile score ${data.website_mobile_score}/100`);
  if (typeof data.load_time_seconds === 'number') c6Items.push(`load ${data.load_time_seconds}s`);
  if (typeof data.lcp_seconds === 'number') c6Items.push(`LCP ${data.lcp_seconds}s`);
  const c6Line = c6Items.length
    ? c6Items.join(', ') + ' — Google PageSpeed Insights (mobile)'
    : 'data pending (no website to measure, or PSI failed/timed out)';

  const c7Items = [];
  if (Array.isArray(profile.compliance_notes) && profile.compliance_notes.length) {
    c7Items.push(`${profile.compliance_notes.length} sector compliance note${profile.compliance_notes.length === 1 ? '' : 's'} applied`);
  }
  if (typeof data.google_review_count === 'number' && data.google_review_count === 0) c7Items.push('zero-reviews flag fires');
  if (data.business_status && data.business_status !== 'OPERATIONAL') c7Items.push(`business_status: ${data.business_status}`);
  // Phase 5+ — sector compliance signals
  if (data.npi) {
    c7Items.push(`NPI ${data.npi_authorized ? 'Active' : (data.npi_status || 'unknown')}${data.npi_number ? ` (#${data.npi_number})` : ''}`);
  }
  if (data.fmcsa && data.dot_number) {
    const sr = data.safety_rating || 'unrated';
    c7Items.push(`FMCSA ${sr}, DOT#${data.dot_number}`);
  }
  if (data.cms && data.cms_overall_rating != null && data.cms_overall_rating !== '') {
    c7Items.push(`CMS overall ${data.cms_overall_rating}/5`);
  }
  const c7Line = c7Items.length ? c7Items.join('; ') : 'no compliance flags';

  // Per-category top-10 contribution: which categories produced top-10 actions?
  const fieldToCategory = (f) => {
    const c1 = ['google_rating', 'google_review_count', 'review_recency_days', 'response_rate_estimated', 'responds_to_reviews', 'photo_count', 'platform_count', 'business_age_months', 'reviews_sampled',
      'ta_rating', 'ta_review_count', 'ta_ranking_position', 'ta_ranking_out_of',
      'ta_subratings', 'ta_value_gap_detected'];
    const c2 = ['median_household_income', 'total_population', 'average_household_size',
      'anchor_tenant_count', 'has_transit_nearby', 'nearest_transit_meters',
      'building_permits_total', 'building_permits_single_family',
      'building_permits_yoy_change', 'building_permits_year', 'county_fips',
      'nearby_venues', 'nearby_venue_count',
      'top_commodity', 'farm_count', 'state_ag_profile',
      'fmr_studio', 'fmr_1br', 'fmr_2br', 'fmr_metro_name', 'fmr_year'];
    const c3 = ['competitor_count', 'competitor_median_rating', 'competitor_median_review_count',
      'fdic_total_deposits', 'fdic_total_assets', 'fdic_bank_name'];
    const c4 = ['peak_tourist_season', 'has_cold_winter', 'has_hot_summer', 'peak_month',
      'bls_employment_level', 'bls_employment_year', 'bls_employment_period'];
    const c5 = ['hours_complete', 'is_open_now', 'online_booking', 'accepts_credit_cards', 'accepts_insurance_visible'];
    const c6 = ['website_exists', 'website_url', 'page_speed_seconds', 'website_mobile_friendly',
      'website_mobile_score', 'load_time_seconds', 'lcp_seconds', 'is_mobile_friendly'];
    const c7 = ['business_status', 'years_in_business',
      'npi_status', 'npi_authorized', 'npi_number', 'provider_type',
      'safety_rating', 'allowed_to_operate', 'dot_number', 'total_drivers', 'total_trucks',
      'cms_overall_rating', 'cms_patient_experience_rating', 'cms_mortality_rating',
      'cms_safety_rating', 'cms_readmission_rating', 'cms_timeliness_rating'];
    if (c1.includes(f)) return 'C1';
    if (c2.includes(f)) return 'C2';
    if (c3.includes(f)) return 'C3';
    if (c4.includes(f)) return 'C4';
    if (c5.includes(f)) return 'C5';
    if (c6.includes(f)) return 'C6';
    if (c7.includes(f)) return 'C7';
    return null;
  };
  const topByCat = { C1: [], C2: [], C3: [], C4: [], C5: [], C6: [], C7: [] };
  (ranked.top10 || []).forEach((t, idx) => {
    const ev = evidenceForRec(t.rec, data);
    const cats = new Set();
    for (const c of ev.compares) {
      const cat = fieldToCategory(c.field);
      if (cat) cats.add(cat);
    }
    for (const f of ev.unknowns) {
      const cat = fieldToCategory(f);
      if (cat) cats.add(cat);
    }
    for (const cat of cats) topByCat[cat].push(`#${idx + 1}`);
  });
  const tagFor = (cat) => topByCat[cat].length ? ` — actions: ${topByCat[cat].join(', ')}` : '';

  // Phase 5+ — dynamic C8-C11 rows. C8/C9/C10 only render when their
  // data field is populated. C11 always renders — events array may be
  // empty and that's still useful information ("no major events").
  const extraRows = [];
  if (data.hud_fmr && data.hud_fmr.fmr_2br != null) {
    const fmr = data.hud_fmr;
    const metro = fmr.metro_name || '—';
    const yr = fmr.fmr_year || '—';
    extraRows.push(`<tr><td><strong>C8 Regional Rents</strong></td><td>2BR rent benchmark: $${fmr.fmr_2br.toLocaleString('en-US')}/mo (${escapeHtml(String(metro))}, ${escapeHtml(String(yr))})</td></tr>`);
  }
  if (data.bls_employment && data.bls_employment.employment_level != null) {
    const bls = data.bls_employment;
    const period = bls.employment_period || '';
    const yr = bls.employment_year || '';
    const periodLabel = (period || yr) ? `${period} ${yr}`.trim() : '—';
    extraRows.push(`<tr><td><strong>C9 Employment Trend</strong></td><td>${bls.employment_level.toLocaleString('en-US')} sector jobs nationally (${escapeHtml(periodLabel)})</td></tr>`);
  }
  if (Array.isArray(data.nearby_venues) && data.nearby_venues.length > 0) {
    const top3 = data.nearby_venues.slice(0, 3).map((v) => v.name).join(', ');
    extraRows.push(`<tr><td><strong>C10 Nearby Venues</strong></td><td>Top nearby: ${escapeHtml(top3)}</td></tr>`);
  }
  // C11 always renders — the absence of events is itself a signal.
  {
    const events = Array.isArray(data.upcoming_events) ? data.upcoming_events : [];
    const content = events.length > 0
      ? `${events.length} events within 10mi next 90 days`
      : 'No major events found within 10mi';
    extraRows.push(`<tr><td><strong>C11 Upcoming Events</strong></td><td>${escapeHtml(content)}</td></tr>`);
  }

  const totalCategoryCount = 7 + extraRows.length;
  const categoryCoverageHtml = `<h2>What we analyzed — ${totalCategoryCount} signal categories</h2>
<table class="coverage">
  <tr><td><strong>C1 Online Presence</strong></td><td>${escapeHtml(c1Line)}${tagFor('C1')}</td></tr>
  <tr><td><strong>C2 Location &amp; Market</strong></td><td>${escapeHtml(c2Line)}${tagFor('C2')}</td></tr>
  <tr><td><strong>C3 Competition</strong></td><td>${escapeHtml(c3Line)}${tagFor('C3')}</td></tr>
  <tr><td><strong>C4 Demand</strong></td><td>${escapeHtml(c4Line)}${tagFor('C4')}</td></tr>
  <tr><td><strong>C5 Operations</strong></td><td>${escapeHtml(c5Line)}${tagFor('C5')}</td></tr>
  <tr><td><strong>C6 Brand</strong></td><td>${escapeHtml(c6Line)}${tagFor('C6')}</td></tr>
  <tr><td><strong>C7 Risk &amp; Compliance</strong></td><td>${escapeHtml(c7Line)}${tagFor('C7')}</td></tr>
  ${extraRows.join('\n  ')}
</table>`;

  let footerHtml = `<h2>Citations</h2>`;
  if (allCitedIds.size === 0) {
    footerHtml += `<p>No studies cited.</p>`;
  } else {
    footerHtml += `<ul>${Array.from(allCitedIds).map((id) => {
      const s = studies.find((x) => x.id === id);
      if (!s) return `<li>${escapeHtml(id)} (not found)</li>`;
      const tier3 = s.tier === 3 ? ' <small>[TIER-3 VENDOR]</small>' : '';
      return `<li><strong>${escapeHtml(s.id)}</strong> (Tier ${s.tier})${tier3}: ${escapeHtml(s.citation)}</li>`;
    }).join('')}</ul>`;
  }
  footerHtml += `<p class="meta"><small>Generated ${new Date().toISOString()}</small></p>`;

  return `${PAGE_OPEN}<a class="back" href="/">&larr; new search</a>
${headerHtml}
${overallHtml}
${localContextHtml}
${redFlagsHtml}
${strengthsHtml}
${industrySurvivalHtml}
${tripAdvisorHtml}
${qualityRatingsHtml}
${complianceHtml}
${competitiveHtml}
${competitorComparisonHtml}
${marketHtml}
${demandHtml}
${opsHtml}
${priorityHtml}
${ninetyDayPlanHtml}
${seasonalStrategyHtml}
${opportunitiesHtml}
${commonProblemsHtml}
${categoryCoverageHtml}
${footerHtml}${PAGE_CLOSE}`;
}

function citationLine(id, studies) {
  const s = studies.find((x) => x.id === id);
  if (!s) return `[${escapeHtml(id)}]`;
  const tier3 = s.tier === 3 ? ' [TIER-3 VENDOR]' : '';
  return `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.id)}</a> ${escapeHtml(s.citation)}${tier3}`;
}

// ───────────────────────────────────────────────────────────────────
// BATCH16 — Common Problems Detected (review-mined)
// ───────────────────────────────────────────────────────────────────
// 8-step procedure from BATCH16.pdf p.3:
//   1. fetch reviews (already in data.sample_reviews)
//   2. match each review.text against sector vocabulary keywords
//   3. count mentions per theme
//   4. weight by star rating (1*=1.5, 2*=1.2, 3*=1.0, 4*=0.5, 5*=0.3)
//   5. rank by weighted_score, threshold >= 1.5
//   6. tag with [REVIEW EVIDENCE] / [REASONABLE INFERENCE] / [CUSTOMER MUST VALIDATE]
//   7. render top 3
//   8. edge cases: <10 reviews, no themes above threshold, non-English

const STAR_WEIGHTS = { 1: 1.5, 2: 1.2, 3: 1.0, 4: 0.5, 5: 0.3 };

function analyzeCommonProblems(reviews, profileId) {
  const sectorVocab = sectorProblems[profileId];
  if (!sectorVocab) {
    return { skip: true, reason: 'no-vocab' };
  }
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return { skip: true, reason: 'no-reviews', reviewCount: 0 };
  }
  if (reviews.length < 5) {
    // Threshold set to 5 to match Google legacy API max review count.
    // Bump to 10 when Places API New is wired in Phase 5.
    return {
      skip: false,
      insufficient: true,
      reviewCount: reviews.length,
      sectorLabel: sectorVocab.sector_label,
    };
  }

  // Score each theme.
  const themeScores = sectorVocab.themes.map((theme) => {
    let mentions = 0;
    let weighted = 0;
    const matchingReviews = [];
    for (const r of reviews) {
      const text = (r.text || '').toLowerCase();
      if (!text) continue;
      const hit = theme.keywords.some((kw) => text.includes(kw.toLowerCase()));
      if (!hit) continue;
      mentions += 1;
      const star = typeof r.rating === 'number' ? Math.round(r.rating) : 3;
      const w = STAR_WEIGHTS[star] || 1.0;
      weighted += w;
      matchingReviews.push({ rating: star, weight: w });
    }
    return {
      name: theme.name,
      fix_direction: theme.fix_direction,
      mentions,
      weighted: +weighted.toFixed(2),
      matching: matchingReviews,
      hasOneStar: matchingReviews.some((m) => m.rating === 1),
      total: reviews.length,
    };
  }).filter((x) => x.weighted >= 1.5);

  themeScores.sort((a, b) => b.weighted - a.weighted);
  const topThemes = themeScores.slice(0, 3);

  return {
    skip: false,
    insufficient: false,
    reviewCount: reviews.length,
    sectorLabel: sectorVocab.sector_label,
    themes: topThemes,
    allBelowThreshold: topThemes.length === 0,
  };
}

function renderCommonProblems(analysis) {
  if (analysis.skip && analysis.reason === 'no-vocab') return '';
  if (analysis.skip && analysis.reason === 'no-reviews') return '';

  let body = '';
  if (analysis.insufficient) {
    body = `<p>Need more reviews for pattern analysis. We found ${analysis.reviewCount} review${analysis.reviewCount === 1 ? '' : 's'} on Google for this business; come back when you have 10+ Google reviews and we'll mine recurring complaint themes for you.</p>`;
  } else if (analysis.allBelowThreshold) {
    body = `<p>No recurring complaints detected in your last ${analysis.reviewCount} reviews. Review content looks healthy.</p>`;
  } else {
    body = `<p class="meta">Reading your last ${analysis.reviewCount} reviews against the ${escapeHtml(analysis.sectorLabel)} complaint vocabulary, ${analysis.themes.length} theme${analysis.themes.length === 1 ? '' : 's'} surfaced above threshold:</p>`;
    body += analysis.themes.map((th) => {
      const sevTag = th.hasOneStar
        ? ` <span class="extra-tag extra-tag-hidden">includes 1-star mention</span>`
        : '';
      return `<div class="problem">
<h3>${escapeHtml(th.name)}${sevTag}</h3>
<div class="honesty honesty-verified"><span class="hmark">[REVIEW EVIDENCE]</span> ${th.mentions} of ${th.total} reviews mention this (weighted score ${th.weighted}).</div>
<div class="honesty honesty-reasonable-inference"><span class="hmark">[REASONABLE INFERENCE]</span> Typically points to: ${escapeHtml(th.fix_direction)}.</div>
<div class="honesty honesty-customer-must-validate"><span class="hmark">[CUSTOMER MUST VALIDATE]</span> Confirm with your operations — the algorithm sees what reviewers wrote, not what's actually happening on-site.</div>
</div>`;
    }).join('');
  }

  return `<h2>What your customers are saying — common problems detected</h2>${body}`;
}

// ───────────────────────────────────────────────────────────────────
// BATCH14 — Money-estimate methodology (CHANGE 6)
// ───────────────────────────────────────────────────────────────────
// Gates (all must pass — otherwise no money estimate is shown):
//   - Impact is HIGH or MEDIUM
//   - At least one cited study is Tier 1 or Tier 2 (not Tier 3 vendor)
//   - Recommendation magnitude string contains a parseable numeric % range
//   - Sector revenue baseline can be reasonably estimated
//
// Method:
//   1. Look up the profile's sector revenue baseline range [low, high]
//   2. Apply size multiplier (review-count-derived: small/med/large/very large)
//   3. Compute estimated annual revenue baseline = midpoint × multiplier
//   4. Apply the study % range to that baseline → $X–$Y/year
//   5. Show one-line math + standard caveat

const SECTOR_BASELINES_USD = {
  'hospitality.lodging': [800000, 5000000],
  'hospitality.full_service_restaurant': [500000, 2000000],
  'hospitality.cafe_quick_service': [300000, 1500000],
  'healthcare.dental_practice': [400000, 1500000],
  'healthcare.medical_practice': [400000, 1500000],
  'other_services.auto_repair': [300000, 1200000],
  'recreation.fitness_studio': [200000, 800000],
  'retail.specialty_brick_mortar': [200000, 1000000],
  'retail.auto_dealers': [2000000, 20000000],
  'retail.grocery_food': [400000, 2500000],
  'hospitality.bar_nightlife': [400000, 1500000],
  'hospitality.catering_special_food': [300000, 1500000],
};
const DEFAULT_BASELINE_USD = [150000, 600000];

function sizeMultiplier(reviewCount) {
  if (typeof reviewCount !== 'number') return 1.0;
  if (reviewCount < 50) return 0.5;
  if (reviewCount < 200) return 1.0;
  if (reviewCount < 500) return 1.5;
  return 2.0;
}

function sizeLabel(reviewCount) {
  if (typeof reviewCount !== 'number') return 'medium';
  if (reviewCount < 50) return 'small';
  if (reviewCount < 200) return 'medium';
  if (reviewCount < 500) return 'large';
  return 'very large';
}

/* Parse a magnitude string like "9-11% RevPAR per reputation point" or
   "1-3% RevPAR per 10pp lift" or "33% revenue impact" → [low, high] as
   decimals. Returns null when no numeric % is present. */
function parsePctMagnitude(magStr) {
  if (!magStr || typeof magStr !== 'string') return null;
  // Match "X-Y%" or "X to Y%" first.
  let m = magStr.match(/(\d+(?:\.\d+)?)\s*[-–to]+\s*(\d+(?:\.\d+)?)\s*%/i);
  if (m) {
    const lo = parseFloat(m[1]) / 100;
    const hi = parseFloat(m[2]) / 100;
    if (lo > 0 && hi > 0 && lo <= hi) return [lo, hi];
  }
  // Single-percent fallback: "33%" → [33%, 33%] (tight range).
  m = magStr.match(/(\d+(?:\.\d+)?)\s*%/);
  if (m) {
    const v = parseFloat(m[1]) / 100;
    if (v > 0) return [v, v];
  }
  return null;
}

function pickKpi(profileId) {
  if (profileId.startsWith('hospitality.lodging')) return 'RevPAR (revenue per available room) monthly';
  if (profileId.startsWith('hospitality.bar_nightlife')) return 'monthly cover count + average tab';
  if (profileId.startsWith('hospitality')) return 'monthly cover count';
  if (profileId.startsWith('healthcare')) return 'new-patient acquisition rate';
  if (profileId.startsWith('other_services.auto_repair')) return 'monthly ticket count';
  if (profileId.startsWith('recreation.fitness_studio')) return '12-month member retention';
  if (profileId.startsWith('retail')) return 'monthly transaction count';
  if (profileId.startsWith('professional')) return 'monthly billable engagements';
  return 'monthly revenue';
}

function buildMoneyEstimate(t, data, profile, studies) {
  // Gate 1 — impact tier
  if (t.impact !== 'HIGH' && t.impact !== 'MEDIUM') return '';
  // Gate 2 — at least one Tier 1 or Tier 2 study
  const tiers = t.rec.study_ids
    .map((sid) => studies.find((s) => s.id === sid))
    .filter(Boolean)
    .map((s) => s.tier);
  if (!tiers.some((t) => t === 1 || t === 2)) return '';
  // Gate 3 — parseable % magnitude
  const pctRange = parsePctMagnitude(t.rec.magnitude);
  if (!pctRange) return '';
  // Gate 4 — baseline available (always true with default)
  const baselineRange = SECTOR_BASELINES_USD[profile.id] || DEFAULT_BASELINE_USD;
  const reviewCount = typeof data.google_review_count === 'number' ? data.google_review_count : null;
  const mult = sizeMultiplier(reviewCount);
  const sizeName = sizeLabel(reviewCount);
  const midBaseline = ((baselineRange[0] + baselineRange[1]) / 2) * mult;

  const lowMoney = Math.round(midBaseline * pctRange[0]);
  const highMoney = Math.round(midBaseline * pctRange[1]);

  const fmtUsd = (n) => '$' + n.toLocaleString('en-US');
  const pctLow = (pctRange[0] * 100).toFixed(pctRange[0] < 0.01 ? 2 : 1).replace(/\.0$/, '');
  const pctHigh = (pctRange[1] * 100).toFixed(pctRange[1] < 0.01 ? 2 : 1).replace(/\.0$/, '');
  const pctDisplay = pctLow === pctHigh ? `${pctLow}%` : `${pctLow}–${pctHigh}%`;
  const moneyDisplay = lowMoney === highMoney
    ? `${fmtUsd(lowMoney)}/year`
    : `${fmtUsd(lowMoney)}–${fmtUsd(highMoney)}/year`;
  const kpi = pickKpi(profile.id);
  const reviewNote = reviewCount != null
    ? `${reviewCount} review${reviewCount === 1 ? '' : 's'} → ${sizeName} (×${mult})`
    : `unknown size (default ×1.0)`;

  return `<div class="money">
<strong>Money estimate: ${moneyDisplay}</strong><br>
<span class="meta">Math: ${fmtUsd(baselineRange[0])}–${fmtUsd(baselineRange[1])} sector baseline → midpoint ${fmtUsd((baselineRange[0] + baselineRange[1]) / 2)} × size multiplier (${reviewNote}) = ${fmtUsd(Math.round(midBaseline))} estimated annual revenue. Apply ${pctDisplay} cited study magnitude → ${moneyDisplay}.</span><br>
<em class="meta">Sector averages used. Track ${escapeHtml(kpi)} to measure your actual lift.</em>
</div>`;
}

// ───────────────────────────────────────────────────────────────────
// BATCH16 — KNOWN vs HIDDEN issue classification
// ───────────────────────────────────────────────────────────────────
//
// Compare each triggered rec's gap against competitor medians from the
// Phase-3 Nearby Search data. If competitors share the gap, mark KNOWN
// (cap score at 0.30, push to bottom). If competitors don't have it,
// mark HIDDEN (push to top regardless of raw score).
//
// Only `google_rating` and `google_review_count` gaps can be classified
// — those are the fields the Nearby Search returns medians for. Other
// gaps (response rate, recency, hours, etc.) stay 'normal' since we
// have no competitor signal for them.
function classifyKnownHidden(top10, data) {
  for (const t of top10) {
    const ev = evidenceForRec(t.rec, data);
    let classification = 'normal';
    let reason = '';

    for (const c of ev.compares) {
      const isLowComparison = c.op === '<' || c.op === '<=';
      if (!isLowComparison) continue;

      if (c.field === 'google_rating' && typeof data.competitor_median_rating === 'number' && c.threshold != null) {
        if (data.competitor_median_rating < c.threshold) {
          classification = 'known';
          reason = `competitors' median rating is ${data.competitor_median_rating.toFixed(1)} (also below benchmark ${c.threshold})`;
        } else {
          classification = 'hidden';
          reason = `competitors' median rating is ${data.competitor_median_rating.toFixed(1)} (above your gap threshold ${c.threshold})`;
        }
        break;
      }

      if (c.field === 'google_review_count' && typeof data.competitor_median_review_count === 'number' && c.threshold != null) {
        if (data.competitor_median_review_count < c.threshold) {
          classification = 'known';
          reason = `competitors' median review count is ${Math.round(data.competitor_median_review_count)} (also below benchmark ${c.threshold})`;
        } else {
          classification = 'hidden';
          reason = `competitors' median review count is ${Math.round(data.competitor_median_review_count)} (above your gap threshold ${c.threshold})`;
        }
        break;
      }
    }

    t.classification = classification;
    t.classificationReason = reason;

    if (classification === 'known') {
      t.score = Math.min(t.score, 0.30);
      // Recompute impact label after capping.
      if (t.score >= 0.60) t.impact = 'HIGH';
      else if (t.score >= 0.30) t.impact = 'MEDIUM';
      else if (t.score >= 0.10) t.impact = 'LOW';
      else t.impact = 'MINIMAL';
    }
  }

  // Re-sort: HIDDEN first (regardless of score), then normal by score desc,
  // then KNOWN at the bottom by capped score desc.
  const groupOrder = { hidden: 0, normal: 1, known: 2 };
  top10.sort((a, b) => {
    const ga = groupOrder[a.classification] ?? 1;
    const gb = groupOrder[b.classification] ?? 1;
    if (ga !== gb) return ga - gb;
    return b.score - a.score;
  });

  return top10;
}

// ───────────────────────────────────────────────────────────────────
// BATCH14 / BATCH16 — 3-layer recommendation rendering helpers
// ───────────────────────────────────────────────────────────────────

/* Walk a trigger AST and collect all (field, op, threshold) comparisons
   plus all is_unknown(field) invocations. Used to derive the [VERIFIED]
   evidence lines under "WHY YOUR BUSINESS". */
function collectTriggerEvidence(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'COMPARE' && node.left && node.left.type === 'FIELD') {
    let threshold = null;
    if (node.right && (node.right.type === 'NUMBER' || node.right.type === 'STRING' || node.right.type === 'BOOL')) {
      threshold = node.right.value;
    }
    out.compares.push({ field: node.left.name, op: node.op, threshold });
  }
  if (node.type === 'IS_UNKNOWN') {
    out.unknowns.push(node.field);
  }
  for (const k of ['left', 'right', 'operand']) {
    if (node[k]) collectTriggerEvidence(node[k], out);
  }
}

function evidenceForRec(rec, data) {
  const ev = { compares: [], unknowns: [] };
  try {
    const ast = triggerDsl.parse(rec.trigger);
    collectTriggerEvidence(ast, ev);
  } catch (e) {
    // bad trigger — skip evidence extraction
  }
  return ev;
}

/* Format a field value for display (handles null, booleans, percentages). */
function fmtFieldValue(field, value) {
  if (value === null || value === undefined) return 'unmeasured';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (field.includes('rate') && typeof value === 'number' && value <= 1) {
    return (value * 100).toFixed(0) + '%';
  }
  if (field.includes('income') && typeof value === 'number') {
    return '$' + value.toLocaleString('en-US');
  }
  return String(value);
}

function fmtThreshold(field, threshold) {
  return fmtFieldValue(field, threshold);
}

function opPhrase(op) {
  switch (op) {
    case '<': return 'below';
    case '<=': return 'at or below';
    case '>': return 'above';
    case '>=': return 'at or above';
    case '==': return 'equal to';
    case '!=': return 'not equal to';
    default: return op;
  }
}

/* Build the three layers for a single ranked recommendation `t`. Returns
   an HTML block. The trailing money-estimate slot is filled in CHANGE 6.
   Phase 5: when `enrichedRec` is provided (top-3 only), Claude's enriched
   WHY-IT-WORKS / WHY-YOUR-BUSINESS / money_estimate replace the deterministic
   versions. WHAT (rec.claim) stays deterministic. */
function renderRec3Layer(t, idx, data, studies, extraTags = [], enrichedRec = null) {
  const rec = t.rec;
  const impactClass = `impact impact-${t.impact.toLowerCase()}`;

  // Phase 5 — Claude-enriched path
  if (enrichedRec) {
    const aiBadge = ` <span class="ai-badge" title="Enriched by Claude">AI</span>`;
    const what = enrichedRec.what || rec.claim || '';
    const why = enrichedRec.why_it_works || '';
    const cite = enrichedRec.study_citation || '';
    const mag = enrichedRec.magnitude || rec.magnitude || '';
    const whyYou = enrichedRec.why_your_business || '';
    let moneyHtml = '';
    if (enrichedRec.money_estimate && enrichedRec.money_estimate.show !== false && enrichedRec.money_estimate.range) {
      const m = enrichedRec.money_estimate;
      moneyHtml = `<div class="money">
<strong>Money estimate: ${escapeHtml(m.range)}</strong><br>
${m.math ? `<span class="meta">Math: ${escapeHtml(m.math)}</span><br>` : ''}
${m.caveat ? `<em class="meta">${escapeHtml(m.caveat)}</em>` : ''}
</div>`;
    }
    const extraTagHtml = extraTags.length
      ? extraTags.map((eT) => `<span class="extra-tag extra-tag-${eT.cls}">${escapeHtml(eT.label)}</span>`).join(' ')
      : '';
    // Replace honesty-marker shorthand in why_your_business with styled spans.
    const styledWhyYou = (whyYou || '')
      .replace(/\[VERIFIED\]/g, '<span class="hmark hmark-verified">[VERIFIED]</span>')
      .replace(/\[REASONABLE INFERENCE\]/g, '<span class="hmark hmark-inference">[REASONABLE INFERENCE]</span>')
      .replace(/\[CUSTOMER MUST VALIDATE\]/g, '<span class="hmark hmark-validate">[CUSTOMER MUST VALIDATE]</span>');

    return `<div class="rec rec-${t.impact.toLowerCase()}">
<h3>${idx + 1}. <span class="${impactClass}">${escapeHtml(t.impact)} IMPACT</span>${aiBadge} ${extraTagHtml} · ${escapeHtml(rec.id)} <small>(score ${t.score.toFixed(2)})</small></h3>
<div class="layer layer-what"><span class="layer-label">WHAT:</span> ${escapeHtml(what)}</div>
<div class="layer layer-why"><span class="layer-label">WHY IT WORKS:</span>
<div class="why-study">
<p>${escapeHtml(why)}</p>
<p class="meta"><strong>Magnitude:</strong> ${escapeHtml(mag)}<br>
<strong>Source:</strong> ${escapeHtml(cite)}</p>
</div>
</div>
<div class="layer layer-business"><span class="layer-label">WHY YOUR BUSINESS:</span>
<p>${styledWhyYou}</p>
</div>
${moneyHtml}
<p class="meta">Score breakdown: magnitude ${t.magnitudeFactor.toFixed(2)} × evidence ${t.evidenceFactor.toFixed(2)} × ease ${t.easeFactor.toFixed(2)}</p>
</div>`;
  }

  // Phase 4 deterministic path (recs 4-10, or when enrichment unavailable)

  // Layer 2: WHY IT WORKS — pull each cited study's finding_summary.
  const studyBlocks = rec.study_ids.map((sid) => {
    const s = studies.find((x) => x.id === sid);
    if (!s) return `<div class="why-study"><strong>${escapeHtml(sid)}</strong> — not found in studies registry</div>`;
    const tierTag = s.tier === 3 ? ' <span class="tier3">[TIER-3 VENDOR]</span>' : '';
    const link = `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.id)}</a>`;
    return `<div class="why-study">
<p>${escapeHtml(s.finding_summary || s.claim || '')}</p>
<p class="meta"><strong>Magnitude:</strong> ${escapeHtml(rec.magnitude || '—')}<br>
<strong>Source:</strong> ${link} (Tier ${s.tier})${tierTag} — ${escapeHtml(s.citation)}</p>
</div>`;
  }).join('');

  // Layer 3: WHY YOUR BUSINESS — auto-derive from trigger + data fields.
  const ev = evidenceForRec(rec, data);
  const layer3Bits = [];

  // VERIFIED: each (field, op, threshold) where data has a real value.
  for (const c of ev.compares) {
    const actual = data[c.field];
    if (actual === null || actual === undefined) continue;
    const actualS = fmtFieldValue(c.field, actual);
    const threshS = c.threshold !== null ? fmtThreshold(c.field, c.threshold) : null;
    const phrase = threshS != null
      ? `Your <code>${escapeHtml(c.field)}</code> is ${escapeHtml(actualS)} (trigger fired ${escapeHtml(opPhrase(c.op))} ${escapeHtml(threshS)}).`
      : `Your <code>${escapeHtml(c.field)}</code> is ${escapeHtml(actualS)}.`;
    layer3Bits.push({ tag: 'VERIFIED', text: phrase });
  }
  // CUSTOMER MUST VALIDATE for is_unknown() and missing fields.
  for (const f of ev.unknowns) {
    if (data[f] === null || data[f] === undefined) {
      layer3Bits.push({
        tag: 'CUSTOMER MUST VALIDATE',
        text: `Public data couldn't measure <code>${escapeHtml(f)}</code>. Verify from your own records or measure directly.`,
      });
    }
  }
  // Always-trigger (KPI-style) recs have no field comparisons.
  if (!layer3Bits.length && t.isAlwaysTrigger) {
    layer3Bits.push({
      tag: 'REASONABLE INFERENCE',
      text: 'Long-term KPI for this sector. Track this metric quarterly to confirm whether your business is on the recommended trajectory.',
    });
  }
  // Generic inference line (one per rec) — sector pattern.
  layer3Bits.push({
    tag: 'REASONABLE INFERENCE',
    text: `This pattern is typical for businesses like yours; the exact lift you'll see depends on execution quality and current baseline.`,
  });
  // Tier-3 disclosure line if any cited study is vendor-tier.
  if (rec.tier3_disclosure_required) {
    layer3Bits.push({
      tag: 'CUSTOMER MUST VALIDATE',
      text: 'One or more cited studies are vendor research (Tier 3) — validate the magnitude against independent sources before committing budget.',
    });
  }

  const layer3Html = layer3Bits.map((b) => {
    const cls = b.tag.toLowerCase().replace(/\s+/g, '-');
    return `<div class="honesty honesty-${cls}"><span class="hmark">[${escapeHtml(b.tag)}]</span> ${b.text}</div>`;
  }).join('');

  const extraTagHtml = extraTags.length
    ? extraTags.map((t) => `<span class="extra-tag extra-tag-${t.cls}">${escapeHtml(t.label)}</span>`).join(' ')
    : '';

  // Money estimate — wired in CHANGE 6. Reserved slot here.
  const moneyHtml = (typeof t.moneyEstimateHtml === 'string' && t.moneyEstimateHtml) ? t.moneyEstimateHtml : '';

  return `<div class="rec rec-${t.impact.toLowerCase()}">
<h3>${idx + 1}. <span class="${impactClass}">${escapeHtml(t.impact)} IMPACT</span> ${extraTagHtml} · ${escapeHtml(rec.id)} <small>(score ${t.score.toFixed(2)})</small></h3>
<div class="layer layer-what"><span class="layer-label">WHAT:</span> ${escapeHtml(rec.claim)}</div>
<div class="layer layer-why"><span class="layer-label">WHY IT WORKS:</span>
${studyBlocks}
</div>
<div class="layer layer-business"><span class="layer-label">WHY YOUR BUSINESS:</span>
${layer3Html}
</div>
${moneyHtml}
<p class="meta">Score breakdown: magnitude ${t.magnitudeFactor.toFixed(2)} × evidence ${t.evidenceFactor.toFixed(2)} × ease ${t.easeFactor.toFixed(2)}</p>
</div>`;
}
