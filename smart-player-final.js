/**
 * Gifflar Winter Vibe - Smart Game Player v2
 *
 * Steering mechanism (reverse-engineered from update()):
 *   if (this.isTouching) {
 *     velocity = (activePointer.x < center.x ? -3.2 : 3.2) * 4;  // ±12.8
 *     player.setVelocity(velocity, player.getVelocityY());
 *   }
 * center.x = 375 (game canvas is 750px wide)
 *
 * Fixes from v1:
 *  - Search range 500→2000 (platforms are 700+ units above at start)
 *  - Also make REAL Playwright mouse clicks in sync with AI direction
 *  - Store desired direction in window.__AI__.desiredX for Playwright to use
 *  - Use weighted platform selection (prefer close horizontally, ignore broken ones)
 */

const { chromium } = require('playwright');

const EMAIL = 'willtwilson+giff@gmail.com';
const NAME = 'Will Wilson';
const USERNAME = 'Frilliam';
const TARGET_SCORE = 300;
const MAX_ROUNDS = 20;

async function runGame() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  let bestScore = 0;
  let lastScoreBody = null;

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/post-game-score')) {
      try {
        const body = await res.json();
        lastScoreBody = body;
        if (body.highScore > bestScore) bestScore = body.highScore;
        console.log(`  🏆 Score: ${body.highScore.toFixed(1)} | Rank: ${body.ranking} | Cheater: ${body.isCheater}`);
      } catch {}
    }
    if (url.includes('/api/post-game-start')) {
      try {
        const body = await res.json();
        console.log(`  🎮 Round started: playerId=${body.playerId?.substring(0, 8)}...`);
      } catch {}
    }
  });

  // Inject AI BEFORE page loads — hooks into Phaser's step event
  await page.addInitScript(() => {
    let w = setInterval(() => {
      if (window.Phaser && !window.__ph) {
        window.__ph = true;
        const OG = window.Phaser.Game;
        window.Phaser.Game = function(...args) {
          const game = new OG(...args);
          window.__PHASER_GAME__ = game;
          window.__AI__ = {
            taps: 0, frames: 0, direction: 'none',
            targetX: 0, playerX: 0, playerY: 0, platformsAbove: 0,
            desiredX: 187,  // canvas pixel X for Playwright to click (187 = center)
            roundOver: false
          };

          game.events.on('step', () => {
            const scene = game.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
            if (!scene || !scene.player || scene.roundOver) {
              window.__AI__.roundOver = !!scene?.roundOver;
              return;
            }
            window.__AI__.roundOver = false;

            if (!scene.player.active) return;
            window.__AI__.frames++;

            const px = scene.player.x;
            const py = scene.player.y;
            window.__AI__.playerX = Math.round(px);
            window.__AI__.playerY = Math.round(py);

            // Gather all platforms — EXPANDED search range (platforms start 700+ units above)
            const platforms = [
              ...(scene.platformPool || []),
              ...(scene.introPlatforms || []),
              ...(scene.trampolines || [])
            ].filter(p => p && p.active && p.visible);

            // Platforms ABOVE the player (more negative Y = higher up)
            // Range: 10 to 2000 units above (wide net)
            const above = platforms
              .filter(p => p.y < py - 10 && p.y > py - 2000)
              .sort((a, b) => b.y - a.y); // closest-above first

            window.__AI__.platformsAbove = above.length;

            if (above.length === 0) {
              scene.isTouching = false;
              window.__AI__.direction = 'none';
              window.__AI__.desiredX = 187;
              return;
            }

            // Pick the best target: prefer platforms close horizontally,
            // and prefer closer ones over far-above ones
            let bestTarget = above[0];
            let bestScore = -Infinity;
            for (const p of above.slice(0, 8)) {
              const xDist = Math.abs(p.x - px);
              const yDist = Math.abs(p.y - py);
              // Avoid broken platforms (texture === 'broken')
              const brokenPenalty = (p.texture?.key === 'broken') ? 200 : 0;
              // Prefer trampolines (extra bounce)
              const trampolineBonus = (p.texture?.key === 'trampoline') ? 50 : 0;
              const score = -xDist * 0.8 - yDist * 0.15 - brokenPenalty + trampolineBonus;
              if (score > bestScore) {
                bestScore = score;
                bestTarget = p;
              }
            }

            const diff = bestTarget.x - px;
            window.__AI__.targetX = Math.round(bestTarget.x);

            if (Math.abs(diff) < 15) {
              // Aligned — no steering needed
              scene.isTouching = false;
              window.__AI__.direction = 'center';
              window.__AI__.desiredX = 187;
            } else {
              const goRight = diff > 0;
              // Set Phaser's input state (game canvas coords: x < 375 = left, x > 375 = right)
              scene.isTouching = true;
              scene.input.activePointer.x = goRight ? 600 : 150;
              scene.input.activePointer.worldX = goRight ? 600 : 150;
              scene.input.activePointer.isDown = true;
              window.__AI__.taps++;
              window.__AI__.direction = goRight ? 'R' : 'L';
              // Viewport pixel (375px wide): left quarter or right quarter
              window.__AI__.desiredX = goRight ? 300 : 75;
            }
          });

          return game;
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

  async function fillAndSubmitForm() {
    // Disable overlays
    await page.evaluate(() => {
      ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => {
        const e = document.querySelector(`[data-testid="${t}"]`);
        if (e) e.style.pointerEvents = 'none';
      });
      const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
      if (f) { f.style.position = 'relative'; f.style.zIndex = '99999'; }
    });

    // Click START GAME
    await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
    await page.waitForTimeout(1500);

    // Fill form if present
    const hasForm = await page.evaluate(() => !!document.querySelector('[data-testid="GAMEFORM_CONTAINER"]'));
    if (!hasForm) { console.log('  No form visible - game may already be running'); return false; }

    for (const [placeholder, value] of [
      ['Name', NAME],
      ['Enter your e-mail address', EMAIL],
      ['username', USERNAME]
    ]) {
      await page.locator(`input[placeholder="${placeholder}"]`).click({ force: true });
      await page.locator(`input[placeholder="${placeholder}"]`).fill(value);
    }

    // Check boxes via React
    await page.evaluate(() => {
      ['GAME_FORM_TERMS', 'PARAM1'].forEach(id => {
        const c = document.getElementById(id);
        const p = Object.keys(c).find(k => k.startsWith('__reactProps$'));
        if (p && c[p].onChange) c[p].onChange({ target: { checked: true } });
      });
    });
    await page.waitForTimeout(200);

    // Submit via React onSubmit
    await page.evaluate(() => {
      const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
      const p = Object.keys(f).find(k => k.startsWith('__reactProps$'));
      if (p) f[p].onSubmit({
        preventDefault: () => {}, stopPropagation: () => {},
        target: f, currentTarget: f, nativeEvent: new Event('submit')
      });
    });
    return true;
  }

  // Submit form
  await fillAndSubmitForm();
  // Wait for game to initialize
  await page.waitForTimeout(2000);

  /**
   * Play one round:
   * - The Phaser step event AI handles steering via isTouching + activePointer.x
   * - ADDITIONALLY we do real Playwright mouse clicks in sync with AI direction
   *   (this provides real browser input events the game might rely on)
   * - We check game state every 150ms (much more frequent than before)
   */
  async function playRound(roundNum) {
    const roundStart = Date.now();
    const maxRoundMs = 120000;

    // Give initial tap in center to wake up game
    await page.mouse.click(187, 400);
    await page.waitForTimeout(100);

    let lastLogTime = Date.now();
    let clicks = 0;

    while (Date.now() - roundStart < maxRoundMs) {
      // Read AI desired direction and game state (fast snapshot)
      const snap = await page.evaluate(() => {
        const ai = window.__AI__;
        if (!ai) return null;
        return {
          desiredX: ai.desiredX,
          direction: ai.direction,
          roundOver: ai.roundOver,
          frames: ai.frames,
          playerY: ai.playerY,
          platformsAbove: ai.platformsAbove,
        };
      });

      if (!snap) { await page.waitForTimeout(50); continue; }
      if (snap.roundOver) { console.log('  → Round over (AI detected)'); break; }

      // Real click at the appropriate viewport X position
      // Game viewport: 375px wide. Left click = move left, right click = move right
      const clickX = snap.desiredX || 187;
      const clickY = 350 + Math.random() * 100;
      await page.mouse.click(clickX, clickY);
      clicks++;

      // Log every 5 seconds
      if (Date.now() - lastLogTime > 5000) {
        const elapsed = Math.round((Date.now() - roundStart) / 1000);
        const full = await page.evaluate(() => {
          const game = window.__PHASER_GAME__;
          const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
          if (!scene) return null;
          return {
            highest: Math.round(scene.highestPointReached || 0),
            difficulty: scene.currentDifficulty,
            ai: { ...window.__AI__ }
          };
        });
        if (full) {
          console.log(`  [${elapsed}s] Y:${snap.playerY} Dir:${snap.direction} Plats:${snap.platformsAbove} AItaps:${full.ai.taps} Frames:${full.ai.frames} Clicks:${clicks} High:${full.highest}`);
        }
        lastLogTime = Date.now();
      }

      // Short wait — ~100ms per click, ~10 clicks/sec
      // Fast enough to steer effectively, slow enough not to thrash
      await page.waitForTimeout(80 + Math.random() * 60);
    }

    const elapsed = Math.round((Date.now() - roundStart) / 1000);
    console.log(`  Round ${roundNum} ended after ${elapsed}s with ${clicks} clicks`);
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n=== Round ${round} / ${MAX_ROUNDS} (best: ${bestScore.toFixed(1)}) ===`);

    await playRound(round);
    // Wait for score API response
    await page.waitForTimeout(3000);

    if (bestScore >= TARGET_SCORE) {
      console.log('\n🎉🎉🎉 TARGET ACHIEVED! Score >= 300! 🎉🎉🎉');
      break;
    }

    if (round < MAX_ROUNDS) {
      // Restart: click START GAME button
      await page.evaluate(() => {
        ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => {
          const e = document.querySelector(`[data-testid="${t}"]`);
          if (e) e.style.pointerEvents = 'none';
        });
      });

      try {
        await page.locator('[data-testid="START_BUTTON"]').click({ force: true, timeout: 5000 });
        await page.waitForTimeout(1000);
      } catch {
        console.log('  No START button - stopping');
        break;
      }
    }
  }

  await page.screenshot({ path: 'screenshots/99-final.png' });

  console.log('\n=== FINAL RESULTS ===');
  console.log(`Best score: ${bestScore.toFixed(2)}`);
  if (lastScoreBody) {
    console.log(`Ranking: ${lastScoreBody.ranking}`);
    console.log(`Is cheater: ${lastScoreBody.isCheater}`);
    console.log(`Number of entries: ${lastScoreBody.numberOfEntries}`);
  }

  if (bestScore >= TARGET_SCORE) {
    console.log('\n✅ SUCCESS: Entered the Cosy Winter Kits prize draw!');
  } else {
    console.log(`\n❌ Need ${(TARGET_SCORE - bestScore).toFixed(1)} more points`);
  }

  await browser.close();
}

runGame().catch(console.error);
