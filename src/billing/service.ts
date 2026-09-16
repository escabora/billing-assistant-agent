// Use-cases composed from the repository + rating engine. Shared by the
// agent tools (interactive) and the InvoiceRun workflow (batch) so both
// paths produce identical numbers — the single most important property
// of a billing system.

import {
  elapsedDays,
  isCurrentPeriod,
  previousPeriod,
  resolvePeriod
} from "./period";
import type { BillingRepo } from "./repo";
import { findPlan, formatMoney, projectTotals, rateUsage } from "./rating";
import type {
  Catalog,
  Customer,
  Period,
  RatedInvoice,
  RatedLine
} from "./types";

export class CustomerNotFoundError extends Error {
  constructor(id: string) {
    super(`Customer '${id}' not found`);
  }
}

/** Compact, LLM-friendly view of a rated line. */
function presentLine(l: RatedLine, currency: string) {
  return {
    sku_id: l.sku_id,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    included: l.included_qty,
    billable: l.billable_qty,
    pct_of_allowance_used:
      l.sku_id && l.included_qty > 0
        ? Math.round((l.quantity / l.included_qty) * 100)
        : null,
    price:
      l.sku_id && l.unit_price_cents > 0
        ? `${formatMoney(l.unit_price_cents, currency)} per ${l.unit_size.toLocaleString("en-US")} ${l.unit}`
        : null,
    amount: formatMoney(l.amount_cents, currency),
    amount_cents: l.amount_cents
  };
}

function presentInvoice(
  rated: RatedInvoice,
  catalog: Catalog,
  currency: string
) {
  return {
    plan: findPlan(catalog, rated.plan_id).name,
    plan_id: rated.plan_id,
    lines: rated.lines.map((l) => presentLine(l, currency)),
    total: formatMoney(rated.total_cents, currency),
    total_cents: rated.total_cents
  };
}

export class BillingService {
  constructor(
    private readonly repo: BillingRepo,
    private readonly now: () => Date = () => new Date()
  ) {}

  private async loadCustomer(customerId: string): Promise<Customer> {
    const c = await this.repo.getCustomer(customerId);
    if (!c) throw new CustomerNotFoundError(customerId);
    return c;
  }

  resolvePeriod(input?: string): Period {
    return resolvePeriod(input, this.now());
  }

  /** Aggregated + rated usage for a period, with a month-end projection if the period is open. */
  async usageSummary(customerId: string, periodInput?: string) {
    const [customer, catalog] = await Promise.all([
      this.loadCustomer(customerId),
      this.repo.getCatalog()
    ]);
    const period = this.resolvePeriod(periodInput);
    const totals = await this.repo.getUsageTotals(customerId, period);
    const rated = rateUsage(catalog, customer.plan_id, totals);
    const open = isCurrentPeriod(period, this.now());
    const elapsed = elapsedDays(period, this.now());

    let projection: ReturnType<typeof presentInvoice> | null = null;
    if (open && elapsed > 0 && elapsed < period.days_in_month) {
      const projected = rateUsage(
        catalog,
        customer.plan_id,
        projectTotals(catalog, totals, elapsed, period.days_in_month)
      );
      projection = presentInvoice(projected, catalog, customer.currency);
    }

    return {
      customer: { id: customer.id, name: customer.name },
      period: period.id,
      period_status: open
        ? `open — ${elapsed} of ${period.days_in_month} days elapsed`
        : "closed",
      raw_events_aggregated: totals.reduce((n, t) => n + t.event_count, 0),
      ...presentInvoice(rated, catalog, customer.currency),
      projected_month_end: projection
    };
  }

  /** Same usage, priced under a different plan. Pure what-if — nothing is written. */
  async simulatePlanChange(
    customerId: string,
    targetPlanId: string,
    periodInput?: string
  ) {
    const [customer, catalog] = await Promise.all([
      this.loadCustomer(customerId),
      this.repo.getCatalog()
    ]);
    const period = this.resolvePeriod(periodInput);
    const totals = await this.repo.getUsageTotals(customerId, period);

    const current = rateUsage(catalog, customer.plan_id, totals);
    const target = rateUsage(catalog, targetPlanId, totals); // throws UnknownPlanError
    const delta = target.total_cents - current.total_cents;

    return {
      customer: { id: customer.id, name: customer.name },
      period: period.id,
      current: presentInvoice(current, catalog, customer.currency),
      simulated: presentInvoice(target, catalog, customer.currency),
      difference: formatMoney(delta, customer.currency),
      difference_cents: delta,
      verdict:
        delta < 0
          ? `Switching to ${findPlan(catalog, targetPlanId).name} would have saved ${formatMoney(-delta, customer.currency)} for ${period.id}.`
          : delta > 0
            ? `Switching to ${findPlan(catalog, targetPlanId).name} would have cost ${formatMoney(delta, customer.currency)} more for ${period.id}.`
            : `No difference for ${period.id}.`
    };
  }

  /** Month-over-month comparison per SKU to explain why a bill changed. */
  async comparePeriods(customerId: string, periodInput?: string) {
    const [customer, catalog] = await Promise.all([
      this.loadCustomer(customerId),
      this.repo.getCatalog()
    ]);
    const period = this.resolvePeriod(periodInput);
    const prev = previousPeriod(period);
    const [curTotals, prevTotals] = await Promise.all([
      this.repo.getUsageTotals(customerId, period),
      this.repo.getUsageTotals(customerId, prev)
    ]);
    const cur = rateUsage(catalog, customer.plan_id, curTotals);
    const before = rateUsage(catalog, customer.plan_id, prevTotals);

    const lines = cur.lines
      .filter((l) => l.sku_id)
      .map((l) => {
        const p = before.lines.find((b) => b.sku_id === l.sku_id)!;
        const qtyChange =
          p.quantity === 0
            ? null
            : Math.round(((l.quantity - p.quantity) / p.quantity) * 100);
        return {
          sku_id: l.sku_id,
          description: l.description,
          unit: l.unit,
          previous_qty: p.quantity,
          current_qty: l.quantity,
          qty_change_pct: qtyChange,
          previous_amount: formatMoney(p.amount_cents, customer.currency),
          current_amount: formatMoney(l.amount_cents, customer.currency),
          amount_delta_cents: l.amount_cents - p.amount_cents
        };
      })
      .sort(
        (a, b) =>
          Math.abs(b.amount_delta_cents) - Math.abs(a.amount_delta_cents)
      );

    return {
      customer: { id: customer.id, name: customer.name },
      previous_period: prev.id,
      current_period: period.id,
      note: isCurrentPeriod(period, this.now())
        ? "Current period is still open; quantities are month-to-date."
        : undefined,
      previous_total: formatMoney(before.total_cents, customer.currency),
      current_total: formatMoney(cur.total_cents, customer.currency),
      total_delta: formatMoney(
        cur.total_cents - before.total_cents,
        customer.currency
      ),
      lines_by_impact: lines
    };
  }

  /** Daily series for one SKU, flagging days > 2x the period median (spike detection). */
  async dailyUsage(customerId: string, skuId: string, periodInput?: string) {
    await this.loadCustomer(customerId);
    const period = this.resolvePeriod(periodInput);
    const rows = await this.repo.getDailyUsage(customerId, period, skuId);
    const qty = rows.map((r) => r.quantity).sort((a, b) => a - b);
    const median = qty.length ? qty[Math.floor(qty.length / 2)] : 0;
    return {
      period: period.id,
      sku_id: skuId,
      median_per_day: median,
      anomalous_days: rows
        .filter((r) => median > 0 && r.quantity > 2 * median)
        .map((r) => ({
          day: r.day,
          quantity: r.quantity,
          multiple_of_median: Number((r.quantity / median).toFixed(1))
        })),
      series: rows.map((r) => ({ day: r.day, quantity: r.quantity }))
    };
  }

  async plans() {
    const catalog = await this.repo.getCatalog();
    return catalog.plans.map((p) => ({
      id: p.id,
      name: p.name,
      base_fee: formatMoney(p.base_fee_cents),
      includes: catalog.prices
        .filter((pr) => pr.plan_id === p.id)
        .map((pr) => {
          const sku = catalog.skus.find((s) => s.id === pr.sku_id)!;
          return {
            sku_id: sku.id,
            included: `${pr.included_qty.toLocaleString("en-US")} ${sku.unit}`,
            overage:
              pr.unit_price_cents > 0
                ? `${formatMoney(pr.unit_price_cents)} per ${sku.unit_size.toLocaleString("en-US")} ${sku.unit}`
                : "not available beyond allowance"
          };
        })
    }));
  }

  /** Rate a closed period for persistence. Used by the InvoiceRun workflow. */
  async rateForInvoice(
    customerId: string,
    periodId: string
  ): Promise<RatedInvoice> {
    const [customer, catalog] = await Promise.all([
      this.loadCustomer(customerId),
      this.repo.getCatalog()
    ]);
    const period = this.resolvePeriod(periodId);
    const totals = await this.repo.getUsageTotals(customerId, period);
    return rateUsage(catalog, customer.plan_id, totals);
  }
}
