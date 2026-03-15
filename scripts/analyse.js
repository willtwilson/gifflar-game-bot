'use strict';
const { readAll } = require('../lib/logger');

const records = readAll();
if (!records.length) { console.log('No records in results.jsonl yet.'); process.exit(0); }

const bySession = {};
records.forEach(r => {
  const sess = r.session || 'default';
  if (!bySession[sess]) bySession[sess] = [];
  bySession[sess].push(r);
});

console.log(`\n=== Gifflar Bot Analysis (${records.length} rounds total) ===\n`);

let allBest = 0;
Object.entries(bySession).forEach(([sess, rounds]) => {
  const scores   = rounds.map(r => r.score || 0);
  const best     = Math.max(...scores);
  const avg      = (scores.reduce((a,b)=>a+b,0) / scores.length).toFixed(1);
  const cheats   = rounds.filter(r => r.isCheater).length;
  const tramHits = rounds.reduce((a,r)=>a+(r.trampolineHits||0),0);
  const avgDur   = (rounds.reduce((a,r)=>a+(r.durationMs||0),0)/rounds.length/1000).toFixed(1);
  if (best > allBest) allBest = best;
  console.log(`Session ${sess}: ${rounds.length} rounds | Best=${best} | Avg=${avg} | Tramps=${tramHits} | AvgDur=${avgDur}s | Cheats=${cheats}`);
});

console.log(`\nAll-time best: ${allBest}`);
const allScores = records.map(r=>r.score||0);
console.log(`Global avg: ${(allScores.reduce((a,b)=>a+b,0)/allScores.length).toFixed(1)}`);
const causeGroups = {};
records.forEach(r => { const c = r.cause||'unknown'; causeGroups[c]=(causeGroups[c]||0)+1; });
console.log('\nDeath causes:');
Object.entries(causeGroups).sort((a,b)=>b[1]-a[1]).forEach(([c,n])=>console.log(`  ${c}: ${n}`));
