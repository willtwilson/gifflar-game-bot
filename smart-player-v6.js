/**
 * Gifflar Winter Vibe - Smart Game Player v6
 *
 * Improvements over v5:
 *  - Score-based stagnation detection: track actual game score across bounces;
 *    only reset stagnant counter when real score improves (not just apex height)
 *  - Force early round exit: when score hasn't improved in 10 bounces AND apex
 *    stagnant for 8+ bounces, stop steering so the ball falls off quickly
 *  - Revert WANDER_AFTER to 4 (was 3); lower value caused premature escape
 *    attempts that disrupted good climbing trajectories
 *  - Revert height scoring coefficient to 0.05 (was 0.08); 0.08 caused AI to
 *    over-prioritize unreachable high platforms
 *  - Escape mode height coefficient reverted to 0.10 (was 0.15)
 *  - Remove recency penalty from normal platform selection (keep in escape mode);
 *    penalty was causing AI to avoid optimal nearby platforms
 *  - Log stagnantScoreBounces (SSB) in telemetry
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EMAIL        = 'willtwilson+giff@gmail.com';
const NAME         = 'Will Wilson';
const USERNAME     = 'Frilliam';
const TARGET_SCORE = 300;
const MAX_ROUNDS   = 60;
const WORLD_WIDTH  = 750;

// Ensure screenshots dir exists
if (!fs.existsSync('screenshots')) fs.mkdirSync('screenshots');

async function runGame() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport:  { width: 375, height: 812 },
    hasTouch:  true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  });
  const page = await context.newPage();

  let bestScore = 0;

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/post-game-score')) {
      try {
        const body = await res.json();
        if (body.highScore > bestScore) bestScore = body.highScore;
        console.log(`  🏆 Score: ${body.highScore.toFixed(1)} | Rank: ${body.ranking}`);
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
    const WORLD_WIDTH   = 750;
    const X_VEL         = 12.8;
    const BH_INIT       = 380;
    const BH_FLOOR      = 220;    // never drop below this (avoids over-filtering)
    const STEER_THRESH  = 20;
    const TRAM_THRESH   = 10;
    const WANDER_AFTER  = 4;      // v6: reverted from 3 → 4 to avoid premature escape
    const BLACKLIST_AT  = 3;
    const VISITED_RECENCY = 6;    // last N platforms to track as "recently visited"

    let w = setInterval(() => {
      if (window.Phaser && !window.__ph) {
        window.__ph = true;
        const OG = window.Phaser.Game;

        window.Phaser.Game = function(...args) {
          const game = new OG(...args);
          window.__PHASER_GAME__ = game;

          window.__AI__ = {
            taps: 0, frames: 0,
            direction: 'none', targetTex: '?', targetX: 0,
            playerX: 0, playerY: 0,
            platformsAbove: 0, desiredX: 187,
            roundOver: false, phase: 'init',
            bounceH: 0, apexY: 0, lastPlatY: 0,
            stagnant: 0, blacklistSize: 0,
            stagnantScore: 0,   // v6: score-based stagnation counter
            _inRoundOver: false,
            _dyn: null
          };

          function freshDyn() {
            return {
              prevY:          null,
              wasGoingUp:     false,
              wasGoingDown:   false,
              platformY:      null,
              apexY:          null,
              bounceH:        BH_INIT,
              bounceFrames:   100,
              lastBounceFrame: null,
              stagnantBounces: 0,
              wanderDir:      1,
              bounceCount:    0,
              blacklisted:    {},
              targetFailCounts: {},
              prevTargetX:    null,
              prevTargetY:    null,
              // v5: recently visited platform buckets (ring buffer)
              recentPlatforms: [],
              currentPlatKey:  null,
              // v6: score-based stagnation tracking
              prevActualScore:     0,
              stagnantScoreBounces: 0,
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
              ai._inRoundOver = true;
              ai.roundOver = true;
              return;
            }

            if (ai._inRoundOver) {
              ai._dyn = freshDyn();
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

            if (!d.initialized || d.prevY === null) {
              d.prevY     = py;
              d.platformY = py;
              d.apexY     = py - d.bounceH;
              d.lastBounceFrame = ai.frames;
              d.initialized = true;
              return;
            }

            const vy        = py - d.prevY;
            const goingUp   = vy < -0.5;
            const goingDown = vy >  0.5;

            if (goingUp && d.wasGoingDown) {
              // Ball just bounced off a platform
              const newPlatY = d.prevY;

              if (d.lastBounceFrame !== null) {
                const cycleFr = ai.frames - d.lastBounceFrame;
                if (cycleFr > 5 && cycleFr < 600) {
                  d.bounceFrames = d.bounceFrames * 0.7 + cycleFr * 0.3;
                }
              }
              d.lastBounceFrame = ai.frames;
              d.bounceCount++;

              // Blacklist tracking (failed to reach previous target)
              if (d.prevTargetY !== null) {
                const reached = Math.abs(newPlatY - d.prevTargetY) < 60;
                if (reached) {
                  d.blacklisted      = {};
                  d.targetFailCounts = {};
                } else {
                  const fk = `${Math.round(d.prevTargetX / 20) * 20}_${Math.round(d.prevTargetY / 20) * 20}`;
                  d.targetFailCounts[fk] = (d.targetFailCounts[fk] || 0) + 1;
                  if (d.targetFailCounts[fk] >= BLACKLIST_AT) {
                    d.blacklisted[fk] = true;
                  }
                }
              }

              // Clear blacklist when we've genuinely climbed
              if (d.platformY !== null && newPlatY < d.platformY - 150) {
                d.blacklisted      = {};
                d.targetFailCounts = {};
              }

              // v5: Track recently visited platforms (ring buffer)
              const platKey = `${Math.round(px / 30) * 30}_${Math.round(newPlatY / 30) * 30}`;
              d.currentPlatKey = platKey;
              if (!d.recentPlatforms.includes(platKey)) {
                d.recentPlatforms.push(platKey);
                if (d.recentPlatforms.length > VISITED_RECENCY) {
                  d.recentPlatforms.shift(); // remove oldest
                }
              }

              d.platformY = newPlatY;
            }

            if (goingDown && d.wasGoingUp) {
              // Ball reached apex
              const newApexY = d.prevY;
              const progress = (d.apexY !== null) ? (d.apexY - newApexY) : 100;

              // v6: Score-based stagnation (more accurate than apex tracking)
              const actualScore = Math.round(scene.highestPointReached || 0);
              if (actualScore > d.prevActualScore + 3) {
                d.stagnantBounces     = 0;
                d.stagnantScoreBounces = 0;
                d.prevActualScore      = actualScore;
              } else {
                d.stagnantScoreBounces++;
                // Only count as stagnant if BOTH apex and score are not improving
                if (progress <= 50) d.stagnantBounces++;
              }

              // Flip wander direction every 2 stagnant bounces
              if (d.stagnantBounces % 2 === 0 && d.stagnantBounces > 0) d.wanderDir *= -1;

              const bh = Math.abs((d.platformY ?? newApexY) - newApexY);
              if (bh > 50 && bh < 4000) {
                const newBH = d.bounceH * 0.65 + bh * 0.35;
                d.bounceH = Math.max(newBH, BH_FLOOR); // enforce floor
              }
              d.apexY = newApexY;
              ai.bounceH      = Math.round(d.bounceH);
              ai.apexY        = Math.round(d.apexY);
              ai.lastPlatY    = Math.round(d.platformY ?? 0);
              ai.stagnant     = d.stagnantBounces;
              ai.stagnantScore = d.stagnantScoreBounces;  // v6
              ai.blacklistSize = Object.keys(d.blacklisted).length;
            }

            d.wasGoingUp   = goingUp;
            d.wasGoingDown = goingDown;
            d.prevY        = py;

            ai.phase = goingUp ? 'rising' : goingDown ? 'falling' : 'apex';

            // ──────────────── Gather platforms ────────────────
            const BROKEN_KEYS = new Set(['broken', 'brown']);
            const allPlats = [
              ...(scene.platformPool   || []),
              ...(scene.introPlatforms || []),
              ...(scene.trampolines    || [])
            ].filter(p => {
              if (!p || !p.active || !p.visible) return false;
              return !BROKEN_KEYS.has(p.texture?.key || '');
            });

            // Horizontal reach this bounce cycle
            const maxReach = X_VEL * d.bounceFrames;

            function effectiveXDist(platX) {
              const raw = Math.abs(platX - px);
              return Math.min(raw, WORLD_WIDTH - raw);
            }

            function isBlacklisted(p) {
              const k = `${Math.round(p.x / 20) * 20}_${Math.round(p.y / 20) * 20}`;
              return !!d.blacklisted[k];
            }

            // v5: recency penalty for platforms we recently visited (used in escape mode)
            function recencyPenalty(p) {
              const k = `${Math.round(p.x / 30) * 30}_${Math.round(p.y / 30) * 30}`;
              const idx = d.recentPlatforms.indexOf(k);
              if (idx === -1) return 0;
              // Most recently visited = largest penalty
              const recency = idx - (d.recentPlatforms.length - 1); // 0 = most recent, negative = older
              return (recency + VISITED_RECENCY) * 30; // 0 (oldest) → 150 (newest) penalty
            }

            // ──────────────── Stagnation escape: expanded search ────────────────
            if (d.stagnantBounces >= WANDER_AFTER) {
              // v6: If truly stuck (score hasn't improved in 10 bounces AND stagnant 8+),
              // stop steering to end the round quickly
              if (d.stagnantScoreBounces >= 10 && d.stagnantBounces >= 8) {
                scene.isTouching = false;
                ai.direction = 'QUIT';
                ai.desiredX = 187;
                ai.platformsAbove = 0;
                return;
              }

              // Clear blacklist when very stuck
              if (d.stagnantBounces >= 5) {
                d.blacklisted      = {};
                d.targetFailCounts = {};
              }

              // Expanded search: relax Y and X constraints significantly
              const expandFactor = 1.0 + (d.stagnantBounces - WANDER_AFTER + 1) * 0.5;
              const expandedCands = allPlats.filter(p =>
                p.y < (d.apexY ?? py) - 10 &&             // above current apex
                p.y > (d.apexY ?? py) - d.bounceH * (1.5 + expandFactor) && // expanded Y reach
                effectiveXDist(p.x) <= maxReach * (1.0 + expandFactor * 0.3) // expanded X reach
              );

              if (expandedCands.length > 0) {
                // Score with strong height preference + recency penalty
                let bestTarget = null, bestPScore = -Infinity;
                for (const p of expandedCands) {
                  const xEff = effectiveXDist(p.x);
                  const key  = p.texture?.key || '';
                  const isTrampoline = key === 'trampoline' || key === 'spring';
                  const pScore =
                    -xEff * 0.5
                    + (-p.y) * 0.10      // v6: reverted from 0.15 → 0.10
                    + (isTrampoline ? 800 : 0)
                    - recencyPenalty(p); // avoid platforms we just bounced on
                  if (pScore > bestPScore) { bestPScore = pScore; bestTarget = p; }
                }

                if (bestTarget) {
                  d.prevTargetX = bestTarget.x;
                  d.prevTargetY = bestTarget.y;
                  ai.targetX   = Math.round(bestTarget.x);
                  ai.targetTex = bestTarget.texture?.key || '?';

                  let diff = bestTarget.x - px;
                  if (Math.abs(diff) > WORLD_WIDTH / 2) {
                    diff = diff > 0 ? diff - WORLD_WIDTH : diff + WORLD_WIDTH;
                  }

                  if (Math.abs(diff) < STEER_THRESH) {
                    ai.direction     = 'center(esc)';
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
                    ai.direction = goRight ? 'R(esc)' : 'L(esc)';
                    ai.desiredX  = goRight ? 300 : 75;
                  }
                  ai.platformsAbove = expandedCands.length;
                  return;
                }
              }

              // Pure wander fallback: alternate direction
              const xVel = d.wanderDir * X_VEL;
              try { scene.player.setVelocity(xVel, scene.player.getVelocityY()); } catch (_) {}
              scene.isTouching = true;
              scene.input.activePointer.x      = d.wanderDir > 0 ? 600 : 150;
              scene.input.activePointer.worldX = d.wanderDir > 0 ? 600 : 150;
              scene.input.activePointer.isDown = true;
              ai.taps++;
              ai.direction = d.wanderDir > 0 ? 'R(wdr)' : 'L(wdr)';
              ai.desiredX  = d.wanderDir > 0 ? 300 : 75;
              ai.platformsAbove = 0;
              return;
            }

            // ──────────────── Normal phase-aware candidate selection ────────────────
            let candidates = [];

            if (goingDown || ai.phase === 'apex') {
              // FALLING: look for platforms between apex and floor
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
              // RISING: look above current apex for next bounce
              if (d.apexY !== null) {
                candidates = allPlats.filter(p =>
                  p.y < d.apexY - 20 &&
                  p.y > d.apexY - d.bounceH * 1.3 &&
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
            // Final fallback: ignore reach + blacklist
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
              const pScore =
                -xEff * 0.8
                + (-p.y) * 0.05          // v6: reverted from 0.08 → 0.05
                + (isTrampoline ? 700 : 0)
                - (isMoving     ? 30  : 0);
                // v6: recency penalty removed from normal scoring (keep only in escape mode)
              if (pScore > bestPScore) { bestPScore = pScore; bestTarget = p; }
            }

            if (!bestTarget) {
              ai.direction     = 'none';
              ai.desiredX      = 187;
              scene.isTouching = false;
              return;
            }

            d.prevTargetX = bestTarget.x;
            d.prevTargetY = bestTarget.y;
            ai.targetX   = Math.round(bestTarget.x);
            ai.targetTex = bestTarget.texture?.key || '?';

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
    // v5 fix: After each round, the LEADERBOARD overlay appears with a "START GAME"
    // button (data-testid="START_BUTTON") at the bottom. We must click that button,
    // not the centre of the screen. Keep clicking it every 250ms until the new round starts.
    const waitStart = Date.now();
    while (Date.now() - waitStart < 10000) {
      const over = await page.evaluate(() => window.__AI__?._inRoundOver ?? true);
      if (!over) break;
      // Prefer the explicit START_BUTTON; fall back to centre-tap
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
      await page.waitForTimeout(250);
    }

    const roundStart = Date.now();
    const maxRoundMs = 180000;
    let lastLogTime  = Date.now();
    let clicks       = 0;
    let screenshotted = false;

    while (Date.now() - roundStart < maxRoundMs) {
      const snap = await page.evaluate(() => {
        const ai = window.__AI__;
        if (!ai) return null;
        return {
          desiredX:       ai.desiredX,
          direction:      ai.direction,
          roundOver:      ai.roundOver,
          playerY:        ai.playerY,
          platformsAbove: ai.platformsAbove,
          phase:          ai.phase,
          bounceH:        ai.bounceH,
          apexY:          ai.apexY,
          stagnant:       ai.stagnant,
          stagnantScore:  ai.stagnantScore,   // v6
          blacklistSize:  ai.blacklistSize,
          targetTex:      ai.targetTex,
          taps:           ai.taps,
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
            ` BL:${snap.blacklistSize} SSB:${snap.stagnantScore}` +
            ` Taps:${snap.taps} Clicks:${clicks} High:${full.highest}`
          );
          lastLogTime = Date.now();
          if (full.highest >= TARGET_SCORE) {
            console.log(`  🎯 TARGET ${TARGET_SCORE} REACHED! Score: ${full.highest}`);
          }
        }
      }

      await page.waitForTimeout(30);
    }

    const elapsed = Math.round((Date.now() - roundStart) / 1000);
    console.log(`  Round ${roundNum} ended after ${elapsed}s | ${clicks} clicks`);
  }

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n=== Round ${round} / ${MAX_ROUNDS} (best: ${bestScore.toFixed(1)}) ===`);
    await playRound(round);

    if (bestScore >= TARGET_SCORE) {
      console.log(`\n🏆 TARGET ACHIEVED! Best score: ${bestScore.toFixed(1)} 🏆`);
      break;
    }

    await page.waitForTimeout(500);
  }

  console.log(`\n=== Done. Best score: ${bestScore.toFixed(1)} ===`);
  await browser.close();
}

runGame().catch(err => { console.error(err); process.exit(1); });
