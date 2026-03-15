const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  let lastScoreResponse = null;
  page.on('response', async (res) => {
    if (res.url().includes('/api/post-game-score')) {
      try { lastScoreResponse = await res.json(); } catch {}
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

  // Submit form  
  await page.evaluate(() => {
    const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
    const p = Object.keys(f).find(k => k.startsWith('__reactProps$'));
    if (p) f[p].onSubmit({ preventDefault: () => {}, stopPropagation: () => {}, target: f, currentTarget: f, nativeEvent: new Event('submit') });
  });

  // Wait briefly for game to initialize
  await page.waitForTimeout(2000);
  console.log('=== Game submitted, starting clicks ===');

  // IMMEDIATELY start clicking - this is what worked in v6!
  // Use a tight click loop with game-state-guided direction
  const startTime = Date.now();
  let taps = 0;
  let lastDirection = 'right';
  const maxPlayTime = 90000; // 90 seconds

  while (Date.now() - startTime < maxPlayTime) {
    // Every few taps, try to read game state for optimal direction
    let targetX = null;
    
    if (taps % 5 === 0) {
      try {
        targetX = await page.evaluate(() => {
          const game = window.__PHASER_GAME__;
          if (!game) return null;
          const scene = game.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
          if (!scene || !scene.player || scene.roundOver) return 'GAME_OVER';
          
          const playerX = scene.player.x;
          const playerY = scene.player.y;
          
          // Find nearest platform above
          const platforms = [
            ...(scene.introPlatforms || []),
            ...(scene.platformPool || [])
          ].filter(p => p && p.active && p.visible && p.y < playerY - 20 && p.y > playerY - 400);
          
          if (platforms.length === 0) return null;
          platforms.sort((a, b) => b.y - a.y);
          return { targetX: platforms[0].x, playerX };
        });
      } catch {}
    }

    if (targetX === 'GAME_OVER') {
      console.log(`Game over after ${taps} taps, ${Math.round((Date.now() - startTime) / 1000)}s`);
      break;
    }

    // Determine click X position
    let clickX;
    if (targetX && typeof targetX === 'object') {
      // Smart direction based on platform position
      const diff = targetX.targetX - targetX.playerX;
      if (Math.abs(diff) < 30) {
        // Close to center, small random movement
        clickX = 170 + Math.random() * 35;
      } else if (diff > 0) {
        clickX = 250 + Math.random() * 80; // Right
        lastDirection = 'right';
      } else {
        clickX = 50 + Math.random() * 80; // Left
        lastDirection = 'left';
      }
    } else {
      // Fallback: alternate left/right with some randomness
      if (taps % 3 === 0) {
        lastDirection = lastDirection === 'right' ? 'left' : 'right';
      }
      clickX = lastDirection === 'right' ? (220 + Math.random() * 100) : (50 + Math.random() * 100);
    }

    const clickY = 350 + Math.random() * 100;
    await page.mouse.click(clickX, clickY);
    taps++;

    // Small delay - not too fast, not too slow
    await page.waitForTimeout(100 + Math.random() * 150);

    // Log progress every 50 taps
    if (taps % 50 === 0) {
      const stats = await page.evaluate(() => {
        const game = window.__PHASER_GAME__;
        const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
        if (!scene) return null;
        return {
          playerY: Math.round(scene.player?.y || 0),
          highest: Math.round(scene.highestPointReached || 0),
          roundOver: scene.roundOver
        };
      });
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[${elapsed}s] Taps:${taps} ${stats ? `Y:${stats.playerY} High:${stats.highest}` : 'no stats'}`);
      if (stats?.roundOver) {
        console.log('Round over!');
        break;
      }
    }
  }

  // Wait for score submission
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'screenshots/92-result.png' });

  console.log('\n=== RESULTS ===');
  if (lastScoreResponse) {
    console.log(`High Score: ${lastScoreResponse.highScore}`);
    console.log(`Ranking: ${lastScoreResponse.ranking}`);
    console.log(`Cheater: ${lastScoreResponse.isCheater}`);
    if (lastScoreResponse.highScore >= 300) console.log('\n🎉 TARGET ACHIEVED! Score >= 300!');
    else console.log(`\n❌ Need ${(300 - lastScoreResponse.highScore).toFixed(1)} more points`);
  } else {
    console.log('No score response received');
  }

  await browser.close();
  console.log('\nDone');
})();
