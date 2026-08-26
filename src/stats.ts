/**
 * Small, pure statistics used by the trend tools. Everything takes
 * `{ t: unixSeconds, v: value }` points so it can be tested without any API.
 */

export interface Point {
  /** Unix seconds. */
  t: number;
  v: number;
}

const DAY = 86_400;

const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

export function mean(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface Regression {
  /** Change in value per day. */
  slope_per_day: number;
  slope_per_week: number;
  intercept: number;
  /** Coefficient of determination, 0–1; low = noisy/no trend. */
  r2: number;
}

/** Ordinary least squares of value against time (in days). */
export function linearRegression(points: Point[]): Regression | undefined {
  if (points.length < 2) return undefined;
  const t0 = points[0].t;
  const xs = points.map((p) => (p.t - t0) / DAY);
  const ys = points.map((p) => p.v);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return undefined; // all points at the same instant
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return {
    slope_per_day: round(slope, 4),
    slope_per_week: round(slope * 7, 3),
    intercept: round(intercept, 3),
    r2: round(Math.max(0, Math.min(1, r2)), 3),
  };
}

export interface MetricSummary {
  readings: number;
  first: { t: number; v: number };
  last: { t: number; v: number };
  min: number;
  max: number;
  mean: number;
  /** Mean of readings in the first `edge_window_days` of the window. */
  start_avg: number;
  /** Mean of readings in the last `edge_window_days` of the window. */
  end_avg: number;
  /** end_avg − start_avg. */
  change: number;
  change_pct: number;
  trend?: Regression;
  edge_window_days: number;
}

/**
 * Summarise a series. Start/end are averaged over a window (default 7 days)
 * at each edge so a single noisy weigh-in doesn't define the "change".
 */
export function summarizeSeries(points: Point[], edgeWindowDays = 7): MetricSummary | undefined {
  if (!points.length) return undefined;
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const values = sorted.map((p) => p.v);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const startCut = first.t + edgeWindowDays * DAY;
  const endCut = last.t - edgeWindowDays * DAY;
  const startAvg = mean(sorted.filter((p) => p.t <= startCut).map((p) => p.v)) ?? first.v;
  const endAvg = mean(sorted.filter((p) => p.t >= endCut).map((p) => p.v)) ?? last.v;
  const change = endAvg - startAvg;
  return {
    readings: sorted.length,
    first: { t: first.t, v: first.v },
    last: { t: last.t, v: last.v },
    min: Math.min(...values),
    max: Math.max(...values),
    mean: round(mean(values)!, 2),
    start_avg: round(startAvg, 2),
    end_avg: round(endAvg, 2),
    change: round(change, 2),
    change_pct: startAvg === 0 ? 0 : round((change / startAvg) * 100, 2),
    trend: linearRegression(sorted),
    edge_window_days: edgeWindowDays,
  };
}

/**
 * Trailing rolling mean over a daily series (by calendar-day distance, not by
 * row count, so gaps don't stretch the window). Input must be ascending by
 * date; returns the same rows with `rolling` attached.
 */
export function rollingMean<T extends { date: string; value: number }>(
  rows: T[],
  windowDays = 7,
): Array<T & { rolling: number }> {
  const dayIndex = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / (DAY * 1000));
  return rows.map((row, i) => {
    const cutoff = dayIndex(row.date) - (windowDays - 1);
    const window: number[] = [];
    for (let j = i; j >= 0 && dayIndex(rows[j].date) >= cutoff; j--) window.push(rows[j].value);
    return { ...row, rolling: round(mean(window)!, 2) };
  });
}

/**
 * The reading closest to `daysAgo` days before `nowSec`, provided one exists
 * within ±`toleranceDays`. Used for "vs 30 days ago" style deltas.
 */
export function valueAtDaysAgo(
  points: Point[],
  daysAgo: number,
  nowSec: number,
  toleranceDays = 3.5,
): Point | undefined {
  const target = nowSec - daysAgo * DAY;
  let best: Point | undefined;
  let bestDist = Infinity;
  for (const p of points) {
    const dist = Math.abs(p.t - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return best && bestDist <= toleranceDays * DAY ? best : undefined;
}

export interface GoalProjection {
  remaining: number;
  /** Weeks until the goal is reached at the current rate; absent if moving away or flat. */
  weeks_to_goal?: number;
  projected_date?: string;
  on_track: boolean;
}

/** Project when a goal is reached given the current weekly rate of change. */
export function projectGoal(
  current: number,
  goal: number,
  slopePerWeek: number | undefined,
  nowSec: number,
): GoalProjection {
  const remaining = round(goal - current, 2);
  if (remaining === 0) return { remaining, weeks_to_goal: 0, on_track: true };
  if (slopePerWeek === undefined || slopePerWeek === 0 || Math.sign(slopePerWeek) !== Math.sign(remaining)) {
    return { remaining, on_track: false };
  }
  const weeks = remaining / slopePerWeek;
  const projected = new Date((nowSec + weeks * 7 * DAY) * 1000);
  return {
    remaining,
    weeks_to_goal: round(weeks, 1),
    projected_date: projected.toISOString().slice(0, 10),
    on_track: true,
  };
}
