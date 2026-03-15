const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  let bestScore = 0;
  page.on('response', async (res) => {
    if (res.url().includes('/api/post-game-score')) {
      try { 
        const body = await res.json();
        bestScore = body.highScore;
        console.log(`  >> Score: ${body.highScore} | Ranking: ${body.ranking} | Cheater: ${body.isCheater} | Entries: ${body.numberOfEntries}`);
      } catch {}
    }
  });

  // Hook Phaser to track game state
  await page.addInitScript(() => {
    let w = setInterval(() => {
      if (window.Phaser && !window.__ph) {
        window.__ph = true;
        const OG = window.Phaser.Game;
        window.Phaser.Game = function(...a) {
          const i = new OG(...a); window.__PHASER_GAME__ = i; return i;
        };
        Object.setPrototypeOf(window.Phaser.Game, OG);
        window.Phaser.Game.prototype = OG.prototype;
        clearInterval(w);
      }
    }, 10);
  });

  async function fillAndSubmitForm() {
    await page.evaluate(() => {
      ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => { 
        const e = document.querySelector(`[data-testid="${t}"]`); if (e) e.style.pointerEvents = 'none'; 
      });
      const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]'); 
      if (f) { f.style.position = 'relative'; f.style.zIndex = '99999'; }
    });
    await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
    await page.waitForTimeout(1500);
    
    // Check if form is visible
    const hasForm = await page.evaluate(() => !!document.querySelector('[data-testid="GAMEFORM_CONTAINER"]'));
    if (hasForm) {
      for (const [p, v] of [['Name', 'Will Wilson'], ['Enter your e-mail address', 'willtwilson+gifflar@gmail.com'], ['username', 'Frilliam']]) {
        await page.locator(`input[placeholder="${p}"]`).click({ force: true });
        await page.locator(`input[placeholder="${p}"]`).fill(v);
      }
      await page.evaluate(() => {
        ['GAME_FORM_TERMS', 'PARAM1'].forEach(id => { 
          const c = document.getElementById(id); 
          const p = Object.keys(c).find(k => k.startsWith('__reactProps$')); 
          if (p && c[p].onChange) c[p].onChange({ target: { checked: true } }); 
        });
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
        const p = Object.keys(f).find(k => k.startsWith('__reactProps$'));
        if (p) f[p].onSubmit({ preventDefault: () => {}, stopPropagation: () => {}, target: f, currentTarget: f, nativeEvent: new Event('submit') });
      });
    }
  }

  async function playRound() {
    // Wait a tiny bit for game to start, then click rapidly
    await page.waitForTimeout(500);
    
    const start = Date.now();
    let taps = 0;
    const maxTime = 90000;
    
    // Pure alternating clicks - no game state queries during gameplay
    // This avoids the latency from page.evaluate() which causes missed platforms
    while (Date.now() - start < maxTime) {
      // Alternate left and right, with slight center bias
      const side = taps % 2;
      const cx = side === 0 ? (80 + Math.random() * 80) : (220 + Math.random() * 80);
      const cy = 350 + Math.random() * 100;
      
      await page.mouse.click(cx, cy);
      taps++;
      
      // Small consistent delay
      await page.waitForTimeout(120 + Math.random() * 80);
      
      // Check game state only every 30 taps (less frequently)
      if (taps % 30 === 0) {
        const isOver = await page.evaluate(() => {
          const g = window.__PHASER_GAME__;
          const s = g?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
          return !s || s.roundOver || !s.player?.active;
        });
        if (isOver) break;
      }
    }
    
    return { taps, elapsed: Math.round((Date.now() - start) / 1000) };
  }

  // Load game
  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(4000);

  // First round
  await fillAndSubmitForm();
  await page.waitForTimeout(500);

  const TARGET = 300;
  const MAX_ROUNDS = 15;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n--- Round ${round} (best: ${bestScore.toFixed(1)}) ---`);
    
    const result = await playRound();
    await page.waitForTimeout(3000); // Wait for score API response
    
    console.log(`  Taps: ${result.taps}, Duration: ${result.elapsed}s`);
    
    if (bestScore >= TARGET) {
      console.log('\n🎉🎉🎉 TARGET ACHIEVED! 🎉🎉🎉');
      break;
    }
    
    if (round < MAX_ROUNDS) {
      // Click START GAME to restart
      await page.evaluate(() => {
        ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => { 
          const e = document.querySelector(`[data-testid="${t}"]`); if (e) e.style.pointerEvents = 'none'; 
        });
      });
      
      try {
        await page.locator('[data-testid="START_BUTTON"]').click({ force: true, timeout: 5000 });
        await page.waitForTimeout(1000);
      } catch (e) {
        console.log('  Could not find START button, reloading...');
        await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
          waitUntil: 'networkidle', timeout: 30000
        });
        await page.waitForTimeout(4000);
        await fillAndSubmitForm();
      }
    }
  }

  await page.screenshot({ path: 'screenshots/96-final.png' });
  
  console.log('\n=== FINAL RESULTS ===');
  console.log(`Best Score: ${bestScore}`);
  if (bestScore >= TARGET) {
    console.log('✅ Successfully entered the Cosy Winter Kits prize draw!');
  } else {
    console.log(`❌ Need ${(TARGET - bestScore).toFixed(1)} more points`);
  }

  await browser.close();
  console.log('Done');
})();
