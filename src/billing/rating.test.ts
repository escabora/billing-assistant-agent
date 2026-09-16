import { describe, expect, it } from "vitest";
import {
  aggregateQuantity,
  projectTotals,
  rateLine,
  rateUsage,
  UnknownPlanError
} from "./rating";
import {
  elapsedDays,
  periodFromId,
  previousPeriod,
  resolvePeriod
} from "./period";
import type { Catalog, Sku, UsageTotal } from "./types";

const requests: Sku = {
  id: "workers_requests",
  name: "Workers requests",
  unit: "requests",
  unit_size: 1_000_000,
  aggregation: "sum"
};
const storage: Sku = {
  id: "r2_storage_gb_month",
  name: "R2 storage",
  unit: "GB-month",
  unit_size: 1,
  aggregation: "avg_daily"
};

const catalog: Catalog = {
  plans: [
    { id: "free", name: "Free", base_fee_cents: 0 },
    { id: "pro", name: "Pro", base_fee_cents: 2000 }
  ],
  skus: [requests, storage],
  prices: [
    {
      plan_id: "free",
      sku_id: "workers_requests",
      included_qty: 3_000_000,
      unit_price_cents: 0
    },
    {
      plan_id: "free",
      sku_id: "r2_storage_gb_month",
      included_qty: 10,
      unit_price_cents: 0
    },
    {
      plan_id: "pro",
      sku_id: "workers_requests",
      included_qty: 10_000_000,
      unit_price_cents: 30
    },
    {
      plan_id: "pro",
      sku_id: "r2_storage_gb_month",
      included_qty: 10,
      unit_price_cents: 2
    }
  ]
};

const usage = (
  sku_id: string,
  total_qty: number,
  sample_days = 30
): UsageTotal => ({
  sku_id,
  total_qty,
  sample_days,
  event_count: sample_days * 4
});

describe("aggregateQuantity", () => {
  it("sums counters", () => {
    expect(aggregateQuantity(requests, usage("workers_requests", 12_345))).toBe(
      12_345
    );
  });
  it("averages gauges over sampled days (GB -> GB-month)", () => {
    expect(
      aggregateQuantity(storage, usage("r2_storage_gb_month", 300, 30))
    ).toBe(10);
    // partial month: 15 samples averaging 40 GB => 40 GB-month, not 20
    expect(
      aggregateQuantity(storage, usage("r2_storage_gb_month", 600, 15))
    ).toBe(40);
  });
  it("returns 0 with no events", () => {
    expect(aggregateQuantity(requests, undefined)).toBe(0);
  });
});

describe("rateLine", () => {
  const price = catalog.prices[2]; // pro / requests
  it("charges nothing inside the allowance", () => {
    const l = rateLine(requests, price, 9_999_999);
    expect(l.billable_qty).toBe(0);
    expect(l.amount_cents).toBe(0);
  });
  it("rounds partial pricing units UP", () => {
    // 10.5M requests -> 0.5M over -> 1 unit -> 30 cents
    expect(rateLine(requests, price, 10_500_000).amount_cents).toBe(30);
    // exactly 2M over -> 2 units
    expect(rateLine(requests, price, 12_000_000).amount_cents).toBe(60);
    // 2M + 1 over -> 3 units
    expect(rateLine(requests, price, 12_000_001).amount_cents).toBe(90);
  });
});

describe("rateUsage", () => {
  it("adds the base fee and one line per SKU offered by the plan", () => {
    const inv = rateUsage(catalog, "pro", [
      usage("workers_requests", 13_000_000),
      usage("r2_storage_gb_month", 900)
    ]);
    expect(inv.lines).toHaveLength(3);
    expect(inv.lines[0].sku_id).toBeNull();
    expect(inv.lines[0].amount_cents).toBe(2000);
    // 3M over -> 3 * 30 = 90 ; storage 30 GB-month -> 20 over * 2 = 40
    expect(inv.total_cents).toBe(2000 + 90 + 40);
  });
  it("prices unused SKUs at zero so the customer sees their allowance", () => {
    const inv = rateUsage(catalog, "pro", []);
    expect(inv.total_cents).toBe(2000);
    expect(
      inv.lines.filter((l) => l.sku_id).every((l) => l.quantity === 0)
    ).toBe(true);
  });
  it("is deterministic: same input, same output (invoice run idempotency)", () => {
    const totals = [usage("workers_requests", 10_500_000)];
    expect(rateUsage(catalog, "pro", totals)).toEqual(
      rateUsage(catalog, "pro", totals)
    );
  });
  it("rejects unknown plans", () => {
    expect(() => rateUsage(catalog, "enterprise", [])).toThrow(
      UnknownPlanError
    );
  });
});

describe("projectTotals", () => {
  it("scales counters linearly but leaves gauges alone", () => {
    const projected = projectTotals(
      catalog,
      [
        usage("workers_requests", 5_000_000, 15),
        usage("r2_storage_gb_month", 600, 15)
      ],
      15,
      30
    );
    expect(projected[0].total_qty).toBe(10_000_000);
    expect(projected[1].total_qty).toBe(600);
  });
});

describe("period helpers", () => {
  const now = new Date("2026-09-16T10:00:00Z");
  it("builds calendar months with correct day counts", () => {
    expect(periodFromId("2026-02")).toMatchObject({
      start: "2026-02-01T00:00:00.000Z",
      end: "2026-03-01T00:00:00.000Z",
      days_in_month: 28
    });
    expect(periodFromId("2026-08").days_in_month).toBe(31);
  });
  it("resolves loose phrasing", () => {
    expect(resolvePeriod(undefined, now).id).toBe("2026-09");
    expect(resolvePeriod("last month", now).id).toBe("2026-08");
    expect(resolvePeriod("August", now).id).toBe("2026-08");
    expect(resolvePeriod("aug 2025", now).id).toBe("2025-08");
    expect(resolvePeriod("2026-07", now).id).toBe("2026-07");
    expect(() => resolvePeriod("yesterday", now)).toThrow();
    expect(() => periodFromId("2026-13")).toThrow();
  });
  it("walks backwards across a year boundary", () => {
    expect(previousPeriod(periodFromId("2026-01")).id).toBe("2025-12");
  });
  it("counts elapsed days, capped at the month length", () => {
    expect(elapsedDays(periodFromId("2026-09"), now)).toBe(16);
    expect(elapsedDays(periodFromId("2026-08"), now)).toBe(31);
    expect(elapsedDays(periodFromId("2026-10"), now)).toBe(0);
  });
});
