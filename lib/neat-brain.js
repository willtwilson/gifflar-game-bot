'use strict';

/**
 * neat-brain.js
 *
 * Injected into the browser via page.addInitScript().
 * Must be a self-contained IIFE — no require(), no external dependencies.
 *
 * Protocol:
 *   Before each round: page.evaluate(() => { window.__NEAT_GENOME__ = serialisedGenome; })
 *   After each round:  page.evaluate(() => window.__NEAT_AI__)
 */

// This entire file is wrapped in an IIFE when injected
(function () {
  // ─── Inline feed-forward network (mirrors neat/network.js) ───────────────

  function sigmoid(x) {
    return 1 / (1 + Math.exp(-x));
  }

  function buildNetwork(genome) {
    const nodeMap = new Map();
    for (const n of genome.nodes) {
      nodeMap.set(n.id, { ...n, value: 0 });
    }

    const enabledConns = genome.connections.filter(c => c.enabled);

    // Topological sort (Kahn's algorithm)
    const inDegree = new Map();
    const adjList  = new Map();
    for (const n of genome.nodes) {
      inDegree.set(n.id, 0);
      adjList.set(n.id, []);
    }
    for (const c of enabledConns) {
      adjList.get(c.in).push(c.out);
      inDegree.set(c.out, (inDegree.get(c.out) || 0) + 1);
    }

    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const order = [];
    const visited = new Set(queue);
    while (queue.length > 0) {
      const cur = queue.shift();
      order.push(cur);
      for (const next of (adjList.get(cur) || [])) {
        const newDeg = inDegree.get(next) - 1;
        inDegree.set(next, newDeg);
        if (newDeg <= 0 && !visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    const inputIds  = genome.nodes.filter(n => n.type === 'input').map(n => n.id);
    const outputIds = genome.nodes.filter(n => n.type === 'output').map(n => n.id);

    function forward(inputs) {
      for (const node of nodeMap.values()) node.value = 0;

      for (let i = 0; i < inputIds.length; i++) {
        const node = nodeMap.get(inputIds[i]);
        if (node) node.value = inputs[i] || 0;
      }

      for (const nodeId of order) {
        if (inputIds.includes(nodeId)) continue;
        const node = nodeMap.get(nodeId);
        if (!node) continue;

        let sum = 0;
        for (const conn of enabledConns) {
          if (conn.out === nodeId) {
            const inNode = nodeMap.get(conn.in);
            if (inNode) sum += inNode.value * conn.weight;
          }
        }
        node.value = sigmoid(sum);
      }

      return outputIds.map(id => {
        const node = nodeMap.get(id);
        return node ? node.value : 0;
      });
    }

    return { forward };
  }

  // ─── State ────────────────────────────────────────────────────────────────

  let network        = null;
  let currentGenome  = null;

  window.__NEAT_AI__ = {
    lastInput:        null,
    lastOutput:       null,
    lastAction:       'NONE',
    stagnantBounces:  0,
    highestY:         0,
    score:            0,
    trampolineHits:   0,
  };

  // ─── Wait for Phaser to load ───────────────────────────────────────────────

  const bootInterval = setInterval(() => {
    if (!window.Phaser) return;
    clearInterval(bootInterval);

    const OrigGame = window.Phaser.Game;

    window.Phaser.Game = function (...args) {
      const game = new OrigGame(...args);
      window.__PHASER_GAME__ = game;

      // ─── Per-round state ────────────────────────────────────────────────
      let prevApexY           = null;
      let apexHistory         = [];   // last N apex Y values
      let stagnantBounces     = 0;
      let highestY            = 0;    // most negative Y (highest point)
      let trampolineHits      = 0;
      let score               = 0;
      let inRoundOver         = false;

      // Vertical phase tracking
      let prevPlayerY = null;
      let wasGoingUp  = false;

      function resetRound(genome) {
        prevApexY       = null;
        apexHistory     = [];
        stagnantBounces = 0;
        highestY        = 0;
        trampolineHits  = 0;
        score           = 0;
        inRoundOver     = false;
        prevPlayerY     = null;
        wasGoingUp      = false;

        if (genome && genome !== currentGenome) {
          currentGenome = genome;
          network = buildNetwork(genome);
        }
      }

      game.events.on('step', () => {
        const scene = game.scene?.scenes?.find(
          s => s.sys?.settings?.key === 'GAME_SCENE'
        );
        if (!scene || !scene.player) return;

        // Detect round restart (score reset or scene flags)
        const newGenome = window.__NEAT_GENOME__;
        if (newGenome && newGenome !== currentGenome) {
          resetRound(newGenome);
        }

        if (scene.roundOver) {
          inRoundOver = true;
          return;
        }

        if (inRoundOver) {
          inRoundOver = false;
          resetRound(window.__NEAT_GENOME__);
        }

        if (!network) {
          if (newGenome) {
            currentGenome = newGenome;
            network = buildNetwork(newGenome);
          } else {
            return;
          }
        }

        if (!scene.player.active) return;

        const player  = scene.player;
        const playerX = player.x;
        const playerY = player.y;
        const vx = player.body?.velocity?.x || 0;
        const vy = player.body?.velocity?.y || 0;

        // Track highest point
        if (playerY < highestY) highestY = playerY;

        // Track game score
        score = Math.max(score, scene.highestPointReached || 0);

        // ─── Apex detection for stagnation tracking ─────────────────────
        const goingUp = vy < 0;
        if (wasGoingUp && !goingUp && prevPlayerY !== null) {
          // Just reached apex
          const apexY = prevPlayerY;
          apexHistory.push(apexY);
          if (apexHistory.length > 3) apexHistory.shift();

          if (prevApexY !== null) {
            const improvement = prevApexY - apexY; // negative Y = higher, so improvement > 0 means going higher
            if (improvement < 50) {
              stagnantBounces++;
            } else {
              stagnantBounces = Math.max(0, stagnantBounces - 1);
              prevApexY = apexY;
            }
          } else {
            prevApexY = apexY;
          }
        }
        wasGoingUp  = goingUp;
        prevPlayerY = playerY;

        // ─── Gather platforms ─────────────────────────────────────────────
        const allPlatforms = [
          ...(scene.platformPool   || []),
          ...(scene.introPlatforms || []),
        ].filter(p => p.active && p.visible);

        // Platforms above the player (lower Y = higher in world)
        const above = allPlatforms
          .filter(p => p.y < playerY)
          .map(p => ({ x: p.x, y: p.y, key: (p.texture?.key || '') }))
          .sort((a, b) => Math.abs(a.y - playerY) - Math.abs(b.y - playerY));

        const p1 = above[0] || { x: playerX, y: playerY - 200, key: '' };
        const p2 = above[1] || { x: playerX, y: playerY - 400, key: '' };

        const isTramp = p1.key.includes('trampoline') || p1.key.includes('spring');

        // Detect trampoline hits
        if (isTramp && goingUp && !wasGoingUp) trampolineHits++;

        // ─── Build 9-input vector ─────────────────────────────────────────
        const inputs = [
          playerX / 375,
          vx / 20,
          vy / 30,
          (p1.x - playerX) / 375,
          (p1.y - playerY) / 800,
          (p2.x - playerX) / 375,
          (p2.y - playerY) / 800,
          isTramp ? 1 : 0,
          stagnantBounces / 10,
        ];

        // ─── Run network ──────────────────────────────────────────────────
        const outputs = network.forward(inputs);

        // ─── Interpret outputs → action ───────────────────────────────────
        let action = 'NONE';
        if (outputs[0] > 0.6 && outputs[0] > outputs[1]) {
          action = 'LEFT';
        } else if (outputs[1] > 0.6 && outputs[1] > outputs[0]) {
          action = 'RIGHT';
        }

        // ─── Apply action via input simulation ───────────────────────────
        const ptr = scene.input?.activePointer;
        if (action === 'LEFT') {
          scene.isTouching = true;
          if (ptr) ptr.x = 100;
        } else if (action === 'RIGHT') {
          scene.isTouching = true;
          if (ptr) ptr.x = 600;
        } else {
          scene.isTouching = false;
        }

        // ─── Export telemetry ─────────────────────────────────────────────
        window.__NEAT_AI__ = {
          lastInput:       inputs,
          lastOutput:      outputs,
          lastAction:      action,
          stagnantBounces: stagnantBounces,
          highestY:        highestY,
          score:           score,
          trampolineHits:  trampolineHits,
        };
      });

      return game;
    };
  }, 50);
})();
