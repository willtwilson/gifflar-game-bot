module.exports = {
  populationSize: 30,          // was 20 — more diversity, better exploration
  maxGenerations: 200,
  targetFitness: 2000,         // score≈342 + trampolines; calibrated target
  inputs: 9,
  outputs: 3,
  compatibilityThreshold: 1.5, // was 3.0 — lower so weight diffs create multiple species
  c1: 1.0,
  c2: 1.0,
  c3: 0.4,
  weightMutateRate: 0.8,
  weightPerturbRate: 0.9,
  weightPerturbStrength: 0.5,  // was 0.3 — wider weight perturbation to escape local optima
  addNodeRate: 0.05,           // was 0.03 — faster topology growth
  addConnectionRate: 0.08,     // was 0.05 — more structural exploration
  disableRate: 0.1,
  elitismCount: 2,
  survivalThreshold: 0.2,
  staleGenerationLimit: 15,
};
