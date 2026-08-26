import { describe, it, expect } from "vitest";
import {
  civilRangeToEpochSeconds,
  daysBetween,
  isoDaysAgo,
  isoInTz,
  localDate,
  localIso,
  nextDayIso,
  parseIsoDate,
  todayIso,
  tzOffsetMinutes,
  zonedMidnightMs,
} from "./dates";

const utc = (s: string) => Date.parse(s);

describe("parseIsoDate / nextDayIso", () => {
  it("parses and validates", () => {
    expect(parseIsoDate("2026-06-11")).toEqual({ year: 2026, month: 6, day: 11 });
    expect(() => parseIsoDate("2026/06/11")).toThrow();
    expect(() => parseIsoDate("2026-13-01")).toThrow();
  });

  it("advances one day across month/year/leap boundaries", () => {
    expect(nextDayIso("2026-06-30")).toBe("2026-07-01");
    expect(nextDayIso("2026-12-31")).toBe("2027-01-01");
    expect(nextDayIso("2028-02-28")).toBe("2028-02-29");
  });
});

describe("isoInTz / todayIso / isoDaysAgo (the UTC-midnight bug class)", () => {
  // 23:30Z is already the next calendar day in London (BST = UTC+1).
  const instant = new Date("2026-06-11T23:30:00Z");

  it("formats per timezone, not per UTC", () => {
    expect(isoInTz(instant, "UTC")).toBe("2026-06-11");
    expect(isoInTz(instant, "Europe/London")).toBe("2026-06-12");
    expect(isoInTz(instant, "America/New_York")).toBe("2026-06-11");
  });

  it("todayIso / isoDaysAgo honour the injected now", () => {
    const now = new Date("2026-06-11T10:00:00Z");
    expect(todayIso("Europe/London", now)).toBe("2026-06-11");
    expect(isoDaysAgo(7, "Europe/London", now)).toBe("2026-06-04");
    expect(isoDaysAgo(0, "Europe/London", now)).toBe("2026-06-11");
  });
});

describe("tzOffsetMinutes", () => {
  it("knows BST, GMT and a negative offset", () => {
    expect(tzOffsetMinutes(utc("2026-06-11T12:00:00Z"), "Europe/London")).toBe(60);
    expect(tzOffsetMinutes(utc("2026-01-11T12:00:00Z"), "Europe/London")).toBe(0);
    expect(tzOffsetMinutes(utc("2026-06-11T12:00:00Z"), "America/New_York")).toBe(-240);
    expect(tzOffsetMinutes(utc("2026-06-11T12:00:00Z"), "Asia/Kolkata")).toBe(330);
  });
});

describe("zonedMidnightMs / civilRangeToEpochSeconds", () => {
  it("resolves local midnight in summer and winter", () => {
    expect(zonedMidnightMs("2026-06-11", "Europe/London")).toBe(utc("2026-06-10T23:00:00Z"));
    expect(zonedMidnightMs("2026-01-11", "Europe/London")).toBe(utc("2026-01-11T00:00:00Z"));
    expect(zonedMidnightMs("2026-06-11", "America/New_York")).toBe(utc("2026-06-11T04:00:00Z"));
  });

  it("handles the DST transition night (London, 2026-03-29 clocks go forward)", () => {
    // Midnight on the 29th is still GMT; midnight on the 30th is BST.
    expect(zonedMidnightMs("2026-03-29", "Europe/London")).toBe(utc("2026-03-29T00:00:00Z"));
    expect(zonedMidnightMs("2026-03-30", "Europe/London")).toBe(utc("2026-03-29T23:00:00Z"));
    const { startSec, endSec } = civilRangeToEpochSeconds("2026-03-29", "2026-03-29", "Europe/London");
    expect(endSec - startSec).toBe(23 * 3600); // a 23-hour day
  });

  it("builds a closed-open range from an inclusive civil range", () => {
    const { startSec, endSec } = civilRangeToEpochSeconds("2026-06-01", "2026-06-07", "Europe/London");
    expect(startSec).toBe(utc("2026-05-31T23:00:00Z") / 1000);
    expect(endSec).toBe(utc("2026-06-07T23:00:00Z") / 1000);
  });

  it("rejects an end before the start", () => {
    expect(() => civilRangeToEpochSeconds("2026-06-07", "2026-06-01", "UTC")).toThrow(/before start_date/);
  });
});

describe("localIso / localDate", () => {
  it("renders RFC-3339 with the zone's offset", () => {
    const t = utc("2026-06-11T06:41:12Z") / 1000;
    expect(localIso(t, "Europe/London")).toBe("2026-06-11T07:41:12+01:00");
    expect(localIso(t, "America/New_York")).toBe("2026-06-11T02:41:12-04:00");
    expect(localIso(t, "UTC")).toBe("2026-06-11T06:41:12+00:00");
    expect(localDate(t, "Asia/Tokyo")).toBe("2026-06-11");
  });
});

describe("daysBetween", () => {
  it("counts whole days", () => {
    expect(daysBetween("2026-06-01", "2026-06-08")).toBe(7);
    expect(daysBetween("2026-06-08", "2026-06-01")).toBe(-7);
  });
});
