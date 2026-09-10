/*
 * Medidas Econometricas - correlation, a long-only portfolio simulator, an
 * efficient-frontier scatter, and a max-Sharpe (Markowitz) recommendation.
 *
 * One asset universe, ASSET_ORDER (16 tickers: EWZ/FXE/EEM/XLK/XLE plus 11
 * more sector/benchmark ETFs) - the correlation heatmap, the portfolio
 * simulator, the frontier and the Markowitz optimum all share it, per
 * Rodrigo's request to fold the correlation-matrix universe into the
 * Markowitz chain too. Only 5 of the 16 have a validated accent color
 * (accentColorFor() falls back to a neutral gray for the rest - a fully
 * CVD-validated 16-hue categorical palette isn't practical, and ticker
 * text labels make it unnecessary for identification anyway).
 *
 * getClose()/getDates()/getName() read transparently from either
 * data/etf_data.json bucket (`assets` - full rolling-metrics treatment -
 * or the lighter `comparison_assets`, close prices only) so the rest of
 * the code doesn't care which bucket a symbol lives in.
 *
 * Everything is computed client-side from data/etf_data.json (same file
 * the other two pages read, fetched via the same Yahoo Finance pipeline in
 * scripts/fetch_and_compute.py) plus its `cdi` field for the risk-free
 * rate - no new data pipeline, consistent with how the Fundo page works.
 * Radar Macro and Fundo both hardcode their own 3-symbol order and ignore
 * every extra key here, so none of this leaks into those two pages.
 *
 * Educational tool, not investment advice - every number here is a
 * historical-sample estimate over a 63-trading-day window, which is a
 * noisy way to estimate *expected* returns in particular. Said plainly in
 * the UI, not just in this comment.
 */

const ASSET_ORDER = ["EWZ", "FXE", "EEM", "XLK", "XLE", "SPY", "XTN", "XLY", "GLD", "XLV", "XLP", "XLI", "XLB", "XLF", "XLU", "TLT"];
const ASSET_ACCENT_VAR = { EWZ: "--accent-ewz", FXE: "--accent-fxe", EEM: "--accent-eem", XLK: "--accent-xlk", XLE: "--accent-xle" };
function accentColorFor(sym) { return ASSET_ACCENT_VAR[sym] ? cssVar(ASSET_ACCENT_VAR[sym]) : cssVar("--text-muted"); }
// At 16 assets, listing every one (mostly at/near 0%) is noise - keep only
// weights above 0.5%, sorted descending, for any "which assets matter here" display.
function sigWeightSymbols(w) { return ASSET_ORDER.filter(sym => w[sym] > 0.005).sort((a, b) => w[b] - w[a]); }

const WINDOW = 63; // trading days - correlation, covariance and realized-return window (all consistent)
const TRADING_DAYS = 252;
const FRONTIER_SAMPLES = 4000; // random long-only weight draws for the feasible-set cloud (grid search doesn't scale past ~3 assets)

let ETF = null;
let RETURNS = {};      // sym -> array of daily returns over the last WINDOW days
let ANN_RETURN = {};   // sym -> annualized realized return over the window
let COV = null;        // 16x16 annualized covariance matrix, order = ASSET_ORDER
let CORR = null;       // 16x16 correlation matrix, order = ASSET_ORDER - also drives the heatmap directly
let SIGMA = {};        // sym -> annualized volatility
let RF = 0;            // annualized risk-free rate (from CDI)
let FRONTIER_CLOUD = [];
let MARKOWITZ = null;  // { w: {...}, ret, vol, sharpe, contrib, diversification }
let sliderWeights = Object.fromEntries(ASSET_ORDER.map(sym => [sym, 100 / ASSET_ORDER.length]));
const charts = {};

function getAssetData(sym) { return (ETF.assets && ETF.assets[sym]) || (ETF.comparison_assets && ETF.comparison_assets[sym]); }
function getClose(sym) { return getAssetData(sym).close; }
function getDates(sym) { return getAssetData(sym).dates; }
function getName(sym) { return getAssetData(sym).name; }

function fmtPct(v, digits = 1) { if (v === null || v === undefined || Number.isNaN(v)) return "—"; return (v >= 0 ? "+" : "") + v.toFixed(digits) + "%"; }
function fmtNum(v, digits = 2) { if (v === null || v === undefined || Number.isNaN(v)) return "—"; return v.toFixed(digits); }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

// --- data prep --------------------------------------------------------------

// Shared by both universes; memoized in RETURNS so a symbol present in both
// (e.g. EWZ) isn't recomputed.
function windowReturns(sym) {
  if (RETURNS[sym]) return RETURNS[sym];
  const close = getClose(sym);
  const n = close.length;
  const windowCloses = close.slice(n - WINDOW - 1); // need WINDOW+1 prices for WINDOW returns
  const rets = [];
  for (let i = 1; i < windowCloses.length; i++) rets.push(windowCloses[i] / windowCloses[i - 1] - 1);
  RETURNS[sym] = rets;
  return rets;
}

function computeReturnsAndStats() {
  ASSET_ORDER.forEach(sym => {
    const rets = windowReturns(sym);
    const close = getClose(sym);
    const n = close.length;
    const windowCloses = close.slice(n - WINDOW - 1);
    const totalReturn = windowCloses[windowCloses.length - 1] / windowCloses[0] - 1;
    ANN_RETURN[sym] = Math.pow(1 + totalReturn, TRADING_DAYS / WINDOW) - 1;
  });

  COV = ASSET_ORDER.map((symI, i) => ASSET_ORDER.map((symJ, j) => {
    const ri = RETURNS[symI], rj = RETURNS[symJ];
    const mi = mean(ri), mj = mean(rj);
    let s = 0;
    for (let k = 0; k < ri.length; k++) s += (ri[k] - mi) * (rj[k] - mj);
    return (s / (ri.length - 1)) * TRADING_DAYS; // annualized covariance
  }));

  ASSET_ORDER.forEach((sym, i) => { SIGMA[sym] = Math.sqrt(COV[i][i]); });

  CORR = ASSET_ORDER.map((_, i) => ASSET_ORDER.map((_, j) => COV[i][j] / (Math.sqrt(COV[i][i]) * Math.sqrt(COV[j][j]))));

  const cdiRates = ETF.cdi?.daily_rate_pct || [];
  const latestCdi = cdiRates.length ? cdiRates[cdiRates.length - 1] : 0;
  RF = Math.pow(1 + latestCdi / 100, TRADING_DAYS) - 1;
}

// --- portfolio math (w = {EWZ, FXE, EEM} fractions summing to 1) -----------

function portfolioReturn(w) {
  return ASSET_ORDER.reduce((s, sym) => s + w[sym] * ANN_RETURN[sym], 0);
}
function portfolioVariance(w) {
  const n = ASSET_ORDER.length;
  const wv = ASSET_ORDER.map(sym => w[sym]);
  let v = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) v += wv[i] * wv[j] * COV[i][j];
  return v;
}
function portfolioStats(w) {
  const n = ASSET_ORDER.length;
  const ret = portfolioReturn(w);
  const variance = portfolioVariance(w);
  const vol = Math.sqrt(variance);
  const sharpe = vol > 0 ? (ret - RF) / vol : null;
  // Euler risk decomposition: contribution_i = w_i * (Sigma w)_i / variance, sums to 1.
  const wv = ASSET_ORDER.map(sym => w[sym]);
  const sigmaW = COV.map(row => row.reduce((s, c, j) => s + c * wv[j], 0));
  const contrib = {};
  ASSET_ORDER.forEach((sym, i) => { contrib[sym] = variance > 0 ? (wv[i] * sigmaW[i]) / variance : 1 / n; });
  const enb = 1 / ASSET_ORDER.reduce((s, sym) => s + contrib[sym] ** 2, 0);
  const diversification = ((enb - 1) / (n - 1)) * 100;
  return { ret, vol, sharpe, contrib, diversification };
}

// --- linear algebra (small, dense, N<=5 - a plain Gauss-Jordan solve is plenty) ---

function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const pv = M[col][col];
    if (Math.abs(pv) < 1e-12) continue; // near-singular subsystem; caller filters bad results
    for (let c = col; c <= n; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map(row => row[n]);
}

// Long-only max-Sharpe (tangency) portfolio via the standard iterative
// heuristic: solve the unconstrained tangency portfolio (proportional to
// Sigma^-1 (mu - rf)); if that has negative weights, drop the most negative
// asset and re-solve on the remaining subset; repeat. Exact for this size
// (<=5 assets) and much more precise than sampling for finding the optimum -
// random sampling is used only for the *visualized* feasible-set cloud below.
function longOnlyTangencyPortfolio() {
  let active = [...ASSET_ORDER];
  while (active.length > 1) {
    const idx = active.map(sym => ASSET_ORDER.indexOf(sym));
    const covSub = idx.map(i => idx.map(j => COV[i][j]));
    const muSub = active.map(sym => ANN_RETURN[sym] - RF);
    const raw = solveLinearSystem(covSub, muSub);
    // Check negativity on the *raw* (pre-normalization) vector, not the
    // sum-normalized one: raw'*excess = raw'*Sigma*raw >= 0 always (Sigma
    // is PSD), so when sum(raw) < 0, dividing by it flips every sign and
    // silently turns the max-Sharpe direction into the min-Sharpe one -
    // that bug once had this function return 100% of the worst asset.
    // A negative raw_i means the unconstrained solve wants to *short*
    // asset i - exactly the one to drop for a long-only solution.
    const minIdx = raw.indexOf(Math.min(...raw));
    if (raw[minIdx] >= -1e-9) {
      const sum = raw.reduce((a, b) => a + b, 0);
      if (sum > 1e-9) {
        const w = raw.map(v => v / sum);
        const full = {};
        ASSET_ORDER.forEach(sym => { full[sym] = 0; });
        active.forEach((sym, i) => { full[sym] = Math.max(0, w[i]); });
        return full;
      }
    }
    active.splice(minIdx, 1);
  }
  const full = {};
  ASSET_ORDER.forEach(sym => { full[sym] = 0; });
  full[active[0]] = 1;
  return full;
}

function randomSimplexWeights() {
  // Dirichlet(1,1,...,1) via normalized Exponential(1) draws = uniform over the simplex.
  const draws = ASSET_ORDER.map(() => -Math.log(Math.random()));
  const sum = draws.reduce((a, b) => a + b, 0);
  const w = {};
  ASSET_ORDER.forEach((sym, i) => { w[sym] = draws[i] / sum; });
  return w;
}

// Uniform-over-the-full-simplex Dirichlet(1) sampling concentrates almost
// all its mass near the centroid once N gets into the teens (every weight
// close to 1/N) - fine at N=3-5, but at N=16 it draws a tight blob instead
// of a spread-out cloud, because "all 16 near equal" is overwhelmingly the
// most probable outcome. Sampling a random k-asset *subset* (k drawn small)
// and only Dirichlet-sampling within it (zero elsewhere) instead visits the
// simplex's lower-dimensional faces - sparse, concentrated combinations -
// which is where the interesting risk/return spread actually lives (it's
// also exactly the kind of portfolio the tangency optimizer itself favors).
function randomSparseSubsetWeights() {
  const n = ASSET_ORDER.length;
  const k = 2 + Math.floor(Math.random() * Math.min(6, n - 1)); // 2..7 active assets
  const pool = [...ASSET_ORDER];
  const chosen = [];
  for (let i = 0; i < k; i++) chosen.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  const draws = chosen.map(() => -Math.log(Math.random()));
  const sum = draws.reduce((a, b) => a + b, 0);
  const w = {};
  ASSET_ORDER.forEach(sym => { w[sym] = 0; });
  chosen.forEach((sym, i) => { w[sym] = draws[i] / sum; });
  return w;
}

function buildFrontierAndMarkowitz() {
  const cloud = [];
  for (let k = 0; k < FRONTIER_SAMPLES; k++) {
    // Mix: half full-dimension draws (dense, "average" portfolios), half
    // sparse-subset draws (concentrated, where the spread actually is).
    const w = k % 2 === 0 ? randomSimplexWeights() : randomSparseSubsetWeights();
    const s = portfolioStats(w);
    cloud.push({ x: s.vol * 100, y: s.ret * 100 });
  }
  FRONTIER_CLOUD = cloud;

  const w = longOnlyTangencyPortfolio();
  const s = portfolioStats(w);
  MARKOWITZ = { w, ret: s.ret, vol: s.vol, sharpe: s.sharpe, contrib: s.contrib, diversification: s.diversification };
}

// --- rendering ---------------------------------------------------------------

function corrColor(v) {
  // red (critical) -> surface-2 (neutral) -> green (good), matching the theme.
  const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const rgbToStr = c => `rgb(${c[0]},${c[1]},${c[2]})`;
  const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const neg = hexToRgb(cssVar("--critical").trim() || "#F85149");
  const neu = hexToRgb("#1C2330");
  const pos = hexToRgb(cssVar("--good").trim() || "#3FB950");
  if (v >= 0) return rgbToStr(lerp(neu, pos, v));
  return rgbToStr(lerp(neu, neg, -v));
}

function renderCorrelation(root) {
  const order = ASSET_ORDER;
  const cells = [];
  cells.push(`<div></div>`);
  order.forEach(sym => cells.push(`<div class="corr-label">${sym}</div>`));
  order.forEach((symRow, i) => {
    cells.push(`<div class="corr-label">${symRow}</div>`);
    order.forEach((symCol, j) => {
      const v = CORR[i][j];
      const textColor = Math.abs(v) > 0.55 ? "#0a0e14" : cssVar("--text-primary");
      cells.push(`<div class="corr-cell" style="background:${corrColor(v)}; color:${textColor}">${v.toFixed(2)}</div>`);
    });
  });

  const pairs = [];
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      pairs.push({ a: order[i], b: order[j], v: CORR[i][j] });
    }
  }
  const avgCorr = mean(pairs.map(p => p.v));
  const divGeral = Math.max(0, Math.min(100, (1 - avgCorr) * 100));
  const divLabel = divGeral >= 70 ? "alta" : divGeral >= 40 ? "moderada" : "baixa";

  // 15 assets = 105 pairs - listing every one is noise. Highlight the top 3
  // most redundant and top 3 best diversifiers instead.
  const byAbsDesc = [...pairs].sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const mostRedundant = byAbsDesc.slice(0, 3);
  const bestDiversifiers = byAbsDesc.slice(-3).reverse();
  const describePair = (p, verdict) => {
    const level = Math.abs(p.v) >= 0.6 ? "alta" : Math.abs(p.v) >= 0.3 ? "moderada" : "baixa";
    const sign = p.v >= 0 ? "positiva" : "negativa";
    return `<li><strong>${p.a} × ${p.b}</strong> correlacao ${level} ${sign} (${fmtNum(p.v)}) — ${verdict}</li>`;
  };
  const interpLines = [
    `<li class="group-label">Pares mais redundantes (correlacao mais forte em modulo):</li>`,
    ...mostRedundant.map(p => describePair(p, "se diversificar, esse par soma pouco valor")),
    `<li class="group-label">Melhores pares para diversificar (correlacao mais fraca em modulo):</li>`,
    ...bestDiversifiers.map(p => describePair(p, p.v < 0 ? "correlacao negativa: tende a compensar movimentos" : "bom par para diversificar")),
  ].join("");

  root.innerHTML = `<div class="corr-grid">${cells.join("")}</div>`;
  document.getElementById("corr-interp").innerHTML = `
    <div class="info-title">📊 Interpretacao</div>
    <ul>${interpLines}</ul>
    <div class="div-score">Diversificacao geral (correlacao media entre os ${pairs.length} pares): <strong>${divGeral.toFixed(0)}% (${divLabel})</strong></div>
  `;
}

function updateSliderUI() {
  ASSET_ORDER.forEach(sym => {
    document.getElementById("slider-" + sym).value = sliderWeights[sym];
    document.getElementById("slider-val-" + sym).textContent = fmtNum(sliderWeights[sym], 1) + "%";
  });
  const total = ASSET_ORDER.reduce((s, sym) => s + sliderWeights[sym], 0);
  const totalEl = document.getElementById("slider-total");
  totalEl.textContent = `Total: ${total.toFixed(0)}%`;
  totalEl.className = "slider-total" + (Math.abs(total - 100) < 0.6 ? " ok" : "");
}

function currentWeightsFraction() {
  const w = {};
  ASSET_ORDER.forEach(sym => { w[sym] = sliderWeights[sym] / 100; });
  return w;
}

function renderSimResults() {
  const w = currentWeightsFraction();
  const s = portfolioStats(w);

  document.getElementById("sim-results").innerHTML = `
    <div class="sim-results-grid">
      <div class="sim-stat"><div class="label">Retorno anualizado</div><div class="value">${fmtPct(s.ret * 100)}</div></div>
      <div class="sim-stat"><div class="label">Volatilidade</div><div class="value">${fmtNum(s.vol * 100, 1)}%</div></div>
      <div class="sim-stat"><div class="label">Sharpe</div><div class="value">${fmtNum(s.sharpe)}</div></div>
      <div class="sim-stat"><div class="label">Diversificacao</div><div class="value">${fmtNum(s.diversification, 0)}%</div></div>
    </div>
    <div class="risk-contrib">
      ${ASSET_ORDER.map(sym => `<div style="width:${(s.contrib[sym] * 100).toFixed(1)}%; background:${accentColorFor(sym)}">${s.contrib[sym] > 0.12 ? (s.contrib[sym] * 100).toFixed(0) + "%" : ""}</div>`).join("")}
    </div>
    <div class="risk-contrib-legend">
      <span>Contribuicao ao risco (so pesos &gt; 0.5%):</span>
      ${sigWeightSymbols(w).map(sym => `<span><span class="asset-dot" style="background:${accentColorFor(sym)}"></span>${sym} ${(s.contrib[sym] * 100).toFixed(0)}%</span>`).join("")}
    </div>
    ${renderAlternativesTable(s)}
  `;

  updateFrontierCurrentPoint(s);
}

function zeroWeights() {
  const w = {};
  ASSET_ORDER.forEach(sym => { w[sym] = 0; });
  return w;
}

function renderAlternativesTable(currentStats) {
  const ewz100 = portfolioStats({ ...zeroWeights(), EWZ: 1 });
  const equalW = 1 / ASSET_ORDER.length;
  const equal = portfolioStats(Object.fromEntries(ASSET_ORDER.map(sym => [sym, equalW])));
  const rows = [
    { label: "Seu portfolio", s: currentStats, cls: "current" },
    { label: "100% EWZ", s: ewz100, cls: "" },
    { label: `Equal weight (${(equalW * 100).toFixed(0)}% cada, ${ASSET_ORDER.length} ativos)`, s: equal, cls: "" },
    { label: `Otimo Markowitz (${sigWeightSymbols(MARKOWITZ.w).map(sym => `${sym} ${(MARKOWITZ.w[sym] * 100).toFixed(0)}%`).join("/")})`, s: MARKOWITZ, cls: "optimal" },
  ];
  return `
    <table class="alt-table">
      <thead><tr><th>vs. alternativas</th><th>Retorno</th><th>Vol.</th><th>Sharpe</th></tr></thead>
      <tbody>
        ${rows.map(r => `<tr class="${r.cls}"><td>${r.label}</td><td>${fmtPct(r.s.ret * 100)}</td><td>${fmtNum(r.s.vol * 100, 1)}%</td><td>${fmtNum(r.s.sharpe)}</td></tr>`).join("")}
      </tbody>
    </table>
  `;
}

function baseScatterOptions(xLabel, yLabel) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar("--surface"), titleColor: cssVar("--text-primary"), bodyColor: cssVar("--text-secondary"),
        borderColor: cssVar("--border-strong"), borderWidth: 1,
        callbacks: {
          label: ctx => `${ctx.dataset.label}: risco ${ctx.parsed.x.toFixed(1)}% · retorno ${ctx.parsed.y.toFixed(1)}%`,
        },
      },
    },
    scales: {
      x: { title: { display: true, text: xLabel, color: cssVar("--text-muted"), font: { size: 11 } }, grid: { color: cssVar("--grid") }, ticks: { color: cssVar("--text-muted"), font: { family: "IBM Plex Mono", size: 10 }, callback: v => v + "%" } },
      y: { title: { display: true, text: yLabel, color: cssVar("--text-muted"), font: { size: 11 } }, grid: { color: cssVar("--grid") }, ticks: { color: cssVar("--text-muted"), font: { family: "IBM Plex Mono", size: 10 }, callback: v => v + "%" } },
    },
  };
}

function renderFrontierChart() {
  const assetPoints = ASSET_ORDER.map(sym => ({ x: SIGMA[sym] * 100, y: ANN_RETURN[sym] * 100 }));
  const currentW = currentWeightsFraction();
  const currentS = portfolioStats(currentW);

  charts.frontier = new Chart(document.getElementById("chart-frontier").getContext("2d"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "Combinacoes possiveis", data: FRONTIER_CLOUD, backgroundColor: cssVar("--border-strong"), pointRadius: 2, pointHoverRadius: 3 },
        ...ASSET_ORDER.map(sym => ({
          label: sym, data: [{ x: SIGMA[sym] * 100, y: ANN_RETURN[sym] * 100 }],
          backgroundColor: accentColorFor(sym), pointRadius: 7, pointHoverRadius: 9, pointStyle: "rectRot",
        })),
        { label: "Seu portfolio", data: [{ x: currentS.vol * 100, y: currentS.ret * 100 }], backgroundColor: cssVar("--text-primary"), pointRadius: 8, pointHoverRadius: 10, pointStyle: "circle" },
        { label: "Otimo Markowitz", data: [{ x: MARKOWITZ.vol * 100, y: MARKOWITZ.ret * 100 }], backgroundColor: cssVar("--good"), pointRadius: 9, pointHoverRadius: 11, pointStyle: "star" },
      ],
    },
    options: baseScatterOptions("Risco (volatilidade anualizada, %)", "Retorno esperado anualizado (%)"),
  });

  document.getElementById("frontier-legend").innerHTML = `
    <div class="legend-item"><span class="legend-dot" style="background:${cssVar('--border-strong')}"></span>Combinacoes possiveis</div>
    ${ASSET_ORDER.map(sym => `<div class="legend-item"><span class="legend-dot" style="background:${accentColorFor(sym)}"></span>${sym} isolado</div>`).join("")}
    <div class="legend-item"><span class="legend-dot" style="background:${cssVar('--text-primary')}"></span>Seu portfolio</div>
    <div class="legend-item"><span class="legend-dot" style="background:${cssVar('--good')}"></span>Otimo Markowitz</div>
  `;
}

function updateFrontierCurrentPoint(stats) {
  if (!charts.frontier) return;
  const ds = charts.frontier.data.datasets.find(d => d.label === "Seu portfolio");
  ds.data = [{ x: stats.vol * 100, y: stats.ret * 100 }];
  charts.frontier.update("none");
}

function renderMarkowitzCard() {
  const ewz100 = portfolioStats({ ...zeroWeights(), EWZ: 1 });
  const sharpeGain = ((MARKOWITZ.sharpe - ewz100.sharpe) / Math.abs(ewz100.sharpe)) * 100;
  const riskCut = ((ewz100.vol - MARKOWITZ.vol) / ewz100.vol) * 100;

  document.getElementById("markowitz-card").innerHTML = `
    <div class="mk-title">🏆 Portfolio otimo (Markowitz)</div>
    <div>Para maximizar o Sharpe (melhor retorno ajustado ao risco), long-only:</div>
    <div class="mk-weights">${sigWeightSymbols(MARKOWITZ.w).map(sym => `${sym}: ${(MARKOWITZ.w[sym] * 100).toFixed(0)}%`).join(" · ")}</div>
    <div class="mk-stats">
      <div><div class="label">Retorno esperado</div><div class="value">${fmtPct(MARKOWITZ.ret * 100)} a.a.</div></div>
      <div><div class="label">Volatilidade</div><div class="value">${fmtNum(MARKOWITZ.vol * 100, 1)}%</div></div>
      <div><div class="label">Sharpe</div><div class="value">${fmtNum(MARKOWITZ.sharpe)}</div></div>
      <div><div class="label">Diversificacao</div><div class="value">${fmtNum(MARKOWITZ.diversification, 0)}%</div></div>
    </div>
    <div class="mk-vs">Vs. 100% EWZ: ${sharpeGain >= 0 ? "+" : ""}${sharpeGain.toFixed(0)}% de Sharpe, ${riskCut >= 0 ? "-" : "+"}${Math.abs(riskCut).toFixed(0)}% de risco.</div>
    <div class="mk-note">⚠️ Baseado em dados historicos dos ultimos ${WINDOW} pregoes (retorno, volatilidade e correlacao). Sharpe maximo nao significa "melhor para todos" — depende do seu perfil e tolerancia a risco. Nao constitui recomendacao de investimento.</div>
  `;
}

function attachSliderHandlers() {
  ASSET_ORDER.forEach(sym => {
    document.getElementById("slider-" + sym).addEventListener("input", e => {
      const newVal = Math.max(0, Math.min(100, Number(e.target.value)));
      const others = ASSET_ORDER.filter(s => s !== sym);
      const remaining = 100 - newVal;
      const othersSum = others.reduce((s, o) => s + sliderWeights[o], 0);
      if (othersSum <= 0.001) {
        others.forEach(o => { sliderWeights[o] = remaining / others.length; });
      } else {
        others.forEach(o => { sliderWeights[o] = (sliderWeights[o] / othersSum) * remaining; });
      }
      sliderWeights[sym] = newVal;
      updateSliderUI();
      renderSimResults();
    });
  });
}

function renderShell() {
  document.getElementById("medidas-root").innerHTML = `
    <header class="top">
      <div>
        <h1>Medidas Econometricas</h1>
        <div class="sub">Correlacao, simulador de portfolio e otimizacao de Markowitz — ${ASSET_ORDER.length} ativos (EWZ, FXE, EEM + ETFs setoriais e macro)</div>
      </div>
    </header>
    <div class="disclaimer-banner">⚠️ Ferramenta educacional. Todos os numeros vem de dados historicos (ultimos ${WINDOW} pregoes) e nao constituem recomendacao de investimento — retorno passado nao garante retorno futuro.</div>

    <div class="section-title">Matriz de correlacao (${WINDOW} pregoes)</div>
    <div class="corr-wrap">
      <div class="corr-scroll"><div id="corr-grid-host"></div></div>
      <div class="corr-scale"><span>-1 (inversa)</span><span class="bar"></span><span>+1 (junto)</span></div>
      <div class="info-card" id="corr-interp"></div>
    </div>

    <div class="section-title">🎯 Construa seu portfolio</div>
    <div class="sim-card">
      <div id="sliders-host"></div>
      <div class="slider-total" id="slider-total">Total: 100%</div>
      <div class="sim-results" id="sim-results"></div>
    </div>

    <div class="section-title">Fronteira eficiente</div>
    <div class="chart-card">
      <h3>Risco vs. retorno</h3>
      <div class="desc">Cada ponto cinza e uma combinacao de pesos possivel (long-only); os pontos coloridos sao os ativos isolados, seu portfolio atual e o otimo de Markowitz.</div>
      <div class="canvas-wrap" style="height:340px"><canvas id="chart-frontier"></canvas></div>
      <div class="legend-row" id="frontier-legend"></div>
    </div>

    <div class="section-title">Recomendacao Markowitz</div>
    <div class="markowitz-card" id="markowitz-card"></div>

    <footer>
      Correlacao, retorno e volatilidade estimados sobre os ultimos ${WINDOW} pregoes de fechamento (Yahoo Finance, mesma fonte do Radar Macro). Taxa livre de risco (rf) = CDI anualizado
      (Banco Central, mesma fonte usada na aba Fundo). Nuvem da fronteira eficiente: ${FRONTIER_SAMPLES} carteiras long-only (sem venda a descoberto) amostradas aleatoriamente; o otimo de
      Markowitz e calculado analiticamente (portfolio tangente), nao por amostragem.
      Estimar retorno esperado a partir de retorno realizado de curto prazo e uma pratica ruidosa — trate os numeros como ilustrativos, nao preditivos. Nao constitui recomendacao de investimento.
    </footer>
  `;

  document.getElementById("sliders-host").innerHTML = ASSET_ORDER.map(sym => `
    <div class="slider-row" style="--slider-accent:${accentColorFor(sym)}">
      <div class="slider-head">
        <span class="name"><span class="asset-dot" style="background:${accentColorFor(sym)}"></span>${sym}</span>
        <span class="val" id="slider-val-${sym}">${fmtNum(sliderWeights[sym], 1)}%</span>
      </div>
      <input type="range" min="0" max="100" step="0.5" id="slider-${sym}" value="${sliderWeights[sym]}" />
    </div>
  `).join("");

  renderCorrelation(document.getElementById("corr-grid-host"));
  attachSliderHandlers();
  updateSliderUI();
}

async function loadData() {
  const bust = Date.now();
  const res = await fetch(`data/etf_data.json?t=${bust}`, { cache: "no-store" });
  if (!res.ok) throw new Error("Falha ao carregar data/etf_data.json.");
  ETF = await res.json();
}

async function init() {
  const root = document.getElementById("medidas-root");
  try {
    await loadData();
  } catch (err) {
    root.innerHTML = `<div class="load-error">Nao foi possivel carregar os dados: ${err.message}</div>`;
    return;
  }
  computeReturnsAndStats();
  buildFrontierAndMarkowitz();
  renderShell();
  renderFrontierChart();
  renderSimResults();
  renderMarkowitzCard();
}

init();
