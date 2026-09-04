/*
 * Radar Macro — renders the dashboard from data/etf_data.json (prices,
 * performance, drawdown, rolling vol/Sharpe — refreshed by the GitHub Actions
 * workflow) and data/thesis.json (the daily "Leitura do mercado" write-up).
 * Both are plain static files fetched same-origin, so this works on GitHub
 * Pages with no API keys or CORS issues.
 */

const ORDER = ["EWZ", "FXE", "EEM"]; // ordered so accent hues sit CVD-safe adjacent (green / blue / magenta)
const ACCENT_VAR = { EWZ: "--accent-ewz", FXE: "--accent-fxe", EEM: "--accent-eem" };
const RANGES = [
  { key: "6m", label: "6M", days: 126 },
  { key: "1y", label: "1A", days: 252 },
  { key: "3y", label: "3A", days: 756 },
  { key: "5y", label: "5A", days: 1260 },
  { key: "max", label: "Max", days: null },
];

let DASHBOARD_DATA = null;
let THESIS_DATA = null;
const charts = {}; // symbol -> {perf, dd, vol, sharpe}

function fmtPct(v, digits = 2) { if (v === null || v === undefined) return "—"; return (v >= 0 ? "+" : "") + v.toFixed(digits) + "%"; }
function fmtNum(v, digits = 2) { if (v === null || v === undefined) return "—"; return v.toFixed(digits); }
function fmtDateShort(iso) { const [y, m, d] = iso.split("-"); return d + "/" + m + "/" + y.slice(2); }
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function computeStatsForRange(asset, days) {
  const n = asset.dates.length;
  const start = days ? Math.max(0, n - days) : 0;
  const dates = asset.dates.slice(start);
  const close = asset.close.slice(start);
  const dd = asset.drawdown_pct.slice(start);
  const rvol = asset.rolling_vol_pct.slice(start);
  const rsharpe = asset.rolling_sharpe.slice(start);
  const base = close[0];
  const perf = close.map(c => (c / base - 1) * 100);
  return { dates, close, perf, dd, rvol, rsharpe };
}

function buildTabs() {
  const tabsEl = document.getElementById("tabs");
  const panelsEl = document.getElementById("panels");
  ORDER.forEach((sym, i) => {
    const a = DASHBOARD_DATA.assets[sym];
    const stats = a.stats;
    const up = stats.day_change_pct >= 0;
    const tab = document.createElement("button");
    tab.className = "tab" + (i === 0 ? " active" : "");
    tab.type = "button";
    tab.style.setProperty("--tab-accent", `var(${ACCENT_VAR[sym]})`);
    tab.dataset.sym = sym;
    tab.innerHTML = `
      <div class="tk"><span class="dot"></span><span class="ticker">${sym}</span></div>
      <div class="name">${a.name}</div>
      <div class="price-row">
        <span class="price num">$${fmtNum(stats.last_close)}</span>
        <span class="pill ${up ? 'up' : 'down'}">${up ? '&#9650;' : '&#9660;'} ${fmtPct(stats.day_change_pct)}</span>
      </div>`;
    tab.addEventListener("click", () => selectTab(sym));
    tabsEl.appendChild(tab);

    const panel = document.createElement("section");
    panel.className = "panel" + (i === 0 ? " active" : "");
    panel.id = "panel-" + sym;
    panel.innerHTML = panelTemplate(sym, a);
    panelsEl.appendChild(panel);
  });
}

function insightBox(insight) {
  return `
    <div class="insight ${insight.status}">
      <div class="ihead"><span class="ititle">${insight.title}</span></div>
      ${insight.lines.map(l => `<p>${l}</p>`).join("")}
    </div>`;
}

function panelTemplate(sym, a) {
  const s = a.stats;
  const insights = buildInsights(sym, DASHBOARD_DATA);
  const thesisAsset = THESIS_DATA.assets[sym] || { paragraphs: [], sources: [] };
  return `
    <div class="stats-row">
      <div class="stat"><div class="label">Ultimo preco</div><div class="value num">$${fmtNum(s.last_close)}</div><div class="note">variacao do dia: ${fmtPct(s.day_change_pct)}</div></div>
      <div class="stat"><div class="label">Drawdown atual</div><div class="value num" style="color:var(--critical-text)">${fmtNum(s.current_drawdown_pct)}%</div><div class="note">maximo: ${fmtNum(s.max_drawdown_pct)}% em ${fmtDateShort(s.max_drawdown_date)}</div></div>
      <div class="stat"><div class="label">Vol. rolante (21d, anualizada)</div><div class="value num">${fmtNum(s.latest_rolling_vol_pct)}%</div><div class="note">janela mais recente</div></div>
      <div class="stat"><div class="label">Sharpe rolante (63d, anualizado)</div><div class="value num">${fmtNum(s.latest_rolling_sharpe)}</div><div class="note">rf assumido = 0%</div></div>
      <div class="stat"><div class="label">Historico carregado</div><div class="value small num">${a.dates.length} pregoes</div><div class="note">desde ${fmtDateShort(a.dates[0])}</div></div>
    </div>

    <div class="insights-row">
      ${insights.map(insightBox).join("")}
    </div>

    <div class="range-row" id="range-${sym}"></div>

    <div class="charts-grid">
      <div class="chart-card">
        <h3>Desempenho (indexado a 100)</h3>
        <div class="desc">Preco de fechamento reindexado ao inicio do periodo selecionado</div>
        <div class="canvas-wrap"><canvas id="chart-perf-${sym}"></canvas></div>
      </div>
      <div class="chart-card">
        <h3>Drawdown</h3>
        <div class="desc">Queda percentual em relacao ao topo do periodo</div>
        <div class="canvas-wrap"><canvas id="chart-dd-${sym}"></canvas></div>
      </div>
      <div class="chart-card">
        <h3>Volatilidade rolante</h3>
        <div class="desc">Desvio-padrao dos retornos diarios, janela de 21 pregoes, anualizada</div>
        <div class="canvas-wrap"><canvas id="chart-vol-${sym}"></canvas></div>
      </div>
      <div class="chart-card">
        <h3>Sharpe rolante</h3>
        <div class="desc">Retorno/risco anualizado, janela de 63 pregoes, rf = 0%</div>
        <div class="canvas-wrap"><canvas id="chart-sharpe-${sym}"></canvas></div>
      </div>
    </div>

    <div class="thesis">
      <h2>Leitura do mercado &mdash; ${sym}</h2>
      <div class="meta">Atualizado em <strong class="ts-thesis">&mdash;</strong> &middot; nao constitui recomendacao de investimento</div>
      ${thesisAsset.paragraphs.map(p => `<p>${p}</p>`).join("")}
      <div class="sources">
        <div class="stitle">Fontes consultadas</div>
        ${thesisAsset.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener">${s.label}</a>`).join("")}
      </div>
    </div>
  `;
}

function selectTab(sym) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.sym === sym));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + sym));
  Object.values(charts[sym] || {}).forEach(c => c && c.resize());
}

function buildRangeButtons(sym) {
  const el = document.getElementById("range-" + sym);
  RANGES.forEach((r) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "range-btn" + (r.key === "3y" ? " active" : "");
    btn.textContent = r.label;
    btn.addEventListener("click", () => {
      el.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderCharts(sym, r.days);
    });
    el.appendChild(btn);
  });
}

function baseLineOptions() {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar("--surface"), titleColor: cssVar("--text-primary"),
        bodyColor: cssVar("--text-secondary"), borderColor: cssVar("--border-strong"), borderWidth: 1,
        padding: 8, titleFont: { family: "IBM Plex Mono", size: 11 }, bodyFont: { family: "IBM Plex Mono", size: 11 },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: cssVar("--text-muted"), maxTicksLimit: 6, font: { family: "IBM Plex Mono", size: 10 } } },
      y: { grid: { color: cssVar("--grid") }, ticks: { color: cssVar("--text-muted"), font: { family: "IBM Plex Mono", size: 10 } } },
    },
  };
}

function renderCharts(sym, days) {
  const a = DASHBOARD_DATA.assets[sym];
  const st = computeStatsForRange(a, days);
  const labels = st.dates.map(fmtDateShort);
  const accent = cssVar(ACCENT_VAR[sym]);
  const good = cssVar("--good"), critical = cssVar("--critical");

  if (!charts[sym]) charts[sym] = {};
  const mk = (key, canvasId, cfg) => {
    if (charts[sym][key]) charts[sym][key].destroy();
    charts[sym][key] = new Chart(document.getElementById(canvasId).getContext("2d"), cfg);
  };

  mk("perf", "chart-perf-" + sym, {
    type: "line",
    data: { labels, datasets: [{ data: st.perf, borderColor: accent, backgroundColor: accent + "22", borderWidth: 1.75, pointRadius: 0, fill: true, tension: 0.05 }] },
    options: baseLineOptions(),
  });

  mk("dd", "chart-dd-" + sym, {
    type: "line",
    data: { labels, datasets: [{ data: st.dd, borderColor: critical, backgroundColor: critical + "22", borderWidth: 1.5, pointRadius: 0, fill: true, tension: 0.05 }] },
    options: baseLineOptions(),
  });

  mk("vol", "chart-vol-" + sym, {
    type: "line",
    data: { labels, datasets: [{ data: st.rvol, borderColor: accent, backgroundColor: "transparent", borderWidth: 1.75, pointRadius: 0, spanGaps: true, tension: 0.05 }] },
    options: baseLineOptions(),
  });

  mk("sharpe", "chart-sharpe-" + sym, {
    type: "line",
    data: {
      labels, datasets: [{
        data: st.rsharpe, borderColor: accent, backgroundColor: "transparent",
        borderWidth: 1.75, pointRadius: 0, spanGaps: true, tension: 0.05,
        segment: { borderColor: ctx => (ctx.p0.parsed.y >= 0 && ctx.p1.parsed.y >= 0) ? good : (ctx.p0.parsed.y < 0 && ctx.p1.parsed.y < 0) ? critical : accent },
      }],
    },
    options: baseLineOptions(),
  });
}

async function loadData() {
  const [dashRes, thesisRes] = await Promise.all([
    fetch("data/etf_data.json", { cache: "no-store" }),
    fetch("data/thesis.json", { cache: "no-store" }),
  ]);
  if (!dashRes.ok || !thesisRes.ok) throw new Error("Falha ao carregar os dados (etf_data.json / thesis.json).");
  DASHBOARD_DATA = await dashRes.json();
  THESIS_DATA = await thesisRes.json();
}

function renderShell() {
  document.getElementById("app-root").innerHTML = `
    <header class="top">
      <div>
        <h1>Radar Macro &mdash; EWZ · FXE · EEM</h1>
        <div class="sub">Desempenho, risco e leitura de mercado dos ativos acompanhados</div>
      </div>
      <div class="updated">
        Precos atualizados em<br><strong id="ts-prices">&mdash;</strong>
      </div>
    </header>
    <nav class="tabs" id="tabs"></nav>
    <div id="panels"></div>
    <footer>
      Fonte de precos: Yahoo Finance (dados diarios de fechamento, nao ajustados por proventos). Volatilidade e Sharpe rolantes calculados sobre retornos diarios,
      janelas de 21 e 63 pregoes (~1 e ~3 meses), anualizados (Sharpe assume taxa livre de risco = 0%). Bandas de "normal" (p25-p75) calculadas sobre o proprio historico
      carregado de cada ativo (ate 6 anos). Atualizado automaticamente por <a href="https://github.com/rodrigomambrini/desafiojgp/actions" target="_blank" rel="noopener">GitHub Actions</a>
      de hora em hora no horario de mercado. Leitura de mercado (texto) atualizada 1x/dia apos o fechamento &mdash; nao constitui recomendacao de investimento.
    </footer>
  `;
}

async function init() {
  const root = document.getElementById("app-root");
  root.innerHTML = '<div class="loading">Carregando dados de mercado…</div>';
  try {
    await loadData();
  } catch (err) {
    root.innerHTML = `<div class="load-error">Nao foi possivel carregar os dados: ${err.message}</div>`;
    return;
  }

  renderShell();
  buildTabs();
  ORDER.forEach(sym => { buildRangeButtons(sym); renderCharts(sym, RANGES[2].days); });
  selectTab(ORDER[0]);

  const priceTs = new Date(DASHBOARD_DATA.generated_at_utc);
  document.getElementById("ts-prices").textContent = priceTs.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) + " (UTC)";
  const thesisTs = new Date(THESIS_DATA.generated_at_utc);
  document.querySelectorAll(".ts-thesis").forEach(el => {
    el.textContent = thesisTs.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) + " (UTC)";
  });
}

init();
