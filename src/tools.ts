/**
 * Coaching-oriented MCP tools. Each answers a question a coach actually asks
 * ("what's my latest reading and how does it compare?", "is my weight
 * trending toward the goal?", "is fat-free mass holding while weight drops?")
 * and returns compact JSON for Claude to reason over alongside Strava /
 * wearable data. Raw Renpho records are shaped by measurements.ts; the
 * arithmetic lives in stats.ts; both are pure and unit-tested.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS, MAX_PAGES_PER_TABLE, PAGE_SIZE, RenphoApiError, RenphoClient, type MeasurementResult, type TableScan } from "./renpho-api";
import { civilRangeToEpochSeconds, isoDaysAgo, localIso, parseIsoDate, todayIso, zonedMidnightMs } from "./dates";
import {
  METRIC_KEYS,
  aggregateDaily,
  aggregateWeekly,
  classify,
  deviceKey,
  normalizeMeasurement,
  normalizeProfile,
  pickMetrics,
  summarizeDevices,
  summarizeExtraFields,
  type MetricKey,
  type NormalizedMeasurement,
  type Profile,
} from "./measurements";
import { parseRenphoJson } from "./json";
import { linearRegression, projectGoal, rollingMean, summarizeSeries, valueAtDaysAgo, type Point } from "./stats";

/** These tools only read upstream data and reach an external API. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const METRIC = z.enum(METRIC_KEYS as [MetricKey, ...MetricKey[]]);
const SCALE_USER_ID = z
  .string()
  .regex(/^\d+$/)
  .optional()
  .describe("Restrict to one scale-user (profile) id, e.g. a family member. See get_scale_users. Defaults to the signed-in account.");

/** Metrics compared in "changes vs N days ago" and the trend summary by default. */
const KEY_METRICS: MetricKey[] = [
  "weight_kg",
  "body_fat_pct",
  "fat_free_mass_kg",
  "muscle_mass_kg",
  "skeletal_muscle_pct",
  "body_water_pct",
  "visceral_fat_level",
  "bmi",
  "bmr_kcal",
  "bone_mass_kg",
  "protein_pct",
  "subcutaneous_fat_pct",
  "metabolic_age",
];

const DAY = 86_400;
const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

/** Map a Renpho error to an actionable hint, when we recognise it. */
function hintFor(err: unknown): string | undefined {
  if (err instanceof RenphoApiError) {
    switch (err.code) {
      case 401:
      case 403:
        return "Renpho rejected the session even after logging in again. If your Renpho password changed, disconnect and reconnect the connector.";
      case 104:
      case 20001:
        return "Renpho says the password is wrong — reconnect the connector with your current Renpho Health credentials.";
      case 429:
        return "Renpho is rate-limiting this account. Wait a minute and retry; previously fetched pages still serve from cache.";
      case -114:
        return "Renpho rejected the payload encryption — the app protocol may have changed. Check for an update to this server.";
    }
    if (err.httpStatus && err.httpStatus >= 500) return "Renpho's servers are struggling; retry shortly.";
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/before start_date/.test(message)) return "Swap the dates: end_date must be on or after start_date.";
  return undefined;
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const hint = hintFor(err);
  return { content: [{ type: "text" as const, text: hint ? `Error: ${message}\n\nHint: ${hint}` : `Error: ${message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Window resolution
// ---------------------------------------------------------------------------

const WINDOW_SCHEMA = {
  start_date: ISO_DATE.optional().describe("Inclusive start, YYYY-MM-DD. Defaults to `days` before end_date."),
  end_date: ISO_DATE.optional().describe("Inclusive end, YYYY-MM-DD. Defaults to today."),
  days: z.number().int().min(1).max(730).optional().describe("Window length when start_date is omitted (default 30)."),
};

interface Window {
  start_date: string;
  end_date: string;
  days: number;
  startSec: number;
  endSec: number;
}

function addDaysIso(iso: string, delta: number): string {
  const { year, month, day } = parseIsoDate(iso);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function resolveWindow(args: { start_date?: string; end_date?: string; days?: number }, timeZone: string, defaultDays = 30): Window {
  const end_date = args.end_date ?? todayIso(timeZone);
  const days = args.days ?? defaultDays;
  const start_date = args.start_date ?? (args.end_date ? addDaysIso(end_date, -days) : isoDaysAgo(days, timeZone));
  const { startSec, endSec } = civilRangeToEpochSeconds(start_date, end_date, timeZone);
  return { start_date, end_date, days: Math.round((endSec - startSec) / DAY), startSec, endSec };
}

function windowOut(w: Window, timeZone: string) {
  return { start_date: w.start_date, end_date: w.end_date, days: w.days, time_zone: timeZone };
}

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

async function loadProfile(client: RenphoClient): Promise<Profile> {
  const session = await client.getSession();
  return normalizeProfile(session.login);
}

/** Normalise every raw record, dropping any that lack weight/timestamp. Newest first. */
function normalizeAll(result: MeasurementResult, timeZone: string): { records: NormalizedMeasurement[]; skipped: number } {
  const records: NormalizedMeasurement[] = [];
  let skipped = 0;
  for (const raw of result.records) {
    try {
      records.push(normalizeMeasurement(raw, timeZone));
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

function pointsFor(records: NormalizedMeasurement[], metric: MetricKey): Point[] {
  return records
    .map((r) => ({ t: r.timestamp, v: (r as unknown as Record<string, unknown>)[metric] }))
    .filter((p): p is Point => typeof p.v === "number");
}

function selectionNote(result: MeasurementResult): string | undefined {
  switch (result.selection) {
    case "fallback_scale_user":
      return "No records are bound to the signed-in account yet, so these belong to the account's first scale-user profile. Wi-Fi scales upload before the app binds the reading; run run_diagnostics if this looks wrong.";
    case "none":
      return "No records matched the signed-in account. Run run_diagnostics to see which profiles hold data, then pass scale_user_id.";
    default:
      return undefined;
  }
}

function scanNote(tables: TableScan[]): string | undefined {
  const notes: string[] = [];
  const truncated = tables.filter((t) => t.truncated).map((t) => `${t.table_name}/${t.endpoint}`);
  if (truncated.length) {
    notes.push(`Scan stopped early on ${truncated.join(", ")} after ${MAX_PAGES_PER_TABLE} pages (${MAX_PAGES_PER_TABLE * PAGE_SIZE} records); narrow the window for complete coverage.`);
  }
  const errored = tables.filter((t) => t.error).map((t) => `${t.table_name}/${t.endpoint}: ${t.error}`);
  if (errored.length) notes.push(`One store could not be read (${errored.join("; ")}); results come from the other store only.`);
  return notes.length ? notes.join(" ") : undefined;
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

const DEVICE_CHANGE_NOTE =
  "Readings span more than one scale. Body-composition metrics come from device-specific equations and electrode layouts and are NOT comparable across the change (weight is). Treat any step at the changeover as an artefact, not physiology.";

/** Warn when a set of readings straddles a change of scale. */
function deviceChange(records: NormalizedMeasurement[]) {
  const scales = summarizeDevices(records);
  return scales ? { scales, note: DEVICE_CHANGE_NOTE } : undefined;
}

/**
 * Register all tools on the MCP server. `getClient` defers client
 * construction to call-time so props/bindings are live.
 */
export function registerTools(server: McpServer, getClient: () => RenphoClient, timeZone: string) {
  // The headline tool: the most recent reading, classified, with deltas vs 7/30/90 days ago.
  server.registerTool(
    "get_latest_measurement",
    {
      title: "Latest Body Composition",
      description:
        "Get the most recent smart-scale reading with every metric Renpho reports (weight, BMI, body fat %, fat-free mass, subcutaneous fat, visceral fat, body water, skeletal muscle %, muscle mass, bone mass, protein, BMR, metabolic age, heart rate if the scale measures it) plus category classifications, changes vs 7/30/90 days ago, and progress toward the Renpho weight goal. Start here for 'how am I doing?'.",
      inputSchema: { scale_user_id: SCALE_USER_ID },
      annotations: READ_ONLY,
    },
    async ({ scale_user_id }) => {
      try {
        const client = getClient();
        const nowSec = Math.floor(Date.now() / 1000);
        let result = await client.getMeasurements({ startSec: nowSec - 97 * DAY, scaleUserId: scale_user_id });
        if (!result.records.length) {
          // Nothing in the last ~3 months: fall back to the newest reading of any age.
          result = await client.getMeasurements({ limit: 100, scaleUserId: scale_user_id, take: 1 });
        }
        const { records } = normalizeAll(result, timeZone);
        if (!records.length) {
          return jsonResult({ measurement: null, selection: result.selection, hidden_other_user_records: result.hidden, note: selectionNote(result) ?? "No measurements found for this account." });
        }

        const latest = records[0];
        const profile = await loadProfile(client);
        const ctx = { gender: profile.gender, age: profile.age };

        // Deltas are only computed against readings from the SAME scale: a
        // different device means different equations, and "body fat −8%" at a
        // scale change is an artefact that reads like physiology.
        const latestKey = deviceKey(latest);
        const sameDevice = records.filter((r) => deviceKey(r) === latestKey);
        const otherDevice = records.filter((r) => deviceKey(r) !== latestKey);
        const changes: Record<string, unknown> = {};
        for (const horizon of [7, 30, 90]) {
          const entry: Record<string, { then: number; delta: number }> = {};
          for (const metric of KEY_METRICS) {
            const current = (latest as unknown as Record<string, unknown>)[metric];
            if (typeof current !== "number") continue;
            const then = valueAtDaysAgo(pointsFor(sameDevice, metric), horizon, latest.timestamp);
            if (then) entry[metric] = { then: then.v, delta: round(current - then.v) };
          }
          if (Object.keys(entry).length) {
            changes[`vs_${horizon}d`] = entry;
          } else if (valueAtDaysAgo(pointsFor(otherDevice, "weight_kg"), horizon, latest.timestamp)) {
            changes[`vs_${horizon}d`] = {
              suppressed: `The reading ~${horizon} days ago came from a different scale (${sameDevice[sameDevice.length - 1]?.date ?? "?"} is the current scale's first reading); body-composition values are not comparable across devices, so no delta is shown.`,
            };
          }
        }
        const device_change = deviceChange(records);

        const goal = profile.goals.weight_kg;
        const goal_progress = goal
          ? compact({
              goal_weight_kg: goal,
              current_weight_kg: latest.weight_kg,
              remaining_kg: round(goal - latest.weight_kg),
              initial_weight_kg: profile.goals.initial_weight_kg,
              progress_pct:
                profile.goals.initial_weight_kg && profile.goals.initial_weight_kg !== goal
                  ? round(((profile.goals.initial_weight_kg - latest.weight_kg) / (profile.goals.initial_weight_kg - goal)) * 100, 1)
                  : undefined,
              goal_date: profile.goals.weight_goal_date,
              body_fat_goal_pct: profile.goals.body_fat_pct,
            })
          : undefined;

        return jsonResult(
          compact({
            measurement: latest,
            classification: classify(latest, ctx),
            changes,
            device_change,
            goal_progress,
            profile_context: compact({ gender: profile.gender, age: profile.age, height_cm: profile.height_cm, athlete_mode: profile.athlete_mode }),
            readings_last_97_days: records.length,
            selection: result.selection,
            hidden_other_user_records: result.hidden || undefined,
            note: selectionNote(result),
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_measurements",
    {
      title: "Measurement History",
      description:
        "Get scale readings over a date range — every metric per reading, or averaged per day/week to keep the payload small. Use `metrics` to request only the fields you need. Records are returned oldest→newest. Set include_details to see the source device/store and any device-specific fields (e.g. MorphoScan segmental data under `extra`).",
      inputSchema: {
        ...WINDOW_SCHEMA,
        metrics: z.array(METRIC).min(1).optional().describe("Subset of metrics to return (default: all)."),
        aggregate: z.enum(["none", "daily", "weekly"]).default("none").describe("none = every reading; daily/weekly = mean per calendar day / ISO week."),
        limit: z.number().int().min(1).max(1000).default(200).describe("Max rows (newest kept when truncating)."),
        include_details: z.boolean().default(false).describe("Include source device, impedance, user ids and any extra fields per reading (aggregate=none only)."),
        scale_user_id: SCALE_USER_ID,
        include_all_users: z.boolean().default(false).describe("Return readings for every profile in the account (adds user ids to each row)."),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, days, metrics, aggregate, limit, include_details, scale_user_id, include_all_users }) => {
      try {
        const client = getClient();
        const w = resolveWindow({ start_date, end_date, days }, timeZone);
        const result = await client.getMeasurements({ startSec: w.startSec, endSec: w.endSec, scaleUserId: scale_user_id, includeAllUsers: include_all_users });
        const { records, skipped } = normalizeAll(result, timeZone);
        const keys = metrics ?? METRIC_KEYS;

        let rows: unknown[];
        let total: number;
        if (aggregate === "none") {
          total = records.length;
          rows = records
            .slice(0, limit)
            .reverse()
            .map((m) => {
              if (include_details) return metrics ? { ...pickMetrics(m, keys), body_type: m.body_type, source: m.source, user: m.user, impedance: m.impedance, extra: m.extra } : m;
              const row: Record<string, unknown> = pickMetrics(m, keys);
              if (m.body_type && !metrics) row.body_type = m.body_type;
              if (include_all_users) row.user = m.user;
              return row;
            });
        } else {
          const daily = aggregateDaily(records, keys);
          const series = aggregate === "daily" ? daily : aggregateWeekly(daily, keys);
          total = series.length;
          rows = series.slice(Math.max(0, series.length - limit));
        }

        return jsonResult(
          compact({
            window: windowOut(w, timeZone),
            aggregate,
            selection: result.selection,
            returned: rows.length,
            total_in_window: total,
            truncated_to_limit: rows.length < total || undefined,
            hidden_other_user_records: result.hidden || undefined,
            skipped_malformed: skipped || undefined,
            note: selectionNote(result),
            scan_note: scanNote(result.tables),
            device_change: deviceChange(records),
            [aggregate === "none" ? "records" : aggregate]: rows,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_body_composition_trend",
    {
      title: "Body Composition Trend",
      description:
        "Summarise how each body-composition metric moved over a window: start/end averages (7-day edges), change, min/max/mean, and a least-squares trend (per week, with r²), plus a daily or weekly series. Use it to judge whether weight change is fat or lean mass (compare weight_kg, body_fat_pct and fat_free_mass_kg together) and whether hydration or visceral fat is drifting.",
      inputSchema: {
        ...WINDOW_SCHEMA,
        metrics: z.array(METRIC).min(1).optional().describe("Metrics to summarise (default: the key composition metrics)."),
        scale_user_id: SCALE_USER_ID,
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, days, metrics, scale_user_id }) => {
      try {
        const client = getClient();
        const w = resolveWindow({ start_date, end_date, days }, timeZone);
        const result = await client.getMeasurements({ startSec: w.startSec, endSec: w.endSec, scaleUserId: scale_user_id });
        const { records } = normalizeAll(result, timeZone);
        const keys = metrics ?? KEY_METRICS;

        const summaries: Record<string, unknown> = {};
        for (const metric of keys) {
          const s = summarizeSeries(pointsFor(records, metric));
          if (s) {
            summaries[metric] = {
              ...s,
              first: { time: localIso(s.first.t, timeZone), value: s.first.v },
              last: { time: localIso(s.last.t, timeZone), value: s.last.v },
            };
          }
        }

        const daily = aggregateDaily(records, keys);
        const useWeekly = w.days > 60;
        return jsonResult(
          compact({
            window: windowOut(w, timeZone),
            readings: records.length,
            days_with_readings: daily.length,
            selection: result.selection,
            hidden_other_user_records: result.hidden || undefined,
            note: selectionNote(result),
            scan_note: scanNote(result.tables),
            device_change: deviceChange(records),
            metrics: summaries,
            series_granularity: useWeekly ? "weekly" : "daily",
            series: useWeekly ? aggregateWeekly(daily, keys) : daily,
            reading_guide: [
              "change = end_avg − start_avg using 7-day edge windows; trend.slope_per_week is the fitted rate, r2 near 0 means noise dominates.",
              "Falling weight_kg with flat fat_free_mass_kg/muscle_mass_kg and falling body_fat_pct = fat loss; falling fat_free_mass_kg suggests lean-mass loss or dehydration (check body_water_pct).",
              "Bio-impedance readings swing with hydration, time of day and recent training — weigh at the same time of day and trust averages over single readings.",
            ],
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_weight_trend",
    {
      title: "Weight Trend & Goal Projection",
      description:
        "Daily-average weight with a 7-day rolling mean, the fitted weekly rate of change, and a projection of when the Renpho weight goal is reached at that rate (plus the weekly rate needed to hit the goal date, if one is set). Windows over 120 days return weekly points.",
      inputSchema: { ...WINDOW_SCHEMA, scale_user_id: SCALE_USER_ID },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, days, scale_user_id }) => {
      try {
        const client = getClient();
        const w = resolveWindow({ start_date, end_date, days }, timeZone);
        const [result, profile] = await Promise.all([
          client.getMeasurements({ startSec: w.startSec, endSec: w.endSec, scaleUserId: scale_user_id }),
          loadProfile(client),
        ]);
        const { records } = normalizeAll(result, timeZone);
        if (!records.length) {
          return jsonResult({ window: windowOut(w, timeZone), readings: 0, selection: result.selection, note: selectionNote(result) ?? "No weigh-ins in this window." });
        }

        const daily = aggregateDaily(records, ["weight_kg"]).filter((d) => typeof d.weight_kg === "number");
        const withRolling = rollingMean(
          daily.map((d) => ({ date: d.date, value: d.weight_kg as number, readings: d.readings })),
          7,
        );
        const dailyPoints: Point[] = daily.map((d) => ({ t: Math.floor(zonedMidnightMs(d.date, timeZone) / 1000), v: d.weight_kg as number }));
        const summary = summarizeSeries(pointsFor(records, "weight_kg"));
        const rate = linearRegression(dailyPoints);
        const nowSec = Math.floor(Date.now() / 1000);
        const current = withRolling[withRolling.length - 1].rolling;

        let goal: Record<string, unknown> | undefined;
        if (profile.goals.weight_kg) {
          const projection = projectGoal(current, profile.goals.weight_kg, rate?.slope_per_week, nowSec);
          let weekly_rate_needed: number | undefined;
          if (profile.goals.weight_goal_date) {
            const goalMs = Date.parse(`${profile.goals.weight_goal_date.slice(0, 10)}T00:00:00Z`);
            if (Number.isFinite(goalMs)) {
              const weeksLeft = (goalMs / 1000 - nowSec) / (7 * DAY);
              if (weeksLeft > 0) weekly_rate_needed = round(projection.remaining / weeksLeft, 3);
            }
          }
          goal = compact({
            goal_weight_kg: profile.goals.weight_kg,
            goal_date: profile.goals.weight_goal_date,
            current_7d_avg_kg: current,
            ...projection,
            fitted_weekly_rate_kg: rate?.slope_per_week,
            weekly_rate_needed_kg: weekly_rate_needed,
          });
        }

        const useWeekly = w.days > 120;
        const series = useWeekly
          ? aggregateWeekly(daily, ["weight_kg"])
          : withRolling.map((d) => ({ date: d.date, weight_kg: d.value, rolling_7d: d.rolling, readings: d.readings }));

        return jsonResult(
          compact({
            window: windowOut(w, timeZone),
            readings: records.length,
            days_with_readings: daily.length,
            selection: result.selection,
            hidden_other_user_records: result.hidden || undefined,
            note: selectionNote(result),
            scan_note: scanNote(result.tables),
            device_change: deviceChange(records),
            summary: summary && {
              ...summary,
              first: { time: localIso(summary.first.t, timeZone), value: summary.first.v },
              last: { time: localIso(summary.last.t, timeZone), value: summary.last.v },
            },
            rate_from_daily_averages: rate,
            goal,
            series_granularity: useWeekly ? "weekly" : "daily",
            series,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_profile",
    {
      title: "Profile & Goals",
      description:
        "Get the Renpho account profile: name, sex, birthday/age, height, display units, athlete mode, and the goals set in the app (target weight and date, target body fat, starting weight/body fat, exercise/sleep goals). Also reports the current Renpho session expiry.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const client = getClient();
        const session = await client.getSession();
        const info = await client.getDeviceInfo();
        return jsonResult(
          compact({
            profile: normalizeProfile(session.login),
            scale_user_ids: Array.from(new Set(info.tables.flatMap((t) => t.user_ids))),
            session: {
              renpho_user_id: session.userId,
              token_issued_at: session.issuedAt ? localIso(Math.floor(session.issuedAt / 1000), timeZone) : undefined,
              token_expires_at: localIso(Math.floor(session.expiresAt / 1000), timeZone),
            },
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_scale_users",
    {
      title: "Scale Users & Devices",
      description:
        "List the scale-user (profile) ids and Renpho data tables linked to the account, family-member profiles, and every device/data category Renpho reports (scale, girth, treadmill, rope…). Use the ids with `scale_user_id` on the other tools.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const client = getClient();
        const session = await client.getSession();
        const [info, family] = await Promise.all([client.getDeviceInfo(), client.getFamilyMembers().catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))]);
        return jsonResult(
          compact({
            account_user_id: session.userId,
            scale_user_ids: Array.from(new Set(info.tables.flatMap((t) => t.user_ids))),
            scale_tables: info.tables,
            family_members: Array.isArray(family) ? family.map((m) => normalizeProfile(m)) : family,
            device_categories: info.categories,
            unhandled_categories_with_data: info.categories.filter((c) => !c.handled && c.has_data).map((c) => c.category),
            note: "Only the `scale` category is read by the measurement tools. Other categories with data (e.g. girth, bodyScan) can be explored with query_endpoint.",
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // Self-check: exercises every step of the pipeline and reports where data
  // lives, so "the connector is broken" becomes a precise diagnosis.
  server.registerTool(
    "run_diagnostics",
    {
      title: "Run Diagnostics",
      description:
        "Probe the Renpho connection end to end: session/token status and devices bound at login, device categories and tables, page ordering per store (legacy vs body-composition), the last 14 days of readings across every profile (bound vs unbound, hidden readings, devices seen, which store each came from, any unrecognised fields), and cache status. Use this when readings look missing, stale, or attributed to the wrong person.",
      inputSchema: { days: z.number().int().min(1).max(90).default(14).describe("How many recent days to inspect.") },
      annotations: READ_ONLY,
    },
    async ({ days }) => {
      const client = getClient();
      const out: Record<string, unknown> = { now: localIso(Math.floor(Date.now() / 1000), timeZone), time_zone: timeZone, cache_enabled: client.cacheEnabled };
      const probe = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
        try {
          const value = await fn();
          out[name] = value;
          return value;
        } catch (err) {
          out[name] = { error: err instanceof Error ? err.message : String(err) };
          return undefined;
        }
      };

      const cached = await client.peekSession();
      out.session_was_cached = Boolean(cached);
      const session = await probe("session", async () => {
        const s = await client.getSession();
        return {
          renpho_user_id: s.userId,
          token_expires_at: localIso(Math.floor(s.expiresAt / 1000), timeZone),
          minutes_left: round((s.expiresAt - Date.now()) / 60_000, 1),
          devices_bound_at_login: s.bindingList,
        };
      });
      if (!session) return jsonResult(out);

      await probe("token_time", () => client.getTokenTime());
      const info = await probe("device_info", async () => {
        const i = await client.getDeviceInfo(true);
        return { tables: i.tables, categories: i.categories, unhandled_with_data: i.categories.filter((c) => !c.handled && c.has_data).map((c) => c.category) };
      });
      await probe("family_members", async () => (await client.getFamilyMembers()).map((m) => normalizeProfile(m)));

      if (info) {
        await probe("recent_readings", async () => {
          const nowSec = Math.floor(Date.now() / 1000);
          const all = await client.getMeasurements({ startSec: nowSec - days * DAY, includeAllUsers: true });
          const mine = await client.getMeasurements({ startSec: nowSec - days * DAY });
          const { records, skipped } = normalizeAll(all, timeZone);
          const accountId = (await client.getSession()).userId;
          const bound = records.filter((r) => r.user.bound_user_id === accountId || r.user.scale_user_id === accountId);
          const mineIds = new Set(mine.records.map((r) => String(r.id)));
          const hidden = records.filter((r) => !mineIds.has(r.id)).slice(0, 5);

          const devices = new Map<string, { model?: string; scale_name?: string; mac?: string; readings: number; latest: string }>();
          for (const r of records) {
            const key = `${r.source.model ?? ""}|${r.source.scale_name ?? ""}|${r.source.mac ?? ""}`;
            const d = devices.get(key);
            if (d) d.readings++;
            else devices.set(key, { model: r.source.model, scale_name: r.source.scale_name, mac: r.source.mac, readings: 1, latest: r.time });
          }

          const byEndpoint: Record<string, number> = {};
          for (const r of records) {
            const ep = r.source.endpoint ?? "unknown";
            byEndpoint[ep] = (byEndpoint[ep] ?? 0) + 1;
          }
          const extraFields = summarizeExtraFields(records);

          const brief = (r: NormalizedMeasurement) => ({ id: r.id, time: r.time, weight_kg: r.weight_kg, body_fat_pct: r.body_fat_pct, bound_user_id: r.user.bound_user_id, scale_user_id: r.user.scale_user_id, method: r.source.method, model: r.source.model, endpoint: r.source.endpoint });
          return compact({
            window_days: days,
            page_scan: all.tables,
            readings_all_profiles: records.length,
            readings_by_store: byEndpoint,
            device_change: deviceChange(records),
            unrecognised_fields: Object.keys(extraFields).length ? extraFields : undefined,
            unrecognised_fields_guide:
              Object.keys(extraFields).length
                ? "Per field: value range, `equals_metric` when it duplicates a mapped metric on every reading, and Pearson r against body-fat % and weight. Fields with |r| near 1 vs body_fat_pct are derived body-composition outputs, not raw measurements."
                : undefined,
            readings_bound_to_account: bound.length,
            readings_selected_for_account: mine.records.length,
            selection_rule: mine.selection,
            skipped_malformed: skipped || undefined,
            latest_any_profile: records[0] ? brief(records[0]) : null,
            latest_selected: mine.records[0] ? brief(normalizeMeasurement(mine.records[0], timeZone)) : null,
            latest_selected_age_hours: mine.records[0] ? round((nowSec - Number(mine.records[0].timeStamp)) / 3600, 1) : undefined,
            hidden_from_account: hidden.map(brief),
            devices_seen: Array.from(devices.values()),
          });
        });
      }

      return jsonResult(out);
    },
  );

  // Escape hatch: call any endpoint of the Renpho Health API directly.
  server.registerTool(
    "query_endpoint",
    {
      title: "Query Any Renpho Endpoint (advanced)",
      description:
        `Call an arbitrary Renpho Health API endpoint (cloud.renpho.com) with the app's encryption/auth applied and return the decrypted JSON. For data this server has no dedicated tool for (girth/tape measurements, goals history, treadmill/rope data, body-scan devices) or new endpoints. Known paths: ${Object.values(ENDPOINTS).join(", ")}. Only use read/query endpoints — the API also has mutating ones.`,
      inputSchema: {
        path: z.string().regex(/^[A-Za-z0-9_\-/.]+$/).max(200).describe("Endpoint path relative to https://cloud.renpho.com/, e.g. \"RenphoHealth/scale/queryAllMeasureDataList\"."),
        body: z.record(z.unknown()).nullable().optional().describe("JSON request body (encrypted for you). Omit/null for the app's empty payload."),
        empty_body: z.enum(["bytes", "object"]).default("bytes").describe("When body is omitted: send an encrypted empty byte array (what the app sends to device/count) or an encrypted \"{}\"."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ path, body, empty_body }) => {
      try {
        const text = await getClient().callRaw(path, body ?? null, { emptyAsObject: empty_body === "object" });
        const MAX = 200_000;
        if (text.length > MAX) {
          return jsonResult({ path, truncated: true, bytes: text.length, preview: text.slice(0, MAX) });
        }
        let parsed: unknown;
        try {
          parsed = parseRenphoJson(text);
        } catch {
          parsed = text;
        }
        return jsonResult({ path, data: parsed });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "refresh_data",
    {
      title: "Refresh Session & Cache",
      description:
        "Drop the cached Renpho session and measurement pages for this account and log in again. Use after a new weigh-in that isn't showing, or after the Renpho app finishes syncing/binding a reading.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const client = getClient();
        const purged = await client.purgeCache();
        const session = await client.getSession(true);
        const info = await client.getDeviceInfo(true);
        return jsonResult({
          purged_cache_entries: purged,
          renpho_user_id: session.userId,
          token_expires_at: localIso(Math.floor(session.expiresAt / 1000), timeZone),
          scale_tables: info.tables,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "delete_my_data",
    {
      title: "Delete My Cached Data",
      description:
        "Delete everything this connector has cached for your account (session token and measurement pages). Your data in Renpho is untouched. To fully revoke access, also disconnect the connector in Claude — that deletes the stored credentials.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const deleted = await getClient().purgeCache();
        return jsonResult({
          deleted_cache_entries: deleted,
          note: "Cached data cleared. Disconnect the connector in Claude (Settings → Connectors) to delete the stored Renpho credentials as well.",
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
