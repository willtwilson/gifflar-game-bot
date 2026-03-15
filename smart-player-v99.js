/**
 * Gifflar Winter Vibe - Smart Game Player v9.9
 *
 * Key fixes over v9.8: corrected emergency search direction in wander mode.
 * v9.8 had the landing direction completely backwards — it filtered platforms
 * MORE negative than apex (above apex = unreachable), causing infinite loops
 * on Stag:10-13 targeting platforms the ball could never fall onto.
 *  - Emergency search now uses expanded bounce-window (apexY < p.y < platformY ±1.5×BH)
 *  - Critical filter p.y > emgApexY ensures only platforms BELOW apex are targeted
 *  - Platforms above apex (p.y < apexY = more negative Y) are correctly excluded
 */

const { chromium } = require('playwright');
const fs = require('fs');

const EMAIL        = 'willtwilson+giff@gmail.com';
const NAME         = 'Will Wilson';
const USERNAME     = 'Frilliam';
const TARGET_SCORE = 300;
const MAX_ROUNDS   = 60;

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
    const WANDER_AFTER  = 6;      // v9.8: one more bounce of normal search before wander (was 5)
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
            highScore: 0,       // v9.7: tracks in-round score for altitude-aware wander threshold
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
              prevTargetTex:  null, // v9.2: track target texture for trampoline escape
              // v5: recently visited platform buckets (ring buffer)
              recentPlatforms: [],
              currentPlatKey:  null,
              // v6: score-based stagnation tracking
              prevActualScore:     0,
              stagnantScoreBounces: 0,
              // v7: platform X history for vertical oscillation detection
              platXHistory: [],
              // v9.2: consecutive trampoline landings (to escape trampoline trap)
              consecutiveTrampolineBounces: 0,
              initialized:    false
            };
          }

          window.__AI__._dyn = freshDyn();

          // Moved outside step handler to avoid per-frame Set allocation (Copilot review fix)
          const BROKEN_KEYS = new Set(['broken', 'brown']);

          game.events.on('step', () => {
            const scene = game.scene?.scenes?.find(
              s => s.sys?.settings?.key === 'GAME_SCENE'
            );

            const ai = window.__AI__;

            if (!scene || !scene.player || scene.roundOver) {
              if (!ai._inRoundOver) {
                ai.desiredX      = 187; // Fix 5: reset steering so next round starts centre
                ai.stagnant      = 0;   // Fix: reset so force-exit doesn't trigger in next round
                ai.stagnantScore = 0;
              }
              ai._inRoundOver = true;
              ai.roundOver = true;
              return;
            }

            if (ai._inRoundOver) {
              ai._dyn          = freshDyn();
              ai._inRoundOver  = false;
              ai.stagnant      = 0;   // belt-and-suspenders reset
              ai.stagnantScore = 0;
              ai.highScore     = 0;  // v9.7: reset altitude-aware threshold per round
            }
            ai.roundOver = false;
            if (!scene.player.active) return;

            const d = ai._dyn;
            ai.frames++;

            const px = scene.player.x;
            const py = scene.player.y;
            ai.playerX = Math.round(px);
            ai.playerY = Math.round(py);
            ai.vx = Math.round((scene.player.body && scene.player.body.velocity) ? scene.player.body.velocity.x : 0);

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

              // v9.2: Track consecutive trampoline landings to escape trampoline trap
              const wasTrampolineTarget = d.prevTargetTex === 'trampoline' || d.prevTargetTex === 'spring';
              if (wasTrampolineTarget && d.prevTargetY !== null && Math.abs(newPlatY - d.prevTargetY) < 80) {
                d.consecutiveTrampolineBounces++;
              } else {
                d.consecutiveTrampolineBounces = 0;
              }
              ai.ctb = d.consecutiveTrampolineBounces; // expose for logging

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

              // v7: Track platform X history to detect vertical oscillation
              d.platXHistory.push(Math.round(px / 50) * 50);
              if (d.platXHistory.length > 6) d.platXHistory.shift();

              // If last 4 bounces are on only 1-2 distinct X buckets → force wander
              // Guard: only after 8 bounces (intro platforms share X positions)
              if (d.platXHistory.length >= 4 && d.bounceCount >= 8) {
                const distinctX = new Set(d.platXHistory.slice(-4)).size;
                if (distinctX <= 2 && d.stagnantBounces < WANDER_AFTER) {
                  d.stagnantBounces = WANDER_AFTER;
                }
              }
            }

            if (goingDown && d.wasGoingUp) {
              // Ball reached apex
              const newApexY = d.prevY;
              const progress = (d.apexY !== null) ? (d.apexY - newApexY) : 100;

              // v6: Score-based stagnation (more accurate than apex tracking)
              const actualScore = Math.round(scene.highestPointReached || 0);
              if (actualScore > d.prevActualScore + 3) {
                d.stagnantBounces      = 0;
                d.stagnantScoreBounces = 0;
                d.prevActualScore      = actualScore;
              } else {
                d.stagnantScoreBounces++;
                if (progress <= 50) {
                  d.stagnantBounces++;
                } else {
                  // Good upward progress — partially deflate stagnation counter
                  if (d.stagnantBounces > 0) d.stagnantBounces = Math.max(0, d.stagnantBounces - 1);
                }
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
              // v9.7: track current high score for altitude-aware WANDER_AFTER
              const currentHighScore = Math.round(scene.highestPointReached || 0);
              if (currentHighScore > ai.highScore) ai.highScore = currentHighScore;
              ai.apexY        = Math.round(d.apexY);
              ai.lastPlatY    = Math.round(d.platformY ?? 0);
              ai.stagnant     = d.stagnantBounces;
              ai.stagnantScore = d.stagnantScoreBounces;  // v6
              ai.blacklistSize = Object.keys(d.blacklisted).length;
            }

            // v7 Fix 1: Only update directional memory when ball is actually moving
            // (not in neutral zone at apex/nadir). Prevents apex detection breaking
            // when |vy| < 0.5.
            if (goingUp || goingDown) {
              d.wasGoingUp   = goingUp;
              d.wasGoingDown = goingDown;
            }
            d.prevY = py;

            ai.phase = goingUp ? 'rising' : goingDown ? 'falling' : 'apex';

            // ──────────────── Gather platforms ────────────────
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
              return idx * 30; // 0 (oldest) → 150 (newest) penalty
            }

            // ──────────────── Stagnation escape: wander mode ────────────────
            // v9.7: at high altitude, give ball more time before entering wander mode
            const effectiveWanderAfter = (ai.highScore > 80) ? 8 : WANDER_AFTER;
            if (d.stagnantBounces >= effectiveWanderAfter) {
              // Clear blacklist when stuck — we need new targets
              if (d.stagnantBounces >= 6) {
                d.blacklisted      = {};
                d.targetFailCounts = {};
              }

              // v9.7: Emergency wide search before pure wander.
              // When at high altitude (or post-big-trampoline), search a 5×BH net for any platform.
              // This prevents the ball dying at score 169 with Cands:0 just because stagnant counter hit 5.
              const isHighAlt   = ai.highScore > 80;
              const isBigBounce = d.bounceH > 400;
              const searchRange = (isHighAlt || isBigBounce) ? d.bounceH * 5.0 : d.bounceH * 2.5;

              // Emergency: search EXPANDED bounce window (platforms the ball can actually land on).
              // Ball falls FROM apexY downward. Reachable platforms have Y > apexY (less negative = lower altitude).
              // We want platforms that are ABOVE the launch platform (Y < platformY = more negative = higher).
              // Standard window: apexY < p.y < platformY. Emergency: expand by ±1.5×BH on each side.
              const emgApexY    = d.apexY    || (py - d.bounceH);
              const emgPlatY    = d.platformY || py;
              const emgWindow   = d.bounceH * 1.5;

              // Primary: platforms in the expanded bounce window, sorted highest (most progress) first
              const windowEmg = allPlats.filter(p =>
                p.y > emgApexY - emgWindow &&   // up to 1.5 BH above apex (reachable with trampoline boost)
                p.y < emgPlatY + emgWindow &&   // up to 1.5 BH below launch (catchable below current floor)
                p.y > emgApexY &&               // CRITICAL: must be BELOW apex (reachable on the fall)
                Math.abs(p.x - px) < searchRange * 0.8
              ).sort((a, b) => a.y - b.y);     // most negative Y first = highest reachable = most progress

              // Fallback: any platform in 2×BH proximity radius (pure proximity, no direction preference)
              const nearbyEmg = allPlats.filter(p =>
                Math.abs(p.y - py) < d.bounceH * 2.0
              ).sort((a, b) => Math.abs(a.y - py) - Math.abs(b.y - py));

              // Last resort: pure directional wander (same as v9.6 — proven to work)
              const emergencyCands = windowEmg.length > 0 ? windowEmg : nearbyEmg;

              if (emergencyCands.length > 0) {
                const emTarget = emergencyCands[0];
                d.prevTargetX   = emTarget.x;
                d.prevTargetY   = emTarget.y;
                d.prevTargetTex = emTarget.texture?.key || '';
                ai.targetX   = Math.round(emTarget.x);
                ai.targetTex = emTarget.texture?.key || '?';

                let diff = emTarget.x - px;
                if (Math.abs(diff) > WORLD_WIDTH / 2) {
                  diff = diff > 0 ? diff - WORLD_WIDTH : diff + WORLD_WIDTH;
                }

                if (Math.abs(diff) < STEER_THRESH) {
                  ai.direction     = 'center(emg)';
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
                  ai.direction = goRight ? 'R(emg)' : 'L(emg)';
                  ai.desiredX  = goRight ? 300 : 75;
                }
                ai.platformsAbove = emergencyCands.length;
                return;
              }

              // No platforms found anywhere nearby — pure directional wander as last resort.
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
              // FALLING: look for platforms in the fall zone (between apex and last bounce)
              if (d.apexY !== null && d.platformY !== null) {
                candidates = allPlats.filter(p =>
                  p.y > d.apexY + 10 &&
                  p.y < d.platformY - 20 &&
                  effectiveXDist(p.x) <= maxReach &&
                  !isBlacklisted(p)
                );
              }
              // v9.6 fix: tight fallback range when no fall-zone candidates (was 2.5×BH below — too wide)
              if (candidates.length === 0) {
                candidates = allPlats.filter(p =>
                  p.y < py + 50 && p.y > py - d.bounceH &&
                  effectiveXDist(p.x) <= maxReach
                );
              }
              // v9.5 CTB survival: after consecutive trampoline bounces at high altitude,
              // the ball is in sparse zone. Cast a 3x BH net around ball for ANY platform.
              if (candidates.length === 0 && d.consecutiveTrampolineBounces >= 1 && py < -7000) {
                const ctbSurvival = allPlats
                  .filter(p => Math.abs(p.y - py) < d.bounceH * 3.0)
                  .sort((a, b) => Math.abs(a.y - py) - Math.abs(b.y - py));
                if (ctbSurvival.length > 0) { candidates = [ctbSurvival[0]]; ai.direction = 'CTB-SRV'; }
              }
              // Emergency: any platform near ball, prefer below (handles platform pool recycling)
              if (candidates.length === 0) {
                const emergency = allPlats.filter(p =>
                  p.y > py - d.bounceH * 0.5    // not way above ball
                ).sort((a, b) => {
                  const aScore = (a.y >= py ? 0 : 10000) + Math.abs(a.y - py);
                  const bScore = (b.y >= py ? 0 : 10000) + Math.abs(b.y - py);
                  return aScore - bScore;
                });
                if (emergency.length > 0) { candidates = [emergency[0]]; ai.direction = 'EMG'; }
              }
            } else {
              // RISING: pre-position for the CURRENT fall by targeting platforms in the
              // fall zone (between predicted next apex and previous platform). Use
              // predictedApexY = platformY - bounceH rather than the stale d.apexY so the
              // filter window reflects the apex this bounce will actually reach.
              const predictedApexY = (d.platformY !== null) ? (d.platformY - d.bounceH) : d.apexY;
              if (predictedApexY !== null && d.platformY !== null) {
                candidates = allPlats.filter(p =>
                  p.y > predictedApexY + 10 &&
                  p.y < d.platformY - 20 &&
                  effectiveXDist(p.x) <= maxReach && !isBlacklisted(p)
                );
              }
              if (candidates.length === 0) {
                candidates = allPlats.filter(p =>
                  p.y < py - 20 && p.y > py - d.bounceH &&
                  effectiveXDist(p.x) <= maxReach && !isBlacklisted(p)
                );
              }
              // Last resort rising: any reachable platform above (expanded to 5000)
              if (candidates.length === 0) {
                candidates = allPlats.filter(p =>
                  p.y < py - 10 && p.y > py - 5000 &&
                  effectiveXDist(p.x) <= maxReach && !isBlacklisted(p)
                );
              }
              // Final rising fallback: ignore reach + blacklist
              if (candidates.length === 0) {
                candidates = allPlats.filter(p =>
                  p.y < py - 10 && p.y > py - 5000
                );
              }
            }

            ai.platformsAbove = candidates.length;

            // Low-density survival: at high altitude with very few platforms, pick nearest any
            const HIGH_ALTITUDE_Y = -8000; // more negative = higher altitude
            const isHighAltitude = py < HIGH_ALTITUDE_Y;
            const isSparse = allPlats.length < 8;
            if (isHighAltitude && isSparse && candidates.length <= 1) {
              // Take any platform reachable, sorted by vertical closeness
              const sparseMode = allPlats
                .filter(p => effectiveXDist(p.x) <= maxReach * 1.5)
                .sort((a, b) => Math.abs(a.y - py) - Math.abs(b.y - py));
              if (sparseMode.length > 0) candidates = [sparseMode[0]];
            }

            // ──────────────── Score candidates ────────────────
            let bestTarget = null, bestPScore = -Infinity;
            for (const p of candidates) {
              const xEff = effectiveXDist(p.x);
              const key  = p.texture?.key || '';
              const isTrampoline = key === 'trampoline' || key === 'spring';
              const isMoving     = key === 'moving';
              // v9.2: Penalty when stuck on same trampoline 3+ bounces in a row
              const tramBonus = isTrampoline
                ? (d.consecutiveTrampolineBounces >= 3 ? -1000 : 1000)  // v9.6: 2000→1000 (less trampoline chasing)
                : 0;
              // Reach-comfort bonus: platforms well within BH range are safer to land on
              const dy = Math.abs(p.y - py);
              const reachPct = dy / Math.max(d.bounceH, 1);
              const reachComfort = reachPct < 0.8 ? (0.8 - reachPct) * 100 : 0; // up to +80
              const pScore =
                -xEff * 0.6       // v9.6: heavier x-penalty (v4 was 0.8; compromise here)
                + (-p.y) * 0.08   // v9.6: lighter height weight (v4 was 0.05)
                + tramBonus
                - (isMoving ? 50 : 0)
                + reachComfort;
              if (pScore > bestPScore) { bestPScore = pScore; bestTarget = p; }
            }

            if (!bestTarget) {
              ai.direction     = 'none';
              ai.desiredX      = 187;
              scene.isTouching = false;
              return;
            }

            d.prevTargetX   = bestTarget.x;
            d.prevTargetY   = bestTarget.y;
            d.prevTargetTex = bestTarget.texture?.key || ''; // v9.2: for trampoline tracking
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

  console.log('=== Loading game (v9.9 — bounce-window-emergency + correct-fall-direction) ===');
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
        if (!c) return; // null guard: element may be absent
        const p = Object.keys(c).find(k => k.startsWith('__reactProps$'));
        if (p && c[p].onChange) c[p].onChange({ target: { checked: true } });
      });
    });
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      const f = document.querySelector('[data-testid="GAMEFORM_CONTAINER"] form');
      if (!f) return; // null guard: form may be absent
      const p = Object.keys(f).find(k => k.startsWith('__reactProps$'));
      if (p) f[p].onSubmit({
        preventDefault: () => {}, stopPropagation: () => {},
        target: f, currentTarget: f, nativeEvent: new Event('submit')
      });
    });
  }

  await fillAndSubmitForm();
  await page.waitForTimeout(2000);

  // v8: Minimum round duration before trusting roundOver (increased from 3000 → 5000)
  const MIN_ROUND_MS = 5000;

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
    const maxRoundMs = 120000; // v9.2: 120s max (was 60s) — longer rounds for higher scores
    let lastLogTime  = Date.now();
    let clicks       = 0;
    let screenshotted = false;
    let lastSnap = null;
    let lastHighestVal = 0;
    let lastHighestMs  = Date.now();  // v9.5: track wall-clock stagnation

    // Per-round stagnant baseline: if ball is still alive from a previous force-exit
    // (trampoline kept bouncing it), stagnant may already be > 0. Use delta, not absolute.
    const roundStartStagnant = await page.evaluate(() => window.__AI__?.stagnant ?? 0) ?? 0;

    while (Date.now() - roundStart < maxRoundMs) {
      const snap = await page.evaluate(() => {
        const ai = window.__AI__;
        if (!ai) return null;
        return {
          desiredX:       ai.desiredX,
          direction:      ai.direction,
          roundOver:      ai.roundOver,
          playerX:        ai.playerX,   // v9.3: for horizontal tracking
          playerY:        ai.playerY,
          vx:             ai.vx || 0,   // v9.3: ball's horizontal velocity
          platformsAbove: ai.platformsAbove,
          phase:          ai.phase,
          bounceH:        ai.bounceH,
          apexY:          ai.apexY,
          stagnant:       ai.stagnant,
          stagnantScore:  ai.stagnantScore,   // v6
          blacklistSize:  ai.blacklistSize,
          targetTex:      ai.targetTex,
          taps:           ai.taps,
          ctb:            ai.ctb || 0,
        };
      });

      if (!snap) { await page.waitForTimeout(50); continue; }
      lastSnap = snap || lastSnap;

      // v9: Force-exit if stuck (no QUIT mode; end the round when stagnant>20)
      // Use DELTA from round start (not absolute) so previous round's carry-over doesn't count.
      if ((snap.stagnant - roundStartStagnant) > 12 && (Date.now() - roundStart) > MIN_ROUND_MS) {
        if (!screenshotted) {
          screenshotted = true;
          const ssPath = `screenshots/round${String(roundNum).padStart(2, '0')}-end.png`;
          await page.screenshot({ path: ssPath });
          console.log(`  → Force-exit (stagnant ${snap.stagnant} Δ${snap.stagnant - roundStartStagnant}) — screenshot: ${ssPath}`);
        }
        // Teleport ball below camera viewport so the game detects "ball fell off" and
        // triggers its own round-end flow (scene.roundOver → step handler freshDyn reset).
        // Velocity kick doesn't work when ball is on a trampoline — trampoline overrides it.
        await page.evaluate(() => {
          const game = window.__PHASER_GAME__;
          const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
          if (scene?.player && scene.cameras?.main) {
            const cam = scene.cameras.main;
            const belowScreen = cam.scrollY + cam.height + 200;
            try { scene.player.setPosition(scene.player.x, belowScreen); } catch (_) {}
          }
        });
        await page.waitForTimeout(800); // wait for game to detect ball off-screen
        break;
      }

      // v8: Debounce roundOver — wait 250ms and re-check to avoid transient exits
      if (snap.roundOver && (Date.now() - roundStart) > MIN_ROUND_MS) {
        await page.waitForTimeout(250);
        const stillOver = await page.evaluate(() => window.__AI__?.roundOver ?? false);
        if (stillOver) {
          if (!screenshotted) {
            screenshotted = true;
            const ssPath = `screenshots/round${String(roundNum).padStart(2, '0')}-end.png`;
            await page.screenshot({ path: ssPath });
            console.log(`  → Round over — screenshot: ${ssPath}`);
          }
          break;
        }
      }

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
            `  [${elapsed}s] X:${snap.playerX} Y:${snap.playerY} Vx:${snap.vx}` +
            ` Ph:${snap.phase} Dir:${snap.direction}` +
            ` Tex:${snap.targetTex} Cands:${snap.platformsAbove}` +
            ` BH:${snap.bounceH} Stag:${snap.stagnant}` +
            ` BL:${snap.blacklistSize} SSB:${snap.stagnantScore} CTB:${snap.ctb}` +
            ` Taps:${snap.taps} Clicks:${clicks} High:${full.highest}`
          );
          lastLogTime = Date.now();
          // v9.3: early bail on confirmed dead seed (High:0 at 5s+ = no platforms in reach)
          if (elapsed >= 5 && full.highest === 0 && !screenshotted) {
            screenshotted = true;
            console.log('  → Dead seed (High:0 at 5s) — bailing early');
            await page.evaluate(() => {
              const scene = window.__PHASER_GAME__?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
              if (scene?.player && scene.cameras?.main) {
                const cam = scene.cameras.main;
                try { scene.player.setPosition(scene.player.x, cam.scrollY + cam.height + 200); } catch (_) {}
              }
            });
            await page.waitForTimeout(800);
            break;
          }
          // v9.5: Track wall-clock stagnation
          if (full.highest > lastHighestVal) {
            lastHighestVal = full.highest;
            lastHighestMs  = Date.now();
          }
          const scoreStaleMs = Date.now() - lastHighestMs;
          // Force-exit if score hasn't improved for 20s past the 12s mark
          if (elapsed > 12 && scoreStaleMs > 20000 && !screenshotted) {
            screenshotted = true;
            const ssPath = `screenshots/round${String(roundNum).padStart(2, '0')}-end.png`;
            await page.screenshot({ path: ssPath });
            console.log(`  → Time-stagnant exit (High:${full.highest} unchanged for ${Math.round(scoreStaleMs/1000)}s) — screenshot: ${ssPath}`);
            await page.evaluate(() => {
              const game = window.__PHASER_GAME__;
              const scene = game?.scene?.scenes?.find(s => s.sys?.settings?.key === 'GAME_SCENE');
              if (scene?.player && scene.cameras?.main) {
                const cam = scene.cameras.main;
                const belowScreen = cam.scrollY + cam.height + 200;
                try { scene.player.setPosition(scene.player.x, belowScreen); } catch (_) {}
              }
            });
            await page.waitForTimeout(800);
            break;
          }
          if (full.highest >= TARGET_SCORE) {
            console.log(`  🎯 TARGET ${TARGET_SCORE} REACHED! Score: ${full.highest}`);
          }
        }
      }

      await page.waitForTimeout(80);
    }

    const elapsed = Math.round((Date.now() - roundStart) / 1000);
    const deathCause = lastSnap?.stagnant > 20 ? 'stagnant' : lastSnap?.roundOver ? 'fell' : 'timeout';
    console.log(`  Round ${roundNum} ended after ${elapsed}s | ${clicks} clicks | cause:${deathCause} stag:${lastSnap?.stagnant ?? 0}`);
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


