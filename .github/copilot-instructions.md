# Gifflar Winter Vibe Game Bot — Copilot Instructions

## Project Purpose
Automate the Gifflar "Winter Vibe" Flarie platform game (Doodle Jump-style) to achieve 300+ points and enter a prize draw. The game URL is https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f

## Current Status (v9.3)
- **Bot record**: High:112 (round 23, 42s) — from multiple deterministic runs
- **API best**: 220.1 (historical, origin uncertain — possibly v4–v6 era)
- **Target**: 300+ points to enter prize draw
- **Seeds are deterministic**: Round 23 always gives the best seed (~112 pts); rounds 35, 36 give ~92-94 pts
- **Key insight**: Early code (v1-v3) used simpler "nearest platform above" selection and achieved 220; v9's complex scoring may be over-engineering

## Game Architecture

### Engine
- **Phaser 3.55.2** with custom `Flarie.Fysics` physics engine
- Canvas 750×1334 world units, viewport 375×667 (2x retina on mobile UA)
- **Y-axis**: increases DOWNWARD (Phaser convention). More negative Y = higher up = better score
- `scene.highestPointReached` = game score (≈1 point per ~100 world units climbed)

### Platform Types
| Texture key | Behaviour | Bot should target? |
|-------------|-----------|-------------------|
| `regular` | Normal bounce | ✅ Yes |
| `moving` | Slides left/right | ✅ Yes (small penalty) |
| `trampoline`/`spring` | Huge boost (~600 world units) | ✅ High priority (+700 score bonus) |
| `broken`/`brown` | Collapses on landing | ❌ NEVER target |

### Steering Mechanism
```javascript
// Game reads pointer position each frame:
if (scene.isTouching) {
  velocity = (pointer.x < 375 ? -3.2 : 3.2) * 4; // ±12.8 units/frame
}
// Bot overrides directly:
scene.player.setVelocity(±12.8, scene.player.getVelocityY());
scene.isTouching = true;
scene.input.activePointer.x = goRight ? 600 : 150;
```

### Screen Wrap
- Ball wraps at X boundaries (left→right, right→left)
- `effectiveXDist = Math.min(Math.abs(dx), WORLD_WIDTH - Math.abs(dx))`
- Wrap-corrected steering: `if (Math.abs(diff) > 375) diff -= 750 * Math.sign(diff)`

## Bot Architecture (Node.js + Playwright)

### Key files
| File | Description |
|------|-------------|
| `smart-player-v9.js` | **Current bot** (v9.3 — phase-aware fallbacks); High:112 bot record |
| `smart-player-v6.js` | Previous best; score-based stagnation detection |
| `smart-player-v5.js` | Fixed leaderboard overlay bug (START_BUTTON); no more 0s rounds |
| `test-ai-logic.js` | 25 unit tests for pure AI logic (run with `node test-ai-logic.js`) |
| `analyze-run.js` | Helper: extract peak High scores from a run log file |

### How the bot works
1. **`addInitScript`**: Injects AI code into the Phaser game via `Phaser.Game` constructor hook
2. **Step hook**: Runs every game frame (60fps) via `game.events.on('step', ...)`
3. **State bridge**: `window.__AI__` exposes game state (playerY, bounceH, phase, stagnant, etc.) to Node.js
4. **Node.js loop**: Every 80ms reads `window.__AI__`, clicks at `desiredX` to simulate touch

### Physics tracking (inside step hook)
```javascript
const vy = py - d.prevY;           // frame-by-frame Y delta
const goingUp   = vy < -0.5;      // ball rising (toward negative Y)
const goingDown = vy >  0.5;      // ball falling (toward positive Y)

// IMPORTANT: Only update wasGoingUp/Down when ball is actually moving
// (not in neutral zone at apex/nadir), else apex detection breaks
if (goingUp || goingDown) {
  d.wasGoingUp   = goingUp;
  d.wasGoingDown = goingDown;
}

// Bounce detection (ball just left a platform):
if (goingUp && d.wasGoingDown) { d.platformY = d.prevY; }

// Apex detection (ball just started falling):
if (goingDown && d.wasGoingUp) {
  const bh = Math.abs(d.platformY - newApexY);
  d.bounceH = EMA(d.bounceH, bh);  // tracks max bounce height
  ai.bounceH = Math.round(d.bounceH);
}
```

### Platform candidate selection
```
FALLING phase → look for platforms between apex and floor, within maxReach X
RISING phase  → look for platforms just above current apex, within maxReach X
Fallback 1    → relax Y range to ±bounceH
Fallback 2    → ignore blacklist
Fallback 3    → ignore reach constraints (last resort)
```

### Stagnation handling
- **Score-based** (v6): `stagnantScoreBounces` — counts bounces where `scene.highestPointReached` didn't improve by >3 pts
- **Apex-based**: `stagnantBounces` — counts bounces where apex didn't improve by >50 units
- At `stagnantBounces >= WANDER_AFTER=4`: expanded candidate search with recency penalty
- At `stagnantScoreBounces >= 10 && stagnantBounces >= 8`: QUIT mode (stop steering to end round)

### Blacklist
- Key: `${round(x/20)*20}_${round(y/20)*20}` (20-unit buckets)
- After 3 failed attempts targeting same platform → blacklisted for this round
- Cleared when: ball climbs 150+ units higher, or stagnant >= 5 (force clear)

## Known Issues & Critical Bugs Fixed

### FIXED in v9.3: Phase-aware fallback (was CRITICAL)
**Symptom**: Falling ball steered toward platforms above it (behind direction of travel) → missed platforms → fell off screen.
**Root cause**: Fallback candidate filter `p.y < py + 50` picked platforms above a falling ball (wrong direction).
**Fix**: Phase-aware fallbacks — falling: `p.y > py - BH*0.3 && p.y < py + BH*1.5`; rising: original above-ball range.

### OPEN: Ball dies at high altitude despite 4 candidates (High:112 ceiling)
**Symptom**: Round 23 consistently dies at 40–42s with High:112, Ph:rising, Cands:4, Dir:center, no stagnation.
**Hypothesis A**: v9's "highest-scoring" platform selection picks platforms at the edge of BH range (95% BH) — slim margin for error. Early code picked NEAREST (50% BH) — much safer.
**Hypothesis B**: Moving platforms shift away from calculated position by landing time.
**Fix in v9.4**: Add reach-comfort bonus to scoring; prefer platforms within 75% of BH.

### OPEN: setVelocity(12.8, vy) effectiveness uncertain
**Symptom**: `scene.player.body.velocity.x` always reads 0 (wrong access path).
**Impact**: Unclear if velocity injection works or if only activePointer manipulation steers the ball.
**Note**: Ball DOES move horizontally (confirmed by X readings), so activePointer IS working.

### FIXED in v9.3: Dead seeds
**Fix**: Early exit at 5s if High==0 — saves ~30% of round time.

### FIXED in v5: 1-second rounds due to leaderboard overlay
**Fix**: Click `[data-testid="START_BUTTON"]` element during wait loop.

## Score & Rankings
- **Bot record**: High:112 (v9.3, round 23 — deterministic seed)
- **API best on bot account**: 220.1 (historical, unknown origin)
- **Target**: 300 pts to enter prize draw
- **Human high score**: 299 (personal) — campaign top scores around 700+
- Score submitted via `POST /api/post-game-score` with AES-encrypted leaderBoardId (cannot forge)

## UI / Browser Details

### Critical: Leaderboard overlay after each round
- After each round, a leaderboard appears with `[data-testid="START_BUTTON"]` at bottom (y≈597)
- **Must click `START_BUTTON` element**, NOT the canvas area
- 0s rounds in v4 were all caused by clicking wrong area
- Fix (v5+): click `[data-testid="START_BUTTON"]` every 250ms in wait loop

### Round start deadlock (fixed in v5)
- `scene.roundOver` only becomes false AFTER a click starts the round
- Must click DURING the wait loop, not after it exits

### Form submission (one-time, on fresh account)
- Email: `<EMAIL>` | Name: `<NAME>` | Username: `<USERNAME>` (set via `EMAIL`/`NAME`/`USERNAME` env vars)
- React checkbox hack: `cb[reactPropsKey].onChange({ target: { checked: true } })`
- React form submit: call `form[reactPropsKey].onSubmit(fakeEvent)`

## Testing
```bash
node test-ai-logic.js        # 25 unit tests, all should pass
node smart-player-v9.js      # runs current bot (non-headless)
node analyze-run.js run.log  # extract per-round High scores from a log file
```

## Coding Conventions
- All AI logic inside `page.addInitScript()` closure — no external imports
- Constants in ALL_CAPS at top of initScript: `BH_INIT`, `X_VEL`, `WANDER_AFTER`, etc.
- `ai` = `window.__AI__` (bridge between Phaser step hook and Node.js)
- `d` = `ai._dyn` (per-round mutable state, reset via `freshDyn()` each round)
- `scene` = the active GAME_SCENE Phaser scene object
- Log prefix format: `[${elapsed}s] Y:${playerY} Ph:${phase} Dir:${dir} BH:${bounceH} High:${score}`
- Never modify `scene.highestPointReached` directly (server-side validation)
- Anti-bot: use mobile User-Agent, `hasTouch: true`, realistic click positions with randomness
