// Domain types shared by the rating engine, the D1 repository, the agent
// tools and the InvoiceRun workflow. Money is always integer cents.

export type Aggregation = "sum" | "avg_daily";

export interface Plan {
  id: string;
  name: string;
  base_fee_cents: number;
}

export interface Sku {
  id: string;
  name: string;
  unit: string;
  unit_size: number;
  aggregation: Aggregation;
}

export interface PlanPrice {
  plan_id: string;
  sku_id: string;
  included_qty: number;
  unit_price_cents: number;
}

export interface Customer {
  id: string;
  name: string;
  plan_id: string;
  currency: string;
  created_at: string;
}

/** Everything static needed to price usage. Loaded once per request. */
export interface Catalog {
  plans: Plan[];
  skus: Sku[];
  prices: PlanPrice[];
}

/** Output of the aggregation query for one SKU in one period. */
export interface UsageTotal {
  sku_id: string;
  total_qty: number; // sum of all samples in the period
  sample_days: number; // distinct days that had at least one sample
  event_count: number;
}

/** A priced line on an invoice / usage summary. */
export interface RatedLine {
  sku_id: string | null; // null => base fee
  description: string;
  unit: string;
  quantity: number; // billable quantity after aggregation (e.g. GB-month)
  included_qty: number;
  billable_qty: number; // max(0, quantity - included)
  unit_price_cents: number;
  unit_size: number;
  amount_cents: number;
}

export interface RatedInvoice {
  plan_id: string;
  lines: RatedLine[];
  subtotal_cents: number;
  total_cents: number;
}

export interface Period {
  /** 'YYYY-MM' */
  id: string;
  /** inclusive ISO start */
  start: string;
  /** exclusive ISO end */
  end: string;
  days_in_month: number;
}
