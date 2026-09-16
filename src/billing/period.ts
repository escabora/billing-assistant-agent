import type { Period } from "./types";

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Build a calendar-month billing period from 'YYYY-MM'. Throws on bad input. */
export function periodFromId(id: string): Period {
  const m = PERIOD_RE.exec(id);
  if (!m) throw new Error(`Invalid period '${id}', expected YYYY-MM`);
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return {
    id,
    start: start.toISOString(),
    end: end.toISOString(),
    days_in_month: Math.round((end.getTime() - start.getTime()) / 86_400_000)
  };
}

export function periodIdFor(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function currentPeriod(now = new Date()): Period {
  return periodFromId(periodIdFor(now));
}

export function previousPeriod(period: Period): Period {
  const d = new Date(period.start);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return periodFromId(periodIdFor(d));
}

/**
 * Resolve loose user phrasing ("this month", "last month", "2026-08",
 * "August") into a Period. The LLM usually passes YYYY-MM already; this
 * is the safety net.
 */
export function resolvePeriod(
  input: string | undefined,
  now = new Date()
): Period {
  const s = (input ?? "").trim().toLowerCase();
  if (!s || s === "this month" || s === "current" || s === "mtd")
    return currentPeriod(now);
  if (s === "last month" || s === "previous month")
    return previousPeriod(currentPeriod(now));
  if (PERIOD_RE.test(s)) return periodFromId(s);

  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december"
  ];
  const idx = months.findIndex((m) => s.startsWith(m.slice(0, 3)));
  if (idx >= 0) {
    const yearMatch = /(\d{4})/.exec(s);
    const year = yearMatch ? Number(yearMatch[1]) : now.getUTCFullYear();
    return periodFromId(`${year}-${String(idx + 1).padStart(2, "0")}`);
  }
  throw new Error(`Could not understand period '${input}'. Use YYYY-MM.`);
}

/** Days of the period that have elapsed so far (0..days_in_month). */
export function elapsedDays(period: Period, now = new Date()): number {
  const start = new Date(period.start).getTime();
  const end = new Date(period.end).getTime();
  const t = Math.min(now.getTime(), end);
  if (t <= start) return 0;
  return Math.min(period.days_in_month, Math.ceil((t - start) / 86_400_000));
}

export function isCurrentPeriod(period: Period, now = new Date()): boolean {
  return period.id === periodIdFor(now);
}
