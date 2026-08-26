/**
 * Pure shaping of Renpho scale records into a compact, self-describing form
 * for Claude. A raw record from `RenphoHealth/scale/queryAllMeasureDataList`
 * has ~57 keys (see README "Field mapping"); we rename the metrics to
 * unit-suffixed snake_case, decode the enum codes, drop envelope noise, and
 * keep anything unrecognised under `extra` so no signal is lost when Renpho
 * adds fields.
 */
import { localDate, localIso } from "./dates";
import { pearson } from "./stats";

/** A raw record exactly as decrypted from the API (ids already stringified). */
export type RawMeasurement = Record<string, unknown>;

export const GENDER: Record<number, string> = { 0: "female", 1: "male" };
export const WEIGHT_UNIT: Record<number, string> = { 1: "kg", 2: "lb", 3: "st_lb", 4: "st" };
export const HEIGHT_UNIT: Record<number, string> = { 1: "cm", 2: "in" };
export const PERSON_TYPE: Record<number, string> = { 0: "normal", 1: "athlete" };

/** Renpho's 9-way body-type classification (`bodyShape` / `bodytype`). */
export const BODY_TYPE: Record<number, string> = {
  0: "thin",
  1: "low_fat",
  2: "athletic",
  3: "muscle_deficient",
  4: "well_balanced",
  5: "overweight",
  6: "invisible_obesity", // "skinny fat": normal weight, high fat
  7: "fat_excess",
  8: "obese",
};

/** How a record was produced/allocated (`method`, a.k.a. ScaleDataSourceType). */
export const SOURCE_METHOD: Record<number, string> = {
  0: "manual_input",
  2: "bluetooth_online_measure",
  3: "ble_cloud_auto_allocation",
  4: "cloud_manual_allocation",
  5: "bluetooth_offline_auto_allocation",
  6: "bluetooth_offline_manual_allocation",
  7: "other",
  8: "renpho_measure_data",
  11: "pregnant_mode_online_measure",
  12: "pregnant_mode_offline_auto_allocation",
  13: "pregnant_mode_offline_manual_allocation",
  14: "pregnant_cloud_manual_allocation",
  15: "pregnant_cloud_ble_allocation",
  16: "pregnant_cloud_wifi_allocation",
  17: "pregnant_ble_cloud_allocation",
  18: "cloud_wifi_auto_allocation",
  19: "cloud_ble_auto_allocation",
};

/**
 * Raw metric key → output key. Units follow what the Renpho app displays:
 * masses in kg, compositional metrics in %, visceral fat as a 1–59 level,
 * BMR in kcal/day. (Weight is always stored in kg regardless of the account's
 * display unit.)
 */
export const METRIC_FIELDS: ReadonlyArray<readonly [raw: string, out: MetricKey]> = [
  ["weight", "weight_kg"],
  ["bmi", "bmi"],
  ["bodyfat", "body_fat_pct"],
  ["fatFreeWeight", "fat_free_mass_kg"],
  ["subfat", "subcutaneous_fat_pct"],
  ["visfat", "visceral_fat_level"],
  ["water", "body_water_pct"],
  ["sinew", "skeletal_muscle_pct"],
  ["muscle", "muscle_mass_kg"],
  ["bone", "bone_mass_kg"],
  ["protein", "protein_pct"],
  ["bmr", "bmr_kcal"],
  ["bodyage", "metabolic_age"],
  ["heartRate", "heart_rate_bpm"],
  ["cardiacIndex", "cardiac_index"],
  ["waistline", "waistline_cm"],
  ["hip", "hip_cm"],
] as const;

export type MetricKey =
  | "weight_kg"
  | "bmi"
  | "body_fat_pct"
  | "fat_free_mass_kg"
  | "subcutaneous_fat_pct"
  | "visceral_fat_level"
  | "body_water_pct"
  | "skeletal_muscle_pct"
  | "muscle_mass_kg"
  | "bone_mass_kg"
  | "protein_pct"
  | "bmr_kcal"
  | "metabolic_age"
  | "heart_rate_bpm"
  | "cardiac_index"
  | "waistline_cm"
  | "hip_cm";

export const METRIC_KEYS: MetricKey[] = METRIC_FIELDS.map(([, out]) => out);

/** Keys that are pure envelope/app noise and never carry a health signal. */
const NOISE_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "localCreatedAt",
  "timeZone",
  "babyPicture",
  "headValue",
  "headUnit",
  "displayModuleType",
  "categoryType",
  "weightUnit",
  "heightUnit",
  "gender",
  "height",
  "birthday",
  "scaleType",
  "isNew",
]);

/** Keys consumed explicitly by normalizeMeasurement (so they don't land in `extra`). */
const CONSUMED_KEYS = new Set([
  ...METRIC_FIELDS.map(([raw]) => raw),
  "id",
  "timeStamp",
  "bodyShape",
  "bodytype",
  "personType",
  "resistance",
  "secResistance",
  "actualResistance",
  "actualSecResistance",
  "method",
  "internalModel",
  "scaleName",
  "mac",
  "deviceType",
  "isAuto",
  "sportFlag",
  "invalidFlag",
  "subUserId",
  "bUserId",
]);

export interface NormalizedMeasurement {
  id: string;
  /** Unix seconds. */
  timestamp: number;
  /** Local RFC-3339 with offset. */
  time: string;
  /** Local calendar date. */
  date: string;
  weight_kg: number;
  bmi?: number;
  body_fat_pct?: number;
  fat_free_mass_kg?: number;
  subcutaneous_fat_pct?: number;
  visceral_fat_level?: number;
  body_water_pct?: number;
  skeletal_muscle_pct?: number;
  muscle_mass_kg?: number;
  bone_mass_kg?: number;
  protein_pct?: number;
  bmr_kcal?: number;
  metabolic_age?: number;
  heart_rate_bpm?: number;
  cardiac_index?: number;
  waistline_cm?: number;
  hip_cm?: number;
  body_type?: string;
  athlete_mode?: boolean;
  impedance?: {
    resistance?: number;
    sec_resistance?: number;
    actual_resistance?: number;
    actual_sec_resistance?: number;
  };
  source: {
    /** Which Renpho store the row came from: "legacy" (queryAllMeasureDataList) or "body_composition". */
    endpoint?: "legacy" | "body_composition";
    method?: string;
    method_code?: number;
    model?: string;
    scale_name?: string;
    mac?: string;
    device_type?: string;
    auto?: boolean;
    sport_flag?: number;
    invalid?: boolean;
  };
  user: {
    bound_user_id?: string;
    scale_user_id?: string;
  };
  extra?: Record<string, unknown>;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** A metric that is 0 was not measured (e.g. heart rate on a scale without it). */
function metric(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined || n === 0 ? undefined : n;
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v);
  return s === "" ? undefined : s;
}

function bool(v: unknown): boolean | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function compact<T extends Record<string, unknown>>(obj: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length ? (out as T) : undefined;
}

/** Normalise one raw record. Throws if it has no usable weight/timestamp. */
export function normalizeMeasurement(raw: RawMeasurement, timeZone: string): NormalizedMeasurement {
  const timestamp = num(raw.timeStamp);
  const weight = num(raw.weight);
  if (timestamp === undefined || weight === undefined) {
    throw new Error(`Measurement ${String(raw.id)} has no timeStamp/weight`);
  }

  const m: NormalizedMeasurement = {
    id: str(raw.id) ?? "",
    timestamp,
    time: localIso(timestamp, timeZone),
    date: localDate(timestamp, timeZone),
    weight_kg: weight,
    source: {},
    user: {},
  };

  for (const [rawKey, outKey] of METRIC_FIELDS) {
    if (outKey === "weight_kg") continue;
    const v = metric(raw[rawKey]);
    if (v !== undefined) (m as unknown as Record<string, unknown>)[outKey] = v;
  }

  const bodyTypeCode = num(raw.bodyShape) ?? num(raw.bodytype);
  if (bodyTypeCode !== undefined) m.body_type = BODY_TYPE[bodyTypeCode] ?? `unknown_${bodyTypeCode}`;

  const personType = num(raw.personType);
  if (personType !== undefined) m.athlete_mode = personType === 1;

  m.impedance = compact({
    resistance: metric(raw.resistance),
    sec_resistance: metric(raw.secResistance),
    actual_resistance: metric(raw.actualResistance),
    actual_sec_resistance: metric(raw.actualSecResistance),
  });
  if (!m.impedance) delete m.impedance;

  const methodCode = num(raw.method);
  const endpointTag = raw.__endpoint;
  m.source =
    compact({
      endpoint: endpointTag === "bodyComposition" ? "body_composition" : endpointTag === "legacy" ? "legacy" : undefined,
      method: methodCode === undefined ? undefined : (SOURCE_METHOD[methodCode] ?? `unknown_${methodCode}`),
      method_code: methodCode,
      model: str(raw.internalModel),
      scale_name: str(raw.scaleName),
      mac: str(raw.mac),
      device_type: str(raw.deviceType),
      auto: bool(raw.isAuto),
      sport_flag: metric(raw.sportFlag),
      invalid: bool(raw.invalidFlag),
    }) ?? {};

  m.user = compact({ bound_user_id: str(raw.bUserId), scale_user_id: str(raw.subUserId) }) ?? {};

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (CONSUMED_KEYS.has(k) || NOISE_KEYS.has(k) || k.startsWith("__")) continue;
    if (v === null || v === undefined || v === "" || v === 0 || v === false) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    extra[k] = v;
  }
  if (Object.keys(extra).length) m.extra = extra;

  return m;
}

/** Keep only the id/time fields plus the requested metrics. */
export function pickMetrics(m: NormalizedMeasurement, metrics: MetricKey[]): Record<string, unknown> {
  const out: Record<string, unknown> = { id: m.id, time: m.time, date: m.date };
  for (const key of metrics) {
    const v = (m as unknown as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export interface DailyAggregate {
  date: string;
  readings: number;
  first_time: string;
  last_time: string;
  [metric: string]: unknown;
}

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * Average every metric per local calendar day (multiple weigh-ins a day are
 * common and mostly noise). Ascending by date.
 */
export function aggregateDaily(
  records: NormalizedMeasurement[],
  metrics: MetricKey[] = METRIC_KEYS,
): DailyAggregate[] {
  const byDate = new Map<string, NormalizedMeasurement[]>();
  for (const r of records) {
    const list = byDate.get(r.date);
    if (list) list.push(r);
    else byDate.set(r.date, [r]);
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, list]) => {
      const sorted = [...list].sort((a, b) => a.timestamp - b.timestamp);
      const day: DailyAggregate = {
        date,
        readings: sorted.length,
        first_time: sorted[0].time,
        last_time: sorted[sorted.length - 1].time,
      };
      for (const key of metrics) {
        const values = sorted
          .map((r) => (r as unknown as Record<string, unknown>)[key])
          .filter((v): v is number => typeof v === "number");
        if (values.length) {
          day[key] = round(values.reduce((a, b) => a + b, 0) / values.length, 2);
        }
      }
      return day;
    });
}

export interface WeeklyAggregate {
  /** Monday of the ISO week. */
  week_start: string;
  days_with_readings: number;
  readings: number;
  [metric: string]: unknown;
}

/** Monday-anchored "YYYY-MM-DD" for an ISO date. */
export function weekStartOf(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Roll daily aggregates up to weekly means (each day weighted equally). */
export function aggregateWeekly(daily: DailyAggregate[], metrics: MetricKey[] = METRIC_KEYS): WeeklyAggregate[] {
  const byWeek = new Map<string, DailyAggregate[]>();
  for (const d of daily) {
    const ws = weekStartOf(d.date);
    const list = byWeek.get(ws);
    if (list) list.push(d);
    else byWeek.set(ws, [d]);
  }
  return Array.from(byWeek.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([week_start, days]) => {
      const week: WeeklyAggregate = {
        week_start,
        days_with_readings: days.length,
        readings: days.reduce((a, d) => a + d.readings, 0),
      };
      for (const key of metrics) {
        const values = days.map((d) => d[key]).filter((v): v is number => typeof v === "number");
        if (values.length) week[key] = round(values.reduce((a, b) => a + b, 0) / values.length, 2);
      }
      return week;
    });
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface DeviceIdentity {
  model?: string;
  scale_name?: string;
  device_type?: string;
  mac?: string;
}

/**
 * Identity of the scale behind a reading. MAC is the most stable handle; a
 * reading without one falls back to model + device type. Two scales of the
 * same model still collide on the fallback, which is acceptable: their
 * equations are identical.
 */
export function deviceKey(m: NormalizedMeasurement): string {
  return m.source.mac ?? `${m.source.model ?? "?"}|${m.source.device_type ?? "?"}`;
}

export function deviceIdentity(m: NormalizedMeasurement): DeviceIdentity {
  return compact({ model: m.source.model, scale_name: m.source.scale_name, device_type: m.source.device_type, mac: m.source.mac }) ?? {};
}

export interface DeviceSpan {
  device: DeviceIdentity;
  first_date: string;
  last_date: string;
  readings: number;
}

/**
 * Which scales produced a set of readings, with the date span of each. Returns
 * undefined for a single device — the caller only needs to warn when a window
 * straddles a change of scale, because body-composition metrics come from
 * device-specific equations and electrode layouts and are not comparable
 * across it (weight is).
 */
export function summarizeDevices(records: NormalizedMeasurement[]): DeviceSpan[] | undefined {
  const spans = new Map<string, DeviceSpan>();
  for (const r of [...records].sort((a, b) => a.timestamp - b.timestamp)) {
    const key = deviceKey(r);
    const span = spans.get(key);
    if (span) {
      span.last_date = r.date;
      span.readings++;
    } else {
      spans.set(key, { device: deviceIdentity(r), first_date: r.date, last_date: r.date, readings: 1 });
    }
  }
  return spans.size > 1 ? Array.from(spans.values()) : undefined;
}

// ---------------------------------------------------------------------------
// Unrecognised (device-specific) fields
// ---------------------------------------------------------------------------

export interface ExtraFieldSummary {
  readings: number;
  type: "number" | "other";
  min?: number;
  max?: number;
  mean?: number;
  /** A mapped metric this field equals on every reading where both exist (≥2) — i.e. a duplicate under another name. */
  equals_metric?: MetricKey;
  r_vs_body_fat_pct?: number;
  r_vs_weight_kg?: number;
  sample?: string;
}

/**
 * Profile every field that landed in `extra`, so a new device's fields can be
 * identified from data rather than guessed: value range, whether the field is
 * a byte-for-byte duplicate of a mapped metric, and how it correlates with
 * body-fat % and weight.
 */
export function summarizeExtraFields(records: NormalizedMeasurement[]): Record<string, ExtraFieldSummary> {
  const keys = new Set<string>();
  for (const r of records) for (const k of Object.keys(r.extra ?? {})) keys.add(k);

  const out: Record<string, ExtraFieldSummary> = {};
  for (const key of Array.from(keys).sort()) {
    const present = records.filter((r) => r.extra?.[key] !== undefined);
    const numeric = present.filter((r): r is NormalizedMeasurement & { extra: Record<string, number> } => typeof r.extra?.[key] === "number");
    if (!numeric.length) {
      out[key] = { readings: present.length, type: "other", sample: JSON.stringify(present[0].extra![key]).slice(0, 120) };
      continue;
    }
    const values = numeric.map((r) => r.extra[key]);
    const summary: ExtraFieldSummary = {
      readings: present.length,
      type: "number",
      min: Math.min(...values),
      max: Math.max(...values),
      mean: round(values.reduce((a, b) => a + b, 0) / values.length, 3),
    };
    for (const metric of METRIC_KEYS) {
      const pairs = numeric
        .map((r) => [r.extra[key], (r as unknown as Record<string, unknown>)[metric]] as const)
        .filter((p): p is readonly [number, number] => typeof p[1] === "number");
      if (pairs.length >= 2 && pairs.every(([a, b]) => Math.abs(a - b) < 1e-9)) {
        summary.equals_metric = metric;
        break;
      }
    }
    const pairsWith = (metric: MetricKey): Array<[number, number]> =>
      numeric
        .map((r) => [r.extra[key], (r as unknown as Record<string, unknown>)[metric]] as [number, unknown])
        .filter((p): p is [number, number] => typeof p[1] === "number");
    summary.r_vs_body_fat_pct = pearson(pairsWith("body_fat_pct"));
    summary.r_vs_weight_kg = pearson(pairsWith("weight_kg"));
    out[key] = JSON.parse(JSON.stringify(summary)) as ExtraFieldSummary;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification (coaching context, not diagnosis)
// ---------------------------------------------------------------------------

export interface ClassificationContext {
  gender?: "male" | "female";
  age?: number;
}

export interface Classification {
  bmi_category?: string;
  body_fat_category?: string;
  visceral_fat_category?: string;
  body_water_category?: string;
  notes: string[];
}

export function classifyBmi(bmi?: number): string | undefined {
  if (bmi === undefined) return undefined;
  if (bmi < 18.5) return "underweight";
  if (bmi < 25) return "normal";
  if (bmi < 30) return "overweight";
  return "obese";
}

/** ACE body-fat ranges. */
export function classifyBodyFat(pct?: number, gender?: "male" | "female"): string | undefined {
  if (pct === undefined) return undefined;
  if (gender === "female") {
    if (pct < 14) return "essential";
    if (pct < 21) return "athlete";
    if (pct < 25) return "fitness";
    if (pct < 32) return "average";
    return "obese";
  }
  if (gender === "male") {
    if (pct < 6) return "essential";
    if (pct < 14) return "athlete";
    if (pct < 18) return "fitness";
    if (pct < 25) return "average";
    return "obese";
  }
  return undefined;
}

export function classifyVisceralFat(level?: number): string | undefined {
  if (level === undefined) return undefined;
  if (level <= 9) return "healthy";
  if (level <= 14) return "high";
  return "very_high";
}

export function classifyBodyWater(pct?: number, gender?: "male" | "female"): string | undefined {
  if (pct === undefined || !gender) return undefined;
  const [lo, hi] = gender === "male" ? [50, 65] : [45, 60];
  if (pct < lo) return "low";
  if (pct > hi) return "high";
  return "normal";
}

export function classify(m: NormalizedMeasurement, ctx: ClassificationContext = {}): Classification {
  const notes: string[] = [];
  if (!ctx.gender) notes.push("Body-fat and water ranges are sex-specific; profile gender unknown so those categories are omitted.");
  if (m.athlete_mode) notes.push("Athlete mode was on for this reading; Renpho applies a different impedance model.");
  if (m.source.invalid) notes.push("Renpho flagged this reading as invalid.");
  return {
    bmi_category: classifyBmi(m.bmi),
    body_fat_category: classifyBodyFat(m.body_fat_pct, ctx.gender),
    visceral_fat_category: classifyVisceralFat(m.visceral_fat_level),
    body_water_category: classifyBodyWater(m.body_water_pct, ctx.gender),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** Keys from the login payload that are secrets or pure app plumbing. */
const PROFILE_DROP = new Set([
  "token",
  "password",
  "encryptedPassword",
  "clientIp",
  "avatar",
  "facebookAccount",
  "twitterAccount",
  "lineAccount",
  "debugFlag",
  "testFlag",
  "agreeFlag",
  "isPushData",
  "isPushEmailMessage",
  "isPushFriendMessage",
  "rememberCreatedAt",
  "deletedAt",
  "platform",
  "appId",
  "appRevision",
  "cellphoneType",
  "systemType",
  "supplyerId",
  "roleType",
  "revise",
  "userCode",
  "extraField",
  "calmDown",
  "firstLogin",
  "emailValid",
  "issAt",
  "expAt",
  "timeStamp",
  "phone",
  "resistance",
  "secResistance",
  "method",
  "weight",
]);

export function ageFromBirthday(birthday: string | undefined, now: Date = new Date()): number | undefined {
  if (!birthday) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthday);
  if (!m) return undefined;
  const [y, mo, d] = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  let age = now.getUTCFullYear() - y;
  const hadBirthday = now.getUTCMonth() + 1 > mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() >= d);
  if (!hadBirthday) age--;
  return age >= 0 && age < 130 ? age : undefined;
}

export interface Profile {
  id: string;
  email?: string;
  account_name?: string;
  first_name?: string;
  last_name?: string;
  gender?: "male" | "female";
  birthday?: string;
  age?: number;
  height_cm?: number;
  display_units?: { weight?: string; height?: string };
  athlete_mode?: boolean;
  waistline_cm?: number;
  hip_cm?: number;
  goals: {
    weight_kg?: number;
    weight_goal_date?: string;
    body_fat_pct?: number;
    initial_weight_kg?: number;
    initial_body_fat_pct?: number;
    reached_weight_goal?: boolean;
    reached_body_fat_goal?: boolean;
    daily_exercise?: unknown;
    sport_goal?: unknown;
    sleep_goal?: unknown;
  };
  app_last_measurement?: { time?: string; weight?: unknown };
  time_zone?: string;
  locale?: string;
  area_code?: string;
  language?: string;
  created_at?: string;
  user_uuid?: string;
  extra?: Record<string, unknown>;
}

const PROFILE_CONSUMED = new Set([
  "id",
  "email",
  "accountName",
  "firstName",
  "lastName",
  "gender",
  "birthday",
  "height",
  "heightUnit",
  "weightUnit",
  "personType",
  "waistline",
  "hip",
  "weightGoal",
  "currentGoalWeight",
  "weightGoalUnit",
  "weightGoalDate",
  "bodyfatGoal",
  "initialWeight",
  "initialBodyfat",
  "reachGoalWeightFlag",
  "reachGoalBodyfatFlag",
  "dailyExercise",
  "sportGoal",
  "sleepGoal",
  "measureLastTime",
  "measureLastWeight",
  "timeZone",
  "locale",
  "areaCode",
  "language",
  "createdAt",
  "userUuid",
]);

/** Shape the `login` object of the login response into a coaching profile. */
export function normalizeProfile(login: Record<string, unknown>, now: Date = new Date()): Profile {
  const genderCode = num(login.gender);
  const gender = genderCode === 1 ? "male" : genderCode === 0 ? "female" : undefined;
  const birthday = str(login.birthday);
  const weightUnit = num(login.weightUnit);
  const heightUnit = num(login.heightUnit);
  const personType = num(login.personType);

  const profile: Profile = {
    id: str(login.id) ?? "",
    email: str(login.email),
    account_name: str(login.accountName),
    first_name: str(login.firstName),
    last_name: str(login.lastName),
    gender,
    birthday,
    age: ageFromBirthday(birthday, now),
    height_cm: metric(login.height),
    display_units: compact({
      weight: weightUnit === undefined ? undefined : (WEIGHT_UNIT[weightUnit] ?? `unknown_${weightUnit}`),
      height: heightUnit === undefined ? undefined : (HEIGHT_UNIT[heightUnit] ?? `unknown_${heightUnit}`),
    }),
    athlete_mode: personType === undefined ? undefined : personType === 1,
    waistline_cm: metric(login.waistline),
    hip_cm: metric(login.hip),
    goals:
      compact({
        weight_kg: metric(login.weightGoal) ?? metric(login.currentGoalWeight),
        weight_goal_date: str(login.weightGoalDate),
        body_fat_pct: metric(login.bodyfatGoal),
        initial_weight_kg: metric(login.initialWeight),
        initial_body_fat_pct: metric(login.initialBodyfat),
        reached_weight_goal: bool(login.reachGoalWeightFlag),
        reached_body_fat_goal: bool(login.reachGoalBodyfatFlag),
        daily_exercise: login.dailyExercise ?? undefined,
        sport_goal: metric(login.sportGoal),
        sleep_goal: metric(login.sleepGoal),
      }) ?? {},
    app_last_measurement: compact({ time: str(login.measureLastTime), weight: metric(login.measureLastWeight) }),
    time_zone: str(login.timeZone),
    locale: str(login.locale),
    area_code: str(login.areaCode),
    language: str(login.language),
    created_at: str(login.createdAt),
    user_uuid: str(login.userUuid),
  };

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(login)) {
    if (PROFILE_DROP.has(k) || PROFILE_CONSUMED.has(k)) continue;
    if (v === null || v === undefined || v === "" || v === 0 || v === false) continue;
    extra[k] = v;
  }
  if (Object.keys(extra).length) profile.extra = extra;

  // Strip undefineds for a lean payload.
  return JSON.parse(JSON.stringify(profile)) as Profile;
}
