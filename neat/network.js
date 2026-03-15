'use strict';

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Feed-forward neural network built from a NEAT Genome.
 * Cycles are broken by ignoring back-edges during topological sort.
 */
class Network {
  constructor(genome) {
    this.genome = genome;
    this._build();
  }

  _build() {
    const { nodes, connections } = this.genome;

    this.nodeMap = new Map();
    for (const n of nodes) {
      this.nodeMap.set(n.id, { ...n, value: 0 });
    }

    // Only enabled connections
    this.enabledConns = connections.filter(c => c.enabled);

    // Topological sort (Kahn's algorithm, skip back-edges)
    const inDegree = new Map();
    const adjList  = new Map();
    for (const n of nodes) {
      inDegree.set(n.id, 0);
      adjList.set(n.id, []);
    }
    for (const c of this.enabledConns) {
      adjList.get(c.in).push(c.out);
      inDegree.set(c.out, (inDegree.get(c.out) || 0) + 1);
    }

    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    this.order = [];
    const visited = new Set(queue);
    while (queue.length > 0) {
      const cur = queue.shift();
      this.order.push(cur);
      for (const next of (adjList.get(cur) || [])) {
        const newDeg = inDegree.get(next) - 1;
        inDegree.set(next, newDeg);
        if (newDeg <= 0 && !visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    this.inputIds  = nodes.filter(n => n.type === 'input').map(n => n.id);
    this.outputIds = nodes.filter(n => n.type === 'output').map(n => n.id);
  }

  /**
   * Run the network forward.
   * @param {number[]} inputs  Array of length genome.config.inputs
   * @returns {number[]} Array of output values in [0,1]
   */
  forward(inputs) {
    // Reset all node values
    for (const node of this.nodeMap.values()) node.value = 0;

    // Set input values
    for (let i = 0; i < this.inputIds.length; i++) {
      const node = this.nodeMap.get(this.inputIds[i]);
      if (node) node.value = inputs[i] || 0;
    }

    // Evaluate in topological order
    for (const nodeId of this.order) {
      if (this.inputIds.includes(nodeId)) continue; // inputs are already set
      const node = this.nodeMap.get(nodeId);
      if (!node) continue;

      let sum = 0;
      for (const conn of this.enabledConns) {
        if (conn.out === nodeId) {
          const inNode = this.nodeMap.get(conn.in);
          if (inNode) sum += inNode.value * conn.weight;
        }
      }
      node.value = sigmoid(sum);
    }

    return this.outputIds.map(id => {
      const node = this.nodeMap.get(id);
      return node ? node.value : 0;
    });
  }
}

module.exports = { Network };
