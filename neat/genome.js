'use strict';

const { randomUUID } = require('crypto');

function randWeight() {
  return (Math.random() * 4) - 2; // [-2, 2]
}

/** BFS reachability check — returns true if `to` is reachable from `from`. */
function hasPath(from, to, connections) {
  const visited = new Set();
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === to) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const c of connections) {
      if (c.enabled && c.in === cur && !visited.has(c.out)) {
        queue.push(c.out);
      }
    }
  }
  return false;
}

class Genome {
  constructor(id, config) {
    this.id = id;
    this.config = config;
    this.nodes = [];       // { id, type, activation }
    this.connections = []; // { in, out, weight, enabled, innovation }
    this.fitness = 0;
  }

  /**
   * Create a minimal fully-connected genome: all inputs → all outputs.
   * Node IDs: 0..(inputs-1) = inputs, inputs..(inputs+outputs-1) = outputs.
   */
  initMinimal(innovationTracker) {
    const { inputs, outputs } = this.config;

    // Seed the tracker so initial innovations are deterministic
    innovationTracker.seed(inputs, outputs);

    for (let i = 0; i < inputs; i++) {
      this.nodes.push({ id: i, type: 'input', activation: 'sigmoid' });
    }
    for (let o = 0; o < outputs; o++) {
      this.nodes.push({ id: inputs + o, type: 'output', activation: 'sigmoid' });
    }

    for (let i = 0; i < inputs; i++) {
      for (let o = 0; o < outputs; o++) {
        const innov = innovationTracker.getInnovation(i, inputs + o);
        this.connections.push({
          in: i,
          out: inputs + o,
          weight: randWeight(),
          enabled: true,
          innovation: innov,
        });
      }
    }
  }

  /**
   * Mutate this genome in-place.
   * allNodeIds: array of all node IDs seen across the population (for add-connection).
   */
  mutate(config, innovationTracker, allNodeIds) {
    // Weight mutation
    if (Math.random() < config.weightMutateRate) {
      for (const conn of this.connections) {
        if (Math.random() < config.weightPerturbRate) {
          conn.weight += (Math.random() * 2 - 1) * config.weightPerturbStrength;
        } else {
          conn.weight = randWeight();
        }
      }
    }

    // Add node: split a random enabled connection
    if (Math.random() < config.addNodeRate && this.connections.length > 0) {
      const enabled = this.connections.filter(c => c.enabled);
      if (enabled.length > 0) {
        const conn = enabled[Math.floor(Math.random() * enabled.length)];
        conn.enabled = false;

        const existingIds = this.nodes.map(n => n.id);
        const newId = Math.max(...existingIds) + 1;
        this.nodes.push({ id: newId, type: 'hidden', activation: 'sigmoid' });

        const innov1 = innovationTracker.getInnovation(conn.in, newId);
        const innov2 = innovationTracker.getInnovation(newId, conn.out);
        this.connections.push({ in: conn.in, out: newId, weight: 1.0, enabled: true, innovation: innov1 });
        this.connections.push({ in: newId, out: conn.out, weight: conn.weight, enabled: true, innovation: innov2 });
      }
    }

    // Add connection: connect two currently unconnected nodes
    if (Math.random() < config.addConnectionRate) {
      const nodeIds = this.nodes.map(n => n.id);
      const outputIds = new Set(this.nodes.filter(n => n.type === 'output').map(n => n.id));
      const inputIds  = new Set(this.nodes.filter(n => n.type === 'input').map(n => n.id));

      const existing = new Set(this.connections.map(c => `${c.in}-${c.out}`));
      const candidates = [];
      for (const a of nodeIds) {
        if (outputIds.has(a)) continue; // outputs can't be source in feed-forward (avoid recurrence)
        for (const b of nodeIds) {
          if (inputIds.has(b)) continue; // inputs can't be target
          if (a === b) continue;
          if (!existing.has(`${a}-${b}`) && !hasPath(b, a, this.connections)) {
            candidates.push([a, b]);
          }
        }
      }
      if (candidates.length > 0) {
        const [a, b] = candidates[Math.floor(Math.random() * candidates.length)];
        const innov = innovationTracker.getInnovation(a, b);
        this.connections.push({ in: a, out: b, weight: randWeight(), enabled: true, innovation: innov });
      }
    }

    // Disable a random connection
    if (Math.random() < config.disableRate && this.connections.length > 0) {
      const idx = Math.floor(Math.random() * this.connections.length);
      this.connections[idx].enabled = false;
    }
  }

  /**
   * NEAT crossover. `this` is the fitter parent.
   * Matching genes are averaged; disjoint/excess come from `this`.
   */
  crossover(other) {
    const child = new Genome(randomUUID(), this.config);

    // Build innovation map for the other parent
    const otherMap = new Map(other.connections.map(c => [c.innovation, c]));

    for (const conn of this.connections) {
      const otherConn = otherMap.get(conn.innovation);
      if (otherConn) {
        // Matching gene — average weights, inherit enabled status conservatively
        const enabled = conn.enabled && otherConn.enabled ? true :
          (!conn.enabled || !otherConn.enabled ? Math.random() > 0.75 : true);
        child.connections.push({
          in: conn.in,
          out: conn.out,
          weight: (conn.weight + otherConn.weight) / 2,
          enabled,
          innovation: conn.innovation,
        });
      } else {
        // Disjoint/excess from fitter parent (this)
        child.connections.push({ ...conn });
      }
    }

    // Collect all node IDs referenced by connections
    const nodeIdSet = new Set();
    for (const conn of child.connections) {
      nodeIdSet.add(conn.in);
      nodeIdSet.add(conn.out);
    }
    // Also keep all nodes from fitter parent
    for (const n of this.nodes) nodeIdSet.add(n.id);

    const nodeMap = new Map(this.nodes.map(n => [n.id, n]));
    const otherNodeMap = new Map(other.nodes.map(n => [n.id, n]));
    for (const id of nodeIdSet) {
      const node = nodeMap.get(id) || otherNodeMap.get(id);
      if (node) child.nodes.push({ ...node });
    }

    return child;
  }

  /**
   * Genetic compatibility distance between this genome and other.
   * δ = c1*E/N + c2*D/N + c3*avgW
   */
  compatibility(other, config) {
    const thisMap  = new Map(this.connections.map(c  => [c.innovation,  c]));
    const otherMap = new Map(other.connections.map(c => [c.innovation, c]));

    const maxInnov1 = this.connections.length  > 0 ? Math.max(...this.connections.map(c  => c.innovation)) : 0;
    const maxInnov2 = other.connections.length > 0 ? Math.max(...other.connections.map(c => c.innovation)) : 0;
    const maxInnov  = Math.max(maxInnov1, maxInnov2);

    let excess = 0, disjoint = 0, weightDiffSum = 0, matching = 0;

    const allInnovations = new Set([...thisMap.keys(), ...otherMap.keys()]);
    const smallThreshold = Math.min(maxInnov1, maxInnov2);

    for (const innov of allInnovations) {
      const hasThis  = thisMap.has(innov);
      const hasOther = otherMap.has(innov);
      if (hasThis && hasOther) {
        weightDiffSum += Math.abs(thisMap.get(innov).weight - otherMap.get(innov).weight);
        matching++;
      } else {
        if (innov > smallThreshold) {
          excess++;
        } else {
          disjoint++;
        }
      }
    }

    const N = Math.max(this.connections.length, other.connections.length, 1);
    const avgW = matching > 0 ? weightDiffSum / matching : 0;

    return config.c1 * excess / N + config.c2 * disjoint / N + config.c3 * avgW;
  }

  clone() {
    const g = new Genome(this.id, this.config);
    g.nodes = this.nodes.map(n => ({ ...n }));
    g.connections = this.connections.map(c => ({ ...c }));
    g.fitness = this.fitness;
    return g;
  }

  toJSON() {
    return {
      id: this.id,
      nodes: this.nodes,
      connections: this.connections,
      fitness: this.fitness,
    };
  }

  static fromJSON(data, config) {
    const g = new Genome(data.id, config);
    g.nodes = data.nodes;
    g.connections = data.connections;
    g.fitness = data.fitness || 0;
    return g;
  }
}

module.exports = { Genome };
