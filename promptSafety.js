/* promptSafety.js - shared prompt-injection input stripper.

   sanitizeForPrompt was moved here VERBATIM from claudeEnricher.js (audit
   fix CE1) so the rate flow (claudeEnricher), the market flow
   (claudeMarketAnalyst), and the competitor-research helpers (googlePlaces)
   can all run untrusted text (business name/address, customer reviews,
   competitor names/reviews, web/Wikipedia content) through the SAME stripper
   before interpolating it into a Claude prompt.

   Behaviour (unchanged): strips ASCII/Unicode control + zero-width/BOM/
   line-separator chars and angle brackets, then truncates ONLY when maxLen
   is finite. Call with maxLen = Infinity for STRIP-ONLY on full-verbatim
   review text (the s.length > Infinity test is always false). */
function sanitizeForPrompt(value, maxLen = 200) {
  if (value == null) return '';
  let s = String(value);
  // Strip ASCII / zero-width / BOM / line-separator control chars.
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '');
  // Strip angle brackets so attacker can't open a fake XML tag.
  s = s.replace(/[<>]/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen) + '…';
  return s;
}

module.exports = { sanitizeForPrompt };
