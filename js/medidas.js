/*
 * Medidas Econometricas - correlation, a long-only 3-asset portfolio
 * simulator, an efficient-frontier scatter, and a max-Sharpe (Markowitz)
 * recommendation for EWZ/FXE/EEM. Everything is computed client-side from
 * data/etf_data.json's existing daily `close` arrays (same file the other
 * two pages read) plus its `cdi` field for the risk-free rate - no new
 * data pipeline, consistent with how the Fundo page works.
 *
 * Educational tool, not investment advice - every number here is a
 * historical-sample estimate over a 63-trading-day window, which is a
 * noisy way to estimate *expected* returns in particular. Said plainly in
 * the UI, not just in this comment.
 */

const ASSET_ORDER = ["EWZ", "FXE", "EEM"];
const ASSET_ACCENT_VAR = { EWZ: "--accent-ewz", FXE: "--accent-fxe", EEM: "--accent-eem" };
const WINDOW = 63; // trading days - correlation, covariance and realized-return window (all consistent)
const TRADING_DAYS = 252;
const FRONTIER_STEP = 0.02; // 2% grid over the 3-asset simplex, long-only

let ETF = null;
let RETURNS = {};      // sym -> array of daily returns over the last WINDOW days
let ANN_RETURN = {};   // sym -> annualized realized return over the window
let COV = null;        // 3x3 annualized covariance matrix, order = ASSET_ORDER
let CORR = null;       // 3x3 correlation matrix
let SIGMA = {};        // sym -> annualized volatility
let RF = 0;            // annualized risk-free rate (from CDI)
let FRONTIER_CLOUD = [];
let MARKOWITZ = null;  // { w: [.,.,.], ret, vol, sharpe }
let sliderWeights = { EWZ: 40, FXE: 30, EEM: 30 };
const charts = {};

function fmtPct(v, digits = 1) { if (v === null || v === undefined || Number.isNaN(v)) return "—"; return (v >= 0 ? "+" : "") + v.toFixed(digits) + "%"; }
function fmtNum(v, digits = 2) { if (v === null || v === undefined || Number.isNaN(v)) return "—"; return v.toFixed(digits); }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

// --- data prep --------------------------------------------------------------

function computeReturnsAndStats() {
  ASSET_ORDER.forEach(sym => {
    const close = ETF.assets[sym].close;
    const n = close.length;
    const windowCloses = close.slice(n - WINDOW - 1); // need WINDOW+1 prices for WINDOW returns
    const rets = [];
    for (let i = 1; i < windowCloses.length; i++) rets.push(windowCloses[i] / windowCloses[i - 1] - 1);
    RETURNS[sym] = rets;
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
  const wv = ASSET_ORDER.map(sym => w[sym]);
  let v = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) v += wv[i] * wv[j] * COV[i][j];
  return v;
}
function portfolioStats(w) {
  const ret = portfolioReturn(w);
  const variance = portfolioVariance(w);
  const vol = Math.sqrt(variance);
  const sharpe = vol > 0 ? (ret - RF) / vol : null;
  // Euler risk decomposition: contribution_i = w_i * (Sigma w)_i / variance, sums to 1.
  const wv = ASSET_ORDER.map(sym => w[sym]);
  const sigmaW = COV.map(row => row.reduce((s, c, j) => s + c * wv[j], 0));
  const contrib = {};
  ASSET_ORDER.forEach((sym, i) => { contrib[sym] = variance > 0 ? (wv[i] * sigmaW[i]) / variance : 1 / 3; });
  const enb = 1 / ASSET_ORDER.reduce((s, sym) => s + contrib[sym] ** 2, 0);
  const diversification = ((enb - 1) / (ASSET_ORDER.length - 1)) * 100;
  return { ret, vol, sharpe, contrib, diversification };
}

function buildFrontierAndMarkowitz() {
  const cloud = [];
  let best = null;
  const steps = Math.round(1 / FRONTIER_STEP); // integer loop counters avoid float drift from repeated +=
  for (let i = 0; i <= steps; i++) {
    const w1 = i / steps;
    for (let j = 0; j <= steps - i; j++) {
      const w2 = j / steps;
      const w3 = Math.max(0, 1 - w1 - w2);
      const w = { EWZ: w1, FXE: w2, EEM: w3 };
      const s = portfolioStats(w);
      cloud.push({ x: s.vol * 100, y: s.ret * 100 });
      if (s.sharpe !== null && (best === null || s.sharpe > best.sharpe)) {
        best = { w, ret: s.ret, vol: s.vol, sharpe: s.sharpe, contrib: s.contrib, diversification: s.diversification };
      }
    }
  }
  FRONTIER_CLOUD = cloud;
  MARKOWITZ = best;
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
  const cells = [];
  cells.push(`<div></div>`);
  ASSET_ORDER.forEach(sym => cells.push(`<div class="corr-label"><span class="asset-dot" style="background:var(${ASSET_ACCENT_VAR[sym]})"></span>${sym}</div>`));
  ASSET_ORDER.forEach((symRow, i) => {
    cells.push(`<div class="corr-label"><span class="asset-dot" style="background:var(${ASSET_ACCENT_VAR[symRow]})"></span>${symRow}</div>`);
    ASSET_ORDER.forEach((symCol, j) => {
      const v = CORR[i][j];
      const textColor = Math.abs(v) > 0.55 ? "#0a0e14" : cssVar("--text-primary");
      cells.push(`<div class="corr-cell" style="background:${corrColor(v)}; color:${textColor}">${v.toFixed(2)}</div>`);
    });
  });

  const pairs = [];
  for (let i = 0; i < ASSET_ORDER.length; i++) {
    for (let j = i + 1; j < ASSET_ORDER.length; j++) {
      pairs.push({ a: ASSET_ORDER[i], b: ASSET_ORDER[j], v: CORR[i][j] });
    }
  }
  const highest = pairs.reduce((a, b) => (Math.abs(b.v) > Math.abs(a.v) ? b : a));
  const lowest = pairs.reduce((a, b) => (Math.abs(b.v) < Math.abs(a.v) ? b : a));
  const avgCorr = mean(pairs.map(p => p.v));
  const divGeral = Math.max(0, Math.min(100, (1 - avgCorr) * 100));
  const divLabel = divGeral >= 70 ? "alta" : divGeral >= 40 ? "moderada" : "baixa";

  const interpLines = pairs.map(p => {
    const level = Math.abs(p.v) >= 0.6 ? "alta" : Math.abs(p.v) >= 0.3 ? "moderada" : "baixa";
    const sign = p.v >= 0 ? "positiva" : "negativa";
    const note = Math.abs(p.v) >= 0.6
      ? "correlacao alta: esse par se move parecido, diversificacao redundante entre eles"
      : Math.abs(p.v) < 0.3
        ? "correlacao baixa: bom par para diversificar"
        : "correlacao intermediaria";
    return `<li><strong>${p.a} × ${p.b}</strong> correlacao ${level} ${sign} (${fmtNum(p.v)}) — ${note}</li>`;
  }).join("");

  root.innerHTML = `
    <div class="corr-grid">${cells.join("")}</div>
    <div class="corr-scale"><span>-1 (inversa)</span><span class="bar"></span><span>+1 (junto)</span></div>
  `;
  document.getElementById("corr-interp").innerHTML = `
    <div class="info-title">📊 Interpretacao</div>
    <ul>${interpLines}</ul>
    <div class="div-score">Diversificacao geral (correlacao media entre os pares): <strong>${divGeral.toFixed(0)}% (${divLabel})</strong></div>
  `;
}

function updateSliderUI() {
  ASSET_ORDER.forEach(sym => {
    document.getElementById("slider-" + sym).value = sliderWeights[sym];
    document.getElementById("slider-val-" + sym).textContent = Math.round(sliderWeights[sym]) + "%";
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
      ${ASSET_ORDER.map(sym => `<div style="width:${(s.contrib[sym] * 100).toFixed(1)}%; background:var(${ASSET_ACCENT_VAR[sym]})">${s.contrib[sym] > 0.12 ? (s.contrib[sym] * 100).toFixed(0) + "%" : ""}</div>`).join("")}
    </div>
    <div class="risk-contrib-legend">
      <span>Contribuicao ao risco:</span>
      ${ASSET_ORDER.map(sym => `<span><span class="asset-dot" style="background:var(${ASSET_ACCENT_VAR[sym]})"></span>${sym} ${(s.contrib[sym] * 100).toFixed(0)}%</span>`).join("")}
    </div>
    ${renderAlternativesTable(s)}
  `;

  updateFrontierCurrentPoint(s);
}

function renderAlternativesTable(currentStats) {
  const ewz100 = portfolioStats({ EWZ: 1, FXE: 0, EEM: 0 });
  const equal = portfolioStats({ EWZ: 1 / 3, FXE: 1 / 3, EEM: 1 / 3 });
  const rows = [
    { label: "Seu portfolio", s: currentStats, cls: "current" },
    { label: "100% EWZ", s: ewz100, cls: "" },
    { label: "Equal weight (33/33/34)", s: equal, cls: "" },
    { label: `Otimo Markowitz (${ASSET_ORDER.map(sym => `${sym} ${(MARKOWITZ.w[sym] * 100).toFixed(0)}%`).join("/")})`, s: MARKOWITZ, cls: "optimal" },
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
          backgroundColor: cssVar(ASSET_ACCENT_VAR[sym]), pointRadius: 7, pointHoverRadius: 9, pointStyle: "rectRot",
        })),
        { label: "Seu portfolio", data: [{ x: currentS.vol * 100, y: currentS.ret * 100 }], backgroundColor: cssVar("--text-primary"), pointRadius: 8, pointHoverRadius: 10, pointStyle: "circle" },
        { label: "Otimo Markowitz", data: [{ x: MARKOWITZ.vol * 100, y: MARKOWITZ.ret * 100 }], backgroundColor: cssVar("--good"), pointRadius: 9, pointHoverRadius: 11, pointStyle: "star" },
      ],
    },
    options: baseScatterOptions("Risco (volatilidade anualizada, %)", "Retorno esperado anualizado (%)"),
  });

  document.getElementById("frontier-legend").innerHTML = `
    <div class="legend-item"><span class="legend-dot" style="background:${cssVar('--border-strong')}"></span>Combinacoes possiveis</div>
    ${ASSET_ORDER.map(sym => `<div class="legend-item"><span class="legend-dot" style="background:var(${ASSET_ACCENT_VAR[sym]})"></span>${sym} isolado</div>`).join("")}
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
  const ewz100 = portfolioStats({ EWZ: 1, FXE: 0, EEM: 0 });
  const sharpeGain = ((MARKOWITZ.sharpe - ewz100.sharpe) / Math.abs(ewz100.sharpe)) * 100;
  const riskCut = ((ewz100.vol - MARKOWITZ.vol) / ewz100.vol) * 100;

  document.getElementById("markowitz-card").innerHTML = `
    <div class="mk-title">🏆 Portfolio otimo (Markowitz)</div>
    <div>Para maximizar o Sharpe (melhor retorno ajustado ao risco), long-only:</div>
    <div class="mk-weights">${ASSET_ORDER.map(sym => `${sym}: ${(MARKOWITZ.w[sym] * 100).toFixed(0)}%`).join(" · ")}</div>
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
        <div class="sub">Correlacao, simulador de portfolio e otimizacao de Markowitz — EWZ · FXE · EEM</div>
      </div>
    </header>
    <div class="disclaimer-banner">⚠️ Ferramenta educacional. Todos os numeros vem de dados historicos (ultimos ${WINDOW} pregoes) e nao constituem recomendacao de investimento — retorno passado nao garante retorno futuro.</div>

    <div class="section-title">Matriz de correlacao (${WINDOW} pregoes)</div>
    <div class="corr-wrap">
      <div id="corr-grid-host"></div>
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
      (Banco Central, mesma fonte usada na aba Fundo). Fronteira eficiente calculada em uma grade de pesos long-only (sem venda a descoberto), passo de ${(FRONTIER_STEP * 100).toFixed(0)}%.
      Estimar retorno esperado a partir de retorno realizado de curto prazo e uma pratica ruidosa — trate os numeros como ilustrativos, nao preditivos. Nao constitui recomendacao de investimento.
    </footer>
  `;

  document.getElementById("sliders-host").innerHTML = ASSET_ORDER.map(sym => `
    <div class="slider-row" style="--slider-accent:var(${ASSET_ACCENT_VAR[sym]})">
      <div class="slider-head">
        <span class="name"><span class="asset-dot" style="background:var(${ASSET_ACCENT_VAR[sym]})"></span>${sym}</span>
        <span class="val" id="slider-val-${sym}">${sliderWeights[sym]}%</span>
      </div>
      <input type="range" min="0" max="100" step="1" id="slider-${sym}" value="${sliderWeights[sym]}" />
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
