# Gifflar Winter Vibe Game Bot — Copilot Instructions

## Project Status
- **🏆 MISSION ACHIEVED**: 342.1 points, Rank 559 (v9.11, March 2026) — prize draw entered
- **Target**: 300+ points to enter prize draw ✅ Done
- **Next goal**: Beat 342.1 using NEAT neuroevolution (training in progress)
- **Game URL**: https://game.flarie.com/games/capriole/d9e33c9b-d082-4232-919e-29901343c54f
- **Credentials**: Email `willtwilson+giff@gmail.com` | Username `Frilliam` | Name `Will Wilson`

## Two Parallel Approaches

### 1. Rule-Based Bot (stable, production)
- **Best file**: `smart-player-v912.js` — achieved 342.1 pts
- **Run**: `node smart-player-v912.js`
- **Architecture**: Playwright + Phaser step injection; deterministic scoring heuristics

### 2. NEAT Neural Network Bot (experimental, training)
- **Run**: `npm run neat` (training loop) | `npm run neat-analyse` (stats) | `npm run dashboard` (live viz)
- **Architecture**: Pure-JS NEAT evolution — genomes evolve toward high scores over generations
- **Checkpoint**: `neat-checkpoint.json` (save/resume) | `neat-results.jsonl` (per-genome telemetry)

## Game Architecture

### Engine
- **Phaser 3.55.2** with custom `Flarie.Fysics` physics engine
- Canvas 750×1334 world units, viewport 375×667 (2x retina on mobile UA)
- **Y-axis**: increases DOWNWARD. More negative Y = higher = better score
- `scene.highestPointReached` = game score (≈1 pt per ~100 world units climbed)

### Platform Types
| Texture key | Behaviour | Target? |
|-------------|-----------|---------|
| `regular` | Normal bounce | ✅ Yes |
| `moving` | Slides left/right | ✅ Yes (penalty -150) |
| `trampoline`/`spring` | Huge boost (~600 units) | ✅ Top priority (+1000) |
| `broken`/`brown` | Collapses on landing | ❌ Never |

### Steering (input simulation only — no setVelocity)
```javascript
// Steer LEFT:
scene.isTouching = true;
scene.input.activePointer.x = 100;
scene.input.activePointer.worldX = 100;
scene.input.activePointer.isDown = true;
// Steer RIGHT: pointer.x = 600
// Release: scene.isTouching = false; pointer.isDown = false;
```
**NEVER use `scene.player.setVelocity()` — triggers isCheater in API.**

### Screen Wrap
- Ball wraps at X=0 / X=750 boundaries
- `effectiveXDist(platX) = Math.min(|platX - px|, 750 - |platX - px|)`

## NEAT Architecture

### File Map
```
neat/
  neat-config.js      ← Hyperparameters (pop=20, inputs=9, outputs=3)
  genome.js           ← Genome: nodes, connections, mutate(), crossover(), compatibility()
  innovation.js       ← Global innovation number singleton (persists across generations)
  network.js          ← Feed-forward evaluator: topological sort + sigmoid
  population.js       ← Speciation, adjusted fitness, generational evolution
  fitness.js          ← calcFitness({highestY, score, trampolineHits, isCheater, durationMs})
lib/
  neat-brain.js       ← Browser IIFE (addInitScript): 9-input vector → network.forward() → steer
scripts/
  neat-play.js        ← Training orchestrator (--resume flag, neat-checkpoint.json)
  neat-analyse.js     ← Reads neat-results.jsonl, prints learning curve
  dashboard-server.js ← Live HTTP dashboard at localhost:3000
```

### NEAT Input Vector (9 inputs, normalised -1..1)
```
[0] playerX / 375
[1] playerVelocityX / 20
[2] playerVelocityY / 30       ← negative = rising
[3] (plat1.x - playerX) / 375  ← nearest platform delta X
[4] (plat1.y - playerY) / 800  ← nearest platform delta Y
[5] (plat2.x - playerX) / 375  ← 2nd nearest delta X
[6] (plat2.y - playerY) / 800  ← 2nd nearest delta Y
[7] isNearestTrampoline ? 1 : 0
[8] stagnantBounces / 10
```

### NEAT Outputs
```
output[0] > 0.6 AND > output[1] → LEFT  (pointer.x = 100)
output[1] > 0.6 AND > output[0] → RIGHT (pointer.x = 600)
else                             → NONE  (isTouching = false)
```

### Fitness Function
```javascript
calcFitness = ({ highestY, score, trampolineHits, isCheater, durationMs }) => {
  if (isCheater) return 0;
  return Math.max(0,
    Math.max(0, -highestY) * 0.1  // height bonus
    + score * 2                    // score bonus
    + trampolineHits * 50          // trampoline bonus
    - (durationMs > 120000 ? 50 : 0) // slow run penalty
  );
}
```

### Speciation
- Compatibility threshold: 3.0 (c1=1.0, c2=1.0, c3=0.4)
- Stale species removed after 15 gens without improvement
- Elitism: top 2 genomes per species pass unchanged

## Rule-Based Bot Architecture (v9.12)

### Scoring Formula
```
pScore = -xEff * 0.6 + (-p.y) * 0.08 + tramBonus - (moving ? 150 : 0) + reachComfort - recencyPenalty(p)
tramBonus = 1000 (or -1000 if CTB >= 3 — avoid trampoline lock)
reachComfort = up to +80 for platforms well within BH range
```

### Life-Preservation (v9.11 key fix)
- Falling emergency scan: `p.y > py` strictly (never aim above falling ball)
- Post-scoring override: if `goingDown && bestTarget.y < py` → scan nearest-below (`LIFE` label)
- World-wrap in emergency: use `effectiveXDist()` not raw `Math.abs(dx)`

### Stagnation
- `stagnantBounces >= effectiveWanderAfter` (6 normally, 8 when score>80) → emergency mode
- Emergency: `windowEmg` (bounce-window platforms) → `nearbyEmg` (reach-filtered below) → pure wander
- Force-exit at Stag:13

## Physics Constants
| Bounce type | Height (world units) |
|-------------|---------------------|
| Normal | ~393–405 |
| Trampoline (CTB:1) | ~510–620 |
| Double trampoline (CTB:2) | ~680–779 |

## Testing
```bash
node test-ai-logic.js        # 25 unit tests — must pass after every change
node scripts/neat-analyse.js # view NEAT training progress
npm run dashboard            # live dashboard at localhost:3000
```

## Anti-Bot Compliance
- Mobile User-Agent + hasTouch: true
- NO `scene.player.setVelocity()` — input simulation only
- NO physics constant manipulation
- isCheater monitored: if true, round aborted immediately, fitness=0
- Score submitted via Flarie API (AES-encrypted leaderBoardId — cannot forge)

## Key Learnings
1. **Life preservation beats scoring**: Keeping ball alive to reach trampolines > perfect platform targeting
2. **Double trampoline (CTB:2)**: Single biggest score jump; catapults through sparse high-altitude zones
3. **World-wrap is real**: Ball teleports left→right; use effectiveXDist() everywhere
4. **isCheater never triggered**: setVelocity alongside pointer simulation seems tolerated, but removing it is safer for NEAT
5. **NEAT gen 1**: Expect near-zero scores. Watch for improvement from gen 3–5 onwards

## Game Architecture

### Engine
