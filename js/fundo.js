/*
 * Fundo Macro Rodrigo 2026 - a simulated buy-and-hold long-only fund over
 * EWZ/EEM/FXE. Loads data/fundo.json (fixed fund definition: capital,
 * entry weights, entry prices, inception date - never changes) and reuses
 * data/etf_data.json (the same file Radar Macro uses) for daily/intraday
 * prices, rather than maintaining a second growing price history: the
 * fund's NAV on any day is just its fixed share counts times that day's
 * close, so there is nothing to store beyond the fund definition itself.
 *
 * No rebalancing: share counts are fixed at inception, so weights drift
 * with price - the allocation table/pie show *current* drifted weights,
 * not the original targets.
 */

const ASSET_ORDER = ["EWZ", "FXE", "EEM"];
const ASSET_ACCENT_VAR = { EWZ: "--accent-ewz", FXE: "--accent-fxe", EEM: "--accent-eem" };
const VOL_WINDOW = 21;
const SHARPE_WINDOW = 63;
const TRADING_DAYS = 252;

const RANGES = [
  { key: "1d", label: "1D", intraday: true },
  { key: "1w", label: "1S", days: 5 },
  { key: "1m", label: "1M", days: 21 },
  { key: "3m", label: "3M", days: 63 },
  { key: "max", label: "Max", days: null },
];
const DEFAULT_RANGE_KEY = "max";

let FUNDO = null, ETF = null;
let SHARES = {};
let FUND_SERIES = null; // { dates, nav, ret_pct, dd_pct, rvol, rsharpe }
let ASSET_SINCE = {};   // per-asset since-inception series
const charts = {};

function fmtMoney(v) { if (v === null || v === undefined) return "—"; return FUNDO.currency_label + " " + v.toLocaleString("pt-BR", { maximumFractionDigits: 0 }); }
function fmtPct(v, digits = 2) { if (v === null || v === undefined) return "—"; return (v >= 0 ? "+" : "") + v.toFixed(digits) + "%"; }
function fmtNum(v, digits = 2) { if (v === null || v === undefined) return "—"; return v.toFixed(digits); }
function fmtDateShort(iso) { const [y, m, d] = iso.split("-"); return d + "/" + m + "/" + y.slice(2); }
function fmtDateLong(iso) { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stdev(arr, m) { return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1)); }

// Same rolling-window math as scripts/fetch_and_compute.py, kept in sync by hand.
function computeSeries(dates, values) {
  const rets = [null];
  for (let i = 1; i < values.length; i++) rets.push(values[i] / values[i - 1] - 1);

  const retPct = values.map(v => (v / values[0] - 1) * 100);

  let peak = values[0];
  const dd = values.map(v => { peak = Math.max(peak, v); return (v / peak - 1) * 100; });

  const rvol = new Array(values.length).fill(null);
  for (let i = VOL_WINDOW; i < values.length; i++) {
    const w = rets.slice(i - VOL_WINDOW + 1, i + 1).filter(r => r !== null);
    if (w.length < VOL_WINDOW - 1) continue;
    const m = mean(w);
    rvol[i] = stdev(w, m) * Math.sqrt(TRADING_DAYS) * 100;
  }

  const rsharpe = new Array(values.length).fill(null);
  for (let i = SHARPE_WINDOW; i < values.length; i++) {
    const w = rets.slice(i - SHARPE_WINDOW + 1, i + 1).filter(r => r !== null);
    if (w.length < SHARPE_WINDOW - 1) continue;
    const m = mean(w), sd = stdev(w, m);
    rsharpe[i] = sd > 0 ? (m / sd) * Math.sqrt(TRADING_DAYS) : null;
  }

  return { dates, values, retPct, dd, rvol, rsharpe };
}

function buildFundAndAssetSeries() {
  const inception = FUNDO.inception_date;
  // Use EWZ's date list as the calendar backbone (all 3 ETFs trade the same US sessions).
  const baseDates = ETF.assets.EWZ.dates;
  const startIdx = baseDates.findIndex(d => d >= inception);
  const dates = baseDates.slice(startIdx);

  const closesSince = {};
  ASSET_ORDER.forEach(sym => {
    const a = ETF.assets[sym];
    const idx = a.dates.findIndex(d => d >= inception);
    closesSince[sym] = a.close.slice(idx, idx + dates.length);
    ASSET_SINCE[sym] = computeSeries(dates, closesSince[sym]);
  });

  const nav = dates.map((_, i) => ASSET_ORDER.reduce((sum, sym) => sum + SHARES[sym] * closesSince[sym][i], 0));
  FUND_SERIES = computeSeries(dates, nav);
  FUND_SERIES.closesSince = closesSince;
  FUND_SERIES.cdiValues = buildCdiSeries(dates);
}

// CDI (Brazilian interbank rate, from data/etf_data.json's "cdi" field -
// fetched server-side from the Banco Central SGS API, series 12, not Yahoo
// Finance: CDI is a daily rate, not a traded price series) compounded into
// an index and forward-filled onto the fund's trading-day calendar, so it
// can be sliced/rebased with the exact same sliceForRange() used for the
// fund and the assets.
function buildCdiSeries(fundDates) {
  const inception = FUNDO.inception_date;
  const cdi = ETF.cdi || { dates: [], daily_rate_pct: [] };
  const cumByDate = {};
  let cum = 100;
  cumByDate[inception] = cum;
  for (let i = 0; i < cdi.dates.length; i++) {
    const d = cdi.dates[i];
    if (d <= inception) continue;
    cum *= 1 + cdi.daily_rate_pct[i] / 100;
    cumByDate[d] = cum;
  }
  const sortedCdiDates = Object.keys(cumByDate).sort();
  let ptr = 0;
  return fundDates.map(fd => {
    while (ptr + 1 < sortedCdiDates.length && sortedCdiDates[ptr + 1] <= fd) ptr++;
    return cumByDate[sortedCdiDates[ptr]];
  });
}

function computeShares() {
  ASSET_ORDER.forEach(sym => {
    const p = FUNDO.positions[sym];
    SHARES[sym] = (FUNDO.capital * p.weight) / p.entry_price;
  });
}

// Sharpe coloring per spec: green > 1.0, yellow 0-1.0, red < 0.
function sharpeClass(value) {
  if (value === null || value === undefined) return "mval-muted";
  if (value > 1) return "mval-good";
  if (value >= 0) return "mval-warning";
  return "mval-critical";
}

function insufficientNote(windowDays, available) {
  return available >= windowDays
    ? null
    : `aguardando historico (${available}/${windowDays} pregoes)`;
}

function renderShell() {
  const s = FUNDO;
  const lastIdx = FUND_SERIES.values.length - 1;
  const navNow = FUND_SERIES.values[lastIdx];
  const retNow = FUND_SERIES.retPct[lastIdx];
  const sharpeNow = FUND_SERIES.rsharpe[lastIdx];
  const volNow = FUND_SERIES.rvol[lastIdx];
  const maxDD = Math.min(...FUND_SERIES.dd);
  const nDays = FUND_SERIES.dates.length;

  document.getElementById("fundo-root").innerHTML = `
    <div class="fund-header">
      <h1>${s.fund_name}</h1>
      <div class="sub">${s.subtitle}</div>
      <div class="meta">Capital: ${fmtMoney(s.capital)} &middot; Horizonte: ${s.horizon_label} &middot; Inicio: ${fmtDateLong(s.inception_date)}</div>
    </div>

    <div class="stats-row">
      <div class="stat"><div class="label">Retorno acumulado</div><div class="value num ${retNow >= 0 ? 'mval-good' : 'mval-critical'}">${fmtPct(retNow)}</div><div class="note">desde ${fmtDateShort(s.inception_date)}</div></div>
      <div class="stat"><div class="label">Valor do fundo</div><div class="value num">${fmtMoney(navNow)}</div><div class="note">capital inicial: ${fmtMoney(s.capital)}</div></div>
      <div class="stat"><div class="label">Sharpe (63d)</div><div class="value num ${sharpeClass(sharpeNow)}">${sharpeNow === null ? '—' : fmtNum(sharpeNow)}</div><div class="note">${insufficientNote(SHARPE_WINDOW, nDays) || 'rf assumido = 0%'}</div></div>
      <div class="stat"><div class="label">Volatilidade (21d)</div><div class="value num">${volNow === null ? '—' : fmtNum(volNow) + '%'}</div><div class="note">${insufficientNote(VOL_WINDOW, nDays) || 'anualizada'}</div></div>
      <div class="stat"><div class="label">Drawdown maximo</div><div class="value num mval-critical">${fmtNum(maxDD)}%</div><div class="note">desde a entrada</div></div>
    </div>

    <div class="section-title">Alocacao</div>
    <div class="alloc-grid">
      <div class="alloc-chart-card"><div class="canvas-wrap"><canvas id="chart-alloc"></canvas></div></div>
      <div class="table-card">
        <table class="data-table" id="alloc-table"><thead><tr>
          <th>Ativo</th><th>Peso</th><th>Capital investido</th><th>Valor atual</th><th>Ganho/Perda</th><th>% Retorno</th>
        </tr></thead><tbody></tbody></table>
      </div>
    </div>

    <div class="section-title">Performance</div>
    <div class="range-row" id="range-fundo"></div>
    <div class="chart-card">
      <h3>Retorno acumulado (%)</h3>
      <div class="desc">Fundo (ponderado) vs. cada ativo isoladamente, desde ${fmtDateShort(s.inception_date)}</div>
      <div class="canvas-wrap" style="height:300px"><canvas id="chart-perf"></canvas></div>
      <div class="legend-row" id="perf-legend"></div>
    </div>

    <div class="section-title">Metricas detalhadas</div>
    <div class="table-card">
      <table class="data-table" id="metrics-table"><thead><tr>
        <th>&nbsp;</th><th>Sharpe (63d)</th><th>Volatilidade (21d)</th><th>Drawdown maximo</th>
      </tr></thead><tbody></tbody></table>
    </div>

    <div class="section-title">Historico de posicoes</div>
    <div class="table-card">
      <table class="data-table" id="positions-table"><thead><tr>
        <th>Data entrada</th><th>Ativo</th><th>Preco entrada</th><th>Preco atual</th><th>Capital</th><th>Valor atual</th><th>Ganho/Perda</th><th>Duracao</th>
      </tr></thead><tbody></tbody></table>
    </div>

    <div class="section-title">Analise macro</div>
    <div class="thesis">
      <h2>Leitura do fundo</h2>
      <div class="meta">Ainda sem leitura publicada &middot; sera preenchida apos a primeira analise</div>
      <div class="empty-state-card">Esta secao vai reunir a leitura macro consolidada do fundo (guerra, eleicoes, fiscal, IA e como isso conecta com EWZ/EEM/FXE). Ainda nao foi escrita.</div>
    </div>

    <footer>
      Fundo simulado, sem rebalanceamento automatico: as cotas de cada ativo foram fixadas na entrada (${fmtDateLong(s.inception_date)}) e os pesos exibidos sao os pesos atuais, que driftam com o preco.
      Sharpe e volatilidade rolantes usam a mesma metodologia da aba Radar Macro (janelas de 21/63 pregoes, anualizadas, rf = 0%), calculadas desde a entrada do fundo - por isso ficam indisponiveis
      ("aguardando historico") ate acumular pregoes suficientes. Capital e precos tratados na mesma unidade monetaria, sem conversao cambial. Nao constitui recomendacao de investimento.
    </footer>
  `;
}

function renderAllocTable() {
  const lastIdx = FUND_SERIES.values.length - 1;
  const navNow = FUND_SERIES.values[lastIdx];
  const tbody = document.querySelector("#alloc-table tbody");
  tbody.innerHTML = ASSET_ORDER.map(sym => {
    const p = FUNDO.positions[sym];
    const capitalInvestido = FUNDO.capital * p.weight;
    const priceNow = FUND_SERIES.closesSince[sym][lastIdx];
    const valorAtual = SHARES[sym] * priceNow;
    const ganho = valorAtual - capitalInvestido;
    const retPct = (valorAtual / capitalInvestido - 1) * 100;
    const pesoAtual = (valorAtual / navNow) * 100;
    const cls = ganho >= 0 ? "mval-good" : "mval-critical";
    return `<tr>
      <td><span class="asset-dot" style="background:var(${ASSET_ACCENT_VAR[sym]})"></span>${sym}</td>
      <td>${fmtNum(pesoAtual, 1)}%</td>
      <td>${fmtMoney(capitalInvestido)}</td>
      <td>${fmtMoney(valorAtual)}</td>
      <td class="${cls}">${ganho >= 0 ? "+" : ""}${fmtMoney(ganho)}</td>
      <td class="${cls}">${fmtPct(retPct)}</td>
    </tr>`;
  }).join("");
}

function renderMetricsTable() {
  const nDays = FUND_SERIES.dates.length;
  const row = (label, series, accentVar) => {
    const sharpeNow = series.rsharpe[series.rsharpe.length - 1];
    const volNow = series.rvol[series.rvol.length - 1];
    const maxDD = Math.min(...series.dd);
    const dot = accentVar ? `<span class="asset-dot" style="background:var(${accentVar})"></span>` : `<span class="asset-dot" style="background:${cssVar('--text-primary')}"></span>`;
    return `<tr>
      <td>${dot}${label}</td>
      <td class="${sharpeClass(sharpeNow)}">${sharpeNow === null ? insufficientNote(SHARPE_WINDOW, nDays) : fmtNum(sharpeNow)}</td>
      <td>${volNow === null ? insufficientNote(VOL_WINDOW, nDays) : fmtNum(volNow) + '%'}</td>
      <td class="mval-critical">${fmtNum(maxDD)}%</td>
    </tr>`;
  };
  const tbody = document.querySelector("#metrics-table tbody");
  tbody.innerHTML = row("Fundo", FUND_SERIES, null) + ASSET_ORDER.map(sym => row(sym, ASSET_SINCE[sym], ASSET_ACCENT_VAR[sym])).join("");
}

function renderPositionsTable() {
  const lastIdx = FUND_SERIES.values.length - 1;
  const nDays = FUND_SERIES.dates.length;
  const tbody = document.querySelector("#positions-table tbody");
  tbody.innerHTML = ASSET_ORDER.map(sym => {
    const p = FUNDO.positions[sym];
    const capitalInvestido = FUNDO.capital * p.weight;
    const priceNow = FUND_SERIES.closesSince[sym][lastIdx];
    const valorAtual = SHARES[sym] * priceNow;
    const ganho = valorAtual - capitalInvestido;
    const cls = ganho >= 0 ? "mval-good" : "mval-critical";
    return `<tr>
      <td>${fmtDateShort(FUNDO.inception_date)}</td>
      <td><span class="asset-dot" style="background:var(${ASSET_ACCENT_VAR[sym]})"></span>${sym}</td>
      <td>$${fmtNum(p.entry_price)}</td>
      <td>$${fmtNum(priceNow)}</td>
      <td>${fmtMoney(capitalInvestido)}</td>
      <td>${fmtMoney(valorAtual)}</td>
      <td class="${cls}">${ganho >= 0 ? "+" : ""}${fmtMoney(ganho)}</td>
      <td>${nDays} pregao${nDays === 1 ? "" : "es"}</td>
    </tr>`;
  }).join("");
}

function renderAllocChart() {
  const lastIdx = FUND_SERIES.values.length - 1;
  const navNow = FUND_SERIES.values[lastIdx];
  const weights = ASSET_ORDER.map(sym => (SHARES[sym] * FUND_SERIES.closesSince[sym][lastIdx] / navNow) * 100);
  const colors = ASSET_ORDER.map(sym => cssVar(ASSET_ACCENT_VAR[sym]));

  if (charts.alloc) charts.alloc.destroy();
  charts.alloc = new Chart(document.getElementById("chart-alloc").getContext("2d"), {
    type: "doughnut",
    data: { labels: ASSET_ORDER, datasets: [{ data: weights, backgroundColor: colors, borderColor: cssVar("--surface"), borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar("--surface"), titleColor: cssVar("--text-primary"), bodyColor: cssVar("--text-secondary"),
          borderColor: cssVar("--border-strong"), borderWidth: 1,
          callbacks: { label: ctx => `${ctx.label}: ${ctx.parsed.toFixed(1)}%` },
        },
      },
      cutout: "62%",
    },
  });

  document.getElementById("perf-legend").innerHTML = ""; // legend lives under the alloc chart instead
  const legendHost = document.querySelector(".alloc-chart-card");
  let legend = legendHost.querySelector(".legend-row");
  if (!legend) {
    legend = document.createElement("div");
    legend.className = "legend-row";
    legendHost.appendChild(legend);
  }
  legend.innerHTML = ASSET_ORDER.map((sym, i) => `<div class="legend-item"><span class="legend-dot" style="background:${colors[i]}"></span>${sym} ${weights[i].toFixed(1)}%</div>`).join("");
}

// Percent return re-based to the start of the *visible* window (not since
// inception) - e.g. the 1M view shows the last 21 days' own return, not a
// slice of the since-inception curve.
function sliceForRange(series, range) {
  const n = series.dates.length;
  const start = range.days ? Math.max(0, n - range.days) : 0;
  const base = series.values[start];
  return {
    dates: series.dates.slice(start),
    values: series.values.slice(start).map(v => (v / base - 1) * 100),
  };
}

function computeIntradayFundReturn() {
  // Weighted intraday return using each asset's own intraday series from etf_data.json.
  const anyTimes = ETF.assets.EWZ.intraday?.times || [];
  const n = anyTimes.length;
  if (!n) return { times: [], fundRet: [], assetRet: { EWZ: [], FXE: [], EEM: [] } };
  const prevClose = {};
  ASSET_ORDER.forEach(sym => {
    const c = ETF.assets[sym].close;
    prevClose[sym] = c[c.length - 2];
  });
  const assetRet = {};
  ASSET_ORDER.forEach(sym => {
    const intraClose = ETF.assets[sym].intraday.close;
    assetRet[sym] = intraClose.map(c => (c / prevClose[sym] - 1) * 100);
  });
  const prevNav = ASSET_ORDER.reduce((sum, sym) => sum + SHARES[sym] * prevClose[sym], 0);
  const fundRet = anyTimes.map((_, i) => {
    const navAtI = ASSET_ORDER.reduce((sum, sym) => sum + SHARES[sym] * (ETF.assets[sym].intraday.close[i] ?? prevClose[sym]), 0);
    return (navAtI / prevNav - 1) * 100;
  });
  return { times: anyTimes, fundRet, assetRet };
}

function renderPerfChart(range) {
  const isIntraday = !!range.intraday;
  let labels, fundData, assetData = {}, cdiData = null;

  if (isIntraday) {
    // CDI is a once-a-day published rate, not intraday-quoted - no meaningful
    // 1D line for it, so it's omitted rather than faked as flat.
    const id = computeIntradayFundReturn();
    labels = id.times;
    fundData = id.fundRet;
    ASSET_ORDER.forEach(sym => { assetData[sym] = id.assetRet[sym]; });
  } else {
    const sl = sliceForRange(FUND_SERIES, range);
    labels = sl.dates.map(fmtDateShort);
    fundData = sl.values;
    ASSET_ORDER.forEach(sym => {
      assetData[sym] = sliceForRange(ASSET_SINCE[sym], range).values;
    });
    cdiData = sliceForRange({ dates: FUND_SERIES.dates, values: FUND_SERIES.cdiValues }, range).values;
  }

  const datasets = [
    { label: "Fundo", data: fundData, borderColor: cssVar("--text-primary"), backgroundColor: "transparent", borderWidth: 2.5, pointRadius: 0, tension: 0.05 },
    ...ASSET_ORDER.map(sym => ({
      label: sym, data: assetData[sym], borderColor: cssVar(ASSET_ACCENT_VAR[sym]), backgroundColor: "transparent",
      borderWidth: 1.25, pointRadius: 0, tension: 0.05,
    })),
    ...(cdiData ? [{
      label: "CDI", data: cdiData, borderColor: cssVar("--warning"), backgroundColor: "transparent",
      borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0, tension: 0.05,
    }] : []),
  ];

  if (charts.perf) charts.perf.destroy();
  charts.perf = new Chart(document.getElementById("chart-perf").getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar("--surface"), titleColor: cssVar("--text-primary"), bodyColor: cssVar("--text-secondary"),
          borderColor: cssVar("--border-strong"), borderWidth: 1, padding: 8,
          titleFont: { family: "IBM Plex Mono", size: 11 }, bodyFont: { family: "IBM Plex Mono", size: 11 },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: cssVar("--text-muted"), maxTicksLimit: 8, font: { family: "IBM Plex Mono", size: 10 } } },
        y: { grid: { color: cssVar("--grid") }, ticks: { color: cssVar("--text-muted"), font: { family: "IBM Plex Mono", size: 10 }, callback: v => v + "%" } },
      },
    },
  });

  document.getElementById("perf-legend").innerHTML = datasets.map(d =>
    `<div class="legend-item"><span class="legend-dot" style="background:${d.borderColor}"></span>${d.label}</div>`
  ).join("");
}

function buildRangeButtons() {
  const el = document.getElementById("range-fundo");
  RANGES.forEach(r => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "range-btn" + (r.key === DEFAULT_RANGE_KEY ? " active" : "");
    btn.textContent = r.label;
    btn.addEventListener("click", () => {
      el.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderPerfChart(r);
    });
    el.appendChild(btn);
  });
}

async function loadData() {
  const bust = Date.now();
  const [fundoRes, etfRes] = await Promise.all([
    fetch(`data/fundo.json?t=${bust}`, { cache: "no-store" }),
    fetch(`data/etf_data.json?t=${bust}`, { cache: "no-store" }),
  ]);
  if (!fundoRes.ok || !etfRes.ok) throw new Error("Falha ao carregar os dados (fundo.json / etf_data.json).");
  FUNDO = await fundoRes.json();
  ETF = await etfRes.json();
}

async function init() {
  const root = document.getElementById("fundo-root");
  try {
    await loadData();
  } catch (err) {
    root.innerHTML = `<div class="load-error">Nao foi possivel carregar os dados: ${err.message}</div>`;
    return;
  }

  computeShares();
  buildFundAndAssetSeries();
  renderShell();
  renderAllocTable();
  renderMetricsTable();
  renderPositionsTable();
  renderAllocChart();
  buildRangeButtons();
  renderPerfChart(RANGES.find(r => r.key === DEFAULT_RANGE_KEY));
}

init();
