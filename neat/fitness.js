'use strict';

/**
 * Fitness function for a NEAT genome run.
 *
 * @param {object} params
 * @param {number} params.highestY        Most negative Y reached (world coords, negative = higher)
 * @param {number} params.score           Game score reported by API
 * @param {number} params.trampolineHits  Number of trampoline bounces
 * @param {number} params.stagnantBounces Number of repeated bounces with little progress
 * @param {number} params.bonusCollected  Number of bonus collectibles acquired
 * @param {number} params.uniquePlatforms Number of unique platforms visited
 * @param {boolean} params.isCheater      Whether the API flagged the run as cheating
 * @param {number} params.durationMs      Round duration in milliseconds
 * @returns {number} Fitness value (>= 0)
 */
function calcFitness({ highestY, score, trampolineHits, stagnantBounces = 0, bonusCollected = 0, uniquePlatforms = 0, isCheater, durationMs }) {
  if (isCheater) return 0;
  const heightScore = Math.max(0, -highestY) * 0.1;
  const scoreBonus  = score * 5;
  const trampBonus  = trampolineHits * 300; // Stronger reward for trampolines
  const bonusReward = bonusCollected * 150; // Reward for collecting bonuses (balloons, etc)
  const stagnationPenalty = -Math.min(stagnantBounces, 20) * 30; // Penalize repeated bounces
  const noveltyReward = uniquePlatforms * 10; // Small reward for exploring new platforms
  const timePenalty = durationMs > 120000 ? -50 : 0;
  return heightScore + scoreBonus + trampBonus + bonusReward + stagnationPenalty + noveltyReward + timePenalty;
}

module.exports = { calcFitness };
