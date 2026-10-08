'use strict';

/**
 * neat-monitor.js — Periodic NEAT training healthcheck daemon
 *
 * Runs every INTERVAL_MS, reads neat-results.jsonl + neat-checkpoint.json,
 * emits a health report to stdout and appends to neat-monitor.log.
 *
 * Usage:
 *   node scripts/neat-monitor.js             # every 5 min (default)
 *   node scripts/neat-monitor.js --interval 2  # every 2 min
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const RESULTS    = path.join(ROOT, 'neat-results.jsonl');
const CHECKPOINT = path.join(ROOT, 'neat-checkpoint.json');
const LOG_FILE   = path.join(ROOT, 'neat-monitor.log');

const args = process.argv.slice(2);
const intervalIdx = args.indexOf('--interval');
const INTERVAL_MIN = intervalIdx !== -1 ? parseFloat(args[intervalIdx + 1]) || 5 : 5;
const INTERVAL_MS  = INTERVAL_MIN * 60 * 1000;

// ── Health report ──────────────────────────────────────────────────────────
function report() {
  const now = new Date().toISOString();
  const lines = [];
  const out = (s) => lines.push(s);

  out(`\n${'═'.repeat(64)}`);
  out(`NEAT Monitor — ${now}`);
  out(`${'═'.repeat(64)}`);

  // ── Results ──────────────────────────────────────────────────────────────
  if (!fs.existsSync(RESULTS)) {
    out('  ⚠️  neat-results.jsonl not found — training may not have started');
  } else {
    const rows = fs.readFileSync(RESULTS, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    if (rows.length === 0) {
      out('  ⚠️  neat-results.jsonl is empty');
    } else {
      const byGen = new Map();
      for (const r of rows) {
        const g = r.generation || 1;
        if (!byGen.has(g)) byGen.set(g, []);
        byGen.get(g).push(r);
      }

      const sortedGens = [...byGen.keys()].sort((a, b) => a - b);
      const latestGen  = sortedGens[sortedGens.length - 1];
      const latestRows = byGen.get(latestGen);

      // All-time best
      let allTimeBest = { fitness: -Infinity, score: 0, genomeId: '?', generation: 0 };
      for (const r of rows) {
        if ((r.fitness || 0) > allTimeBest.fitness) allTimeBest = r;
      }

      out(`\n  📊 Results: ${rows.length} total runs across ${byGen.size} generations`);
      out(`\n  🏆 All-time best: Gen ${allTimeBest.generation} | ${allTimeBest.genomeId} | fitness=${(allTimeBest.fitness||0).toFixed(1)} | score=${(allTimeBest.score||0).toFixed(1)}`);
      out(`\n  📈 Per-generation summary:`);
      out(`     ${'Gen'.padEnd(5)} ${'Best fit'.padStart(9)} ${'Avg fit'.padStart(9)} ${'Best score'.padStart(11)} ${'Runs'.padStart(5)} ${'0-score'.padStart(7)}`);

      for (const gen of sortedGens) {
        const genRows = byGen.get(gen);
        const fits    = genRows.map(r => r.fitness || 0);
        const scores  = genRows.map(r => r.score   || 0);
        const zeroScores = scores.filter(s => s === 0).length;
        const bestFit = Math.max(...fits);
        const avgFit  = fits.reduce((a, b) => a + b, 0) / fits.length;
        const bestScore = Math.max(...scores);
        const isLatest = gen === latestGen ? ' ← current' : '';
        out(`     ${String(gen).padEnd(5)} ${bestFit.toFixed(1).padStart(9)} ${avgFit.toFixed(1).padStart(9)} ${bestScore.toFixed(1).padStart(11)} ${String(genRows.length).padStart(5)} ${String(zeroScores).padStart(7)}${isLatest}`);
      }

      // ── Health checks ─────────────────────────────────────────────────
      out(`\n  🩺 Health checks:`);

      // Last 5 runs all zero scores?
      const recent = rows.slice(-10);
      const recentZeros = recent.filter(r => (r.score || 0) === 0).length;
      if (recentZeros === recent.length && recent.length >= 5) {
        out(`  ❌ WARN: Last ${recent.length} runs all have score=0 — possible browser crash or game load failure`);
      } else {
        out(`  ✅ Scores: ${recent.length - recentZeros}/${recent.length} recent runs scored >0`);
      }

      // Any durationMs=0 (crash signal)?
      const crashRuns = recent.filter(r => (r.durationMs || 0) === 0).length;
      if (crashRuns > 0) {
        out(`  ❌ WARN: ${crashRuns} recent runs with durationMs=0 — likely error/crash in runGenome()`);
      } else {
        out(`  ✅ No crash signals in recent runs`);
      }

      // Fitness trend (last 3 gens)
      if (sortedGens.length >= 3) {
        const last3 = sortedGens.slice(-3).map(g => Math.max(...byGen.get(g).map(r => r.fitness || 0)));
        const trending = last3[2] > last3[0];
        out(`  ${trending ? '✅' : '⚠️ '} Fitness trend last 3 gens: ${last3.map(f => f.toFixed(1)).join(' → ')} ${trending ? '(improving)' : '(not improving)'}`);
      }

      // Zero-score runs in current gen
      const curZeros = latestRows.filter(r => (r.score || 0) === 0).length;
      if (curZeros > latestRows.length * 0.5 && latestRows.length >= 5) {
        out(`  ⚠️  Current gen: ${curZeros}/${latestRows.length} runs scored 0 — evolution may be in a valley`);
      }

      // Trampoline hits — are genomes finding trampolines?
      const tramHits = rows.slice(-20).filter(r => (r.trampolineHits || 0) > 0).length;
      out(`  ${tramHits > 0 ? '✅' : '⚠️ '} Trampoline discovery: ${tramHits}/20 recent runs hit a trampoline`);
    }
  }

  // ── Checkpoint ───────────────────────────────────────────────────────────
  out(`\n  💾 Checkpoint:`);
  if (!fs.existsSync(CHECKPOINT)) {
    out('  ⚠️  neat-checkpoint.json not found');
  } else {
    try {
      const cp = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));
      const cpAge = Date.now() - fs.statSync(CHECKPOINT).mtimeMs;
      const cpAgeMin = (cpAge / 60000).toFixed(1);
      out(`     Generation:  ${cp.generation}`);
      out(`     Best fitness: ${(cp.bestFitness ?? -Infinity).toFixed ? (cp.bestFitness ?? -Infinity).toFixed(1) : cp.bestFitness}`);
      out(`     Genomes:     ${cp.genomes?.length ?? '?'}`);
      out(`     Species:     ${cp.species?.length ?? '?'}`);
      out(`     Last updated: ${cpAgeMin} min ago`);
      if (cp._midGen) {
        out(`     Mid-gen state: Gen ${cp._midGen.gen + 1}, genome ${cp._midGen.genomeIndex + 1}/${cp.genomes?.length ?? '?'}`);
      }
      if (cpAge > INTERVAL_MS * 1.5) {
        out(`  ⚠️  Checkpoint is ${cpAgeMin} min old — training may have stalled or crashed`);
      } else {
        out(`  ✅ Checkpoint recently updated`);
      }
    } catch (e) {
      out(`  ❌ ERROR reading checkpoint: ${e.message}`);
    }
  }

  out(`\n${'─'.repeat(64)}\n`);

  const text = lines.join('\n');
  process.stdout.write(text + '\n');

  // Append to log file
  fs.appendFileSync(LOG_FILE, text + '\n', 'utf8');
}

// ── Main loop ──────────────────────────────────────────────────────────────
console.log(`🔍 NEAT Monitor started — reporting every ${INTERVAL_MIN} min (log: neat-monitor.log)`);
console.log('   Press Ctrl+C to stop.\n');

report(); // Run immediately on startup

setInterval(report, INTERVAL_MS);
