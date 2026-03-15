'use strict';

/**
 * Global singleton tracking NEAT innovation numbers.
 * Innovations persist across generations — never reset mid-run.
 * The initial counter starts at inputs*outputs since minimal genomes
 * pre-allocate those connection slots.
 */
class InnovationTracker {
  constructor() {
    // Map of `${inNode}-${outNode}` -> innovationNumber
    this._map = new Map();
    this._next = 0;
  }

  /** Seed the tracker for an initial fully-connected topology. */
  seed(inputs, outputs) {
    let n = 0;
    for (let i = 0; i < inputs; i++) {
      for (let o = 0; o < outputs; o++) {
        const key = `${i}-${inputs + o}`;
        this._map.set(key, n++);
      }
    }
    this._next = n;
  }

  /**
   * Return the innovation number for the in→out connection.
   * Assigns a new number if this structural change is novel.
   */
  getInnovation(inNode, outNode) {
    const key = `${inNode}-${outNode}`;
    if (this._map.has(key)) return this._map.get(key);
    const num = this._next++;
    this._map.set(key, num);
    return num;
  }

  toJSON() {
    return { map: [...this._map.entries()], next: this._next };
  }

  static fromJSON(data) {
    const tracker = new InnovationTracker();
    tracker._map = new Map(data.map);
    tracker._next = data.next;
    return tracker;
  }
}

module.exports = new InnovationTracker();
