'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const REPO_ROOT = path.join(__dirname, '..');
const RESULTS_FILE = path.join(REPO_ROOT, 'neat-results.jsonl');
const CHECKPOINT_FILE = path.join(REPO_ROOT, 'neat-checkpoint.json');

// ─── Data cache ────────────────────────────────────────────────────────────
let needsReload = true;
let cachedData = null;

fs.watchFile(RESULTS_FILE, { interval: 2000 }, () => {
  needsReload = true;
});

// ─── Parse JSONL → structured API response ──────────────────────────────
function parseResults() {
  let lines = [];
  try {
    const raw = fs.readFileSync(RESULTS_FILE, 'utf8');
    lines = raw.split('\n').filter(l => l.trim());
  } catch {
    return { totalRuns: 0, generations: [], allTimeBest: null, ruleBasedRecord: 342.1, currentGen: 0, currentGenProgress: { completed: 0, total: 0 } };
  }

  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { /* skip bad lines */ }
  }

  // group by generation
  const genMap = new Map();
  for (const r of records) {
    const g = r.generation ?? r.gen ?? 0;
    if (!genMap.has(g)) genMap.set(g, []);
    genMap.get(g).push(r);
  }

  const generations = [];
  for (const [genNum, recs] of [...genMap.entries()].sort((a, b) => a[0] - b[0])) {
    const fitnesses = recs.map(r => r.fitness ?? 0);
    const scores = recs.map(r => r.score ?? 0);
    const heights = recs.map(r => r.highestY ?? 0);
    const genomes = recs.map(r => ({
      genomeId: r.genomeId ?? r.id ?? 'unknown',
      fitness: r.fitness ?? 0,
      score: r.score ?? 0,
      highestY: r.highestY ?? 0,
      trampolineHits: r.trampolineHits ?? 0,
      isCheater: r.isCheater ?? false,
      species: r.species ?? 1,
      durationMs: r.durationMs ?? 0,
    }));
    genomes.sort((a, b) => b.fitness - a.fitness);
    const speciesSet = new Set(recs.map(r => r.species ?? 1));
    generations.push({
      gen: genNum,
      bestFitness: Math.max(...fitnesses),
      avgFitness: fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length,
      bestScore: Math.max(...scores),
      avgScore: scores.reduce((a, b) => a + b, 0) / scores.length,
      speciesCount: speciesSet.size,
      isCheaterCount: recs.filter(r => r.isCheater).length,
      bestHeight: Math.min(...heights),
      genomes,
    });
  }

  // all-time best
  let allTimeBest = null;
  for (const gen of generations) {
    for (const g of gen.genomes) {
      if (!allTimeBest || g.fitness > allTimeBest.fitness) {
        allTimeBest = { gen: gen.gen, genomeId: g.genomeId, fitness: g.fitness, score: g.score, species: g.species };
      }
    }
  }

  // current gen progress — last generation that isn't complete relative to total genomes in prior gens
  const lastGen = generations[generations.length - 1];
  const prevGenTotal = generations.length > 1 ? generations[generations.length - 2].genomes.length : 20;
  const currentGen = lastGen ? lastGen.gen : 0;
  const currentGenProgress = lastGen
    ? { completed: lastGen.genomes.length, total: Math.max(lastGen.genomes.length, prevGenTotal) }
    : { completed: 0, total: 0 };

  return {
    totalRuns: records.length,
    generations,
    allTimeBest,
    ruleBasedRecord: 342.1,
    currentGen,
    currentGenProgress,
  };
}

function getApiData() {
  if (needsReload || !cachedData) {
    cachedData = parseResults();
    needsReload = false;
  }
  return cachedData;
}

function getCheckpoint() {
  try {
    const raw = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
    const data = JSON.parse(raw);
    return { exists: true, ...data };
  } catch {
    return { exists: false };
  }
}

// ─── HTML Dashboard ─────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>🧬 NEAT Training Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0e1a;color:#e5e7eb;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh}
  a{color:#3b82f6}
  /* ── Top Bar ── */
  #topbar{background:#111827;border-bottom:1px solid #1f2937;padding:12px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;position:sticky;top:0;z-index:10}
  #topbar h1{font-size:1.25rem;font-weight:700;white-space:nowrap}
  .status-dot{width:10px;height:10px;border-radius:50%;background:#6b7280;flex-shrink:0}
  .status-dot.active{background:#10b981;box-shadow:0 0 0 0 #10b981;animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(16,185,129,.7)}70%{box-shadow:0 0 0 8px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}
  #gen-counter{color:#9ca3af;font-size:.9rem}
  #best-badge{background:#1e3a2f;border:1px solid #10b981;color:#10b981;padding:4px 10px;border-radius:20px;font-size:.85rem;font-weight:600;transition:background .4s}
  #best-badge.flash{background:#10b981;color:#fff}
  #spinner{color:#3b82f6;font-size:.85rem;opacity:0;transition:opacity .3s}
  #spinner.visible{opacity:1}
  #updated{color:#6b7280;font-size:.78rem;margin-left:auto}
  /* ── Layout ── */
  .container{max-width:1400px;margin:0 auto;padding:24px}
  /* ── Stat Cards ── */
  .stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
  @media(max-width:900px){.stats-row{grid-template-columns:repeat(2,1fr)}}
  @media(max-width:480px){.stats-row{grid-template-columns:1fr}}
  .stat-card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:20px;text-align:center}
  .stat-card .label{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:6px}
  .stat-card .value{font-size:2rem;font-weight:700}
  .stat-card.blue .value{color:#3b82f6}
  .stat-card.green .value{color:#10b981}
  .stat-card.purple .value{color:#8b5cf6}
  .stat-card.amber .value{color:#f59e0b}
  /* ── Chart Cards ── */
  .card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:20px;margin-bottom:24px}
  .card-title{font-size:1rem;font-weight:600;margin-bottom:4px}
  .card-sub{font-size:.8rem;color:#6b7280;margin-bottom:16px}
  .two-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:24px}
  @media(max-width:700px){.two-col{grid-template-columns:1fr}}
  .two-col .card{margin-bottom:0}
  /* ── Genome Grid ── */
  .genome-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
  .genome-card{background:#1a2234;border:1px solid #1f2937;border-radius:8px;padding:12px;font-size:.8rem}
  .genome-card.cheater{border-color:#ef4444;background:#2a1010}
  .genome-card .gid{color:#6b7280;font-family:monospace;font-size:.7rem;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .fitness-bar-wrap{height:6px;background:#1f2937;border-radius:3px;margin:6px 0}
  .fitness-bar{height:6px;border-radius:3px;background:#3b82f6;max-width:100%}
  .genome-meta{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px}
  .species-badge{padding:1px 6px;border-radius:10px;font-size:.7rem;font-weight:600}
  /* ── SVG Network ── */
  #network-svg{width:100%;overflow-x:auto;min-height:300px}
  /* ── Activity Log ── */
  .log-table{width:100%;border-collapse:collapse;font-size:.8rem}
  .log-table th{background:#1f2937;color:#9ca3af;padding:8px 10px;text-align:left;border-bottom:1px solid #374151}
  .log-table td{padding:7px 10px;border-bottom:1px solid #1a2234}
  .log-table tr.high td{color:#10b981}
  .log-table tr.mid td{color:#f59e0b}
  .log-table tr.low td{color:#6b7280}
  .log-wrap{max-height:340px;overflow-y:auto;border-radius:8px;border:1px solid #1f2937}
  /* ── Explainer Cards ── */
  .explainer-row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
  @media(max-width:900px){.explainer-row{grid-template-columns:1fr}}
  .exp-card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:20px}
  .exp-card h3{font-size:1rem;font-weight:700;margin-bottom:12px}
  .exp-card p,.exp-card pre{font-size:.82rem;color:#9ca3af;line-height:1.6;white-space:pre-wrap;font-family:inherit}
  .exp-card code{background:#1f2937;padding:2px 5px;border-radius:4px;font-family:monospace;color:#e5e7eb}
  .section-title{font-size:1.1rem;font-weight:700;margin-bottom:16px;color:#e5e7eb}
  .empty-state{text-align:center;padding:48px;color:#4b5563}
  .empty-state .big{font-size:3rem;margin-bottom:8px}
</style>
</head>
<body>

<!-- Top Bar -->
<div id="topbar">
  <h1>🧬 NEAT Training Dashboard</h1>
  <div class="status-dot" id="status-dot"></div>
  <span id="gen-counter">Loading…</span>
  <span id="best-badge">🏆 Best: — | Record: 342.1</span>
  <span id="spinner">⟳ Live</span>
  <div id="live-indicator" style="display:none;background:#1a2e1a;border:1px solid #10b981;border-radius:6px;padding:4px 12px;font-size:.82rem;margin-left:8px"></div>
  <span id="updated"></span>
</div>

<div class="container">

  <!-- Stat Cards -->
  <div class="stats-row" id="stats-row">
    <div class="stat-card blue"><div class="label">Best Fitness (all time)</div><div class="value" id="s-bestfit">—</div></div>
    <div class="stat-card green"><div class="label">Best Score (all time)</div><div class="value" id="s-bestscore">—</div></div>
    <div class="stat-card amber"><div class="label">Species (current gen)</div><div class="value" id="s-species">—</div></div>
    <div class="stat-card purple"><div class="label">Total Runs</div><div class="value" id="s-runs">—</div></div>
  </div>

  <!-- Fitness Chart -->
  <div class="card">
    <div class="card-title">📈 Fitness over Generations</div>
    <div class="card-sub">Watch for the upward trend! Blue = best fitness, Purple = average fitness, Red dashed = target (2000)</div>
    <canvas id="fitChart" height="100"></canvas>
  </div>

  <!-- Score + Species + Height Charts -->
  <div class="two-col">
    <div class="card">
      <div class="card-title">🎯 Best Score per Generation</div>
      <div class="card-sub">Green bars. Dashed line = rule-based record (342.1)</div>
      <canvas id="scoreChart" height="160"></canvas>
    </div>
    <div class="card">
      <div class="card-title">🦋 Species Count over Time</div>
      <div class="card-sub">More species = more diverse strategies exploring the space</div>
      <canvas id="speciesChart" height="160"></canvas>
    </div>
    <div class="card">
      <div class="card-title">📏 Height Progress per Generation</div>
      <div class="card-sub">Cyan = max height climbed (world units). Higher = better.</div>
      <canvas id="heightChart" height="160"></canvas>
    </div>
  </div>

  <!-- Current Gen Genome Grid -->
  <div class="card">
    <div class="card-title">🔬 Current Generation — Genome Population</div>
    <div class="card-sub">Sorted by fitness (best first). Red border = cheater (isCheater=true → immediate 0 fitness)</div>
    <div class="genome-grid" id="genome-grid">
      <div class="empty-state"><div class="big">⏳</div><div>Waiting for training data…</div></div>
    </div>
  </div>

  <!-- Network Topology -->
  <div class="card">
    <div class="card-title">🧠 Best Genome Network Topology</div>
    <div class="card-sub">Inputs (left) → Hidden nodes (middle, if any) → Outputs (right). Blue = positive weight, Red = negative, Grey dashed = disabled. Hover for weight value.</div>
    <div id="network-svg"><div class="empty-state"><div class="big">🔌</div><div>No checkpoint yet — network topology appears after first checkpoint save.</div></div></div>
  </div>

  <!-- Educational Explainer -->
  <div class="explainer-row">
    <div class="exp-card">
      <h3>🧬 What is NEAT?</h3>
      <p>NEAT (NeuroEvolution of Augmenting Topologies) evolves both the <strong style="color:#3b82f6">weights AND structure</strong> of neural networks simultaneously.

Starting with simple networks (9 inputs → 3 outputs), it gradually adds hidden nodes and connections only when they help survival. This "complexification" mirrors how natural brains evolved.

Unlike standard neural nets that need you to design the architecture upfront, NEAT <em>discovers</em> the right structure automatically.</p>
    </div>
    <div class="exp-card">
      <h3>🦋 What are Species?</h3>
      <p>NEAT groups similar genomes into "species" so structural innovations get time to prove themselves before competing with established solutions.

Each species evolves semi-independently. New structural mutations (like adding a hidden node) start as their own species, competing within themselves until they're proven.

Species count: <strong id="exp-species" style="color:#f59e0b">—</strong> — More species = more diverse exploration strategies.</p>
    </div>
    <div class="exp-card">
      <h3>📊 How Fitness Works</h3>
      <p>Each genome is scored by how well it plays the game:</p>
      <pre style="margin:10px 0;background:#0a0e1a;padding:10px;border-radius:6px;font-size:.75rem;color:#a5f3fc">Fitness = (height × 0.1) + (score × 5)
        + (trampolines × 50)
        − (if > 120s: 50 penalty)
        − (if isCheater: 0 — disqualified)</pre>
      <p>Higher altitude = higher fitness. Trampolines give massive bonuses (+50 each). isCheater = instant zero.

Current target: <strong style="color:#f59e0b">2000+ fitness (~score 342+)</strong> to beat the rule-based record.</p>
    </div>
  </div>

  <!-- Activity Log -->
  <div class="card">
    <div class="card-title">📋 Activity Log — Last 20 Runs</div>
    <div class="card-sub">Green = fitness > 100, Amber = fitness > 50</div>
    <div class="log-wrap">
      <table class="log-table">
        <thead><tr>
          <th>Gen</th><th>Genome ID</th><th>Fitness</th><th>Score</th>
          <th>Species</th><th>Tramp</th><th>Duration</th><th>Cheater?</th>
        </tr></thead>
        <tbody id="log-body"><tr class="low"><td colspan="8" style="text-align:center;padding:24px">Waiting for data…</td></tr></tbody>
      </table>
    </div>
  </div>

</div><!-- /container -->

<script>
(function(){
  'use strict';

  const POLL_MS = 5000;
  const RULE_RECORD = 342.1;
  const FITNESS_TARGET = 2000;
  const SPECIES_COLORS = ['#3b82f6','#10b981','#8b5cf6','#f59e0b','#ef4444','#ec4899','#06b6d4','#84cc16'];

  let fitChart = null, scoreChart = null, speciesChart = null, heightChart = null;
  let prevBestScore = -Infinity;
  let lastData = null;

  // ── Utils ──────────────────────────────────────────────────────────
  function fmt(v, d=0){ return v==null?'—':Number(v).toFixed(d); }
  function fmtFit(v){ return fmt(v, 1); }
  function fmtMs(ms){ if(!ms) return '—'; if(ms<1000) return ms+'ms'; return (ms/1000).toFixed(1)+'s'; }
  function speciesColor(s){ return SPECIES_COLORS[(s-1) % SPECIES_COLORS.length]; }

  // ── Fetch & update ─────────────────────────────────────────────────
  async function fetchData(){
    document.getElementById('spinner').classList.add('visible');
    try {
      const [dataRes, cpRes, liveRes] = await Promise.all([
        fetch('/api/data').then(r=>r.json()),
        fetch('/api/checkpoint').then(r=>r.json()).catch(()=>({exists:false})),
        fetch('/api/live').then(r=>r.json()).catch(()=>({hasMidGen:false}))
      ]);
      update(dataRes, cpRes, liveRes);
    } catch(e){
      console.warn('Fetch error:', e);
    } finally {
      document.getElementById('spinner').classList.remove('visible');
    }
  }

  function update(data, cp, live){
    lastData = data;
    const isActive = data.currentGenProgress && data.currentGenProgress.completed > 0;
    const dot = document.getElementById('status-dot');
    dot.className = 'status-dot' + (isActive ? ' active' : '');

    // Top bar
    const prog = data.currentGenProgress || {};
    document.getElementById('gen-counter').textContent =
      'Generation ' + (data.currentGen||0) + ' | ' + (prog.completed||0) + '/' + (prog.total||0) + ' genomes';

    const atb = data.allTimeBest;
    const badge = document.getElementById('best-badge');
    badge.textContent = '🏆 Best: ' + fmt(atb?.score) + ' | Record: ' + RULE_RECORD;
    if(atb && atb.score > prevBestScore && prevBestScore !== -Infinity){
      badge.classList.add('flash');
      setTimeout(()=>badge.classList.remove('flash'), 1000);
    }
    if(atb) prevBestScore = atb.score;

    document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();

    // Stat cards
    document.getElementById('s-bestfit').textContent = fmtFit(atb?.fitness);
    document.getElementById('s-bestscore').textContent = fmt(atb?.score);
    const curGen = data.generations && data.generations[data.generations.length-1];
    document.getElementById('s-species').textContent = curGen ? curGen.speciesCount : '—';
    document.getElementById('s-runs').textContent = data.totalRuns || 0;
    document.getElementById('exp-species').textContent = curGen ? curGen.speciesCount : '—';

    // Charts
    updateFitChart(data.generations);
    updateScoreChart(data.generations);
    updateSpeciesChart(data.generations);
    updateHeightChart(data.generations);

    // Genome grid
    updateGenomeGrid(curGen);

    // Network
    updateNetwork(cp);

    // Log
    updateLog(data.generations);

    // Live indicator
    updateLive(live);
  }

  // ── Fitness Chart ─────────────────────────────────────────────────
  function updateFitChart(gens){
    const labels = gens.map(g=>g.gen);
    const best = gens.map(g=>g.bestFitness);
    const avg = gens.map(g=>g.avgFitness);
    const targetLine = gens.map(()=>FITNESS_TARGET);

    if(!fitChart){
      const ctx = document.getElementById('fitChart').getContext('2d');
      fitChart = new Chart(ctx,{
        type:'line',
        data:{
          labels,
          datasets:[
            {label:'Best Fitness',data:best,borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,.1)',tension:.3,pointRadius:3,fill:true},
            {label:'Avg Fitness',data:avg,borderColor:'#8b5cf6',backgroundColor:'rgba(139,92,246,.05)',tension:.3,pointRadius:2,fill:true,borderDash:[4,3]},
            {label:'Target (2000)',data:targetLine,borderColor:'#ef4444',borderDash:[8,4],pointRadius:0,borderWidth:1.5,fill:false}
          ]
        },
        options:{
          responsive:true,
          interaction:{mode:'index',intersect:false},
          plugins:{legend:{labels:{color:'#9ca3af',font:{size:11}}},tooltip:{backgroundColor:'#1f2937',borderColor:'#374151',borderWidth:1,titleColor:'#e5e7eb',bodyColor:'#9ca3af'}},
          scales:{
            x:{grid:{color:'#1f2937'},ticks:{color:'#6b7280'},title:{display:true,text:'Generation',color:'#6b7280'}},
            y:{grid:{color:'#1f2937'},ticks:{color:'#6b7280'},title:{display:true,text:'Fitness',color:'#6b7280'}}
          }
        }
      });
    } else {
      fitChart.data.labels = labels;
      fitChart.data.datasets[0].data = best;
      fitChart.data.datasets[1].data = avg;
      fitChart.data.datasets[2].data = targetLine;
      fitChart.update();
    }
  }

  // ── Score Chart ───────────────────────────────────────────────────
  function updateScoreChart(gens){
    const labels = gens.map(g=>g.gen);
    const scores = gens.map(g=>g.bestScore);
    const ruleLines = gens.map(()=>RULE_RECORD);
    if(!scoreChart){
      const ctx = document.getElementById('scoreChart').getContext('2d');
      scoreChart = new Chart(ctx,{
        type:'bar',
        data:{
          labels,
          datasets:[
            {label:'Best Score',data:scores,backgroundColor:'rgba(16,185,129,.7)',borderColor:'#10b981',borderWidth:1,borderRadius:4},
            {label:'Rule-based Record',data:ruleLines,type:'line',borderColor:'#f59e0b',borderDash:[6,3],pointRadius:0,borderWidth:1.5}
          ]
        },
        options:{
          responsive:true,
          plugins:{legend:{labels:{color:'#9ca3af',font:{size:10}}},tooltip:{backgroundColor:'#1f2937',titleColor:'#e5e7eb',bodyColor:'#9ca3af'}},
          scales:{
            x:{grid:{color:'#1f2937'},ticks:{color:'#6b7280'}},
            y:{grid:{color:'#1f2937'},ticks:{color:'#6b7280'},title:{display:true,text:'Score',color:'#6b7280'}}
          }
        }
      });
    } else {
      scoreChart.data.labels = labels;
      scoreChart.data.datasets[0].data = scores;
      scoreChart.data.datasets[1].data = ruleLines;
      scoreChart.update();
    }
  }

  // ── Species Chart ─────────────────────────────────────────────────
  function updateSpeciesChart(gens){
    const labels = gens.map(g=>g.gen);
    const counts = gens.map(g=>g.speciesCount);
    if(!speciesChart){
      const ctx = document.getElementById('speciesChart').getContext('2d');
      speciesChart = new Chart(ctx,{
        type:'line',
        data:{labels,datasets:[{label:'Species Count',data:counts,borderColor:'#f59e0b',backgroundColor:'rgba(245,158,11,.1)',tension:.3,pointRadius:4,fill:true}]},
        options:{
          responsive:true,
          plugins:{legend:{labels:{color:'#9ca3af',font:{size:10}}},tooltip:{backgroundColor:'#1f2937',titleColor:'#e5e7eb',bodyColor:'#9ca3af'}},
          scales:{
            x:{grid:{color:'#1f2937'},ticks:{color:'#6b7280'}},
            y:{grid:{color:'#1f2937'},ticks:{color:'#6b7280',stepSize:1},title:{display:true,text:'# Species',color:'#6b7280'}}
          }
        }
      });
    } else {
      speciesChart.data.labels = labels;
      speciesChart.data.datasets[0].data = counts;
      speciesChart.update();
    }
  }

  // ── Height Chart ──────────────────────────────────────────────────
  function updateHeightChart(gens){
    const labels = gens.map(g=>g.gen);
    const heights = gens.map(g=>g.bestHeight ? Math.max(0, -g.bestHeight) : 0);
    if(!heightChart){
      const ctx = document.getElementById('heightChart').getContext('2d');
      heightChart = new Chart(ctx,{
        type:'line',
        data:{
          labels,
          datasets:[{
            label:'Max Height (units)',
            data:heights,
            borderColor:'#06b6d4',
            backgroundColor:'rgba(6,182,212,.1)',
            tension:.3,
            pointRadius:3,
            fill:true
          }]
        },
        options:{
          responsive:true,
          plugins:{legend:{labels:{color:'#9ca3af',font:{size:10}}},tooltip:{backgroundColor:'#1f2937',titleColor:'#e5e7eb',bodyColor:'#9ca3af'}},
          scales:{
            x:{grid:{color:'#1f2937'},ticks:{color:'#6b7280'}},
            y:{grid:{color:'#1f2937'},ticks:{color:'#6b7280'},title:{display:true,text:'Height (world units)',color:'#6b7280'}}
          }
        }
      });
    } else {
      heightChart.data.labels = labels;
      heightChart.data.datasets[0].data = heights;
      heightChart.update();
    }
  }

  // ── Live Indicator ────────────────────────────────────────────────
  function updateLive(live){
    const el = document.getElementById('live-indicator');
    if(!el) return;
    if(!live || !live.hasMidGen){
      el.style.display = 'none';
      return;
    }
    const mg = live.midGen;
    const completed = mg.genomeIndex + 1;
    const fitnessValues = Object.values(mg.fitnessMap || {});
    const bestSoFar = fitnessValues.length ? Math.max(...fitnessValues).toFixed(1) : '—';
    const avgSoFar = fitnessValues.length ? (fitnessValues.reduce((a,b)=>a+b,0)/fitnessValues.length).toFixed(1) : '—';
    el.style.display = 'block';
    el.innerHTML = \`<span style="color:#10b981;font-weight:600">🔴 LIVE</span> Gen \${mg.gen+1} · Genome \${completed+1}/${live.populationSize || '?'} running · Best so far: <strong>\${bestSoFar}</strong> · Avg: \${avgSoFar}\`;
  }

  // ── Genome Grid ───────────────────────────────────────────────────
  function updateGenomeGrid(gen){
    const el = document.getElementById('genome-grid');
    if(!gen || !gen.genomes || !gen.genomes.length){
      el.innerHTML = '<div class="empty-state"><div class="big">⏳</div><div>Waiting for training data…</div></div>';
      return;
    }
    const maxFit = gen.genomes[0].fitness || 1;
    el.innerHTML = gen.genomes.map(g=>{
      const pct = Math.min(100, (g.fitness / Math.max(maxFit,1)) * 100).toFixed(1);
      const sc = speciesColor(g.species);
      return \`<div class="genome-card\${g.isCheater?' cheater':''}">
        <div class="gid" title="\${g.genomeId}">\${g.genomeId.substring(0,16)}…</div>
        <div style="font-size:1rem;font-weight:700;color:\${g.isCheater?'#ef4444':'#e5e7eb'}">\${fmtFit(g.fitness)} fit</div>
        <div class="fitness-bar-wrap"><div class="fitness-bar" style="width:\${pct}%"></div></div>
        <div class="genome-meta">
          <span style="color:#9ca3af">score: \${fmt(g.score)}</span>
          <span class="species-badge" style="background:\${sc}22;color:\${sc}">S\${g.species}</span>
          \${g.trampolineHits?'<span style="color:#f59e0b">🏐×'+g.trampolineHits+'</span>':''}
          \${g.isCheater?'<span style="color:#ef4444">🚫cheater</span>':''}
        </div>
        <div style="color:#4b5563;font-size:.7rem;margin-top:4px">\${fmtMs(g.durationMs)}</div>
      </div>\`;
    }).join('');
  }

  // ── Network SVG ───────────────────────────────────────────────────
  const INPUT_LABELS  = ['playerX','playerVX','playerVY','plat1ΔX','plat1ΔY','plat2ΔX','plat2ΔY','isTramp','stagnation'];
  const OUTPUT_LABELS = ['← LEFT','RIGHT →','⬆ NONE'];

  function updateNetwork(cp){
    const el = document.getElementById('network-svg');
    if(!cp || !cp.exists || !cp.bestGenome){
      el.innerHTML = '<div class="empty-state"><div class="big">🔌</div><div>No checkpoint yet — network topology appears after first checkpoint save.</div></div>';
      return;
    }
    const g = cp.bestGenome;
    const nodes = g.nodes || [];
    const conns = g.connections || [];

    const inputs  = nodes.filter(n=>n.type==='input');
    const outputs = nodes.filter(n=>n.type==='output');
    const hidden  = nodes.filter(n=>n.type!=='input'&&n.type!=='output');

    const W = 900, PAD = 80;
    const layerX = { input: PAD, hidden: W/2, output: W - PAD };
    const rowH = (layer, count) => (W * 0.45) / Math.max(count, 1);

    function nodeY(idx, total){
      const spacing = Math.min(50, (360 - 40) / Math.max(total-1,1));
      const startY = 200 - (spacing * (total-1)) / 2;
      return startY + idx * spacing;
    }

    const posMap = {};
    inputs.forEach((n,i)=>{ posMap[n.id]={ x: layerX.input, y: nodeY(i, inputs.length) }; });
    outputs.forEach((n,i)=>{ posMap[n.id]={ x: layerX.output, y: nodeY(i, outputs.length) }; });
    hidden.forEach((n,i)=>{ posMap[n.id]={ x: layerX.hidden + (i%2===1?30:-30), y: nodeY(i, hidden.length) }; });

    const maxW = conns.reduce((m,c)=>Math.max(m,Math.abs(c.weight||0)),0.001);

    const connSVG = conns.map(c=>{
      const from = posMap[c.in], to = posMap[c.out];
      if(!from||!to) return '';
      const w = Math.abs(c.weight||0);
      const sw = 0.5 + (w / maxW) * 3.5;
      const color = !c.enabled ? '#374151' : c.weight > 0 ? '#3b82f6' : '#ef4444';
      const dash = !c.enabled ? 'stroke-dasharray="5,4"' : '';
      return \`<line x1="\${from.x}" y1="\${from.y}" x2="\${to.x}" y2="\${to.y}" stroke="\${color}" stroke-width="\${sw.toFixed(1)}" opacity="\${c.enabled?0.7:0.25}" \${dash}><title>w=\${(c.weight||0).toFixed(3)} \${c.enabled?'':'(disabled)'}</title></line>\`;
    }).join('');

    function nodeCircle(n, label, r, textAbove){
      const p = posMap[n.id];
      if(!p) return '';
      const fill = n.type==='input'?'#1e3a5f': n.type==='output'?'#1e3a2f':'#2a2040';
      const stroke = n.type==='input'?'#3b82f6': n.type==='output'?'#10b981':'#8b5cf6';
      const lbl = label || (n.type==='input'?INPUT_LABELS[n.id]||('in'+n.id): n.type==='output'?OUTPUT_LABELS[n.id-inputs.length]||('out'+n.id): 'H');
      const textY = textAbove ? p.y - r - 5 : p.y + r + 14;
      return \`<circle cx="\${p.x}" cy="\${p.y}" r="\${r}" fill="\${fill}" stroke="\${stroke}" stroke-width="2"><title>\${lbl} (id:\${n.id})</title></circle>
      <text x="\${p.x}" y="\${textY}" text-anchor="middle" fill="#d1d5db" font-size="10" font-family="system-ui">\${lbl}</text>\`;
    }

    const inputSVG  = inputs.map((n,i) => nodeCircle(n, INPUT_LABELS[i], 18, false)).join('');
    const outputSVG = outputs.map((n,i)=> nodeCircle(n, OUTPUT_LABELS[i], 22, false)).join('');
    const hiddenSVG = hidden.map(n     => nodeCircle(n, 'H', 14, false)).join('');

    const allY = [...inputs,...outputs,...hidden].map(n=>posMap[n.id]?.y||200);
    const minY = Math.min(...allY) - 60;
    const maxY = Math.max(...allY) + 60;
    const svgH = Math.max(300, maxY - minY);

    el.innerHTML = \`<svg viewBox="0 \${minY} \${W} \${svgH}" width="100%" style="display:block">
      <text x="\${layerX.input}" y="\${minY+20}" text-anchor="middle" fill="#6b7280" font-size="11">INPUTS</text>
      <text x="\${layerX.hidden}" y="\${minY+20}" text-anchor="middle" fill="#6b7280" font-size="11">HIDDEN</text>
      <text x="\${layerX.output}" y="\${minY+20}" text-anchor="middle" fill="#6b7280" font-size="11">OUTPUTS</text>
      \${connSVG}\${inputSVG}\${hiddenSVG}\${outputSVG}
    </svg>\`;
  }

  // ── Activity Log ──────────────────────────────────────────────────
  function updateLog(gens){
    const tbody = document.getElementById('log-body');
    const rows = [];
    for(let gi = gens.length-1; gi >= 0 && rows.length < 20; gi--){
      const gen = gens[gi];
      const sorted = [...gen.genomes].sort((a,b)=>b.fitness-a.fitness);
      for(const g of sorted){
        if(rows.length >= 20) break;
        rows.push({gen:gen.gen, g});
      }
    }
    if(!rows.length){
      tbody.innerHTML = '<tr class="low"><td colspan="8" style="text-align:center;padding:24px">No data yet…</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(({gen,g})=>{
      const cls = g.fitness>100?'high':g.fitness>50?'mid':'low';
      const sc = speciesColor(g.species);
      return \`<tr class="\${cls}">
        <td>\${gen}</td>
        <td style="font-family:monospace" title="\${g.genomeId}">\${g.genomeId.substring(0,14)}…</td>
        <td>\${fmtFit(g.fitness)}</td>
        <td>\${fmt(g.score)}</td>
        <td><span class="species-badge" style="background:\${sc}22;color:\${sc}">S\${g.species}</span></td>
        <td>\${g.trampolineHits||0}</td>
        <td>\${fmtMs(g.durationMs)}</td>
        <td>\${g.isCheater?'<span style="color:#ef4444">🚫 yes</span>':'<span style="color:#6b7280">no</span>'}</td>
      </tr>\`;
    }).join('');
  }

  // ── Boot ──────────────────────────────────────────────────────────
  fetchData();
  setInterval(fetchData, POLL_MS);
})();
</script>
</body>
</html>`;

// ─── HTTP Server ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.url}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (url === '/api/data') {
    const data = getApiData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (url === '/api/checkpoint') {
    const cp = getCheckpoint();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cp));
    return;
  }

  if (url === '/api/live') {
    try {
      const raw = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
      const cp = JSON.parse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        hasMidGen: !!cp._midGen,
        midGen: cp._midGen || null,
        generation: cp.generation,
        bestFitness: cp.bestFitness,
        populationSize: Array.isArray(cp.genomes) ? cp.genomes.length : null,
      }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hasMidGen: false, midGen: null }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`[NEAT Dashboard] Serving at http://localhost:${PORT}`);
  console.log(`[NEAT Dashboard] Watching ${RESULTS_FILE}`);
});
