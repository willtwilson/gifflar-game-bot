'use strict';

/**
 * neat-play.js — NEAT training orchestration
 *
 * Usage:
 *   node scripts/neat-play.js                   # start fresh (headless)
 *   node scripts/neat-play.js --headful          # visible browser window
 *   node scripts/neat-play.js --resume           # resume from neat-checkpoint.json
 *   node scripts/neat-play.js --generations 50  # override max generations
 *   node scripts/neat-play.js --pop-size 30      # override population size
 *
 * Credentials (env overrides): NEAT_EMAIL, NEAT_NAME, NEAT_USERNAME
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
const EMAIL       = process.env.NEAT_EMAIL    || 'willtwilson@hotmail.com';
const NAME        = process.env.NEAT_NAME     || 'Bill Wilson';
const USERNAME    = process.env.NEAT_USERNAME || 'NEAT';
const CHECKPOINT  = path.join(__dirname, '..', 'neat-checkpoint.json');
const RESULTS     = path.join(__dirname, '..', 'neat-results.jsonl');

// ── CLI args ───────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const resume   = args.includes('--resume');
const headless = !args.includes('--headful');   // --headful shows the browser window

const genArg  = args.indexOf('--generations');
if (genArg !== -1) config.maxGenerations = parseInt(args[genArg + 1], 10);

const popArg  = args.indexOf('--pop-size');
if (popArg !== -1) config.populationSize = parseInt(args[popArg + 1], 10);

// ── Helpers ────────────────────────────────────────────────────────────────
function appendResult(entry) {
  fs.appendFileSync(RESULTS, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
}

/**
 * Save checkpoint.  When midGen is provided the checkpoint also records
 * which genome we're currently at so a crash can be recovered mid-generation.
 *
 * @param {Population} pop
 * @param {{ gen: number, genomeIndex: number, fitnessMap: Map<string,number> } | null} midGen
 */
function saveCheckpoint(pop, midGen = null) {
  const data = pop.toJSON();
  data._innovationTracker = innovationTracker.toJSON();
  if (midGen) {
    data._midGen = {
      gen:        midGen.gen,
      genomeIndex: midGen.genomeIndex,
      fitnessMap: Object.fromEntries(midGen.fitnessMap),
    };
  } else {
    delete data._midGen;
  }
  fs.writeFileSync(CHECKPOINT, JSON.stringify(data, null, 2), 'utf8');
}

// ── Form filling — shared helper, only needed on first genome per session ──
async function fillAndSubmitForm(page) {
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

// ── Run a single genome through one round ─────────────────────────────────
// Reuses the shared browser context — opens a new tab, plays, then closes it.
async function runGenome(context, genome) {
  const page = await context.newPage();

  // Capture isCheater flag from API response
  let isCheater    = false;
  let apiResponded = false;

  page.on('response', async (res) => {
    if (res.url().includes('/api/post-game-score')) {
      try {
        const body = await res.json();
        isCheater    = body.isCheater || false;
        apiResponded = true;
      } catch (_) {}
    }
  });

  // Inject brain + genome weights before page load
  await page.addInitScript(neatBrainSrc);
  await page.addInitScript(`window.__NEAT_GENOME__ = ${JSON.stringify(genome.toJSON())};`);

  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  await fillAndSubmitForm(page);
  await page.waitForTimeout(1000);

  // Confirm genome is live (guards against rare timing issues)
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

  await page.close();

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
  console.log(`  resume: ${resume}, headless: ${headless}`);

  let population;
  let resumeMidGen = null; // { gen, genomeIndex, fitnessMap } — set when crash-recovery is possible

  if (resume && fs.existsSync(CHECKPOINT)) {
    console.log(`\n📂 Resuming from ${CHECKPOINT}`);
    const data = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));

    // Restore innovation tracker (toJSON serialises as { map, next })
    if (data._innovationTracker) {
      const it = require('../neat/innovation.js');
      const { map, next } = data._innovationTracker;
      it._map  = new Map(map);
      it._next = typeof next === 'number' ? next : 0;
    }

    population = Population.fromJSON(data, config, innovationTracker);

    // Mid-generation crash recovery: _midGen records which genome we stopped at
    if (data._midGen) {
      resumeMidGen = {
        gen:        data._midGen.gen,
        genomeIndex: data._midGen.genomeIndex,
        fitnessMap: new Map(Object.entries(data._midGen.fitnessMap).map(([k, v]) => [k, Number(v)])),
      };
      console.log(`  Mid-gen crash detected: gen ${resumeMidGen.gen + 1}, completed ${resumeMidGen.genomeIndex + 1}/${population.genomes.length} genomes`);
      console.log(`  Will resume from genome ${resumeMidGen.genomeIndex + 2}/${population.genomes.length}`);
    } else {
      console.log(`  Resumed at generation ${population.getGeneration()}, bestFitness: ${(population.bestFitness ?? -Infinity).toFixed(2)}`);
    }
  } else {
    population = new Population(config, innovationTracker);
    population.initialise();
    console.log(`  Initialised fresh population (${population.genomes.length} genomes, ${population.species.length} species)`);
  }

  let allTimeBestFitness = population.bestFitness || -Infinity;

  // ── Browser / context management (supports crash recovery) ───────────────
  // Recreate the browser every BROWSER_RESTART_EVERY genomes to avoid memory
  // build-up, and automatically recover if the browser crashes mid-run.
  const BROWSER_RESTART_EVERY = 40;   // pages opened before a proactive restart
  const CONTEXT_OPTS = {
    viewport:  { width: 375, height: 812 },
    hasTouch:  true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  };

  let browser = await chromium.launch({ headless });
  let context  = await browser.newContext(CONTEXT_OPTS);
  let pagesOpened = 0;
  console.log('  Browser launched (shared context across all genome runs)');

  /** Tear down the current browser+context and spin up fresh ones. */
  async function recycleBrowser(reason) {
    console.log(`\n  🔄 Recycling browser (${reason})…`);
    try { await browser.close(); } catch (_) {}
    browser      = await chromium.launch({ headless });
    context      = await browser.newContext(CONTEXT_OPTS);
    pagesOpened  = 0;
    console.log('  🔄 New browser ready');
  }

  /**
   * Run a genome with automatic browser-crash recovery.
   * On first failure we recycle the browser and retry once.
   */
  async function runGenomeSafe(genome) {
    // Proactively restart the browser every BROWSER_RESTART_EVERY pages
    if (pagesOpened > 0 && pagesOpened % BROWSER_RESTART_EVERY === 0) {
      await recycleBrowser(`${pagesOpened} pages opened`);
    }

    try {
      const result = await runGenome(context, genome);
      pagesOpened++;
      return result;
    } catch (firstErr) {
      const msg = firstErr.message || '';
      const isBrowserDead =
        msg.includes('closed') || msg.includes('crashed') ||
        msg.includes('disconnected') || msg.includes('Target closed') ||
        msg.includes('browser') || msg.includes('Timeout') ||
        msg.includes('net::ERR');

      console.error(`\n  ❌ Error running genome ${genome.id}: ${msg.slice(0, 120)}`);

      if (isBrowserDead) {
        await recycleBrowser('browser error detected');
        try {
          console.log('  ↩️  Retrying genome after browser recycle…');
          const result = await runGenome(context, genome);
          pagesOpened++;
          return result;
        } catch (retryErr) {
          console.error(`  ❌ Retry also failed: ${retryErr.message.slice(0, 120)}`);
        }
      }

      return { genomeId: genome.id, highestY: 0, score: 0, trampolineHits: 0, isCheater: false, durationMs: 0 };
    }
  }

  try {
    for (let gen = population.getGeneration(); gen < population.getGeneration() + config.maxGenerations; gen++) {
      const genStart = Date.now();

      // ── Mid-gen crash recovery ─────────────────────────────────────────────
      let fitnessMap    = new Map();
      let cheaterCount  = 0;
      let startGi       = 0;

      if (resumeMidGen && resumeMidGen.gen === gen) {
        fitnessMap   = resumeMidGen.fitnessMap;
        cheaterCount = [...fitnessMap.values()].filter(f => f === 0).length; // best-effort
        startGi      = resumeMidGen.genomeIndex + 1;
        resumeMidGen = null;
        console.log(`\n══ Generation ${gen + 1} ══ (RESUMED from genome ${startGi + 1}/${population.genomes.length})`);
      } else {
        console.log(`\n══ Generation ${gen + 1} ══ (${population.genomes.length} genomes, ${population.species.length} species)`);
        // Save checkpoint at generation start so genome weights are captured before any run
        saveCheckpoint(population, { gen, genomeIndex: -1, fitnessMap });
      }

      for (let gi = startGi; gi < population.genomes.length; gi++) {
        const genome = population.genomes[gi];
        process.stdout.write(`  [${gi + 1}/${population.genomes.length}] genome ${genome.id} ... `);

        const result  = await runGenomeSafe(genome);
        const fitness = calcFitness(result);
        fitnessMap.set(genome.id, fitness);
        if (result.isCheater) cheaterCount++;

        console.log(`score=${result.score.toFixed(0)} fit=${fitness.toFixed(1)} dur=${(result.durationMs / 1000).toFixed(0)}s tramp=${result.trampolineHits}${result.isCheater ? ' CHEAT' : ''}`);

        appendResult({
          generation:    gen + 1,
          genomeIndex:   gi + 1,
          ...result,
          fitness,
        });

        // Save after every genome so a crash mid-generation is recoverable
        saveCheckpoint(population, { gen, genomeIndex: gi, fitnessMap });
      }

      population.evaluateFitness(fitnessMap);

      const bestFit = Math.max(...[...fitnessMap.values()]);
      const avgFit  = [...fitnessMap.values()].reduce((s, v) => s + v, 0) / fitnessMap.size;

      if (bestFit > allTimeBestFitness) allTimeBestFitness = bestFit;

      const elapsed = ((Date.now() - genStart) / 1000).toFixed(0);
      console.log(`\n  ✅ Gen ${gen + 1} done in ${elapsed}s`);
      console.log(`     bestFit=${bestFit.toFixed(2)} avgFit=${avgFit.toFixed(2)} allTimeBest=${allTimeBestFitness.toFixed(2)}`);
      console.log(`     species=${population.species.length} cheaters=${cheaterCount}`);

      // Clean end-of-generation checkpoint (no _midGen)
      saveCheckpoint(population);

      if (allTimeBestFitness >= config.targetFitness) {
        console.log(`\n🎯 Target fitness ${config.targetFitness} reached! Stopping.`);
        break;
      }

      population.evolve();
      console.log(`  After evolve: ${population.genomes.length} genomes, ${population.species.length} species`);
    }
  } finally {
    await browser.close();
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
