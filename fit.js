// Drying model: w(t) = dry + excess0 * exp(-t / tau)
// t = cumulative hours in the oven, w = gross spool weight (g).
(function (root) {
  function linFit(xs, ys) {
    const n = xs.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    const d = n * sxx - sx * sx;
    if (Math.abs(d) < 1e-12) return null;
    const b = (n * sxy - sx * sy) / d;
    const a = (sy - b * sx) / n;
    let sse = 0;
    for (let i = 0; i < n; i++) { const r = ys[i] - (a + b * xs[i]); sse += r * r; }
    return { a, b, sse };
  }

  function fitForTau(ts, ws, tau) {
    const r = linFit(ts.map(t => Math.exp(-t / tau)), ws);
    return r && { dry: r.a, excess0: r.b, tau, sse: r.sse };
  }

  const TAU_MIN = 0.05, TAU_MAX = 200;

  // Grid search over tau (log-spaced) then golden-section refine.
  function fitDecay(points) {
    if (!points || points.length < 3) return null;
    const ts = points.map(p => p.t), ws = points.map(p => p.w);
    if (Math.max(...ts) <= 0) return null;
    let best = null, bestI = -1;
    const N = 300, grid = [];
    for (let i = 0; i < N; i++) {
      const tau = TAU_MIN * Math.pow(TAU_MAX / TAU_MIN, i / (N - 1));
      grid.push(tau);
      const f = fitForTau(ts, ws, tau);
      if (f && f.excess0 > 0 && (!best || f.sse < best.sse)) { best = f; bestI = i; }
    }
    if (!best) return null;
    let lo = Math.log(grid[Math.max(0, bestI - 1)]), hi = Math.log(grid[Math.min(N - 1, bestI + 1)]);
    const g = (Math.sqrt(5) - 1) / 2;
    const sseAt = lt => { const f = fitForTau(ts, ws, Math.exp(lt)); return f && f.excess0 > 0 ? f.sse : Infinity; };
    let c = hi - g * (hi - lo), d = lo + g * (hi - lo), fc = sseAt(c), fd = sseAt(d);
    for (let k = 0; k < 60; k++) {
      if (fc < fd) { hi = d; d = c; fd = fc; c = hi - g * (hi - lo); fc = sseAt(c); }
      else { lo = c; c = d; fc = fd; d = lo + g * (hi - lo); fd = sseAt(d); }
    }
    const refined = fitForTau(ts, ws, Math.exp((lo + hi) / 2));
    if (refined && refined.excess0 > 0 && refined.sse <= best.sse) best = refined;
    const n = ts.length;
    best.rmse = Math.sqrt(best.sse / n);
    // If tau hits the upper bound, data is still ~linear: asymptote is not yet identifiable.
    best.unreliable = best.tau > TAU_MAX * 0.5 || best.tau > 4 * Math.max(...ts);
    return best;
  }

  const predict = (fit, t) => fit.dry + fit.excess0 * Math.exp(-t / fit.tau);

  // tare = empty spool weight (g). targetPct = target moisture % of dry filament mass.
  function analyze(points, { tare = 0, targetPct = 0.1, scaleRes = 1, intervalMin = 30 } = {}) {
    const out = { n: points.length };
    if (points.length === 0) return out;
    const first = points[0], last = points[points.length - 1];
    out.totalLoss = first.w - last.w;
    out.tNow = last.t;
    if (points.length >= 2) {
      const prev = points[points.length - 2];
      const dt = last.t - prev.t;
      out.lastRate = dt > 0 ? (prev.w - last.w) / dt : null; // g/h
    }
    const fit = fitDecay(points);
    if (!fit) return out;
    out.fit = fit;
    const filamentDry = fit.dry - tare;
    if (filamentDry <= 0) { out.badTare = true; return out; }
    const excessNow = predict(fit, last.t) - fit.dry;
    out.dryWeight = fit.dry;
    out.moistureStartPct = (first.w - fit.dry) / filamentDry * 100;
    out.moistureNowPct = Math.max(0, (last.w - fit.dry) / filamentDry * 100);
    out.moistureFitNowPct = excessNow / filamentDry * 100;
    out.remainingWater = Math.max(0, excessNow);
    out.removedPct = fit.excess0 > 0 ? 100 * (1 - excessNow / fit.excess0) : null;
    out.nextIntervalLoss = excessNow * (1 - Math.exp(-(intervalMin / 60) / fit.tau));
    out.targetWeight = fit.dry + targetPct / 100 * filamentDry;
    const targetExcess = targetPct / 100 * filamentDry;
    out.tTarget = fit.excess0 > targetExcess ? fit.tau * Math.log(fit.excess0 / targetExcess) : 0;
    out.hoursToTarget = Math.max(0, out.tTarget - last.t);
    // Diminishing returns: time when the loss over one weigh interval drops below scale resolution,
    // i.e. the next weigh-in could no longer show any change.
    const intervalFrac = 1 - Math.exp(-(intervalMin / 60) / fit.tau);
    const excessUnmeasurable = scaleRes / intervalFrac;
    out.tMeasurable = fit.excess0 > excessUnmeasurable ? fit.tau * Math.log(fit.excess0 / excessUnmeasurable) : 0;
    out.hoursToMeasurable = Math.max(0, out.tMeasurable - last.t);
    out.reachedTarget = out.moistureFitNowPct <= targetPct;
    out.belowScale = out.nextIntervalLoss < scaleRes;
    return out;
  }

  const api = { fitDecay, predict, analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DryFit = api;
})(this);
