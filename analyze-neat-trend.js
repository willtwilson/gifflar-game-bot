// analyze-neat-trend.js
// Analyzes neat-results.jsonl for 4-hour rolling average trend, detects stagnation/regression, logs status
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, 'neat-results.jsonl');
const LOG = path.join(__dirname, 'neat-trend.log');
const ROLLING_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG, line + '\n');
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch (e) {
    log(`WARN: Failed to parse line: ${e.message}`);
    return null;
  }
}

function analyze() {
  let lines;
  try {
    lines = fs.readFileSync(INPUT, 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    log(`ERROR: Failed to read input: ${e.message}`);
    return;
  }
  const results = lines.map(parseLine).filter(Boolean);
  if (!results.length) {
    log('ERROR: No valid results found.');
    return;
  }
  // Sort by timestamp ascending
  results.sort((a, b) => new Date(a.timestamp || a.time || 0) - new Date(b.timestamp || b.time || 0));
  // Rolling bests
  let status = 'green';
  let lastBestScore = null, lastBestFitness = null, lastBestTime = null;
  let stagnationStart = null, regressionDetected = false;
  for (let i = 0; i < results.length; ++i) {
    const cur = results[i];
    const curTime = new Date(cur.timestamp || cur.time || 0).getTime();
    // Rolling window: look back 4h
    const windowStart = curTime - ROLLING_WINDOW_MS;
    const window = results.filter(r => {
      const t = new Date(r.timestamp || r.time || 0).getTime();
      return t >= windowStart && t <= curTime;
    });
    const bestScore = Math.max(...window.map(r => r.score || 0));
    const bestFitness = Math.max(...window.map(r => r.fitness || 0));
    if (lastBestScore !== null && bestScore < lastBestScore) {
      regressionDetected = true;
      status = 'red';
      log(`REGRESSION: Best score dropped from ${lastBestScore} to ${bestScore} at ${cur.timestamp}`);
    }
    if (lastBestFitness !== null && bestFitness < lastBestFitness) {
      regressionDetected = true;
      status = 'red';
      log(`REGRESSION: Best fitness dropped from ${lastBestFitness} to ${bestFitness} at ${cur.timestamp}`);
    }
    if (lastBestScore !== null && bestScore === lastBestScore && bestFitness === lastBestFitness) {
      if (!stagnationStart) stagnationStart = curTime;
      if (curTime - stagnationStart >= ROLLING_WINDOW_MS) {
        if (status !== 'red') status = 'orange';
        log(`STAGNATION: No improvement for 4h at ${cur.timestamp}`);
      }
    } else {
      stagnationStart = null;
    }
    lastBestScore = bestScore;
    lastBestFitness = bestFitness;
    lastBestTime = curTime;
  }
  log(`STATUS: ${status.toUpperCase()} | Best score: ${lastBestScore} | Best fitness: ${lastBestFitness}`);
}

try {
  analyze();
} catch (e) {
  log(`FATAL: Analysis failed: ${e.stack}`);
}
