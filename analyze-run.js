#!/usr/bin/env node
/**
 * analyze-run.js — Extract per-round peak scores from a bot run log file.
 *
 * Usage:
 *   node smart-player-v9.js 2>&1 | tee run.log
 *   node analyze-run.js run.log
 *   node analyze-run.js run.log --summary
 */

const fs = require('fs');

const args = process.argv.slice(2);
const logFile = args.find(a => !a.startsWith('-'));
const showSummary = args.includes('--summary') || args.includes('-s');

if (!logFile) {
  console.error('Usage: node analyze-run.js <logfile> [--summary]');
  process.exit(1);
}

const content = fs.readFileSync(logFile, 'utf8');

// Join lines to handle PowerShell line-wrap artifact: "High:\n:51" → "High::51"
const joined = content.replace(/\r?\n/g, '\n');

// Split into per-round blocks
const blocks = joined.split(/=== Round /);

const rounds = [];

for (const block of blocks.slice(1)) {
  const rMatch = block.match(/^(\d+)\s*\/\s*(\d+)/);
  if (!rMatch) continue;
  const roundNum = parseInt(rMatch[1]);
  const totalRounds = parseInt(rMatch[2]);

  // Extract all High: values — handle wrap artifact "High:\n:51" by joining lines first
  const highMatches = [...block.matchAll(/High:[\n:]*(\d+)/g)];
  const highs = highMatches.map(m => parseInt(m[1])).filter(n => !isNaN(n));
  const peak = highs.length > 0 ? Math.max(...highs) : 0;

  // Duration
  const durMatch = block.match(/ended after (\d+)s/);
  const dur = durMatch ? parseInt(durMatch[1]) : null;

  // Cause
  const causeMatch = block.match(/cause:(\S+)/);
  const cause = causeMatch ? causeMatch[1] : 'unknown';

  // Trampoline hit detected
  const tramHit = /Tex:trampoline/.test(block) || /Tex:spring/.test(block);

  // Best API score logged in this round
  const apiMatch = block.match(/Score: ([\d.]+) \| Rank: (\d+)/);
  const apiScore = apiMatch ? parseFloat(apiMatch[1]) : null;
  const apiRank = apiMatch ? parseInt(apiMatch[2]) : null;

  rounds.push({ roundNum, totalRounds, peak, dur, cause, tramHit, apiScore, apiRank });
}

if (rounds.length === 0) {
  console.error('No rounds found in log file. Is this a valid bot run log?');
  process.exit(1);
}

// Print per-round table
const COL = { r: 4, peak: 6, dur: 5, cause: 8, tram: 5, api: 8 };
console.log(
  'R#'.padStart(COL.r) + '  ' +
  'Peak'.padEnd(COL.peak) + '  ' +
  'Dur'.padEnd(COL.dur) + '  ' +
  'Cause'.padEnd(COL.cause) + '  ' +
  'Tram'.padEnd(COL.tram) + '  ' +
  'API Best'
);
console.log('-'.repeat(50));

for (const r of rounds) {
  const tramIcon = r.tramHit ? '🚀' : '  ';
  const apiStr = r.apiScore != null ? `${r.apiScore.toFixed(1)} (#${r.apiRank})` : '';
  console.log(
    String(r.roundNum).padStart(COL.r) + '  ' +
    String(r.peak).padEnd(COL.peak) + '  ' +
    (r.dur != null ? `${r.dur}s` : '?').padEnd(COL.dur) + '  ' +
    r.cause.padEnd(COL.cause) + '  ' +
    tramIcon + '  ' +
    apiStr
  );
}

console.log('-'.repeat(50));

// Summary stats
const totalRoundsRan = rounds.length;
const peakAll = Math.max(...rounds.map(r => r.peak));
const bestRound = rounds.find(r => r.peak === peakAll);
const sumPeaks = rounds.reduce((s, r) => s + r.peak, 0);
const avgPeak = (sumPeaks / totalRoundsRan).toFixed(1);
const deadRounds = rounds.filter(r => r.peak === 0 && r.dur != null && r.dur <= 5).length;
const tramRounds = rounds.filter(r => r.tramHit).length;
const roundsOver50 = rounds.filter(r => r.peak >= 50).length;
const roundsOver100 = rounds.filter(r => r.peak >= 100).length;
const apiHighest = Math.max(...rounds.filter(r => r.apiScore != null).map(r => r.apiScore), 0);

console.log(`\nSummary (${totalRoundsRan} rounds):`);
console.log(`  Best single round : R${bestRound?.roundNum} → Peak:${peakAll} (${bestRound?.dur}s)`);
console.log(`  Average peak      : ${avgPeak}`);
console.log(`  Rounds ≥ 50       : ${roundsOver50} (${(100 * roundsOver50 / totalRoundsRan).toFixed(0)}%)`);
console.log(`  Rounds ≥ 100      : ${roundsOver100} (${(100 * roundsOver100 / totalRoundsRan).toFixed(0)}%)`);
console.log(`  Dead seeds (≤5s)  : ${deadRounds} (${(100 * deadRounds / totalRoundsRan).toFixed(0)}%)`);
console.log(`  Trampoline rounds : ${tramRounds} (${(100 * tramRounds / totalRoundsRan).toFixed(0)}%)`);
if (apiHighest > 0) console.log(`  API high score    : ${apiHighest.toFixed(1)}`);

if (showSummary) {
  console.log('\nTop 10 rounds:');
  const sorted = [...rounds].sort((a, b) => b.peak - a.peak).slice(0, 10);
  for (const r of sorted) {
    const tram = r.tramHit ? ' 🚀' : '';
    console.log(`  R${r.roundNum}: ${r.peak} pts (${r.dur}s, ${r.cause})${tram}`);
  }
}
