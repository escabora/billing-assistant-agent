// Rating engine: pure functions, no I/O. Given aggregated usage totals and
// a catalog, produce priced invoice lines.
//
// Rules (kept deliberately simple and explicit — these are the ones the
// assistant explains to customers):
//   1. quantity      = aggregated usage for the period (sum, or daily
//                      average for gauges such as GB stored)
//   2. billable_qty  = max(0, quantity - included_qty)
//   3. units         = ceil(billable_qty / unit_size)   (partial units round UP)
//   4. amount_cents  = units * unit_price_cents
//   5. total         = base fee + sum(line amounts)

import type {
  Catalog,
  Plan,
  PlanPrice,
  RatedInvoice,
  RatedLine,
  Sku,
  UsageTotal
} from "./types";

export class UnknownPlanError extends Error {
  constructor(planId: string) {
    super(`Unknown plan '${planId}'`);
  }
}

/** Turn raw totals into the billable quantity according to the SKU's aggregation. */
export function aggregateQuantity(
  sku: Sku,
  usage: UsageTotal | undefined
): number {
  if (!usage || usage.event_count === 0) return 0;
  switch (sku.aggregation) {
    case "sum":
      return usage.total_qty;
    case "avg_daily":
      // Gauge sampled once per day: mean over the days we have samples for.
      return Math.round(usage.total_qty / Math.max(1, usage.sample_days));
  }
}

export function rateLine(
  sku: Sku,
  price: PlanPrice,
  quantity: number
): RatedLine {
  const billable = Math.max(0, quantity - price.included_qty);
  const units = Math.ceil(billable / sku.unit_size);
  return {
    sku_id: sku.id,
    description: sku.name,
    unit: sku.unit,
    quantity,
    included_qty: price.included_qty,
    billable_qty: billable,
    unit_price_cents: price.unit_price_cents,
    unit_size: sku.unit_size,
    amount_cents: units * price.unit_price_cents
  };
}

export function findPlan(catalog: Catalog, planId: string): Plan {
  const plan = catalog.plans.find((p) => p.id === planId);
  if (!plan) throw new UnknownPlanError(planId);
  return plan;
}

/**
 * Rate a period's usage under a given plan. Every SKU in the catalog gets a
 * line (with zero quantity if unused) so the customer can see their
 * remaining allowance, not just what they were charged for.
 */
export function rateUsage(
  catalog: Catalog,
  planId: string,
  totals: UsageTotal[]
): RatedInvoice {
  const plan = findPlan(catalog, planId);
  const byId = new Map(totals.map((t) => [t.sku_id, t]));

  const lines: RatedLine[] = [
    {
      sku_id: null,
      description: `${plan.name} plan base fee`,
      unit: "month",
      quantity: 1,
      included_qty: 0,
      billable_qty: 1,
      unit_price_cents: plan.base_fee_cents,
      unit_size: 1,
      amount_cents: plan.base_fee_cents
    }
  ];

  for (const sku of catalog.skus) {
    const price = catalog.prices.find(
      (p) => p.plan_id === planId && p.sku_id === sku.id
    );
    if (!price) continue; // plan doesn't offer this SKU
    lines.push(rateLine(sku, price, aggregateQuantity(sku, byId.get(sku.id))));
  }

  const subtotal = lines.reduce((acc, l) => acc + l.amount_cents, 0);
  return {
    plan_id: planId,
    lines,
    subtotal_cents: subtotal,
    total_cents: subtotal
  };
}

/**
 * Linear projection of month-to-date usage to a full month. Gauges
 * (avg_daily) are not scaled — an average is already month-independent.
 */
export function projectTotals(
  catalog: Catalog,
  totals: UsageTotal[],
  elapsedDays: number,
  daysInMonth: number
): UsageTotal[] {
  if (elapsedDays <= 0) return totals;
  const factor = daysInMonth / elapsedDays;
  return totals.map((t) => {
    const sku = catalog.skus.find((s) => s.id === t.sku_id);
    if (sku?.aggregation === "avg_daily") return t;
    return { ...t, total_qty: Math.round(t.total_qty * factor) };
  });
}

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    cents / 100
  );
}
