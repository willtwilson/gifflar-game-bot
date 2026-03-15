'use strict';
/**
 * diagnose-neat.js — quick diagnostic to see what errors runGenome() encounters
 * Runs a single dummy genome through the game to capture the actual error
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const neatBrainSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'neat-brain.js'), 'utf8');
const GAME_URL = 'https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f';

// Minimal dummy genome (random weights, fully connected 9->3)
const dummyGenome = {
  id: 'diag001',
  nodes: [
    ...Array.from({length:9},(_,i)=>({id:`in${i}`,type:'input'})),
    ...Array.from({length:3},(_,i)=>({id:`out${i}`,type:'output'})),
  ],
  connections: [],
};
// connect all inputs to all outputs
for (let i=0;i<9;i++) for (let o=0;o<3;o++) {
  dummyGenome.connections.push({ in:`in${i}`, out:`out${o}`, weight:(Math.random()-0.5)*2, enabled:true });
}

async function diagnose() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false }); // headful to see what happens
  const context = await browser.newContext({
    viewport:  { width: 375, height: 812 },
    hasTouch:  true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  });

  for (let round = 1; round <= 2; round++) {
    console.log(`\n=== Round ${round} ===`);
    const page = await context.newPage();

    page.on('pageerror', e => console.error('  PAGE ERR:', e.message.slice(0,200)));
    page.on('console',   m => { if (['error','warning'].includes(m.type())) console.log(`  CONSOLE[${m.type()}]:`, m.text().slice(0,200)); });
    page.on('response', async res => {
      if (res.status() >= 400) console.log(`  HTTP ${res.status()}: ${res.url().slice(0,100)}`);
    });

    try {
      await page.addInitScript(neatBrainSrc);
      await page.addInitScript(`window.__NEAT_GENOME__ = ${JSON.stringify(dummyGenome)};`);

      console.log('  Navigating to game...');
      await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('  Page loaded');
      await page.waitForTimeout(4000);

      const ui = await page.evaluate(() => {
        return {
          hasStartBtn: !!document.querySelector('[data-testid="START_BUTTON"]'),
          hasForm:     !!document.querySelector('[data-testid="GAMEFORM_CONTAINER"]'),
          hasCanvas:   !!document.querySelector('canvas'),
          hasPhaser:   !!window.Phaser,
          hasGame:     !!window.__PHASER_GAME__,
          title:       document.title,
        };
      });
      console.log('  UI:', JSON.stringify(ui));

      // Try clicking start
      try {
        const btn = page.locator('[data-testid="START_BUTTON"]');
        if (await btn.isVisible({ timeout: 2000 })) {
          console.log('  START button visible, clicking...');
          await btn.click({ force: true });
        } else {
          console.log('  START button not visible');
        }
      } catch (e) {
        console.log('  START button error:', e.message.slice(0,100));
      }

      await page.waitForTimeout(3000);

      const state = await page.evaluate(() => {
        const g = window.__PHASER_GAME__;
        const s = g && g.scene && g.scene.scenes && g.scene.scenes.find(sc => sc.sys && sc.sys.settings && sc.sys.settings.key === 'GAME_SCENE');
        return { hasGame: !!g, hasScene: !!s, roundOver: s && s.roundOver, score: window.__NEAT_AI__ && window.__NEAT_AI__.score };
      });
      console.log('  Game state after click:', JSON.stringify(state));

    } catch (err) {
      console.error('  CAUGHT ERROR:', err.constructor.name, err.message.slice(0,300));
    } finally {
      await page.close();
      console.log('  Page closed');
    }

    if (round < 2) {
      console.log('Waiting 2s before next round...');
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log('\nDiagnosis complete. Closing browser in 5s...');
  await new Promise(r => setTimeout(r, 5000));
  await browser.close();
}

diagnose().catch(e => { console.error('FATAL:', e); process.exit(1); });
