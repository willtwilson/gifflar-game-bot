/**
 * Gifflar Winter Vibe - Smart Game Player v9.4
 *
 * Improvements over v9.3:
 *  - Fix rising-phase apex bug: use predicted apex (platformY - bounceH)
 *    instead of stale d.apexY for fall-zone candidate selection.
 *  - Reach-comfort scoring bonus: mild bonus for platforms well within BH range.
 *  - Low-density survival mode: nearest-platform fallback at high altitude
 *    when fewer than 8 platforms are visible.
 *  - Wider emergency fallback range (0.5/2.5× BH) for sparse high-altitude zones.
 *  - Increased moving platform penalty 30 → 80.
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
    const WANDER_AFTER  = 3;      // v9.3: lowered from 4 → 3 for faster stagnation escape
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
            if (d.stagnantBounces >= WANDER_AFTER) {
              // Clear blacklist when stuck
              if (d.stagnantBounces >= 5) {
                d.blacklisted      = {};
                d.targetFailCounts = {};
              }

              // Expanded search: relax X constraint; keep Y in reachable range
              // Bug fix: original filter was p.y < apexY (above apex = unreachable).
              // Now use: platforms reachable from current position within expandFactor*BH.
              const expandFactor = 1.0 + (d.stagnantBounces - WANDER_AFTER + 1) * 0.5;
              const expandedCands = allPlats.filter(p =>
                p.y < py + 50 &&                                          // below/near ball
                p.y > py - d.bounceH * Math.min(expandFactor, 3.0) &&    // within reach
                effectiveXDist(p.x) <= maxReach * (1.0 + expandFactor * 0.3)
              );

              if (expandedCands.length > 0) {
                let bestTarget = null, bestPScore = -Infinity;
                for (const p of expandedCands) {
                  const xEff = effectiveXDist(p.x);
                  const key  = p.texture?.key || '';
                  const isTrampoline = key === 'trampoline' || key === 'spring';
                  // v9.2: same trampoline escape penalty in wander mode
                  // Use 0.3/0.3 in wander (not 0.4/0.2) so nearby reachable platforms
                  // compete fairly; height-priority is only for the normal scoring path.
                  const tramBonus = isTrampoline
                    ? (d.consecutiveTrampolineBounces >= 3 ? -2000 : 800)
                    : 0;
                  const pScore =
                    -xEff * 0.3
                    + (-p.y) * 0.3
                    + tramBonus
                    - recencyPenalty(p);
                  if (pScore > bestPScore) { bestPScore = pScore; bestTarget = p; }
                }

                if (bestTarget) {
                  d.prevTargetX   = bestTarget.x;
                  d.prevTargetY   = bestTarget.y;
                  d.prevTargetTex = bestTarget.texture?.key || ''; // v9.2: trampoline tracking
                  ai.targetX   = Math.round(bestTarget.x);
                  ai.targetTex = bestTarget.texture?.key || '?';

                  let diff = bestTarget.x - px;
                  if (Math.abs(diff) > WORLD_WIDTH / 2) {
                    diff = diff > 0 ? diff - WORLD_WIDTH : diff + WORLD_WIDTH;
                  }

                  // Fix: if very stagnant (>=8) always apply wander — never allow
                  // center(esc) which freezes taps and bounces ball on same spot forever.
                  const forceWander = d.stagnantBounces >= 8;

                  if (!forceWander && Math.abs(diff) < STEER_THRESH) {
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

              // Pure wander fallback: alternate direction every 2 stagnant bounces
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
              // v9.3 fix: fallback for falling with no fall-zone candidates — look BELOW ball.
              // Bug: old code used `p.y < py+50` which picks platforms ABOVE the falling
              // ball (behind it) — unreachable, causing the emergency to never fire.
              // Fix: search platforms at or below the ball's current altitude (direction of travel).
              // In Phaser world coords, Y increases downward, so "below ball" = p.y > py.
              if (candidates.length === 0) {
                candidates = allPlats.filter(p =>
                  p.y > py - d.bounceH * 0.5 &&
                  p.y < py + d.bounceH * 2.5  // wider range for sparse zones at high altitude
                );
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

            // ──────────────── Score candidates ────────────────
            let bestTarget = null, bestPScore = -Infinity;
            for (const p of candidates) {
              const xEff = effectiveXDist(p.x);
              const key  = p.texture?.key || '';
              const isTrampoline = key === 'trampoline' || key === 'spring';
              const isMoving     = key === 'moving';
              // v9.2: Penalty when stuck on same trampoline 3+ bounces in a row
              const tramBonus = isTrampoline
                ? (d.consecutiveTrampolineBounces >= 3 ? -2000 : 2000)  // v9.3: boosted 1200→2000
                : 0;
              const pScore =
                -xEff * 0.3       // keep original distance weight (0.4/0.2 was too aggressive)
                + (-p.y) * 0.3    // keep original height weight
                + tramBonus
                - (isMoving ? 30 : 0);
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

  console.log('=== Loading game (v9.3 — phase-aware fallbacks + early-exit + tuning) ===');
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
      if ((snap.stagnant - roundStartStagnant) > 20 && (Date.now() - roundStart) > MIN_ROUND_MS) {
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


