/*
 * Turns the raw numbers in data/etf_data.json into the 3 "insight" boxes shown
 * under the stat tiles: Sharpe rolante, Drawdown, Volatilidade rolante.
 *
 * Historical context comes from percentile bands (bands.sharpe / bands.vol)
 * computed by scripts/fetch_and_compute.py over the asset's own full loaded
 * history (p10/p25/p50/p75/p90) - not hardcoded guesses - so the "normal
 * range" a reader sees is this specific ETF's own real distribution.
 */

function fmtSigned(v, digits = 2) {
  if (v === null || v === undefined) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(digits);
}

function fmtDateShort(iso) {
  const [y, m, d] = iso.split("-");
  return d + "/" + m + "/" + y.slice(2);
}

// status: 'good' | 'neutral' | 'warning' | 'critical'
function classifyByBand(value, band, higherIsBetter) {
  if (value === null || value === undefined || !band || band.p25 === null) return "neutral";
  if (higherIsBetter) {
    if (value >= band.p75) return "good";
    if (value <= band.p25) return "critical";
    return "neutral";
  }
  if (value <= band.p25) return "good";
  if (value >= band.p75) return "warning";
  return "neutral";
}

function bandLabel(status) {
  return { good: "acima do normal", neutral: "dentro do normal", warning: "acima do normal", critical: "abaixo do normal" }[status] || "dentro do normal";
}

function rankAmong(allStats, sym, key, higherIsBetter) {
  const entries = Object.entries(allStats)
    .filter(([, s]) => s[key] !== null && s[key] !== undefined)
    .sort((a, b) => higherIsBetter ? b[1][key] - a[1][key] : a[1][key] - b[1][key]);
  const idx = entries.findIndex(([s]) => s === sym);
  return { rank: idx + 1, total: entries.length, order: entries.map(([s]) => s) };
}

function interpretSharpe(sym, asset, allAssets) {
  const s = asset.stats;
  const band = asset.bands.sharpe;
  const status = classifyByBand(s.latest_rolling_sharpe, band, true);
  const wowDelta = (s.latest_rolling_sharpe !== null && s.rolling_sharpe_1w_ago !== null)
    ? s.latest_rolling_sharpe - s.rolling_sharpe_1w_ago : null;
  const allStats = Object.fromEntries(Object.entries(allAssets).map(([k, v]) => [k, v.stats]));
  const peer = rankAmong(allStats, sym, "latest_rolling_sharpe", true);

  const lines = [];
  lines.push(`Sharpe atual de ${fmtSigned(s.latest_rolling_sharpe)} está ${bandLabel(status)} para ${sym} (mediana histórica: ${fmtSigned(band.p50)}; faixa p25-p75: ${fmtSigned(band.p25)} a ${fmtSigned(band.p75)}).`);
  if (wowDelta !== null) {
    const dir = wowDelta > 0.05 ? "subiu" : wowDelta < -0.05 ? "caiu" : "estável";
    lines.push(`Na última semana o indicador ${dir} (${fmtSigned(wowDelta)} vs. ${fmtSigned(s.rolling_sharpe_1w_ago)}).${peer.total > 1 ? ` Hoje é o ${peer.rank}º de ${peer.total} entre os ativos acompanhados (ordem: ${peer.order.join(" > ")}).` : ""}`);
  }
  return { status, title: "Sharpe rolante (63d)", lines };
}

function interpretVol(sym, asset, allAssets) {
  const s = asset.stats;
  const band = asset.bands.vol;
  const status = classifyByBand(s.latest_rolling_vol_pct, band, false);
  const wowDelta = (s.latest_rolling_vol_pct !== null && s.rolling_vol_1w_ago_pct !== null)
    ? s.latest_rolling_vol_pct - s.rolling_vol_1w_ago_pct : null;
  const vsWeekLabel = wowDelta === null ? null : wowDelta > 1 ? "subindo" : wowDelta < -1 ? "recuando" : "estável";

  const lines = [];
  const bandWord = status === "good" ? "baixa" : status === "warning" ? "elevada" : "normal";
  lines.push(`Volatilidade anualizada de ${s.latest_rolling_vol_pct?.toFixed(1)}% está ${bandWord} para ${sym} (mediana histórica: ${band.p50?.toFixed(1)}%; faixa p25-p75: ${band.p25?.toFixed(1)}% a ${band.p75?.toFixed(1)}%).`);
  if (vsWeekLabel) {
    lines.push(`Está ${vsWeekLabel} na comparação com uma semana atrás (${s.rolling_vol_1w_ago_pct?.toFixed(1)}% → ${s.latest_rolling_vol_pct?.toFixed(1)}%).`);
  }
  return { status, title: "Volatilidade rolante (21d)", lines };
}

function interpretDrawdown(sym, asset) {
  const s = asset.stats;
  const ratio = s.max_drawdown_pct !== 0 ? s.current_drawdown_pct / s.max_drawdown_pct : 0;
  const status = ratio >= 0.7 ? "critical" : ratio >= 0.35 ? "warning" : "good";
  const depthWord = status === "critical" ? "perto do pior momento histórico" : status === "warning" ? "em zona de correção relevante" : "bem acima do fundo histórico";

  const lines = [];
  lines.push(`${sym} está ${s.current_drawdown_pct.toFixed(1)}% abaixo do topo recente — ${depthWord}. O maior drawdown do período carregado foi de ${s.max_drawdown_pct.toFixed(1)}%, em ${fmtDateShort(s.max_drawdown_date)}.`);
  lines.push(`Desde o fundo daquele drawdown, o preço já ${s.recovery_from_trough_pct >= 0 ? "recuperou" : "caiu mais"} ${Math.abs(s.recovery_from_trough_pct).toFixed(1)}%.`);
  return { status, title: "Drawdown", lines };
}

function buildInsights(sym, dashboardData) {
  const asset = dashboardData.assets[sym];
  return [
    interpretSharpe(sym, asset, dashboardData.assets),
    interpretDrawdown(sym, asset),
    interpretVol(sym, asset, dashboardData.assets),
  ];
}
