// _print_table.js — render testResults.json as a table.
const fs = require('fs');
const rows = JSON.parse(fs.readFileSync('testResults.json', 'utf8'));

const W = { num: 3, biz: 38, prof: 36, mode: 24, status: 14 };
const pad = (s, w) => {
  s = String(s == null ? '' : s);
  if (s.length > w) return s.slice(0, w - 1) + '…';
  return s.padEnd(w);
};

console.log(
  '| ' + pad('#', W.num) +
  ' | ' + pad('Business', W.biz) +
  ' | ' + pad('Profile', W.prof) +
  ' | ' + pad('Mode', W.mode) +
  ' | ' + pad('Status', W.status) +
  ' |'
);
console.log(
  '|' + '-'.repeat(W.num + 2) +
  '|' + '-'.repeat(W.biz + 2) +
  '|' + '-'.repeat(W.prof + 2) +
  '|' + '-'.repeat(W.mode + 2) +
  '|' + '-'.repeat(W.status + 2) +
  '|'
);

for (const r of rows) {
  console.log(
    '| ' + pad(r.line, W.num) +
    ' | ' + pad(r.business_name, W.biz) +
    ' | ' + pad(r.profile_id || '-', W.prof) +
    ' | ' + pad(r.mode || '-', W.mode) +
    ' | ' + pad(r.status, W.status) +
    ' |'
  );
}
