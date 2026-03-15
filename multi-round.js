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
  let lastScoreResponse = null;

  page.on('response', async (res) => {
    if (res.url().includes('/api/post-game-score')) {
      try { 
        lastScoreResponse = await res.json();
        bestScore = lastScoreResponse.highScore;
      } catch {}
    }
  });

  // Hook Phaser
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

  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(4000);

  // Form submission
  await page.evaluate(() => {
    ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => { const e = document.querySelector(`[data-testid="${t}"]`); if (e) e.style.pointerEvents = 'none'; });
    const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]'); if (f) { f.style.position = 'relative'; f.style.zIndex = '99999'; }
  });
  await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
  await page.waitForTimeout(2000);
  for (const [p, v] of [['Name', 'Will Wilson'], ['Enter your e-mail address', 'willtwilson+gifflar@gmail.com'], ['username', 'Frilliam']]) {
    await page.locator(`input[placeholder="${p}"]`).click({ force: true });
    await page.locator(`input[placeholder="${p}"]`).fill(v);
  }
  await page.evaluate(() => {
    ['GAME_FORM_TERMS', 'PARAM1'].forEach(id => { const c = document.getElementById(id); const p = Object.keys(c).find(k => k.startsWith('__reactProps$')); if (p && c[p].onChange) c[p].onChange({ target: { checked: true } }); });
  });
  await page.waitForTimeout(300);

  // Play function - encapsulate one round of play
  async function playOneRound() {
    lastScoreResponse = null;
    const startTime = Date.now();
    let taps = 0;
    let lastDirection = 'right';
    let gameOver = false;

    while (Date.now() - startTime < 60000 && !gameOver) {
      // Check game state every 3 taps
      let targetX = null;
      if (taps % 3 === 0) {
        try {
          targetX = await page.evaluate(() => {
            const g = window.__PHASER_GAME__;
            if (!g) return null;
            const s = g.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
            if (!s || !s.player || s.roundOver) return 'OVER';
            const px = s.player.x, py = s.player.y;
            const plats = [...(s.introPlatforms || []), ...(s.platformPool || [])]
              .filter(p => p && p.active && p.visible && p.y < py - 20 && p.y > py - 400);
            if (plats.length === 0) return null;
            plats.sort((a, b) => b.y - a.y);
            return { tx: plats[0].x, px };
          });
        } catch {}
      }

      if (targetX === 'OVER') {
        gameOver = true;
        break;
      }

      let cx;
      if (targetX && typeof targetX === 'object') {
        const diff = targetX.tx - targetX.px;
        if (Math.abs(diff) < 30) cx = 170 + Math.random() * 35;
        else if (diff > 0) { cx = 250 + Math.random() * 80; lastDirection = 'right'; }
        else { cx = 50 + Math.random() * 80; lastDirection = 'left'; }
      } else {
        if (taps % 4 === 0) lastDirection = lastDirection === 'right' ? 'left' : 'right';
        cx = lastDirection === 'right' ? (220 + Math.random() * 100) : (50 + Math.random() * 100);
      }

      await page.mouse.click(cx, 350 + Math.random() * 100);
      taps++;
      await page.waitForTimeout(80 + Math.random() * 120);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    return { taps, elapsed };
  }

  // Round 1: Submit form and immediately start playing
  console.log('=== Round 1 ===');
  
  // Submit form and start clicking in parallel - don't wait!
  page.evaluate(() => {
    const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
    const p = Object.keys(f).find(k => k.startsWith('__reactProps$'));
    if (p) f[p].onSubmit({ preventDefault: () => {}, stopPropagation: () => {}, target: f, currentTarget: f, nativeEvent: new Event('submit') });
  });
  
  // Start clicking immediately, overlapping with form submission processing
  await page.waitForTimeout(800);
  
  let result = await playOneRound();
  await page.waitForTimeout(3000);
  
  console.log(`Round 1: ${result.taps} taps, ${result.elapsed}s, highScore=${bestScore}`);

  // Check if we've reached 300
  const TARGET = 300;
  const MAX_ROUNDS = 10;
  
  for (let round = 2; round <= MAX_ROUNDS && bestScore < TARGET; round++) {
    console.log(`\n=== Round ${round} (best: ${bestScore}) ===`);
    
    // Wait for game over screen, then find and click "Play Again" or reload
    await page.waitForTimeout(2000);
    
    // Check for a replay/play again button
    const replayBtn = await page.evaluate(() => {
      // Look for play again button in the modal
      const elements = document.querySelectorAll('[data-testid]');
      for (const el of elements) {
        const tid = el.dataset.testid;
        if (tid.includes('PLAY_AGAIN') || tid.includes('REPLAY') || tid.includes('TRY_AGAIN') || tid === 'START_BUTTON') {
          return { testId: tid, text: el.textContent?.trim().substring(0, 50) };
        }
      }
      // Also check for spans/buttons with "Play Again" text
      const spans = document.querySelectorAll('span, div, button');
      for (const el of spans) {
        const text = el.textContent?.trim().toLowerCase();
        if (text === 'play again' || text === 'try again' || text === 'restart') {
          return { text: el.textContent.trim(), tag: el.tagName };
        }
      }
      return null;
    });
    
    console.log('Replay button found:', replayBtn);
    
    if (replayBtn?.testId) {
      // Disable overlays again
      await page.evaluate(() => {
        ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => { 
          const e = document.querySelector(`[data-testid="${t}"]`); 
          if (e) e.style.pointerEvents = 'none'; 
        });
      });
      await page.locator(`[data-testid="${replayBtn.testId}"]`).click({ force: true });
      await page.waitForTimeout(1500);
    } else {
      // No replay button found - need to reload page
      console.log('No replay button - reloading page');
      await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
        waitUntil: 'networkidle', timeout: 30000
      });
      await page.waitForTimeout(4000);
      
      // Re-do form submission
      await page.evaluate(() => {
        ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => { const e = document.querySelector(`[data-testid="${t}"]`); if (e) e.style.pointerEvents = 'none'; });
        const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]'); if (f) { f.style.position = 'relative'; f.style.zIndex = '99999'; }
      });
      await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
      await page.waitForTimeout(2000);
      for (const [p, v] of [['Name', 'Will Wilson'], ['Enter your e-mail address', 'willtwilson+gifflar@gmail.com'], ['username', 'Frilliam']]) {
        await page.locator(`input[placeholder="${p}"]`).click({ force: true });
        await page.locator(`input[placeholder="${p}"]`).fill(v);
      }
      await page.evaluate(() => {
        ['GAME_FORM_TERMS', 'PARAM1'].forEach(id => { const c = document.getElementById(id); const p = Object.keys(c).find(k => k.startsWith('__reactProps$')); if (p && c[p].onChange) c[p].onChange({ target: { checked: true } }); });
      });
      await page.waitForTimeout(300);
      
      page.evaluate(() => {
        const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
        const p = Object.keys(f).find(k => k.startsWith('__reactProps$'));
        if (p) f[p].onSubmit({ preventDefault: () => {}, stopPropagation: () => {}, target: f, currentTarget: f, nativeEvent: new Event('submit') });
      });
      await page.waitForTimeout(800);
    }
    
    result = await playOneRound();
    await page.waitForTimeout(3000);
    console.log(`Round ${round}: ${result.taps} taps, ${result.elapsed}s, highScore=${bestScore}`);
  }

  await page.screenshot({ path: 'screenshots/95-final-result.png' });
  
  console.log('\n=== FINAL RESULTS ===');
  if (lastScoreResponse) {
    console.log(`Best Score: ${lastScoreResponse.highScore}`);
    console.log(`Ranking: ${lastScoreResponse.ranking}`);
    console.log(`Cheater: ${lastScoreResponse.isCheater}`);
    console.log(`Entries: ${lastScoreResponse.numberOfEntries}`);
    if (lastScoreResponse.highScore >= TARGET) {
      console.log('\n🎉🎉🎉 TARGET ACHIEVED! Score >= 300! 🎉🎉🎉');
      console.log('Entry into the Cosy Winter Kits prize draw is confirmed!');
    } else {
      console.log(`\n❌ Best score: ${lastScoreResponse.highScore} (need ${(TARGET - lastScoreResponse.highScore).toFixed(1)} more)`);
    }
  }

  await browser.close();
  console.log('\nDone');
})();
