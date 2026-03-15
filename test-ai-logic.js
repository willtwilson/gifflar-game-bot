/**
 * Tests for AI targeting logic in smart-player-v4
 *
 * These are unit tests for the pure-logic parts extracted from the browser context:
 *  - effectiveXDist (screen-wrap X distance)
 *  - candidate filtering (broken exclusion, reach, blacklist)
 *  - target scoring (trampoline bonus, height bonus)
 *  - bounce height EMA
 *
 * Run with: node test-ai-logic.js
 */

'use strict';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function assertApprox(actual, expected, tolerance, label) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    console.log(`  ✅ ${label} (got ${actual.toFixed(2)})`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label} — expected ~${expected}, got ${actual.toFixed(2)}`);
    failed++;
  }
}

// ── Helpers replicated from browser script ──────────────────────────────────

const WORLD_WIDTH = 750;
const X_VEL       = 12.8;

function effectiveXDist(platX, px) {
  const raw = Math.abs(platX - px);
  return Math.min(raw, WORLD_WIDTH - raw);
}

function isBlacklisted(p, blacklisted) {
  const k = `${Math.round(p.x / 20) * 20}_${Math.round(p.y / 20) * 20}`;
  return !!blacklisted[k];
}

function blacklistKey(p) {
  return `${Math.round(p.x / 20) * 20}_${Math.round(p.y / 20) * 20}`;
}

function scorePlatform(p, px) {
  const xEff         = effectiveXDist(p.x, px);
  const isTrampoline = p.tex === 'trampoline' || p.tex === 'spring';
  const isMoving     = p.tex === 'moving';
  return (
    -xEff * 0.8
    + (-p.y) * 0.05
    + (isTrampoline ? 600 : 0)
    - (isMoving     ? 30  : 0)
  );
}

function selectBest(candidates, px) {
  let best = null, bestScore = -Infinity;
  for (const p of candidates) {
    const s = scorePlatform(p, px);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return best;
}

// ── Test Suite ───────────────────────────────────────────────────────────────

console.log('\n─── effectiveXDist (screen-wrap) ───');
assert(effectiveXDist(100, 100) === 0,   'same X → 0');
assert(effectiveXDist(200, 100) === 100, 'simple right → 100');
assert(effectiveXDist(0,   100) === 100, 'simple left → 100');
// Wrap: player at 50, platform at 700 → raw=650, wrapped=100
assertApprox(effectiveXDist(700, 50), 100, 1, 'wrap: player=50, plat=700 → 100');
// Wrap: player at 700, platform at 50 → raw=650, wrapped=100
assertApprox(effectiveXDist(50, 700), 100, 1, 'wrap: player=700, plat=50 → 100');
// No-wrap case: player 375, platform 600 → raw=225, 750-225=525, min=225
assert(effectiveXDist(600, 375) === 225, 'no wrap needed: player=375, plat=600 → 225');

console.log('\n─── Broken/brown platform exclusion ───');
const BROKEN_KEYS = new Set(['broken', 'brown']);
const plats = [
  { x: 100, y: -500, tex: 'regular' },
  { x: 200, y: -600, tex: 'broken'  },
  { x: 300, y: -700, tex: 'trampoline' },
  { x: 400, y: -800, tex: 'brown'   },
];
const safe = plats.filter(p => !BROKEN_KEYS.has(p.tex));
assert(safe.length === 2, 'only 2 safe platforms (regular + trampoline)');
assert(!safe.find(p => p.tex === 'broken'),  'broken excluded');
assert(!safe.find(p => p.tex === 'brown'),   'brown excluded');

console.log('\n─── Sideways reach filter ───');
const bounceFrames = 20;                     // small value so maxReach < world radius
const maxReach     = X_VEL * bounceFrames;   // 12.8 * 20 = 256
const px           = 375;
// Two close platforms (eff < 256) and one at world-wrap midpoint (eff = 375 > 256)
const reachPlats = [
  { x: 350, y: -500, tex: 'regular'    }, // effectiveXDist = 25 → reachable
  { x: 400, y: -600, tex: 'trampoline' }, // effectiveXDist = 25 → reachable
  { x:   0, y: -700, tex: 'regular'    }, // effectiveXDist = min(375,375) = 375 → NOT reachable
];
const reachable = reachPlats.filter(p =>
  !BROKEN_KEYS.has(p.tex) && effectiveXDist(p.x, px) <= maxReach
);
assert(reachable.length === 2, 'both close platforms within 256 reach');

// Platform exactly at world-wrap midpoint: effectiveXDist = 375 > 256 → unreachable
const tooFarPlat = { x: 0, y: -900, tex: 'regular' }; // effectiveXDist(0, 375) = min(375, 375) = 375
assert(effectiveXDist(tooFarPlat.x, px) > maxReach, 'opposite-edge platform out of reach');
const reachable2 = [tooFarPlat].filter(p => effectiveXDist(p.x, px) <= maxReach);
assert(reachable2.length === 0, 'out-of-reach platform excluded from candidates');

console.log('\n─── Blacklist tracking ───');
const blacklisted = {};
const target = { x: 305, y: -710, tex: 'regular' };
const tKey   = blacklistKey(target);

// Simulate 3 failures using a single accumulated failCounts map (mirrors real accumulation logic)
const failCounts = {};
for (let i = 0; i < 3; i++) {
  failCounts[tKey] = (failCounts[tKey] || 0) + 1;
  if (i < 2) assert(!blacklisted[tKey], `not blacklisted after ${i + 1} failure(s)`);
  if (failCounts[tKey] >= 3) blacklisted[tKey] = true;
}
assert(blacklisted[tKey], 'platform blacklisted after 3 failures');
assert(isBlacklisted(target, blacklisted), 'isBlacklisted returns true');

// A nearby platform with a different bucket key is NOT blacklisted
// x=340 → Math.round(340/20)*20 = 340; y=-740 → Math.round(-740/20)*20 = -740 → different from target key
const nearby2 = { x: 340, y: -740, tex: 'regular' };
assert(!isBlacklisted(nearby2, blacklisted), 'different-bucket position not blacklisted');

// Clearing blacklist
const clearedBL = {};
assert(!isBlacklisted(target, clearedBL), 'cleared blacklist allows target again');

console.log('\n─── Target scoring ───');
const candidates2 = [
  { x: 380, y: -1100, tex: 'regular'    }, // close X, reasonable height
  { x: 380, y: -1200, tex: 'trampoline' }, // same X, higher, trampoline
  { x: 450, y: -1050, tex: 'regular'    }, // farther right
  { x: 380, y: -1150, tex: 'moving'     }, // same X, mid height, moving
];
const best = selectBest(candidates2, 375);
assert(best.tex === 'trampoline', 'trampoline wins despite not being highest');

// Without trampoline, prefer higher + closer
const candidates3 = [
  { x: 380, y: -1100, tex: 'regular' },
  { x: 380, y: -1500, tex: 'regular' }, // much higher, same X
];
const best3 = selectBest(candidates3, 375);
assert(best3.y === -1500, 'prefers higher platform when X is equal');

// Moving platform penalty
const candidates4 = [
  { x: 380, y: -1100, tex: 'regular' },
  { x: 380, y: -1100, tex: 'moving'  },
];
const s_reg    = scorePlatform(candidates4[0], 375);
const s_moving = scorePlatform(candidates4[1], 375);
assert(s_reg > s_moving, 'regular beats moving at same position');

console.log('\n─── Bounce height EMA ───');
let bounceH = 380;
const measurements = [390, 400, 350, 410, 380];
for (const bh of measurements) {
  bounceH = bounceH * 0.65 + bh * 0.35;
}
assertApprox(bounceH, 385, 15, 'EMA of bounce heights ~385');

console.log('\n─── Screen-wrap steering direction ───');
function steerDiff(platX, px) {
  let diff = platX - px;
  if (Math.abs(diff) > WORLD_WIDTH / 2) {
    diff = diff > 0 ? diff - WORLD_WIDTH : diff + WORLD_WIDTH;
  }
  return diff;
}
// Platform at 700, player at 50 → wrap left (diff = -100 not +650)
assertApprox(steerDiff(700, 50), -100, 1, 'wrap: steer LEFT toward plat at 700 from player at 50');
// Platform at 50, player at 700 → wrap right (+100 not -650)
assertApprox(steerDiff(50, 700), 100, 1, 'wrap: steer RIGHT toward plat at 50 from player at 700');
// Normal case
assert(steerDiff(600, 375) === 225, 'normal: steer right 225 units');

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Tests: ${passed + failed}  ✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
