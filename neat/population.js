'use strict';

const { Genome } = require('./genome.js');

let _speciesIdCounter = 0;
let _genomeIdCounter  = 1000;

class Population {
  constructor(config, innovationTracker) {
    this.config = config;
    this.innovationTracker = innovationTracker;
    this.genomes = [];
    this.species = [];
    this.generation = 0;
    this.bestGenome = null;
    this.bestFitness = -Infinity;
  }

  /** Create populationSize minimal genomes. */
  initialise() {
    this.innovationTracker.seed(this.config.inputs, this.config.outputs);
    for (let i = 0; i < this.config.populationSize; i++) {
      const g = new Genome(`g${_genomeIdCounter++}`, this.config);
      g.initMinimal(this.innovationTracker);
      // Randomise weights so genomes are distinct from birth
      for (const c of g.connections) {
        c.weight = (Math.random() * 4) - 2;
      }
      this.genomes.push(g);
    }
    this.speciate();
  }

  /** Assign each genome to a species by compatibility distance. */
  speciate() {
    // Reset member lists
    for (const sp of this.species) sp.members = [];

    for (const genome of this.genomes) {
      let placed = false;
      for (const sp of this.species) {
        const dist = genome.compatibility(sp.representative, this.config);
        if (dist < this.config.compatibilityThreshold) {
          sp.members.push(genome);
          placed = true;
          break;
        }
      }
      if (!placed) {
        this.species.push({
          id: _speciesIdCounter++,
          representative: genome.clone(),
          members: [genome],
          bestFitness: 0,
          staleCount: 0,
        });
      }
    }

    // Remove empty species
    this.species = this.species.filter(sp => sp.members.length > 0);

    // Update representatives
    for (const sp of this.species) {
      sp.representative = sp.members[Math.floor(Math.random() * sp.members.length)].clone();
    }
  }

  /**
   * Record fitness scores.
   * @param {Map<string, number>} scores  genomeId → fitnessValue
   */
  evaluateFitness(scores) {
    for (const genome of this.genomes) {
      genome.fitness = scores.get(genome.id) || 0;
      if (genome.fitness > this.bestFitness) {
        this.bestFitness = genome.fitness;
        this.bestGenome  = genome.clone();
      }
    }

    // Update species best fitness and stale counts
    for (const sp of this.species) {
      const best = Math.max(...sp.members.map(g => g.fitness));
      if (best > sp.bestFitness) {
        sp.bestFitness = best;
        sp.staleCount  = 0;
      } else {
        sp.staleCount++;
      }
    }
  }

  /** Selection + crossover + mutation → next generation. */
  evolve() {
    // Remove stale species (protect the best species from culling)
    const bestSpecies = this.species.reduce((a, b) => a.bestFitness > b.bestFitness ? a : b, this.species[0]);
    this.species = this.species.filter(sp =>
      sp === bestSpecies || sp.staleCount < this.config.staleGenerationLimit
    );

    // Adjusted fitness: genome.fitness / species size
    for (const sp of this.species) {
      for (const g of sp.members) {
        g.adjustedFitness = Math.max(0, g.fitness) / sp.members.length;
      }
    }

    // Total adjusted fitness
    const totalAdj = this.species.reduce((sum, sp) =>
      sum + sp.members.reduce((s, g) => s + g.adjustedFitness, 0), 0);

    const nextGenomes = [];

    for (const sp of this.species) {
      const spAdj = sp.members.reduce((s, g) => s + g.adjustedFitness, 0);
      let offspring = totalAdj > 0
        ? Math.round((spAdj / totalAdj) * this.config.populationSize)
        : 1;
      offspring = Math.max(offspring, 1);

      // Sort by fitness descending
      const sorted = [...sp.members].sort((a, b) => b.fitness - a.fitness);

      // Elitism: top genomes pass unchanged
      const elites = Math.min(this.config.elitismCount, sorted.length);
      for (let i = 0; i < elites && nextGenomes.length < this.config.populationSize; i++) {
        nextGenomes.push(sorted[i].clone());
      }

      // Survival pool: top survivalThreshold fraction
      const surviveN = Math.max(1, Math.floor(sorted.length * this.config.survivalThreshold));
      const pool = sorted.slice(0, surviveN);

      // Fill remaining offspring
      for (let i = elites; i < offspring && nextGenomes.length < this.config.populationSize; i++) {
        let child;
        if (pool.length > 1 && Math.random() > 0.25) {
          const p1 = pool[Math.floor(Math.random() * pool.length)];
          const p2 = pool[Math.floor(Math.random() * pool.length)];
          const fitter = p1.fitness >= p2.fitness ? p1 : p2;
          const weaker = fitter === p1 ? p2 : p1;
          child = fitter.crossover(weaker);
        } else {
          child = pool[Math.floor(Math.random() * pool.length)].clone();
          child.id = `g${_genomeIdCounter++}`;
        }
        const allNodeIds = [...new Set(this.genomes.flatMap(g => g.nodes.map(n => n.id)))];
        child.mutate(this.config, this.innovationTracker, allNodeIds);
        nextGenomes.push(child);
      }
    }

    // Top-up if population shrank (e.g., species were removed)
    while (nextGenomes.length < this.config.populationSize) {
      const src = nextGenomes[Math.floor(Math.random() * nextGenomes.length)];
      const clone = src.clone();
      clone.id = `g${_genomeIdCounter++}`;
      const allNodeIds = [...new Set(nextGenomes.flatMap(g => g.nodes.map(n => n.id)))];
      clone.mutate(this.config, this.innovationTracker, allNodeIds);
      nextGenomes.push(clone);
    }

    this.genomes = nextGenomes.slice(0, this.config.populationSize);
    this.generation++;
    this.speciate();
  }

  getBestGenome() { return this.bestGenome; }
  getGeneration()  { return this.generation; }

  toJSON() {
    return {
      generation:     this.generation,
      bestFitness:    this.bestFitness,
      bestGenome:     this.bestGenome ? this.bestGenome.toJSON() : null,
      genomes:        this.genomes.map(g => g.toJSON()),
      species:        this.species.map(sp => ({
        id:             sp.id,
        representative: sp.representative.toJSON(),
        bestFitness:    sp.bestFitness,
        staleCount:     sp.staleCount,
        memberIds:      sp.members.map(g => g.id),
      })),
      innovationTracker: this.innovationTracker.toJSON(),
    };
  }

  static fromJSON(data, config, innovationTracker) {
    const pop = new Population(config, innovationTracker);
    pop.generation  = data.generation;
    pop.bestFitness = data.bestFitness;
    pop.bestGenome  = data.bestGenome ? Genome.fromJSON(data.bestGenome, config) : null;
    pop.genomes     = data.genomes.map(g => Genome.fromJSON(g, config));

    // Rebuild species (members will be relinked by genome id)
    const genomeById = new Map(pop.genomes.map(g => [g.id, g]));
    pop.species = data.species.map(sp => ({
      id:             sp.id,
      representative: Genome.fromJSON(sp.representative, config),
      members:        sp.memberIds.map(id => genomeById.get(id)).filter(Boolean),
      bestFitness:    sp.bestFitness,
      staleCount:     sp.staleCount,
    }));

    return pop;
  }
}

module.exports = { Population };
