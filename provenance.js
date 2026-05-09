/* provenance.js — review-quote verification for market analysis output.

   Every quote Claude emits in the deep_dive is checked against the actual
   review_snippets we shipped to it. A quote is VERIFIED when its
   normalized text is a substring of any of the stored snippets;
   FABRICATED when no snippet contains it; and UNVERIFIED when the quote
   is too short (<20 chars) to make a reliable substring claim.

   verifyQuotes() walks three deep_dive sections:
     - steal_strategy[].actions_to_steal[].evidence
     - hidden_gaps[].evidence
     - personas[].review_source

   Returns a flat array of { quote, section, business, verified,
   matched_business?, matched_author?, matched_time?, reason? } so the
   renderer can decorate each quote with a colour-coded badge AND show
   the original reviewer's name + relative time when available.

   The verifier is pure — no I/O, no async — so it's safe to run inline
   inside the /market-analysis route handler. */

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pull the first quoted substring out of an evidence string. Most
// Claude outputs follow the schema "From {biz} Google review: '{quote}'"
// so the inner quote is between the first pair of double quotes.
// Falls back to the whole string when no quotes are found.
function extractQuote(evidenceStr) {
  if (!evidenceStr) return '';
  const s = String(evidenceStr);
  // Prefer double-quoted first, then single, then raw.
  let m = s.match(/"([^"]+)"/);
  if (m) return m[1];
  m = s.match(/'([^']+)'/);
  if (m) return m[1];
  return s;
}

function collectQuotes(deepDive) {
  const out = [];
  if (!deepDive || typeof deepDive !== 'object') return out;

  // Steal strategy — quote sits inside actions_to_steal[].evidence
  for (const s of (deepDive.steal_strategy || [])) {
    for (const a of (s && s.actions_to_steal) || []) {
      if (a && a.evidence) {
        out.push({
          quote: a.evidence,
          section: 'steal_strategy',
          business: s && s.business_name ? s.business_name : null,
        });
      }
    }
  }

  // Hidden gaps — quote in evidence
  for (const g of (deepDive.hidden_gaps || [])) {
    if (g && g.evidence) {
      out.push({
        quote: g.evidence,
        section: 'hidden_gaps',
        business: null,
      });
    }
  }

  // Personas — quote in review_source. Note: review_source can be
  // either a real review citation OR a "Real signal — {keyword} ..."
  // statement. Both are checked; the latter typically falls through to
  // verified=null because the extracted text is too short.
  for (const p of (deepDive.personas || [])) {
    if (p && p.review_source) {
      out.push({
        quote: p.review_source,
        section: 'personas',
        business: null,
      });
    }
  }

  return out;
}

function flattenSnippets(provenance) {
  const businesses = (provenance && provenance.local_businesses) || [];
  const out = [];
  for (const b of businesses) {
    for (const r of (b && b.review_snippets) || []) {
      // Snippets may be objects { text, author, time } or legacy strings;
      // accept both for robustness.
      const text = (r && typeof r === 'object') ? r.text : r;
      if (!text) continue;
      out.push({
        text,
        author: (r && typeof r === 'object') ? (r.author || null) : null,
        time: (r && typeof r === 'object') ? (r.time || null) : null,
        business_name: b.name || null,
        place_id: b.place_id || null,
      });
    }
  }
  return out;
}

function verifyQuotes(deepDive, provenance) {
  const quotes = collectQuotes(deepDive);
  const snippets = flattenSnippets(provenance);

  return quotes.map((q) => {
    const extracted = extractQuote(q.quote);
    const norm = normalize(extracted);

    if (norm.length < 20) {
      return {
        ...q,
        verified: null,
        reason: 'too short to verify (under 20 normalized chars)',
      };
    }

    const match = snippets.find((s) => normalize(s.text).includes(norm));
    if (match) {
      return {
        ...q,
        verified: true,
        matched_business: match.business_name,
        matched_author: match.author,
        matched_time: match.time,
        matched_place_id: match.place_id,
      };
    }
    return {
      ...q,
      verified: false,
      reason: 'not found in fetched review data',
    };
  });
}

module.exports = {
  verifyQuotes,
  // Exposed for tests / debugging
  _normalize: normalize,
  _extractQuote: extractQuote,
  _collectQuotes: collectQuotes,
  _flattenSnippets: flattenSnippets,
};
