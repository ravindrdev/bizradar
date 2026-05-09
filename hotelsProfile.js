/* hospitality.hotels_motels — hardcoded from BATCH13.pdf p.12
   The profileRegistry.json hospitality.lodging entry is just a stub; this
   module supplies the BATCH13 worked schema for hotels/motels. */

const HOTELS_MOTELS = {
  id: 'hospitality.hotels_motels',
  sector_naics2: '72',
  name: 'Hotels and motels (independent and chain)',
  naics6_codes: ['721110', '721120', '721191', '721199'],
  scope: 'in_scope',
  evidence_class: 'STRONG',
  required_inputs: [
    'place_id',
    'google_rating',
    'google_review_count',
    'business_status',
  ],
  optional_inputs: [
    'review_recency_days',
    'photo_count',
    'responds_to_reviews',
    'response_rate_estimated',
    'years_in_business',
    'competitor_density_5mi',
  ],
  missing_data_policy: 'estimate',
  benchmarks: {
    good_review_count: 100,
    good_rating: 4.2,
    good_response_rate: 0.4,
    review_recency_target_days: 30,
    photo_count_good: 50,
  },
  recommendations: [
    {
      id: 'rec_response_rate',
      study_ids: ['S004'],
      trigger:
        'response_rate_estimated < 0.40 OR is_unknown(response_rate_estimated)',
      claim:
        'Hotels responding to >40% of reviews see RevPAR lift; diminishing returns above 65%. Target band: 40-60%.',
      magnitude: '1-3% RevPAR per 10pp lift in response rate',
      ease: 'low_effort',
      tier3_disclosure_required: false,
    },
    {
      id: 'rec_reputation_index',
      study_ids: ['S001', 'S002'],
      trigger: 'google_rating < 4.0 OR google_review_count < 50',
      claim:
        '1-point reputation gain → 9-11% RevPAR lift (stronger for independents than chains).',
      magnitude: '9-11% RevPAR per reputation point',
      ease: 'medium_effort',
      tier3_disclosure_required: false,
    },
    {
      id: 'rec_engagement',
      study_ids: ['S003'],
      trigger: 'google_rating < 4.5 AND google_review_count > 50',
      claim:
        'Engaging with reviews moves RevPAR; 1pp lift in good-ratings share → 1.4% RevPAR.',
      magnitude: '1.4% RevPAR per pp good-ratings share',
      ease: 'low_effort',
      tier3_disclosure_required: false,
    },
  ],
  red_flags: [
    {
      id: 'rf_zero_reviews',
      trigger: 'google_review_count == 0',
      severity: 'warning',
      message:
        '0 Google reviews. Verify business is operational; the algorithm needs reviews to benchmark.',
      blocks_report: false,
    },
    {
      id: 'rf_closed_permanently',
      trigger: "business_status == 'CLOSED_PERMANENTLY'",
      severity: 'critical',
      message: 'Google reports this business as permanently closed.',
      blocks_report: true,
    },
  ],
  chain_handling: {
    description:
      'Branded hotels (Marriott/Hilton/etc) get magnitudes scaled down ~30% per the chain-vs-independent gap.',
    study_scaling: {
      S001: 0.7,
      S002: 0.7,
      S006: 0.0,
    },
  },
  compliance_notes: [],
  report_sections: [
    'header',
    'overall_status',
    'red_flags',
    'strengths',
    'priority_actions',
    'additional_opportunities',
    'competitive_context',
    'out_of_scope_data',
    'footer',
  ],
};

const HOTEL_NAICS_CODES = new Set(HOTELS_MOTELS.naics6_codes);

function resolveProfile(naics6) {
  if (HOTEL_NAICS_CODES.has(naics6)) return HOTELS_MOTELS;
  return null;
}

module.exports = { HOTELS_MOTELS, HOTEL_NAICS_CODES, resolveProfile };
