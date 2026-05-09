// _probe_hud.js — find a working HUD residential-permits service URL.
// Hits several candidate endpoints, shows what each returns.

const CANDIDATES = [
  // 1. The exact FeatureServer base from the user's spec
  'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Residential_Construction_Permits_by_County/FeatureServer?f=json',

  // 2. The HUD open-data hub root — search query for "permits"
  'https://hudgis-hud.opendata.arcgis.com/api/v3/datasets?q=residential+construction+permits&f=json',

  // 3. ArcGIS Hub search API
  'https://hub.arcgis.com/api/v3/datasets?q=HUD%20Residential%20Construction%20Permits&f=json',

  // 4. ArcGIS Online portal search
  'https://www.arcgis.com/sharing/rest/search?q=Residential%20Construction%20Permits%20by%20County%20HUD&f=json',
];

async function probe(url) {
  console.log('\n' + '─'.repeat(70));
  console.log('GET', url);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'BizRadar/1.0 (business audit tool)',
      },
    });
    const dt = Date.now() - t0;
    const ct = res.headers.get('content-type') || '';
    console.log(`  → HTTP ${res.status} ${res.statusText} (${dt}ms, ${ct})`);
    const body = await res.text();
    if (body.startsWith('<')) {
      console.log('  HTML response (first 200 chars):', body.slice(0, 200).replace(/\s+/g, ' '));
      return;
    }
    let json;
    try { json = JSON.parse(body); } catch { console.log('  Body (first 400):', body.slice(0, 400)); return; }
    // Surface useful fields
    if (json.error) {
      console.log(`  ArcGIS error: ${json.error.code} ${json.error.message}`);
    }
    if (json.layers) {
      console.log(`  ✓ FeatureServer layers found: ${json.layers.length}`);
      json.layers.forEach((l) => console.log(`     • id=${l.id}  name="${l.name}"  type=${l.type}`));
    }
    if (json.tables) {
      console.log(`  Tables: ${json.tables.length}`);
      json.tables.forEach((t) => console.log(`     • id=${t.id}  name="${t.name}"`));
    }
    if (json.serviceDescription !== undefined) console.log(`  serviceDescription: ${(json.serviceDescription || '').slice(0, 120)}`);
    if (json.copyrightText !== undefined) console.log(`  copyrightText: ${(json.copyrightText || '').slice(0, 120)}`);
    if (json.data && Array.isArray(json.data)) {
      console.log(`  ✓ Hub /datasets returned ${json.data.length} items. Top 5:`);
      json.data.slice(0, 5).forEach((d) => {
        const a = d.attributes || {};
        console.log(`     • ${a.name || d.id || '(unnamed)'}  | url: ${a.url || a.landingPage || '(no url)'}`);
        if (a.url) console.log(`       service: ${a.url}`);
      });
    }
    if (json.results && Array.isArray(json.results)) {
      console.log(`  ✓ ArcGIS portal returned ${json.results.length} results. Top 5:`);
      json.results.slice(0, 5).forEach((r) => {
        console.log(`     • "${r.title}" type=${r.type} owner=${r.owner}`);
        console.log(`       url: ${r.url || '(none)'}`);
      });
    }
  } catch (err) {
    console.log(`  ✗ fetch threw: ${err.message}`);
  }
}

(async () => {
  for (const url of CANDIDATES) await probe(url);
})();
