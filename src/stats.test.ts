import { describe, it, expect } from "vitest";
import { linearRegression, projectGoal, rollingMean, summarizeSeries, valueAtDaysAgo } from "./stats";

const DAY = 86_400;
const T0 = 1_780_000_000;

describe("linearRegression", () => {
  it("recovers an exact line (−0.1 kg/day) with r² = 1", () => {
    const points = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * DAY, v: 90 - 0.1 * i }));
    const r = linearRegression(points)!;
    expect(r.slope_per_day).toBeCloseTo(-0.1, 6);
    expect(r.slope_per_week).toBeCloseTo(-0.7, 6);
    expect(r.intercept).toBeCloseTo(90, 6);
    expect(r.r2).toBe(1);
  });

  it("returns undefined for fewer than two points or a single instant", () => {
    expect(linearRegression([])).toBeUndefined();
    expect(linearRegression([{ t: T0, v: 1 }])).toBeUndefined();
    expect(linearRegression([{ t: T0, v: 1 }, { t: T0, v: 2 }])).toBeUndefined();
  });

  it("reports low r² for noise", () => {
    const points = [1, -1, 1, -1, 1, -1].map((v, i) => ({ t: T0 + i * DAY, v: 80 + v }));
    expect(linearRegression(points)!.r2).toBeLessThan(0.2);
  });
});

describe("summarizeSeries", () => {
  it("averages the 7-day edges rather than trusting single readings", () => {
    // 30 days: first week ~90, last week ~88, with a rogue 95 on day 0 and 80 on the last day.
    const points = Array.from({ length: 30 }, (_, i) => ({ t: T0 + i * DAY, v: i < 7 ? 90 : i >= 23 ? 88 : 89 }));
    points[0].v = 95;
    points[29].v = 80;
    const s = summarizeSeries(points)!;
    expect(s.readings).toBe(30);
    expect(s.first).toEqual({ t: T0, v: 95 });
    expect(s.last).toEqual({ t: T0 + 29 * DAY, v: 80 });
    expect(s.min).toBe(80);
    expect(s.max).toBe(95);
    // Edge windows are inclusive of the 7th day: days 0..7 and 22..29.
    expect(s.start_avg).toBeCloseTo((95 + 90 * 6 + 89) / 8, 2);
    expect(s.end_avg).toBeCloseTo((89 + 88 * 6 + 80) / 8, 2);
    expect(s.change).toBeCloseTo(s.end_avg - s.start_avg, 2);
    expect(s.trend!.slope_per_week).toBeLessThan(0);
    expect(s.edge_window_days).toBe(7);
  });

  it("handles a single reading and sorts unsorted input", () => {
    expect(summarizeSeries([])).toBeUndefined();
    const one = summarizeSeries([{ t: T0, v: 80 }])!;
    expect(one).toMatchObject({ readings: 1, start_avg: 80, end_avg: 80, change: 0, change_pct: 0 });
    expect(one.trend).toBeUndefined();
    const s = summarizeSeries([{ t: T0 + DAY, v: 81 }, { t: T0, v: 80 }])!;
    expect(s.first.v).toBe(80);
    expect(s.last.v).toBe(81);
  });
});

describe("rollingMean", () => {
  it("windows by calendar distance so gaps don't stretch it", () => {
    const rows = [
      { date: "2026-06-01", value: 80 },
      { date: "2026-06-02", value: 82 },
      { date: "2026-06-10", value: 90 }, // 8 days later: the earlier rows fall outside a 7-day window
      { date: "2026-06-12", value: 92 },
    ];
    expect(rollingMean(rows, 7).map((r) => r.rolling)).toEqual([80, 81, 90, 91]);
  });
});

describe("valueAtDaysAgo", () => {
  const points = [0, 1, 2, 5, 9, 30].map((d) => ({ t: T0 + d * DAY, v: d }));
  const now = T0 + 30 * DAY;

  it("finds the nearest reading within tolerance", () => {
    expect(valueAtDaysAgo(points, 7, now)).toBeUndefined(); // target day 23: nearest readings (9, 30) are > 3.5 days away
    expect(valueAtDaysAgo(points, 21, now)?.v).toBe(9); // target day 9 exactly
    expect(valueAtDaysAgo(points, 24, now)?.v).toBe(5); // target day 6, day 5 is 1 day off
    expect(valueAtDaysAgo(points, 30, now)?.v).toBe(0);
  });

  it("returns undefined when nothing is within tolerance", () => {
    expect(valueAtDaysAgo(points, 15, now)).toBeUndefined(); // target day 15; nearest is day 9 (6 days off)
    expect(valueAtDaysAgo([], 7, now)).toBeUndefined();
  });
});

describe("projectGoal", () => {
  it("projects weeks and a date when moving toward the goal", () => {
    const p = projectGoal(88, 82, -0.5, T0);
    expect(p).toMatchObject({ remaining: -6, weeks_to_goal: 12, on_track: true });
    expect(p.projected_date).toBe(new Date((T0 + 12 * 7 * DAY) * 1000).toISOString().slice(0, 10));
  });

  it("flags moving away or flat, and an already-met goal", () => {
    expect(projectGoal(88, 82, 0.3, T0)).toEqual({ remaining: -6, on_track: false });
    expect(projectGoal(88, 82, 0, T0)).toEqual({ remaining: -6, on_track: false });
    expect(projectGoal(88, 82, undefined, T0)).toEqual({ remaining: -6, on_track: false });
    expect(projectGoal(82, 82, -0.5, T0)).toEqual({ remaining: 0, weeks_to_goal: 0, on_track: true });
    expect(projectGoal(70, 75, 0.25, T0)).toMatchObject({ remaining: 5, weeks_to_goal: 20, on_track: true });
  });
});
