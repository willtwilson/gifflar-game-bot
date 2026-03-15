/**
 * Gifflar Winter Vibe - Smart Game Player v4
 *
 * Improvements over v3:
 *  - Fix round-reset bug: _inRoundOver flag set BEFORE early return so transition is detected
 *  - Platform blacklist: after 3 failed bounce attempts at a target, blacklist it; reset on real progress
 *  - Sideways reach filter: only target platforms within max horizontal travel distance per bounce
 *  - Screen-wrap awareness: effective X distance = min(|dx|, WORLD_WIDTH - |dx|)
 *  - Brown/broken platform exclusion: never include in candidates
 *  - Wander alternates direction every 3 stagnant bounces to escape plateau
 *  - 60 max rounds
 */

const { chromium } = require('playwright');

const EMAIL        = 'willtwilson+giff@gmail.com';
const NAME         = 'Will Wilson';
const USERNAME     = 'Frilliam';
const TARGET_SCORE = 300;
const MAX_ROUNDS   = 60;
const WORLD_WIDTH  = 750; // game canvas width in world units

async function runGame() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport:  { width: 375, height: 812 },
    hasTouch:  true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  let bestScore    = 0;
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
        console.log(`  🎮 Round started: playerId=${body.playerId?.substring(0,8)}...`);
      } catch {}
    }
  });

  await page.addInitScript(() => {
    // Shared constants (must be literals inside injected script)
    const WORLD_WIDTH   = 750;
    const X_VEL         = 12.8;   // game units/frame when steering
    const BH_INIT       = 380;    // initial bounce-height estimate (world units)
    const STEER_THRESH  = 20;     // align within this many units → no steering
    const TRAM_THRESH   = 10;     // tighter threshold to ensure trampoline hit
    const WANDER_AFTER  = 4;      // stagnant bounce count before wander kicks in
    const BLACKLIST_AT  = 3;      // failed attempts before a target is blacklisted

    let w = setInterval(() => {
      if (window.Phaser && !window.__ph) {
        window.__ph = true;
        const OG = window.Phaser.Game;

        window.Phaser.Game = function(...args) {
          const game = new OG(...args);
          window.__PHASER_GAME__ = game;

          // Telemetry exposed to Playwright
          window.__AI__ = {
            taps: 0, frames: 0,
            direction: 'none', targetTex: '?', targetX: 0,
            playerX: 0, playerY: 0,
            platformsAbove: 0, desiredX: 187,
            roundOver: false, phase: 'init',
            bounceH: 0, apexY: 0, lastPlatY: 0,
            stagnant: 0, blacklistSize: 0,
            _inRoundOver: false,
            _dyn: null   // initialised per-round
          };

          function freshDyn() {
            return {
              prevY:          null,
              wasGoingUp:     false,
              wasGoingDown:   false,
              platformY:      null,
              apexY:          null,
              bounceH:        BH_INIT,
              bounceFrames:   100,      // frames per bounce cycle (EMA)
              lastBounceFrame: null,
              stagnantBounces: 0,
              wanderDir:      1,
              bounceCount:    0,
              blacklisted:    {},       // "x_y" → true
              targetFailCounts: {},     // "x_y" → count of failed attempts
              prevTargetX:    null,
              prevTargetY:    null,
              initialized:    false
            };
          }

          window.__AI__._dyn = freshDyn();

          game.events.on('step', () => {
            const scene = game.scene?.scenes?.find(
              s => s.sys?.settings?.key === 'GAME_SCENE'
            );

            const ai = window.__AI__;

            if (!scene || !scene.player || scene.roundOver) {
              // Mark that we are (or were) in round-over state BEFORE returning
              ai._inRoundOver = true;
              ai.roundOver = true;
              return;
            }

            // ---- Detect new round start (transition: roundOver → active) ----
            if (ai._inRoundOver) {
              ai._dyn = freshDyn();   // full reset every new round
              ai._inRoundOver = false;
            }
            ai.roundOver = false;
            if (!scene.player.active) return;

            const d = ai._dyn;
            ai.frames++;

            const px = scene.player.x;
            const py = scene.player.y;
            ai.playerX = Math.round(px);
            ai.playerY = Math.round(py);

            // ---- First-frame initialisation ----
            if (!d.initialized || d.prevY === null) {
              d.prevY     = py;
              d.platformY = py;
              d.apexY     = py - d.bounceH;
              d.lastBounceFrame = ai.frames;
              d.initialized = true;
              return;
            }

            // ---- Bounce dynamics ----
            const vy        = py - d.prevY;
            const goingUp   = vy < -0.5;
            const goingDown = vy >  0.5;

            if (goingUp && d.wasGoingDown) {
              // ── Ball just bounced off a platform ──
              const newPlatY = d.prevY;

              // Measure frames per bounce cycle
              if (d.lastBounceFrame !== null) {
                const cycleFr = ai.frames - d.lastBounceFrame;
                if (cycleFr > 5 && cycleFr < 600) {
                  d.bounceFrames = d.bounceFrames * 0.7 + cycleFr * 0.3;
                }
              }
              d.lastBounceFrame = ai.frames;
              d.bounceCount++;

              // ── Platform blacklist: did we reach our previous target? ──
              if (d.prevTargetY !== null) {
                const reached = Math.abs(newPlatY - d.prevTargetY) < 60;
                if (reached) {
                  // Landed on the target — clear blacklist (real progress)
                  d.blacklisted     = {};
                  d.targetFailCounts = {};
                } else {
                  const fk = `${Math.round(d.prevTargetX / 20) * 20}_${Math.round(d.prevTargetY / 20) * 20}`;
                  d.targetFailCounts[fk] = (d.targetFailCounts[fk] || 0) + 1;
                  if (d.targetFailCounts[fk] >= BLACKLIST_AT) {
                    d.blacklisted[fk] = true;
                  }
                }
              }

              // Also clear blacklist if we've genuinely climbed (new floor >> old floor)
              if (d.platformY !== null && newPlatY < d.platformY - 150) {
                d.blacklisted      = {};
                d.targetFailCounts = {};
              }

              d.platformY = newPlatY;
            }

            if (goingDown && d.wasGoingUp) {
              // ── Ball reached apex ──
              const newApexY = d.prevY;
              const progress = (d.apexY !== null) ? (d.apexY - newApexY) : 100;
              if (progress > 50) {
                d.stagnantBounces = 0;
              } else {
                d.stagnantBounces++;
                if (d.stagnantBounces % 3 === 0) d.wanderDir *= -1;
              }
              const bh = Math.abs((d.platformY ?? newApexY) - newApexY);
              if (bh > 50 && bh < 4000) d.bounceH = d.bounceH * 0.65 + bh * 0.35;
              d.apexY = newApexY;
              ai.bounceH    = Math.round(d.bounceH);
              ai.apexY      = Math.round(d.apexY);
              ai.lastPlatY  = Math.round(d.platformY ?? 0);
              ai.stagnant   = d.stagnantBounces;
              ai.blacklistSize = Object.keys(d.blacklisted).length;
            }

            d.wasGoingUp   = goingUp;
            d.wasGoingDown = goingDown;
            d.prevY        = py;

            ai.phase = goingUp ? 'rising' : goingDown ? 'falling' : 'apex';

            // ──────────────── Wander mode (plateau escape) ────────────────
            if (d.stagnantBounces >= WANDER_AFTER) {
              const xVel = d.wanderDir * X_VEL;
              try { scene.player.setVelocity(xVel, scene.player.getVelocityY()); } catch (_) {}
              scene.isTouching = true;
              scene.input.activePointer.x      = d.wanderDir > 0 ? 600 : 150;
              scene.input.activePointer.worldX = d.wanderDir > 0 ? 600 : 150;
              scene.input.activePointer.isDown = true;
              ai.taps++;
              ai.direction = d.wanderDir > 0 ? 'R(wander)' : 'L(wander)';
              ai.desiredX  = d.wanderDir > 0 ? 300 : 75;
              return;
            }

            // ──────────────── Gather platforms ────────────────
            // Exclude broken/brown platforms entirely — they collapse on landing
            const BROKEN_KEYS = new Set(['broken', 'brown']);
            const allPlats = [
              ...(scene.platformPool   || []),
              ...(scene.introPlatforms || []),
              ...(scene.trampolines    || [])
            ].filter(p => {
              if (!p || !p.active || !p.visible) return false;
              return !BROKEN_KEYS.has(p.texture?.key || '');
            });

            // Max horizontal reach this bounce (full cycle, conservative)
            // With screen wrap, effective X distance is min(|dx|, WORLD_WIDTH - |dx|)
            const maxReach = X_VEL * d.bounceFrames;

            function effectiveXDist(platX) {
              const raw = Math.abs(platX - px);
              return Math.min(raw, WORLD_WIDTH - raw);
            }

            function isBlacklisted(p) {
              const k = `${Math.round(p.x / 20) * 20}_${Math.round(p.y / 20) * 20}`;
              return !!d.blacklisted[k];
            }

            // ──────────────── Phase-aware candidate selection ────────────────
            let candidates = [];

            if (goingDown || ai.phase === 'apex') {
              // FALLING: catch a platform between apex and current floor → step-up
              if (d.apexY !== null && d.platformY !== null) {
                candidates = allPlats.filter(p =>
                  p.y > d.apexY + 10 &&
                  p.y < d.platformY - 20 &&
                  effectiveXDist(p.x) <= maxReach &&
                  !isBlacklisted(p)
                );
              }
              if (candidates.length === 0) {
                candidates = allPlats.filter(p =>
                  p.y < py + 50 && p.y > py - d.bounceH &&
                  effectiveXDist(p.x) <= maxReach && !isBlacklisted(p)
                );
              }
            } else {
              // RISING: target above current apex for next bounce cycle
              if (d.apexY !== null) {
                candidates = allPlats.filter(p =>
                  p.y < d.apexY - 20 &&
                  p.y > d.apexY - d.bounceH * 1.25 &&
                  effectiveXDist(p.x) <= maxReach && !isBlacklisted(p)
                );
              }
              if (candidates.length === 0) {
                candidates = allPlats.filter(p =>
                  p.y < py - 20 && p.y > py - d.bounceH &&
                  effectiveXDist(p.x) <= maxReach && !isBlacklisted(p)
                );
              }
            }

            // Last resort: any reachable non-broken platform above player
            if (candidates.length === 0) {
              candidates = allPlats.filter(p =>
                p.y < py - 10 && p.y > py - 2000 &&
                effectiveXDist(p.x) <= maxReach && !isBlacklisted(p)
              );
            }
            // Final fallback: ignore reach + blacklist constraints
            if (candidates.length === 0) {
              candidates = allPlats.filter(p =>
                p.y < py - 10 && p.y > py - 2000
              );
            }

            ai.platformsAbove = candidates.length;

            // ──────────────── Score candidates ────────────────
            let bestTarget = null, bestPScore = -Infinity;
            for (const p of candidates) {
              const xEff = effectiveXDist(p.x);
              const key  = p.texture?.key || '';
              const isTrampoline = key === 'trampoline' || key === 'spring';
              const isMoving     = key === 'moving';
              // Prefer: horizontally close, higher up, trampolines
              const pScore =
                -xEff * 0.8
                + (-p.y) * 0.05       // higher platform (more negative Y) = bonus
                + (isTrampoline ? 600 : 0)
                - (isMoving     ? 30  : 0);
              if (pScore > bestPScore) { bestPScore = pScore; bestTarget = p; }
            }

            if (!bestTarget) {
              ai.direction     = 'none';
              ai.desiredX      = 187;
              scene.isTouching = false;
              return;
            }

            // Store target for blacklist tracking next bounce
            d.prevTargetX = bestTarget.x;
            d.prevTargetY = bestTarget.y;

            ai.targetX   = Math.round(bestTarget.x);
            ai.targetTex = bestTarget.texture?.key || '?';

            // Calculate effective diff with screen-wrap
            let diff = bestTarget.x - px;
            if (Math.abs(diff) > WORLD_WIDTH / 2) {
              diff = diff > 0 ? diff - WORLD_WIDTH : diff + WORLD_WIDTH;
            }

            const isTrampoline = ai.targetTex === 'trampoline' || ai.targetTex === 'spring';
            const threshold    = isTrampoline ? TRAM_THRESH : STEER_THRESH;

            if (Math.abs(diff) < threshold) {
              ai.direction     = 'center';
              ai.desiredX      = 187;
              scene.isTouching = false;
            } else {
              const goRight = diff > 0;
              const xVel    = goRight ? X_VEL : -X_VEL;

              try { scene.player.setVelocity(xVel, scene.player.getVelocityY()); } catch (_) {}
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
  await page.goto(
    'https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f',
    { waitUntil: 'networkidle', timeout: 30000 }
  );
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

    const hasForm = await page.evaluate(
      () => !!document.querySelector('[data-testid="GAMEFORM_CONTAINER"]')
    );
    if (!hasForm) { console.log('  No form — game already running'); return; }

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
  }

  await fillAndSubmitForm();
  await page.waitForTimeout(2000);

  async function playRound(roundNum) {
    // Wait for any stale roundOver=true from previous round to clear
    const waitStart = Date.now();
    while (Date.now() - waitStart < 5000) {
      const over = await page.evaluate(() => window.__AI__?._inRoundOver ?? true);
      if (!over) break;
      await page.waitForTimeout(150);
    }

    const roundStart = Date.now();
    const maxRoundMs = 180000;
    let lastLogTime  = Date.now();
    let clicks       = 0;
    let screenshotted = false;

    await page.mouse.click(187, 400);
    await page.waitForTimeout(100);

    while (Date.now() - roundStart < maxRoundMs) {
      const snap = await page.evaluate(() => {
        const ai = window.__AI__;
        if (!ai) return null;
        return {
          desiredX:      ai.desiredX,
          direction:     ai.direction,
          roundOver:     ai.roundOver,
          playerY:       ai.playerY,
          platformsAbove: ai.platformsAbove,
          phase:         ai.phase,
          bounceH:       ai.bounceH,
          apexY:         ai.apexY,
          stagnant:      ai.stagnant,
          blacklistSize: ai.blacklistSize,
          targetTex:     ai.targetTex,
          taps:          ai.taps,
        };
      });

      if (!snap) { await page.waitForTimeout(50); continue; }

      if (snap.roundOver && !screenshotted) {
        screenshotted = true;
        const ssPath = `screenshots/round${String(roundNum).padStart(2, '0')}-end.png`;
        await page.screenshot({ path: ssPath });
        console.log(`  → Round over — screenshot: ${ssPath}`);
        break;
      }
      if (snap.roundOver) break;

      await page.mouse.click(snap.desiredX || 187, 350 + Math.random() * 100);
      clicks++;

      if (Date.now() - lastLogTime > 5000) {
        const elapsed = Math.round((Date.now() - roundStart) / 1000);
        const full = await page.evaluate(() => {
          const game  = window.__PHASER_GAME__;
          const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
          return scene ? { highest: Math.round(scene.highestPointReached || 0) } : null;
        });
        if (full) {
          console.log(
            `  [${elapsed}s] Y:${snap.playerY} Ph:${snap.phase} Dir:${snap.direction}` +
            ` Tex:${snap.targetTex} Cands:${snap.platformsAbove}` +
            ` BH:${snap.bounceH} Apex:${snap.apexY} Stag:${snap.stagnant}` +
            ` BL:${snap.blacklistSize} Taps:${snap.taps} Clicks:${clicks} High:${full.highest}`
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
    await page.waitForTimeout(3000);

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
