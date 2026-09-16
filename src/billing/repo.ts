// D1 access layer. The only place SQL lives. Everything returns plain
// domain objects so the rating engine and tools stay testable without a DB.

import type {
  Catalog,
  Customer,
  Period,
  Plan,
  PlanPrice,
  RatedInvoice,
  Sku,
  UsageTotal
} from "./types";

export interface DailyUsage {
  day: string; // YYYY-MM-DD
  sku_id: string;
  quantity: number;
}

export interface InvoiceRow {
  id: string;
  customer_id: string;
  period: string;
  plan_id: string;
  status: string;
  subtotal_cents: number;
  total_cents: number;
  created_at: string;
}

export class BillingRepo {
  constructor(private readonly db: D1Database) {}

  async listCustomers(): Promise<Customer[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM customers ORDER BY name")
      .all<Customer>();
    return results;
  }

  async getCustomer(id: string): Promise<Customer | null> {
    return this.db
      .prepare("SELECT * FROM customers WHERE id = ?")
      .bind(id)
      .first<Customer>();
  }

  async getCatalog(): Promise<Catalog> {
    const [plans, skus, prices] = await this.db.batch([
      this.db.prepare("SELECT * FROM plans ORDER BY base_fee_cents"),
      this.db.prepare("SELECT * FROM skus ORDER BY id"),
      this.db.prepare("SELECT * FROM plan_prices")
    ]);
    return {
      plans: plans.results as Plan[],
      skus: skus.results as Sku[],
      prices: prices.results as PlanPrice[]
    };
  }

  /**
   * The aggregation query. Rolls raw metering events up to one row per SKU
   * for the period. Uses idx_usage_customer_time.
   */
  async getUsageTotals(
    customerId: string,
    period: Period
  ): Promise<UsageTotal[]> {
    const { results } = await this.db
      .prepare(
        `SELECT sku_id,
                SUM(quantity)                              AS total_qty,
                COUNT(DISTINCT substr(occurred_at, 1, 10)) AS sample_days,
                COUNT(*)                                   AS event_count
           FROM usage_events
          WHERE customer_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3
          GROUP BY sku_id`
      )
      .bind(customerId, period.start, period.end)
      .all<UsageTotal>();
    return results;
  }

  /** Per-day totals — used to explain spikes and trends. */
  async getDailyUsage(
    customerId: string,
    period: Period,
    skuId?: string
  ): Promise<DailyUsage[]> {
    const sql = `SELECT substr(occurred_at, 1, 10) AS day, sku_id, SUM(quantity) AS quantity
                   FROM usage_events
                  WHERE customer_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3
                    ${skuId ? "AND sku_id = ?4" : ""}
                  GROUP BY day, sku_id
                  ORDER BY day`;
    const stmt = this.db.prepare(sql);
    const bound = skuId
      ? stmt.bind(customerId, period.start, period.end, skuId)
      : stmt.bind(customerId, period.start, period.end);
    const { results } = await bound.all<DailyUsage>();
    return results;
  }

  async listInvoices(customerId: string): Promise<InvoiceRow[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM invoices WHERE customer_id = ? ORDER BY period DESC"
      )
      .bind(customerId)
      .all<InvoiceRow>();
    return results;
  }

  async getInvoice(
    customerId: string,
    periodId: string
  ): Promise<InvoiceRow | null> {
    return this.db
      .prepare("SELECT * FROM invoices WHERE customer_id = ? AND period = ?")
      .bind(customerId, periodId)
      .first<InvoiceRow>();
  }

  /**
   * Persist a rated invoice. Idempotent: re-running for the same
   * (customer, period) replaces the draft instead of duplicating it. All
   * statements go in one batch, which D1 executes atomically.
   */
  async saveInvoice(
    customerId: string,
    periodId: string,
    rated: RatedInvoice
  ): Promise<string> {
    const id = `inv_${customerId.replace(/^cus_/, "")}_${periodId}`;
    const now = new Date().toISOString();
    const stmts: D1PreparedStatement[] = [
      this.db
        .prepare("DELETE FROM invoice_lines WHERE invoice_id = ?")
        .bind(id),
      this.db
        .prepare(
          `INSERT INTO invoices (id, customer_id, period, plan_id, status, subtotal_cents, total_cents, created_at)
           VALUES (?1, ?2, ?3, ?4, 'finalized', ?5, ?6, ?7)
           ON CONFLICT(customer_id, period) DO UPDATE SET
             plan_id = excluded.plan_id, status = excluded.status,
             subtotal_cents = excluded.subtotal_cents, total_cents = excluded.total_cents,
             created_at = excluded.created_at`
        )
        .bind(
          id,
          customerId,
          periodId,
          rated.plan_id,
          rated.subtotal_cents,
          rated.total_cents,
          now
        )
    ];
    for (const l of rated.lines) {
      stmts.push(
        this.db
          .prepare(
            `INSERT INTO invoice_lines (invoice_id, sku_id, description, quantity, included_qty, billable_qty, amount_cents)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
          )
          .bind(
            id,
            l.sku_id,
            l.description,
            l.quantity,
            l.included_qty,
            l.billable_qty,
            l.amount_cents
          )
      );
    }
    await this.db.batch(stmts);
    return id;
  }
}
