'use strict';

/**
 * Fitness function for a NEAT genome run.
 *
 * @param {object} params
 * @param {number} params.highestY        Most negative Y reached (world coords, negative = higher)
 * @param {number} params.score           Game score reported by API
 * @param {number} params.trampolineHits  Number of trampoline bounces
 * @param {boolean} params.isCheater      Whether the API flagged the run as cheating
 * @param {number} params.durationMs      Round duration in milliseconds
 * @returns {number} Fitness value (>= 0)
 */
function calcFitness({ highestY, score, trampolineHits, isCheater, durationMs }) {
  if (isCheater) return 0;
  const heightScore = Math.max(0, -highestY) * 0.1;
  const scoreBonus  = score * 2;
  const trampBonus  = trampolineHits * 50;
  const timePenalty = durationMs > 120000 ? -50 : 0;
  return Math.max(0, heightScore + scoreBonus + trampBonus + timePenalty);
}

module.exports = { calcFitness };
