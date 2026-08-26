import { describe, it, expect } from "vitest";
import {
  METRIC_KEYS,
  ageFromBirthday,
  aggregateDaily,
  aggregateWeekly,
  classify,
  classifyBodyFat,
  normalizeMeasurement,
  normalizeProfile,
  pickMetrics,
  weekStartOf,
  type RawMeasurement,
} from "./measurements";

const TZ = "Europe/London";
// 2026-06-11T06:41:12Z = 07:41:12 BST
const T = 1781160072;

/** A record with every field the app's BodyScaleResponse model declares. */
function rawRecord(overrides: Partial<RawMeasurement> = {}): RawMeasurement {
  return {
    id: "5919278420902642176",
    timeStamp: T,
    localCreatedAt: "2026-06-11 07:41:12",
    timeZone: "Europe/London",
    internalModel: "ES-CS20M",
    scaleType: 1,
    scaleName: "Elis 1",
    mac: "AA:BB:CC:DD:EE:FF",
    gender: 1,
    height: 180,
    heightUnit: 1,
    birthday: "1990-05-04",
    waistline: 0,
    hip: 0,
    categoryType: 0,
    personType: 0,
    invalidFlag: 0,
    weight: 88.15,
    weightUnit: 1,
    bodyfat: 21.3,
    water: 55.2,
    bmr: 1890,
    bodyage: 31,
    muscle: 65.8,
    bone: 3.4,
    subfat: 18.9,
    visfat: 9,
    bmi: 27.2,
    sinew: 49.1,
    protein: 17.6,
    bodyShape: 5,
    fatFreeWeight: 69.4,
    resistance: 512,
    secResistance: 460,
    createdAt: "2026-06-11T06:41:20.000+00:00",
    updatedAt: "2026-06-11T06:41:20.000+00:00",
    actualResistance: 512,
    actualSecResistance: 460,
    heartRate: 0,
    cardiacIndex: 0,
    method: 18,
    sportFlag: 0,
    extraField: null,
    headValue: 0,
    headUnit: 0,
    babyPicture: null,
    deviceType: "00038",
    isAuto: 1,
    isNew: false,
    displayModuleType: 0,
    subUserId: "5245536005636456320",
    bUserId: "5245536005636456320",
    bodytype: 5,
    TW: 0,
    WC: 0,
    FC: 0,
    A1: 0,
    ...overrides,
  };
}

describe("normalizeMeasurement", () => {
  it("renames metrics with units, decodes enums, drops zero/noise, keeps unknowns in extra", () => {
    const m = normalizeMeasurement(rawRecord({ futureMetric: 12.5, TW: 3 }), TZ);
    expect(m).toMatchObject({
      id: "5919278420902642176",
      timestamp: T,
      time: "2026-06-11T07:41:12+01:00",
      date: "2026-06-11",
      weight_kg: 88.15,
      bmi: 27.2,
      body_fat_pct: 21.3,
      fat_free_mass_kg: 69.4,
      subcutaneous_fat_pct: 18.9,
      visceral_fat_level: 9,
      body_water_pct: 55.2,
      skeletal_muscle_pct: 49.1,
      muscle_mass_kg: 65.8,
      bone_mass_kg: 3.4,
      protein_pct: 17.6,
      bmr_kcal: 1890,
      metabolic_age: 31,
      body_type: "overweight",
      athlete_mode: false,
      impedance: { resistance: 512, sec_resistance: 460, actual_resistance: 512, actual_sec_resistance: 460 },
      source: { method: "cloud_wifi_auto_allocation", method_code: 18, model: "ES-CS20M", scale_name: "Elis 1", mac: "AA:BB:CC:DD:EE:FF", device_type: "00038", auto: true, invalid: false },
      user: { bound_user_id: "5245536005636456320", scale_user_id: "5245536005636456320" },
      extra: { futureMetric: 12.5, TW: 3 },
    });
    // Zero means "not measured" for optional metrics.
    expect(m).not.toHaveProperty("heart_rate_bpm");
    expect(m).not.toHaveProperty("cardiac_index");
    expect(m).not.toHaveProperty("waistline_cm");
    // Envelope noise never leaks into extra.
    expect(m.extra).not.toHaveProperty("createdAt");
    expect(m.extra).not.toHaveProperty("localCreatedAt");
    expect(m.extra).not.toHaveProperty("gender");
  });

  it("keeps heart rate when present and accepts numeric strings", () => {
    const m = normalizeMeasurement(rawRecord({ heartRate: 58, cardiacIndex: "3.1", personType: 1, bodyShape: undefined, bodytype: 2 }), TZ);
    expect(m.heart_rate_bpm).toBe(58);
    expect(m.cardiac_index).toBe(3.1);
    expect(m.athlete_mode).toBe(true);
    expect(m.body_type).toBe("athletic");
  });

  it("records which store the row came from and never leaks the tag into extra", () => {
    const body = normalizeMeasurement(rawRecord({ __endpoint: "bodyComposition", leftArmMuscle: 3.1 }), TZ);
    expect(body.source.endpoint).toBe("body_composition");
    expect(body.extra).toEqual({ leftArmMuscle: 3.1 });
    expect(normalizeMeasurement(rawRecord({ __endpoint: "legacy" }), TZ).source.endpoint).toBe("legacy");
    expect(normalizeMeasurement(rawRecord(), TZ).source.endpoint).toBeUndefined();
  });

  it("labels unknown enum codes instead of dropping them", () => {
    const m = normalizeMeasurement(rawRecord({ method: 99, bodyShape: 42 }), TZ);
    expect(m.source.method).toBe("unknown_99");
    expect(m.body_type).toBe("unknown_42");
  });

  it("throws on a record without weight/timestamp", () => {
    expect(() => normalizeMeasurement({ id: "1", weight: 80 }, TZ)).toThrow(/timeStamp/);
  });
});

describe("pickMetrics", () => {
  it("keeps identity fields plus the requested metrics only", () => {
    const m = normalizeMeasurement(rawRecord(), TZ);
    expect(pickMetrics(m, ["weight_kg", "body_fat_pct", "heart_rate_bpm"])).toEqual({
      id: "5919278420902642176",
      time: "2026-06-11T07:41:12+01:00",
      date: "2026-06-11",
      weight_kg: 88.15,
      body_fat_pct: 21.3,
    });
  });
});

describe("aggregateDaily / aggregateWeekly", () => {
  const DAY = 86_400;
  const records = [
    normalizeMeasurement(rawRecord({ id: "1", timeStamp: T, weight: 88.0, bodyfat: 21 }), TZ),
    normalizeMeasurement(rawRecord({ id: "2", timeStamp: T + 3600 * 12, weight: 89.0, bodyfat: 22 }), TZ), // same day, evening
    normalizeMeasurement(rawRecord({ id: "3", timeStamp: T - DAY, weight: 87.5, bodyfat: 0 }), TZ), // day before, no fat reading
    normalizeMeasurement(rawRecord({ id: "4", timeStamp: T - 8 * DAY, weight: 90.0 }), TZ), // previous ISO week
  ];

  it("averages per local day, ascending, omitting metrics with no readings", () => {
    const daily = aggregateDaily(records, ["weight_kg", "body_fat_pct"]);
    expect(daily.map((d) => d.date)).toEqual(["2026-06-03", "2026-06-10", "2026-06-11"]);
    expect(daily[2]).toMatchObject({ date: "2026-06-11", readings: 2, weight_kg: 88.5, body_fat_pct: 21.5 });
    expect(daily[1]).toMatchObject({ date: "2026-06-10", readings: 1, weight_kg: 87.5 });
    expect(daily[1]).not.toHaveProperty("body_fat_pct");
  });

  it("rolls up to Monday-anchored weeks", () => {
    expect(weekStartOf("2026-06-11")).toBe("2026-06-08"); // Thursday → Monday
    expect(weekStartOf("2026-06-08")).toBe("2026-06-08");
    expect(weekStartOf("2026-06-07")).toBe("2026-06-01"); // Sunday → previous Monday
    const weekly = aggregateWeekly(aggregateDaily(records, ["weight_kg"]), ["weight_kg"]);
    expect(weekly).toEqual([
      { week_start: "2026-06-01", days_with_readings: 1, readings: 1, weight_kg: 90 },
      { week_start: "2026-06-08", days_with_readings: 2, readings: 3, weight_kg: 88 },
    ]);
  });

  it("defaults to every metric key", () => {
    const daily = aggregateDaily(records);
    for (const key of ["weight_kg", "bmi", "body_water_pct"]) expect(daily[2]).toHaveProperty(key);
    expect(METRIC_KEYS).toContain("visceral_fat_level");
  });
});

describe("classification", () => {
  it("uses sex-specific body-fat ranges and omits them when sex is unknown", () => {
    expect(classifyBodyFat(21.3, "male")).toBe("average");
    expect(classifyBodyFat(21.3, "female")).toBe("fitness");
    expect(classifyBodyFat(21.3)).toBeUndefined();
  });

  it("classifies a full reading with notes", () => {
    const m = normalizeMeasurement(rawRecord({ personType: 1 }), TZ);
    const c = classify(m, { gender: "male", age: 36 });
    expect(c).toMatchObject({ bmi_category: "overweight", body_fat_category: "average", visceral_fat_category: "healthy", body_water_category: "normal" });
    expect(c.notes.join(" ")).toMatch(/Athlete mode/);
    expect(classify(m).notes.join(" ")).toMatch(/gender unknown/);
  });
});

describe("profile", () => {
  it("computes age from a birthday", () => {
    const now = new Date("2026-06-11T00:00:00Z");
    expect(ageFromBirthday("1990-05-04", now)).toBe(36);
    expect(ageFromBirthday("1990-06-12", now)).toBe(35);
    expect(ageFromBirthday("not-a-date", now)).toBeUndefined();
  });

  it("maps the login object to a profile, dropping secrets and plumbing", () => {
    const profile = normalizeProfile(
      {
        id: "5245536005636456320",
        email: "a@b.co",
        token: "SECRET",
        encryptedPassword: "SECRET",
        accountName: "Aidan",
        gender: 1,
        birthday: "1990-05-04",
        height: 180,
        heightUnit: 1,
        weightUnit: 3,
        personType: 0,
        weightGoal: 82,
        weightGoalDate: "2026-09-01",
        bodyfatGoal: 15,
        initialWeight: 95,
        initialBodyfat: 25,
        reachGoalWeightFlag: 0,
        sportGoal: 10000,
        sleepGoal: 8,
        measureLastTime: "2026-06-11 07:41:12",
        measureLastWeight: 88.15,
        timeZone: "Europe/London",
        locale: "en",
        areaCode: "GB",
        clientIp: "1.2.3.4",
        appRevision: "7.0.0",
        someNewField: "keep me",
        emptyField: "",
      },
      new Date("2026-06-11T00:00:00Z"),
    );
    expect(profile).toEqual({
      id: "5245536005636456320",
      email: "a@b.co",
      account_name: "Aidan",
      gender: "male",
      birthday: "1990-05-04",
      age: 36,
      height_cm: 180,
      display_units: { weight: "st_lb", height: "cm" },
      athlete_mode: false,
      goals: {
        weight_kg: 82,
        weight_goal_date: "2026-09-01",
        body_fat_pct: 15,
        initial_weight_kg: 95,
        initial_body_fat_pct: 25,
        reached_weight_goal: false,
        sport_goal: 10000,
        sleep_goal: 8,
      },
      app_last_measurement: { time: "2026-06-11 07:41:12", weight: 88.15 },
      time_zone: "Europe/London",
      locale: "en",
      area_code: "GB",
      extra: { someNewField: "keep me" },
    });
    expect(JSON.stringify(profile)).not.toContain("SECRET");
    expect(JSON.stringify(profile)).not.toContain("1.2.3.4");
  });
});
