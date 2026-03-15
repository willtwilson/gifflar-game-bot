/**
 * Gifflar Winter Vibe - Smart Game Player v4
 *
 * Improvements over v3:
 *  - Fix 0-duration rounds: wait for roundOver to clear before play loop
 *  - Exclude broken platforms from candidates (never steer toward them)
 *  - Plateau-breaking wander: after 4 bounces with <50 unit apex progress, alternate L/R
 *  - Trampoline targeting: wider steering threshold (30→50) when target is trampoline
 *  - 60 max rounds to get more attempts
 *  - Wander alternates direction every 3 bounces when stuck
 */

const { chromium } = require('playwright');

const EMAIL    = 'willtwilson+giff@gmail.com';
const NAME     = 'Will Wilson';
const USERNAME = 'Frilliam';
const TARGET_SCORE = 300;
const MAX_ROUNDS   = 60;

async function runGame() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport:  { width: 375, height: 812 },
    hasTouch:  true,
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

  // Inject AI script BEFORE page loads
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
            targetX: 0, targetTex: '?',
            playerX: 0, playerY: 0,
            platformsAbove: 0,
            desiredX: 187,
            roundOver: false,
            bounceH: 0, apexY: 0, lastPlatY: 0,
            phase: 'init', stagnant: 0,
            _dyn: {
              prevY: null,
              wasGoingUp: false, wasGoingDown: false,
              platformY: null,
              apexY: null,
              bounceH: 380,
              stagnantBounces: 0,
              wanderDir: 1,          // +1 = right, -1 = left for wander alternation
              bounceCount: 0,
              initialized: false
            }
          };

          game.events.on('step', () => {
            const scene = game.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
            if (!scene || !scene.player) { window.__AI__.roundOver = true;  return; }
            if (scene.roundOver)         { window.__AI__.roundOver = true;  return; }

            const ai = window.__AI__;
            const d  = ai._dyn;

            // ---- Detect new round start: reset dynamics when roundOver clears ----
            if (ai._wasRoundOver && !scene.roundOver) {
              d.prevY          = null;
              d.platformY      = null;
              d.apexY          = null;
              d.stagnantBounces = 0;
              d.wanderDir      = 1;
              d.bounceCount    = 0;
              d.initialized    = false;
            }
            ai._wasRoundOver = scene.roundOver;
            window.__AI__.roundOver = false;
            if (!scene.player.active) return;

            ai.frames++;

            const px = scene.player.x;
            const py = scene.player.y;
            ai.playerX = Math.round(px);
            ai.playerY = Math.round(py);

            // ---- Initialise dynamic tracking ----
            if (!d.initialized || d.prevY === null) {
              d.prevY    = py;
              d.platformY = py;
              d.apexY    = py - d.bounceH;
              d.initialized = true;
              return;
            }

            // ---- Bounce dynamics ----
            const vy        = py - d.prevY;
            const goingUp   = vy < -0.5;
            const goingDown = vy >  0.5;

            if (goingUp && d.wasGoingDown) {
              // Ball just bounced off a platform
              d.platformY = d.prevY;
              d.bounceCount++;
            }
            if (goingDown && d.wasGoingUp) {
              // Ball just reached its apex
              const newApexY = d.prevY;
              // Measure upward progress (new apex higher = more negative Y)
              const progress = (d.apexY !== null) ? (d.apexY - newApexY) : 100;
              if (progress > 50) {
                d.stagnantBounces = 0;  // making progress — reset stagnation counter
              } else {
                d.stagnantBounces++;    // stuck at same height
                // Flip wander direction every 3 stagnant bounces
                if (d.stagnantBounces % 3 === 0) d.wanderDir *= -1;
              }
              const bh = Math.abs(d.platformY - newApexY);
              if (bh > 50 && bh < 4000) d.bounceH = d.bounceH * 0.65 + bh * 0.35;
              d.apexY = newApexY;
              ai.bounceH   = Math.round(d.bounceH);
              ai.apexY     = Math.round(d.apexY);
              ai.lastPlatY = Math.round(d.platformY);
              ai.stagnant  = d.stagnantBounces;
            }
            d.wasGoingUp   = goingUp;
            d.wasGoingDown = goingDown;
            d.prevY        = py;

            ai.phase = goingUp ? 'rising' : goingDown ? 'falling' : 'apex';

            // ---- Plateau-breaking wander ----
            if (d.stagnantBounces >= 4) {
              const xVel = d.wanderDir * 12.8;
              try { scene.player.setVelocity(xVel, scene.player.getVelocityY()); } catch (_) {}
              scene.isTouching = true;
              scene.input.activePointer.x      = d.wanderDir > 0 ? 600 : 150;
              scene.input.activePointer.worldX = d.wanderDir > 0 ? 600 : 150;
              scene.input.activePointer.isDown = true;
              ai.taps++;
              ai.direction = d.wanderDir > 0 ? 'R(wander)' : 'L(wander)';
              ai.desiredX  = d.wanderDir > 0 ? 300 : 75;
              return;  // skip normal targeting while wandering
            }

            // ---- Gather platforms (exclude broken) ----
            const allPlats = [
              ...(scene.platformPool    || []),
              ...(scene.introPlatforms  || []),
              ...(scene.trampolines     || [])
            ].filter(p => {
              if (!p || !p.active || !p.visible) return false;
              const key = p.texture?.key || '';
              return key !== 'broken';  // never target broken platforms
            });

            // ---- Phase-aware candidate selection ----
            let candidates = [];

            if (goingDown || ai.phase === 'apex') {
              // FALLING: look for platforms between apex and bounce floor
              // Landing on one of these steps us up progressively
              if (d.apexY !== null && d.platformY !== null) {
                candidates = allPlats.filter(p =>
                  p.y > d.apexY + 10 &&     // below apex (ball can reach while falling)
                  p.y < d.platformY - 20    // above current bounce floor (progress!)
                );
              }
              if (candidates.length === 0) {
                // Fallback: platforms near current player position
                candidates = allPlats.filter(p =>
                  p.y < py + 50 && p.y > py - d.bounceH
                );
              }
            } else {
              // RISING: target platform just above current apex for next bounce cycle
              if (d.apexY !== null) {
                candidates = allPlats.filter(p =>
                  p.y < d.apexY - 20 &&
                  p.y > d.apexY - d.bounceH * 1.25
                );
              }
              if (candidates.length === 0) {
                candidates = allPlats.filter(p =>
                  p.y < py - 20 && p.y > py - d.bounceH
                );
              }
            }

            // Last resort: any non-broken platform within 2000 units above
            if (candidates.length === 0) {
              candidates = allPlats.filter(p => p.y < py - 10 && p.y > py - 2000);
            }

            ai.platformsAbove = candidates.length;

            // ---- Score candidates ----
            let bestTarget = null, bestPScore = -Infinity;
            for (const p of candidates) {
              const xDist = Math.abs(p.x - px);
              const key   = p.texture?.key || '';
              const isTrampoline = key === 'trampoline' || key === 'spring';
              const isMoving     = key === 'moving';
              // Higher platforms get a meaningful bonus to prefer upward progress
              const heightBonus = -(p.y) * 0.08;
              const pScore =
                -xDist * 0.8
                + heightBonus
                + (isTrampoline ? 600 : 0)   // strongly prefer trampolines
                - (isMoving     ? 30  : 0);
              if (pScore > bestPScore) { bestPScore = pScore; bestTarget = p; }
            }

            if (!bestTarget) {
              ai.direction     = 'none';
              ai.desiredX      = 187;
              scene.isTouching = false;
              return;
            }

            const diff        = bestTarget.x - px;
            ai.targetX        = Math.round(bestTarget.x);
            ai.targetTex      = bestTarget.texture?.key || '?';

            // Wider threshold when trampoline — don't give up early on it
            const isTrampoline = ai.targetTex === 'trampoline' || ai.targetTex === 'spring';
            const THRESHOLD    = isTrampoline ? 10 : 20;

            if (Math.abs(diff) < THRESHOLD) {
              ai.direction     = 'center';
              ai.desiredX      = 187;
              scene.isTouching = false;
            } else {
              const goRight = diff > 0;
              const xVel    = goRight ? 12.8 : -12.8;

              // Primary: direct velocity injection
              try { scene.player.setVelocity(xVel, scene.player.getVelocityY()); } catch (_) {}

              // Secondary: isTouching
              scene.isTouching = true;
              scene.input.activePointer.x      = goRight ? 600 : 150;
              scene.input.activePointer.worldX = goRight ? 600 : 150;
              scene.input.activePointer.isDown = true;

              ai.taps++;
              ai.direction = goRight ? 'R' : 'L';
              ai.desiredX  = goRight ? 300 : 75;
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
    await page.evaluate(() => {
      ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => {
        const e = document.querySelector(`[data-testid="${t}"]`);
        if (e) e.style.pointerEvents = 'none';
      });
      const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"]');
      if (f) { f.style.position = 'relative'; f.style.zIndex = '99999'; }
    });

    await page.locator('[data-testid="START_BUTTON"]').click({ force: true });
    await page.waitForTimeout(1500);

    const hasForm = await page.evaluate(() => !!document.querySelector('[data-testid="GAMEFORM_CONTAINER"]'));
    if (!hasForm) { console.log('  No form — game already running'); return false; }

    for (const [placeholder, value] of [
      ['Name', NAME],
      ['Enter your e-mail address', EMAIL],
      ['username', USERNAME]
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
    await page.waitForTimeout(200);

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

  await fillAndSubmitForm();
  await page.waitForTimeout(2000);

  async function playRound(roundNum) {
    // FIX: wait for roundOver to clear from previous round before starting
    const waitClearStart = Date.now();
    while (Date.now() - waitClearStart < 4000) {
      const isOver = await page.evaluate(() => window.__AI__?.roundOver ?? true);
      if (!isOver) break;
      await page.waitForTimeout(150);
    }

    const roundStart    = Date.now();
    const maxRoundMs    = 180000;
    let lastLogTime     = Date.now();
    let clicks          = 0;
    let roundEndScreenshot = false;

    // Initial tap to wake up the game
    await page.mouse.click(187, 400);
    await page.waitForTimeout(100);

    while (Date.now() - roundStart < maxRoundMs) {
      const snap = await page.evaluate(() => {
        const ai = window.__AI__;
        if (!ai) return null;
        return {
          desiredX:       ai.desiredX,
          direction:      ai.direction,
          roundOver:      ai.roundOver,
          frames:         ai.frames,
          playerY:        ai.playerY,
          platformsAbove: ai.platformsAbove,
          phase:          ai.phase,
          bounceH:        ai.bounceH,
          apexY:          ai.apexY,
          lastPlatY:      ai.lastPlatY,
          taps:           ai.taps,
          targetTex:      ai.targetTex,
          stagnant:       ai.stagnant,
        };
      });

      if (!snap) { await page.waitForTimeout(50); continue; }

      if (snap.roundOver && !roundEndScreenshot) {
        roundEndScreenshot = true;
        const ssPath = `screenshots/round${String(roundNum).padStart(2,'0')}-end.png`;
        await page.screenshot({ path: ssPath });
        console.log(`  → Round over — screenshot: ${ssPath}`);
        break;
      }
      if (snap.roundOver) break;

      // Click at AI-directed X
      const clickX = snap.desiredX || 187;
      await page.mouse.click(clickX, 350 + Math.random() * 100);
      clicks++;

      // Status log every 5 seconds
      if (Date.now() - lastLogTime > 5000) {
        const elapsed = Math.round((Date.now() - roundStart) / 1000);
        const full = await page.evaluate(() => {
          const game  = window.__PHASER_GAME__;
          const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
          return scene ? { highest: Math.round(scene.highestPointReached || 0), ai: { ...window.__AI__, _dyn: undefined } } : null;
        });
        if (full) {
          const ai = full.ai;
          console.log(
            `  [${elapsed}s] Y:${snap.playerY} Ph:${snap.phase} Dir:${snap.direction}` +
            ` Tex:${snap.targetTex} Cands:${snap.platformsAbove}` +
            ` BH:${snap.bounceH} Apex:${snap.apexY} Stag:${snap.stagnant}` +
            ` Taps:${ai.taps} Clicks:${clicks} High:${full.highest}`
          );
        }
        lastLogTime = Date.now();
      }

      await page.waitForTimeout(80 + Math.random() * 40);
    }

    const elapsed = Math.round((Date.now() - roundStart) / 1000);
    console.log(`  Round ${roundNum} ended after ${elapsed}s | ${clicks} clicks`);
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n=== Round ${round} / ${MAX_ROUNDS} (best: ${bestScore.toFixed(1)}) ===`);

    await playRound(round);
    await page.waitForTimeout(3000);  // wait for score API

    if (bestScore >= TARGET_SCORE) {
      console.log('\n🎉🎉🎉 TARGET ACHIEVED! Score >= 300! 🎉🎉🎉');
      break;
    }

    if (round < MAX_ROUNDS) {
      await page.evaluate(() => {
        ['MODAL_BACKDROP', 'ADDITIONAL_TEXT_CONTAINER'].forEach(t => {
          const e = document.querySelector(`[data-testid="${t}"]`);
          if (e) e.style.pointerEvents = 'none';
        });
      });
      try {
        await page.locator('[data-testid="START_BUTTON"]').click({ force: true, timeout: 5000 });
        await page.waitForTimeout(1500);
      } catch {
        console.log('  No START button — stopping');
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
