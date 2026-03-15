'use strict';

/**
 * neat-analyse.js — Analyse NEAT training results from neat-results.jsonl
 *
 * Usage:
 *   node scripts/neat-analyse.js
 */

const fs   = require('fs');
const path = require('path');

const RESULTS = path.join(__dirname, '..', 'neat-results.jsonl');

if (!fs.existsSync(RESULTS)) {
  console.log('No neat-results.jsonl found. Run `npm run neat` first.');
  process.exit(0);
}

const lines = fs.readFileSync(RESULTS, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

if (lines.length === 0) {
  console.log('neat-results.jsonl is empty.');
  process.exit(0);
}

// ── Aggregate per generation ───────────────────────────────────────────────
const byGen = new Map();
for (const row of lines) {
  const gen = row.generation || 1;
  if (!byGen.has(gen)) byGen.set(gen, []);
  byGen.get(gen).push(row);
}

// ── Print per-generation summary ──────────────────────────────────────────
console.log('\n══ Per-Generation Summary ══\n');
const header = 'Gen  | BestFit  | AvgFit   | BestScore | Cheaters | Species | Genomes';
console.log(header);
console.log('─'.repeat(header.length));

const genStats = [];
let allTimeBestFitness = -Infinity;
let allTimeBestEntry   = null;

for (const [gen, rows] of [...byGen.entries()].sort((a, b) => a[0] - b[0])) {
  const fitnesses = rows.map(r => r.fitness || 0);
  const scores    = rows.map(r => r.score   || 0);
  const bestFit   = Math.max(...fitnesses);
  const avgFit    = fitnesses.reduce((s, v) => s + v, 0) / fitnesses.length;
  const bestScore = Math.max(...scores);
  const cheaters  = rows.filter(r => r.isCheater).length;
  // Species count not stored per-row, but we can count unique genomeIds as a proxy
  const genomes   = rows.length;

  if (bestFit > allTimeBestFitness) {
    allTimeBestFitness = bestFit;
    allTimeBestEntry   = rows.find(r => (r.fitness || 0) === bestFit);
  }

  genStats.push({ gen, bestFit, avgFit, bestScore, cheaters, genomes });

  console.log(
    `${String(gen).padStart(4)} | ` +
    `${bestFit.toFixed(2).padStart(8)} | ` +
    `${avgFit.toFixed(2).padStart(8)} | ` +
    `${bestScore.toFixed(1).padStart(9)} | ` +
    `${String(cheaters).padStart(8)} | ` +
    `       - | ` +
    `${String(genomes).padStart(7)}`
  );
}

// ── All-time best ─────────────────────────────────────────────────────────
console.log('\n══ All-Time Best ══\n');
if (allTimeBestEntry) {
  console.log(`  Generation:     ${allTimeBestEntry.generation}`);
  console.log(`  Genome:         ${allTimeBestEntry.genomeId}`);
  console.log(`  Fitness:        ${(allTimeBestEntry.fitness || 0).toFixed(2)}`);
  console.log(`  Score:          ${(allTimeBestEntry.score   || 0).toFixed(1)}`);
  console.log(`  HighestY:       ${allTimeBestEntry.highestY || 0}`);
  console.log(`  TrampolineHits: ${allTimeBestEntry.trampolineHits || 0}`);
  console.log(`  Duration:       ${((allTimeBestEntry.durationMs || 0) / 1000).toFixed(1)}s`);
}

// ── ASCII Learning Curve ──────────────────────────────────────────────────
console.log('\n══ Learning Curve (Best Fitness) ══\n');

const BAR_WIDTH = 40;
const maxVal    = Math.max(...genStats.map(g => g.bestFit), 1);

for (const { gen, bestFit } of genStats) {
  const filled = Math.round((bestFit / maxVal) * BAR_WIDTH);
  const bar    = '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, BAR_WIDTH - filled));
  console.log(`Gen ${String(gen).padStart(3)}: [${bar}] ${bestFit.toFixed(1)}`);
}

console.log(`\nScale: ${maxVal.toFixed(1)} = full bar`);
console.log(`Total runs: ${lines.length} across ${byGen.size} generations\n`);
