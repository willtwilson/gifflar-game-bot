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
      try {
        lastScoreResponse = await res.json();
        console.log(`<< SCORE: highScore=${lastScoreResponse.highScore}, ranking=${lastScoreResponse.ranking}, cheater=${lastScoreResponse.isCheater}`);
      } catch {}
    }
    if (res.url().includes('/api/post-game-start')) {
      try {
        const body = await res.json();
        console.log(`<< START: playerId=${body.playerId}`);
      } catch {}
    }
  });

  // Hook Phaser.Game constructor
  await page.addInitScript(() => {
    let w = setInterval(() => {
      if (window.Phaser && !window.__ph) {
        window.__ph = true;
        const O = window.Phaser.Game;
        if (O) {
          window.Phaser.Game = function(...a) {
            const i = new O(...a);
            window.__PHASER_GAME__ = i;
            return i;
          };
          Object.setPrototypeOf(window.Phaser.Game, O);
          window.Phaser.Game.prototype = O.prototype;
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

  // Form filling + submission
  await page.evaluate(() => {
    ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => {
      const e = document.querySelector(`[data-testid="${t}"]`);
      if (e) e.style.pointerEvents = 'none';
    });
    const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
    if (f) { f.style.position = 'relative'; f.style.zIndex = '99999'; }
  });
  await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
  await page.waitForTimeout(2000);

  for (const [placeholder, value] of [
    ['Name', 'Will Wilson'],
    ['Enter your e-mail address', 'willtwilson+gifflar@gmail.com'],
    ['username', 'Frilliam']
  ]) {
    await page.locator(`input[placeholder="${placeholder}"]`).click({ force: true });
    await page.locator(`input[placeholder="${placeholder}"]`).fill(value);
  }

  await page.evaluate(() => {
    ['GAME_FORM_TERMS', 'PARAM1'].forEach(id => {
      const c = document.getElementById(id);
      const p = Object.keys(c).find(k => k.startsWith('__reactProps$'));
      if (p && c[p].onChange) c[p].onChange({ target: { checked: true } });
    });
  });
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
    const p = Object.keys(f).find(k => k.startsWith('__reactProps$'));
    if (p) f[p].onSubmit({ preventDefault: () => {}, stopPropagation: () => {}, target: f, currentTarget: f, nativeEvent: new Event('submit') });
  });
  await page.waitForTimeout(4000);

  console.log('=== Game started ===');

  // Inject the smart player AI directly into the game loop
  console.log('=== Injecting smart player AI ===');
  
  await page.evaluate(() => {
    const game = window.__PHASER_GAME__;
    if (!game) { console.log('[AI] No game instance!'); return; }
    
    const gameScene = game.scene.scenes.find(s => s.sys?.settings?.key === 'GAME_SCENE');
    if (!gameScene) { console.log('[AI] No GAME_SCENE!'); return; }
    
    window.__AI_STATS__ = { taps: 0, direction: 'none', lastPlatformX: 0, playerX: 0, playerY: 0 };
    
    // Create the AI update function
    window.__AI_INTERVAL__ = setInterval(() => {
      try {
        const player = gameScene.player;
        if (!player || !player.active || gameScene.roundOver) {
          clearInterval(window.__AI_INTERVAL__);
          console.log('[AI] Game over or player inactive');
          return;
        }
        
        const playerX = player.x;
        const playerY = player.y;
        const playerVY = player.body?.velocity?.y || 0;
        
        // Get ALL platforms from both arrays
        const allPlatforms = [
          ...(gameScene.introPlatforms || []),
          ...(gameScene.platformPool || []),
          ...(gameScene.trampolines || [])
        ].filter(p => p && p.active && p.visible);
        
        // Find platforms ABOVE the player (lower Y = higher in game)
        // and within a reasonable range
        const platformsAbove = allPlatforms
          .filter(p => p.y < playerY - 10 && p.y > playerY - 400)
          .sort((a, b) => b.y - a.y); // Sort by closest above first
        
        if (platformsAbove.length === 0) {
          // No platforms above - might be at the start or very high
          // Just stay centered
          return;
        }
        
        // Target the nearest platform above
        const target = platformsAbove[0];
        const targetX = target.x;
        
        // Calculate direction to move
        const diff = targetX - playerX;
        const threshold = 20; // Don't tap if already close enough
        
        if (Math.abs(diff) < threshold) {
          // Close enough to target, don't tap
          return;
        }
        
        // Simulate tap on the appropriate side of the screen
        const canvas = document.querySelector('canvas');
        if (!canvas) return;
        
        const canvasRect = canvas.getBoundingClientRect();
        const tapX = diff > 0 
          ? canvasRect.left + canvasRect.width * 0.75  // Right side
          : canvasRect.left + canvasRect.width * 0.25; // Left side
        const tapY = canvasRect.top + canvasRect.height * 0.5;
        
        // Dispatch touch events (mobile game)
        const touch = new Touch({
          identifier: Date.now(),
          target: canvas,
          clientX: tapX,
          clientY: tapY,
          pageX: tapX,
          pageY: tapY
        });
        
        canvas.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [touch],
          targetTouches: [touch],
          changedTouches: [touch]
        }));
        
        // Brief delay then release
        setTimeout(() => {
          canvas.dispatchEvent(new TouchEvent('touchend', {
            bubbles: true,
            cancelable: true,
            touches: [],
            targetTouches: [],
            changedTouches: [touch]
          }));
        }, 50);
        
        window.__AI_STATS__.taps++;
        window.__AI_STATS__.direction = diff > 0 ? 'right' : 'left';
        window.__AI_STATS__.lastPlatformX = targetX;
        window.__AI_STATS__.playerX = Math.round(playerX);
        window.__AI_STATS__.playerY = Math.round(playerY);
        
      } catch (e) {
        console.log('[AI] Error: ' + e.message);
      }
    }, 80); // Run every 80ms
    
    console.log('[AI] Smart player injected!');
  });
  
  // Monitor game progress
  const startTime = Date.now();
  const maxTime = 120000; // 2 minutes max
  
  while (Date.now() - startTime < maxTime) {
    await page.waitForTimeout(5000);
    
    const stats = await page.evaluate(() => {
      const game = window.__PHASER_GAME__;
      const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
      if (!scene) return null;
      
      return {
        aiStats: window.__AI_STATS__,
        roundOver: scene.roundOver,
        highestPoint: Math.round(scene.highestPointReached || 0),
        difficulty: scene.currentDifficulty,
        bounceSpeed: Math.round(scene.currentBounceSpeed || 0),
        gravity: Math.round(scene.currentPlayerGravity || 0),
        playerActive: scene.player?.active,
        playerY: Math.round(scene.player?.y || 0),
        playerVY: Math.round(scene.player?.body?.velocity?.y || 0),
        usingBoots: scene.usingBoots,
        usingBalloon: scene.usingBalloon,
        aiRunning: !!window.__AI_INTERVAL__,
      };
    });
    
    if (!stats || stats.roundOver || !stats.playerActive) {
      console.log(`Game ended after ${Math.round((Date.now() - startTime) / 1000)}s`);
      console.log('Final stats:', JSON.stringify(stats));
      break;
    }
    
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[${elapsed}s] Player Y:${stats.playerY} VY:${stats.playerVY} Highest:${stats.highestPoint} Taps:${stats.aiStats?.taps} Dir:${stats.aiStats?.direction}`);
  }

  // Wait for score response
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'screenshots/90-smart-result.png' });

  console.log('\n=== RESULTS ===');
  if (lastScoreResponse) {
    console.log(`High Score: ${lastScoreResponse.highScore}`);
    console.log(`Ranking: ${lastScoreResponse.ranking}`);
    console.log(`Cheater: ${lastScoreResponse.isCheater}`);
    console.log(`Entries: ${lastScoreResponse.numberOfEntries}`);
    
    if (lastScoreResponse.highScore >= 300) {
      console.log('\n🎉 TARGET ACHIEVED! Score >= 300!');
    } else {
      console.log(`\n❌ Need ${300 - lastScoreResponse.highScore} more points.`);
    }
  } else {
    console.log('No score response received');
  }

  await browser.close();
  console.log('\nDone');
})();
