# Gifflar Winter Vibe Game Bot — Copilot Instructions

## Project Purpose
Automate the Gifflar "Winter Vibe" Flarie platform game (Doodle Jump-style) to achieve 300+ points and enter a prize draw. The game URL is https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f

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
| `smart-player-v6.js` | **Current best** player; score-based stagnation detection |
| `smart-player-v5.js` | Fixed leaderboard overlay bug (START_BUTTON); no more 0s rounds |
| `smart-player-v4.js` | Previous record holder (220.1 pts); phase-aware targeting |
| `test-ai-logic.js` | 22 unit tests for pure AI logic (run with `node test-ai-logic.js`) |

### How the bot works
1. **`addInitScript`**: Injects AI code into the Phaser game via `Phaser.Game` constructor hook
2. **Step hook**: Runs every game frame (60fps) via `game.events.on('step', ...)`
3. **State bridge**: `window.__AI__` exposes game state (playerY, bounceH, phase, stagnant, etc.) to Node.js
4. **Node.js loop**: Every 30ms reads `window.__AI__`, clicks at `desiredX` to simulate touch

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

## Known Bugs (to fix in v7)

### 1. wasGoingUp/Down neutral zone bug (CRITICAL)
**Symptom**: `BH:0` in round 1; apex detection never fires.
**Root cause**: When ball passes through "neutral" zone (|vy| < 0.5) at apex, the code sets `d.wasGoingUp = false` (because `goingUp = false`). Next frame when `goingDown = true`, `wasGoingUp = false` → apex detection skips.
**Fix**: Only update `wasGoingUp/wasGoingDown` when `goingUp || goingDown` is true:
```javascript
if (goingUp || goingDown) {
  d.wasGoingUp = goingUp;
  d.wasGoingDown = goingDown;
}
```

### 2. QUIT mode doesn't end the round (CRITICAL)
**Symptom**: Round 28 ran 55+ seconds in QUIT mode (SSB:25, Stag:20) with High:47 frozen. Ball bounces between dense platforms and never falls off.
**Root cause**: Current QUIT just sets `isTouching = false` — ball bounces naturally between platforms without falling.
**Fix**: When QUIT, actively steer into platform GAPS (air) to cause ball to miss platforms and fall. Or: periodically apply downward velocity `setVelocity(0, currentVY + 200)` to break the bounce cycle.

### 3. 1-second rounds (~40% of rounds)
**Symptom**: Rounds 2, 3, 5, 6, 7, 8, 12, 15, 17, 18, 23 all end in 1s with 11 clicks.
**Root cause**: A brief `scene.roundOver = true` transient (leaderboard animation frame) causes the bot to think the round ended immediately.
**Fix**: Add minimum round duration of 2-3s before checking `roundOver` in the main loop.

### 4. Vertical oscillation (no lateral input)
**Symptom**: Ball bouncing straight up/down between 2 platforms indefinitely. Stagnant counter doesn't accumulate fast enough.
**Fix**: Detect when `stagnantBounces >= 2` AND ball X hasn't moved >30 units from last bounce → force lateral steer immediately (don't wait for WANDER_AFTER).

### 5. Emergency preservation (ball falling past platform)
**Symptom**: Ball aims for platform, misses it, falls past with no recovery.
**Fix**: When `goingDown && candidates.length === 0`, scan for ANY platform within 500 units AROUND the ball (not just above), aim for closest one.

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

## Score & Rankings
- **Current bot best**: 220.1 pts (v4, round ~5 in that session)
- **Round 27 v6**: reached High:140 with 2 trampoline hits
- **Target**: 300 pts to enter prize draw
- **Human high score**: 299 (personal) — campaign top scores around 700+
- Score submitted via `POST /api/post-game-score` with AES-encrypted leaderBoardId (cannot forge)

## Testing
```bash
node test-ai-logic.js  # 22 unit tests, all should pass
node smart-player-v6.js  # runs game (non-headless)
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
