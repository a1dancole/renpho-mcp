/**
 * Pure date helpers. Renpho measurements carry a unix `timeStamp` (seconds);
 * the tools accept civil dates ("YYYY-MM-DD") in the user's timezone. Every
 * conversion between the two lives here, free of I/O, so it can be unit
 * tested — the UTC-midnight bug class is exactly what bit the Google Health
 * server.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate and split "YYYY-MM-DD". */
export function parseIsoDate(iso: string): { year: number; month: number; day: number } {
  if (!ISO_DATE_RE.test(iso)) throw new Error(`Invalid date "${iso}" — expected YYYY-MM-DD`);
  const [year, month, day] = iso.split("-").map((n) => parseInt(n, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid date "${iso}" — expected YYYY-MM-DD`);
  }
  return { year, month, day };
}

/** The day after `isoDate`, used to turn an inclusive end into an exclusive bound. */
export function nextDayIso(isoDate: string): string {
  const { year, month, day } = parseIsoDate(isoDate);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" for an instant, as seen in the given IANA timezone. */
export function isoInTz(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD; the timeZone option shifts the calendar day.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** "YYYY-MM-DD" for today, in the given timezone. */
export function todayIso(timeZone: string, now: Date = new Date()): string {
  return isoInTz(now, timeZone);
}

/** "YYYY-MM-DD" for a date N days before today, in the given timezone. */
export function isoDaysAgo(days: number, timeZone: string, now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return isoInTz(d, timeZone);
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** Wall-clock components of a UTC instant in the given timezone. */
export function wallClock(utcMs: number, timeZone: string): WallClock {
  const parts = wallClockFormatter(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const hour = get("hour");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    // Some engines render midnight as "24" even with hourCycle h23.
    hour: hour === 24 ? 0 : hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` from UTC at the given instant, in minutes (east = positive). */
export function tzOffsetMinutes(utcMs: number, timeZone: string): number {
  const w = wallClock(utcMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const wholeSeconds = Math.floor(utcMs / 1000) * 1000;
  return Math.round((asUtc - wholeSeconds) / 60_000);
}

/** UTC epoch milliseconds of local midnight on `isoDate` in `timeZone`. */
export function zonedMidnightMs(isoDate: string, timeZone: string): number {
  const { year, month, day } = parseIsoDate(isoDate);
  const guess = Date.UTC(year, month - 1, day);
  // First-pass offset, then re-check at the candidate instant so a DST
  // transition on that very night still resolves to the right offset.
  const off1 = tzOffsetMinutes(guess, timeZone);
  let ms = guess - off1 * 60_000;
  const off2 = tzOffsetMinutes(ms, timeZone);
  if (off2 !== off1) ms = guess - off2 * 60_000;
  return ms;
}

/**
 * Epoch-second bounds for an inclusive civil date range in `timeZone`:
 * `[startSec, endSec)` — start inclusive, end exclusive (local midnight after
 * the end date).
 */
export function civilRangeToEpochSeconds(
  startDate: string,
  endDateInclusive: string,
  timeZone: string,
): { startSec: number; endSec: number } {
  if (endDateInclusive < startDate) {
    throw new Error(`end_date ${endDateInclusive} is before start_date ${startDate}`);
  }
  return {
    startSec: Math.floor(zonedMidnightMs(startDate, timeZone) / 1000),
    endSec: Math.floor(zonedMidnightMs(nextDayIso(endDateInclusive), timeZone) / 1000),
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** RFC-3339 local timestamp with offset, e.g. "2026-08-26T07:41:12+01:00". */
export function localIso(epochSeconds: number, timeZone: string): string {
  const ms = epochSeconds * 1000;
  const w = wallClock(ms, timeZone);
  const off = tzOffsetMinutes(ms, timeZone);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return (
    `${w.year}-${pad2(w.month)}-${pad2(w.day)}T${pad2(w.hour)}:${pad2(w.minute)}:${pad2(w.second)}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** "YYYY-MM-DD" of an epoch-second instant in `timeZone`. */
export function localDate(epochSeconds: number, timeZone: string): string {
  return isoInTz(new Date(epochSeconds * 1000), timeZone);
}

/** Whole calendar days between two ISO dates (b - a). */
export function daysBetween(aIso: string, bIso: string): number {
  const a = parseIsoDate(aIso);
  const b = parseIsoDate(bIso);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}
