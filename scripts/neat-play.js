'use strict';

/**
 * neat-play.js — NEAT training orchestration
 *
 * Usage:
 *   node scripts/neat-play.js                   # start fresh
 *   node scripts/neat-play.js --resume           # resume from neat-checkpoint.json
 *   node scripts/neat-play.js --generations 50  # override max generations
 *   node scripts/neat-play.js --pop-size 30      # override population size
 */

const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');

const config           = require('../neat/neat-config.js');
const innovationTracker = require('../neat/innovation.js');
const { Population }   = require('../neat/population.js');
const { calcFitness }  = require('../neat/fitness.js');
const neatBrainSrc     = fs.readFileSync(path.join(__dirname, '..', 'lib', 'neat-brain.js'), 'utf8');

// ── Constants ──────────────────────────────────────────────────────────────
const GAME_URL    = 'https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f';
const EMAIL       = 'willtwilson+giff@gmail.com';
const NAME        = 'Will Wilson';
const USERNAME    = 'Frilliam';
const CHECKPOINT  = path.join(__dirname, '..', 'neat-checkpoint.json');
const RESULTS     = path.join(__dirname, '..', 'neat-results.jsonl');

// ── CLI args ───────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const resume  = args.includes('--resume');

const genArg  = args.indexOf('--generations');
if (genArg !== -1) config.maxGenerations = parseInt(args[genArg + 1], 10);

const popArg  = args.indexOf('--pop-size');
if (popArg !== -1) config.populationSize = parseInt(args[popArg + 1], 10);

// ── Helpers ────────────────────────────────────────────────────────────────
function appendResult(entry) {
  fs.appendFileSync(RESULTS, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}

function saveCheckpoint(pop) {
  const data = pop.toJSON();
  data._innovationTracker = innovationTracker.toJSON();
  fs.writeFileSync(CHECKPOINT, JSON.stringify(data, null, 2), 'utf8');
}

// ── Run a single genome through one round ─────────────────────────────────
async function runGenome(genome) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport:  { width: 375, height: 812 },
    hasTouch:  true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();

  // Capture score from API
  let apiScore     = 0;
  let isCheater    = false;
  let apiResponded = false;

  page.on('response', async (res) => {
    if (res.url().includes('/api/post-game-score')) {
      try {
        const body = await res.json();
        apiScore    = body.highScore || 0;
        isCheater   = body.isCheater || false;
        apiResponded = true;
      } catch (_) {}
    }
  });

  // Inject the NEAT brain IIFE and genome (pre-inject so genome is available at page-load time)
  await page.addInitScript(neatBrainSrc);
  await page.addInitScript(`window.__NEAT_GENOME__ = ${JSON.stringify(genome.toJSON())};`);

  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // ── Form filling — only clicks START_BUTTON if form is present ────────────
  async function fillAndSubmitForm() {
    await page.evaluate(() => {
      ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => {
        const e = document.querySelector(`[data-testid="${t}"]`);
        if (e) e.style.pointerEvents = 'none';
      });
      const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
      if (f) { f.style.position = 'relative'; f.style.zIndex = '99999'; }
    });

    // Check whether the registration form is present BEFORE clicking START
    // (clicking START on a returning player starts the round immediately)
    const hasFormFirst = await page.evaluate(
      () => !!document.querySelector('[data-testid="GAMEFORM_CONTAINER"]')
    );

    if (!hasFormFirst) {
      // Try clicking START once in case form appears on first click
      try {
        await page.locator('[data-testid="START_BUTTON"]').click({ force: true, timeout: 2000 });
        await page.waitForTimeout(1000);
      } catch (_) {}
    } else {
      await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
      await page.waitForTimeout(1500);
    }

    const hasForm = await page.evaluate(
      () => !!document.querySelector('[data-testid="GAMEFORM_CONTAINER"]')
    );
    if (!hasForm) return;

    for (const [placeholder, value] of [
      ['Name', NAME],
      ['Enter your e-mail address', EMAIL],
      ['username', USERNAME],
    ]) {
      await page.locator(`input[placeholder="${placeholder}"]`).click({ force: true });
      await page.locator(`input[placeholder="${placeholder}"]`).fill(value);
    }

    await page.evaluate(() => {
      ['GAME_FORM_TERMS', 'PARAM1'].forEach(id => {
        const c = document.getElementById(id);
        if (!c) return;
        const p = Object.keys(c).find(k => k.startsWith('__reactProps$'));
        if (p && c[p].onChange) c[p].onChange({ target: { checked: true } });
      });
    });
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
      if (!f) return;
      const p = Object.keys(f).find(k => k.startsWith('__reactProps$'));
      if (p) f[p].onSubmit({
        preventDefault: () => {}, stopPropagation: () => {},
        target: f, currentTarget: f, nativeEvent: new Event('submit'),
      });
    });
  }

  await fillAndSubmitForm();
  await page.waitForTimeout(1000);

  // Genome already injected via addInitScript — confirm it's live in page
  await page.evaluate((g) => { window.__NEAT_GENOME__ = g; }, genome.toJSON());

  // ── Click to start next round ──────────────────────────────────────────
  const waitStart = Date.now();
  while (Date.now() - waitStart < 10000) {
    try {
      const btn = page.locator('[data-testid="START_BUTTON"]');
      if (await btn.isVisible({ timeout: 100 })) {
        await btn.click({ force: true });
      } else {
        await page.mouse.click(187, 400);
      }
    } catch (_) {
      await page.mouse.click(187, 400);
    }
    const roundOver = await page.evaluate(() => {
      const g = window.__PHASER_GAME__;
      const s = g?.scene?.scenes?.find(sc => sc.sys?.settings?.key === 'GAME_SCENE');
      return !s || s.roundOver;
    });
    if (!roundOver) break;
    await page.waitForTimeout(250);
  }

  // ── Play until round ends ──────────────────────────────────────────────
  const roundStart  = Date.now();
  const MAX_ROUND_MS = 90000;
  const MIN_ROUND_MS = 5000;

  while (Date.now() - roundStart < MAX_ROUND_MS) {
    const snap = await page.evaluate(() => {
      const g = window.__PHASER_GAME__;
      const s = g?.scene?.scenes?.find(sc => sc.sys?.settings?.key === 'GAME_SCENE');
      if (!s) return { roundOver: true };
      return {
        roundOver:       !!s.roundOver,
        stagnantBounces: window.__NEAT_AI__?.stagnantBounces || 0,
      };
    });

    if (snap.roundOver && (Date.now() - roundStart) > MIN_ROUND_MS) {
      // Double-check to avoid transient false positives
      await page.waitForTimeout(250);
      const stillOver = await page.evaluate(() => {
        const g = window.__PHASER_GAME__;
        const s = g?.scene?.scenes?.find(sc => sc.sys?.settings?.key === 'GAME_SCENE');
        return !s || !!s.roundOver;
      });
      if (stillOver) break;
    }

    // Force-exit on extreme stagnation
    if (snap.stagnantBounces > 15 && (Date.now() - roundStart) > MIN_ROUND_MS) {
      await page.evaluate(() => {
        const g = window.__PHASER_GAME__;
        const s = g?.scene?.scenes?.find(sc => sc.sys?.settings?.key === 'GAME_SCENE');
        if (s?.player && s.cameras?.main) {
          const belowScreen = s.cameras.main.scrollY + s.cameras.main.height + 200;
          try { s.player.setPosition(s.player.x, belowScreen); } catch (_) {}
        }
      });
      await page.waitForTimeout(800);
      break;
    }

    await page.waitForTimeout(100);
  }

  // ── Collect results ────────────────────────────────────────────────────
  const ai = await page.evaluate(() => window.__NEAT_AI__ || {});
  const durationMs = Date.now() - roundStart;

  // Wait briefly for API response
  if (!apiResponded) {
    await page.waitForTimeout(2000);
  }

  await browser.close();

  return {
    genomeId:       genome.id,
    highestY:       ai.highestY        || 0,
    score:          ai.score           || 0,   // use brain score, not API highScore (API returns account all-time best)
    trampolineHits: ai.trampolineHits  || 0,
    isCheater:      isCheater,
    durationMs:     durationMs,
    lastAction:     ai.lastAction      || 'NONE',
  };
}

// ── Main training loop ─────────────────────────────────────────────────────
async function main() {
  console.log('🧬 NEAT Player — starting up');
  console.log(`  populationSize: ${config.populationSize}, maxGenerations: ${config.maxGenerations}`);
  console.log(`  resume: ${resume}`);

  let population;

  if (resume && fs.existsSync(CHECKPOINT)) {
    console.log(`\n📂 Resuming from ${CHECKPOINT}`);
    const data = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));

    // Restore innovation tracker
    if (data._innovationTracker) {
      const restored = require('../neat/innovation.js');
      const it = require('../neat/innovation.js');
      Object.assign(it, require('../neat/innovation.js').constructor
        ? require('../neat/innovation.js')
        : {});
      // Re-hydrate via fromJSON on the singleton
      const { _map, _next } = data._innovationTracker;
      it._map  = new Map(_map);
      it._next = _next;
    }

    population = Population.fromJSON(data, config, innovationTracker);
    console.log(`  Resumed at generation ${population.getGeneration()}, bestFitness: ${population.bestFitness.toFixed(2)}`);
  } else {
    population = new Population(config, innovationTracker);
    population.initialise();
    console.log(`  Initialised fresh population (${population.genomes.length} genomes, ${population.species.length} species)`);
  }

  let allTimeBestFitness = population.bestFitness || -Infinity;

  for (let gen = population.getGeneration(); gen < population.getGeneration() + config.maxGenerations; gen++) {
    const genStart = Date.now();
    console.log(`\n══ Generation ${gen + 1} ══ (${population.genomes.length} genomes, ${population.species.length} species)`);

    const fitnessMap = new Map();
    let cheaterCount = 0;

    for (let gi = 0; gi < population.genomes.length; gi++) {
      const genome = population.genomes[gi];
      process.stdout.write(`  [${gi + 1}/${population.genomes.length}] genome ${genome.id} ... `);

      let result;
      try {
        result = await runGenome(genome);
      } catch (err) {
        console.error(`\n  ❌ Error running genome ${genome.id}:`, err.message);
        result = { genomeId: genome.id, highestY: 0, score: 0, trampolineHits: 0, isCheater: false, durationMs: 0 };
      }

      const fitness = calcFitness(result);
      fitnessMap.set(genome.id, fitness);
      if (result.isCheater) cheaterCount++;

      console.log(`score=${result.score.toFixed(1)} fit=${fitness.toFixed(1)} dur=${(result.durationMs / 1000).toFixed(0)}s tramp=${result.trampolineHits}${result.isCheater ? ' CHEAT' : ''}`);

      appendResult({
        generation:    gen + 1,
        genomeIndex:   gi + 1,
        ...result,
        fitness,
      });
    }

    population.evaluateFitness(fitnessMap);

    const bestFit   = Math.max(...[...fitnessMap.values()]);
    const avgFit    = [...fitnessMap.values()].reduce((s, v) => s + v, 0) / fitnessMap.size;
    const bestEntry = population.genomes.reduce((a, b) =>
      (fitnessMap.get(a.id) || 0) >= (fitnessMap.get(b.id) || 0) ? a : b
    );

    if (bestFit > allTimeBestFitness) allTimeBestFitness = bestFit;

    const elapsed = ((Date.now() - genStart) / 1000).toFixed(0);
    console.log(`\n  ✅ Gen ${gen + 1} done in ${elapsed}s`);
    console.log(`     bestFit=${bestFit.toFixed(2)} avgFit=${avgFit.toFixed(2)} allTimeBest=${allTimeBestFitness.toFixed(2)}`);
    console.log(`     species=${population.species.length} cheaters=${cheaterCount}`);

    saveCheckpoint(population);

    if (allTimeBestFitness >= config.targetFitness) {
      console.log(`\n🎯 Target fitness ${config.targetFitness} reached! Stopping.`);
      break;
    }

    population.evolve();
    console.log(`  After evolve: ${population.genomes.length} genomes, ${population.species.length} species`);
  }

  const best = population.getBestGenome();
  console.log('\n══ Training complete ══');
  console.log(`  All-time best fitness: ${allTimeBestFitness.toFixed(2)}`);
  if (best) {
    console.log(`  Best genome: ${best.id} (fitness: ${best.fitness.toFixed(2)})`);
    console.log(`  Nodes: ${best.nodes.length}, Connections: ${best.connections.length}`);
  }
  console.log(`  Results written to: ${RESULTS}`);
  console.log(`  Checkpoint at:      ${CHECKPOINT}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
