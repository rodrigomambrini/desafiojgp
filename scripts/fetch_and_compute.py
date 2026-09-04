"""
Fetches daily price history for the dashboard's ETFs from Yahoo Finance and
computes performance, drawdown, rolling volatility and rolling Sharpe series,
plus historical percentile bands used by js/interpretations.js.

Writes data/etf_data.json, fetched at runtime by the GitHub Pages site
(js/app.js) and also read by site/build_site.py to build the Claude Artifact
version (which has to embed the JSON inline - its CSP blocks client fetches).

Run this any time to refresh prices; the GitHub Actions workflow
(.github/workflows/update-prices.yml) calls it on a schedule.
"""
import json
import math
import os
import urllib.request
import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

ASSETS = {
    "EWZ": "iShares MSCI Brazil ETF",
    "EEM": "iShares MSCI Emerging Markets ETF",
    "FXE": "Invesco CurrencyShares Euro Trust",
}

VOL_WINDOW = 21    # ~1 trading month
SHARPE_WINDOW = 63  # ~1 trading quarter
TRADING_DAYS = 252
YEARS_TO_KEEP = 6   # keep enough history for a 5y view plus rolling-window warmup


def fetch_daily(symbol):
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?period1=0&period2=9999999999&interval=1d&events=history"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.load(resp)
    result = payload["chart"]["result"][0]
    ts = result["timestamp"]
    quote = result["indicators"]["quote"][0]
    rows = []
    for i in range(len(ts)):
        c = quote["close"][i]
        if c is None:
            continue
        d = datetime.datetime.utcfromtimestamp(ts[i]).date()
        rows.append((d, c))
    rows.sort(key=lambda r: r[0])
    # dedupe same-day duplicates (keep last)
    dedup = {}
    for d, c in rows:
        dedup[d] = c
    rows = sorted(dedup.items())
    return rows


def compute_series(rows):
    dates = [d.isoformat() for d, _ in rows]
    closes = [c for _, c in rows]

    rets = [None]
    for i in range(1, len(closes)):
        rets.append(closes[i] / closes[i - 1] - 1)

    # cumulative performance indexed to 100 at the first point kept
    perf = [100.0]
    for i in range(1, len(closes)):
        perf.append(perf[-1] * (1 + rets[i]))

    # drawdown: % below running peak of the close price
    peak = closes[0]
    drawdown = []
    for c in closes:
        peak = max(peak, c)
        drawdown.append((c / peak - 1) * 100)
    max_dd = min(drawdown)
    max_dd_idx = drawdown.index(max_dd)
    max_dd_date = dates[max_dd_idx]

    # rolling annualized volatility (%) over VOL_WINDOW trading days
    roll_vol = [None] * len(closes)
    for i in range(VOL_WINDOW, len(closes)):
        window = [r for r in rets[i - VOL_WINDOW + 1: i + 1] if r is not None]
        if len(window) < VOL_WINDOW - 1:
            continue
        mean = sum(window) / len(window)
        var = sum((r - mean) ** 2 for r in window) / (len(window) - 1)
        roll_vol[i] = math.sqrt(var) * math.sqrt(TRADING_DAYS) * 100

    # rolling annualized Sharpe (rf = 0) over SHARPE_WINDOW trading days
    roll_sharpe = [None] * len(closes)
    for i in range(SHARPE_WINDOW, len(closes)):
        window = [r for r in rets[i - SHARPE_WINDOW + 1: i + 1] if r is not None]
        if len(window) < SHARPE_WINDOW - 1:
            continue
        mean = sum(window) / len(window)
        var = sum((r - mean) ** 2 for r in window) / (len(window) - 1)
        sd = math.sqrt(var)
        roll_sharpe[i] = (mean / sd) * math.sqrt(TRADING_DAYS) if sd > 0 else None

    last_close = closes[-1]
    prev_close = closes[-2] if len(closes) > 1 else last_close
    day_change_pct = (last_close / prev_close - 1) * 100

    vol_valid = [v for v in roll_vol if v is not None]
    sharpe_valid = [s for s in roll_sharpe if s is not None]
    latest_vol = vol_valid[-1] if vol_valid else None
    latest_sharpe = sharpe_valid[-1] if sharpe_valid else None
    vol_1w_ago = vol_valid[-6] if len(vol_valid) >= 6 else None
    sharpe_1w_ago = sharpe_valid[-6] if len(sharpe_valid) >= 6 else None

    # current drawdown (how far below the all-time peak of this window we sit today)
    current_dd = drawdown[-1]
    # recovery from the worst drawdown's trough back to today's price
    trough_close = closes[max_dd_idx]
    recovery_from_trough_pct = (last_close / trough_close - 1) * 100

    return {
        "dates": dates,
        "close": [round(c, 4) for c in closes],
        "perf_index": [round(p, 4) for p in perf],
        "drawdown_pct": [round(d, 4) for d in drawdown],
        "rolling_vol_pct": [None if v is None else round(v, 4) for v in roll_vol],
        "rolling_sharpe": [None if s is None else round(s, 4) for s in roll_sharpe],
        "bands": {
            "vol": percentile_band(vol_valid),
            "sharpe": percentile_band(sharpe_valid),
        },
        "stats": {
            "last_close": round(last_close, 2),
            "day_change_pct": round(day_change_pct, 4),
            "max_drawdown_pct": round(max_dd, 2),
            "max_drawdown_date": max_dd_date,
            "current_drawdown_pct": round(current_dd, 2),
            "recovery_from_trough_pct": round(recovery_from_trough_pct, 2),
            "latest_rolling_vol_pct": None if latest_vol is None else round(latest_vol, 2),
            "latest_rolling_sharpe": None if latest_sharpe is None else round(latest_sharpe, 2),
            "rolling_vol_1w_ago_pct": None if vol_1w_ago is None else round(vol_1w_ago, 2),
            "rolling_sharpe_1w_ago": None if sharpe_1w_ago is None else round(sharpe_1w_ago, 2),
        },
    }


def fetch_intraday(symbol):
    """5-minute bars for the most recent trading session (Yahoo's `range=1d`
    returns the latest available session even outside market hours / on
    weekends). Used only for the 1D view - rolling vol/Sharpe stay daily.

    Times are kept in UTC (not the exchange's local time) to match the
    "atualizado em ... UTC" timestamp shown in the page header - otherwise
    the chart looks hours "behind" to a visitor outside US Eastern time.
    """
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?range=1d&interval=5m"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.load(resp)
    result = payload["chart"]["result"][0]
    ts = result["timestamp"]
    quote = result["indicators"]["quote"][0]
    times, closes = [], []
    for i in range(len(ts)):
        c = quote["close"][i]
        if c is None:
            continue
        utc_dt = datetime.datetime.utcfromtimestamp(ts[i])
        times.append(utc_dt.strftime("%H:%M"))
        closes.append(round(c, 4))
    return {"times": times, "close": closes}


def percentile(sorted_vals, pct):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * pct
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return sorted_vals[int(k)]
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


def percentile_band(values):
    if not values:
        return {"p10": None, "p25": None, "p50": None, "p75": None, "p90": None}
    s = sorted(values)
    return {
        "p10": round(percentile(s, 0.10), 4),
        "p25": round(percentile(s, 0.25), 4),
        "p50": round(percentile(s, 0.50), 4),
        "p75": round(percentile(s, 0.75), 4),
        "p90": round(percentile(s, 0.90), 4),
    }


def main():
    cutoff = datetime.date.today() - datetime.timedelta(days=int(365.25 * YEARS_TO_KEEP))
    out = {
        "generated_at_utc": datetime.datetime.utcnow().isoformat() + "Z",
        "vol_window_days": VOL_WINDOW,
        "sharpe_window_days": SHARPE_WINDOW,
        "assets": {},
    }
    for symbol, name in ASSETS.items():
        rows = fetch_daily(symbol)
        rows = [(d, c) for d, c in rows if d >= cutoff]
        series = compute_series(rows)
        series["name"] = name
        try:
            series["intraday"] = fetch_intraday(symbol)
        except Exception as exc:  # intraday is a nice-to-have; never fail the whole run over it
            print(f"{symbol}: intraday fetch failed ({exc}), skipping")
            series["intraday"] = {"times": [], "close": []}
        out["assets"][symbol] = series
        print(f"{symbol}: {len(rows)} daily rows, {len(series['intraday']['times'])} intraday points, last close {series['stats']['last_close']}")

    out_path = os.path.join(DATA_DIR, "etf_data.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print("wrote", out_path)


if __name__ == "__main__":
    main()
