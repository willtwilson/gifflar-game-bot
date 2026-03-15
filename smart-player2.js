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
      try { lastScoreResponse = await res.json(); console.log(`<< SCORE: high=${lastScoreResponse.highScore}, cheater=${lastScoreResponse.isCheater}`); } catch {}
    }
  });

  // Hook Phaser game AND scene update
  await page.addInitScript(() => {
    let w = setInterval(() => {
      if (window.Phaser && !window.__ph) {
        window.__ph = true;
        const OG = window.Phaser.Game;
        if (OG) {
          window.Phaser.Game = function(...a) {
            const inst = new OG(...a);
            window.__PHASER_GAME__ = inst;
            return inst;
          };
          Object.setPrototypeOf(window.Phaser.Game, OG);
          window.Phaser.Game.prototype = OG.prototype;
        }
        clearInterval(w);
      }
    }, 10);
  });

  console.log('=== Loading game ===');
  await page.goto('https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f', {
    waitUntil: 'networkidle', timeout: 30000
  });
  await page.waitForTimeout(4000);

  // Form submission (compact)
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

  // Inject AI BEFORE submitting form so it's ready when game starts
  await page.evaluate(() => {
    window.__AI_READY__ = false;
    window.__AI_STATS__ = { taps: 0, frames: 0, direction: 'none', score: 0, playerY: 0, targetX: 0 };
    
    // Poll for game scene to become active
    const waitForGame = setInterval(() => {
      const game = window.__PHASER_GAME__;
      if (!game) return;
      
      const scene = game.scene.scenes.find(s => s.sys?.settings?.key === 'GAME_SCENE');
      if (!scene || !scene.player) return;
      
      // Hook into the scene's update method
      if (!scene.__aiHooked) {
        scene.__aiHooked = true;
        const origUpdate = scene.update.bind(scene);
        
        scene.update = function(time, delta) {
          // Call original update first
          origUpdate(time, delta);
          
          // Then run our AI
          if (scene.roundOver || !scene.player?.active) return;
          
          window.__AI_STATS__.frames++;
          
          const player = scene.player;
          const playerX = player.x;
          const playerY = player.y;
          
          window.__AI_STATS__.playerY = Math.round(playerY);
          
          // Get all platforms
          const platforms = [
            ...(scene.introPlatforms || []),
            ...(scene.platformPool || [])
          ].filter(p => p && p.active && p.visible);
          
          // Find platforms above the player (lower Y in game coords = higher)
          // Look for the nearest platform that's 50-300 units above
          const above = platforms
            .filter(p => p.y < playerY - 20 && p.y > playerY - 350)
            .sort((a, b) => b.y - a.y); // closest first
          
          if (above.length === 0) return;
          
          const target = above[0];
          const diff = target.x - playerX;
          window.__AI_STATS__.targetX = Math.round(target.x);
          
          // Only tap if we need to move significantly
          if (Math.abs(diff) < 30) return;
          
          // Set isTouching to true and simulate the input pointer position
          scene.isTouching = true;
          
          // Set the pointer position in game coordinates
          // The game checks pointer.x relative to the canvas
          if (scene.input?.activePointer) {
            scene.input.activePointer.isDown = true;
            // Set pointer X to the side we want to move toward
            if (diff > 0) {
              // Move right - set pointer to right side of canvas
              scene.input.activePointer.x = 600;
              scene.input.activePointer.worldX = 600;
            } else {
              // Move left - set pointer to left side of canvas
              scene.input.activePointer.x = 150;
              scene.input.activePointer.worldX = 150;
            }
          }
          
          window.__AI_STATS__.taps++;
          window.__AI_STATS__.direction = diff > 0 ? 'R' : 'L';
        };
        
        console.log('[AI] Hooked into scene update!');
        clearInterval(waitForGame);
      }
    }, 50);
  });

  // Now submit the form to start the game
  console.log('=== Starting game ===');
  await page.evaluate(() => {
    const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
    const p = Object.keys(f).find(k => k.startsWith('__reactProps$'));
    if (p) f[p].onSubmit({ preventDefault: () => {}, stopPropagation: () => {}, target: f, currentTarget: f, nativeEvent: new Event('submit') });
  });

  // Immediately start clicking to trigger game start
  await page.waitForTimeout(500);
  // Click center to start gameplay
  await page.mouse.click(187, 400);
  await page.waitForTimeout(200);
  await page.mouse.click(187, 400);
  
  // Monitor game for up to 2 minutes
  const startTime = Date.now();
  let gameEnded = false;
  
  while (Date.now() - startTime < 120000 && !gameEnded) {
    await page.waitForTimeout(3000);
    
    const stats = await page.evaluate(() => {
      const game = window.__PHASER_GAME__;
      const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
      if (!scene) return null;
      
      return {
        ai: window.__AI_STATS__,
        roundOver: scene.roundOver,
        highestPoint: Math.round(scene.highestPointReached || 0),
        playerY: Math.round(scene.player?.y || 0),
        playerVY: Math.round(scene.player?.body?.velocity?.y || 0),
        difficulty: scene.currentDifficulty,
      };
    });
    
    if (!stats) { console.log('No game stats available'); continue; }
    
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[${elapsed}s] Y:${stats.playerY} VY:${stats.playerVY} High:${stats.highestPoint} Frames:${stats.ai?.frames} Taps:${stats.ai?.taps} Dir:${stats.ai?.direction}`);
    
    if (stats.roundOver) {
      console.log('Game round ended!');
      gameEnded = true;
    }
  }

  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'screenshots/91-smart-result.png' });

  console.log('\n=== RESULTS ===');
  if (lastScoreResponse) {
    console.log(`High Score: ${lastScoreResponse.highScore}`);
    console.log(`Ranking: ${lastScoreResponse.ranking}`);
    console.log(`Cheater: ${lastScoreResponse.isCheater}`);
    console.log(`Entries: ${lastScoreResponse.numberOfEntries}`);
    if (lastScoreResponse.highScore >= 300) console.log('\n🎉 TARGET ACHIEVED!');
    else console.log(`\n❌ Need ${(300 - lastScoreResponse.highScore).toFixed(1)} more points`);
  }

  await browser.close();
  console.log('\nDone');
})();
