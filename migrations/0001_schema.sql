-- Billing Assistant — D1 schema
--
-- Design notes
-- * usage_events is the append-only *metering* layer: one row per raw
--   usage sample emitted by a product. It is never updated in place.
-- * Aggregation is done on read (GROUP BY) for the chat tools, and
--   materialised into `invoices` / `invoice_lines` by the InvoiceRun
--   Workflow when a billing period is closed.
-- * All money is stored as integer cents to avoid floating-point drift.
-- * idempotency_key on usage_events lets producers retry safely.

CREATE TABLE IF NOT EXISTS plans (
  id             TEXT PRIMARY KEY,           -- 'free' | 'pro' | 'business'
  name           TEXT NOT NULL,
  base_fee_cents INTEGER NOT NULL DEFAULT 0  -- flat monthly fee
);

-- Metered products (SKUs). unit_price_cents is the price per `unit_size`
-- units of usage *above* the plan's included allowance.
CREATE TABLE IF NOT EXISTS skus (
  id          TEXT PRIMARY KEY,   -- 'workers_requests', 'r2_storage_gb_month', ...
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL,      -- human unit, e.g. 'requests', 'GB-month'
  unit_size   INTEGER NOT NULL,   -- pricing granularity, e.g. 1000000 requests
  -- How raw samples roll up into a billable quantity for a period:
  --   'sum'       -> total of all samples (requests, ops, CPU-ms, neurons)
  --   'avg_daily' -> mean of one-sample-per-day gauges (GB stored -> GB-month)
  aggregation TEXT NOT NULL DEFAULT 'sum' CHECK (aggregation IN ('sum', 'avg_daily'))
);

-- What each plan includes for free, and what it charges beyond that.
CREATE TABLE IF NOT EXISTS plan_prices (
  plan_id          TEXT NOT NULL REFERENCES plans(id),
  sku_id           TEXT NOT NULL REFERENCES skus(id),
  included_qty     INTEGER NOT NULL DEFAULT 0,  -- in raw units
  unit_price_cents INTEGER NOT NULL,            -- per sku.unit_size, above included
  PRIMARY KEY (plan_id, sku_id)
);

CREATE TABLE IF NOT EXISTS customers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  plan_id    TEXT NOT NULL REFERENCES plans(id),
  currency   TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL
);

-- Metering: raw, append-only usage samples.
CREATE TABLE IF NOT EXISTS usage_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  sku_id          TEXT NOT NULL REFERENCES skus(id),
  quantity        INTEGER NOT NULL,
  occurred_at     TEXT NOT NULL,   -- ISO-8601 UTC
  source          TEXT NOT NULL    -- emitting system, e.g. 'workers-metering'
);

-- The hot path for every aggregation query: customer + time range.
CREATE INDEX IF NOT EXISTS idx_usage_customer_time
  ON usage_events (customer_id, occurred_at);

-- Aggregation output: one invoice per customer per calendar month.
CREATE TABLE IF NOT EXISTS invoices (
  id            TEXT PRIMARY KEY,   -- 'inv_<customer>_<YYYY-MM>'
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  period        TEXT NOT NULL,      -- 'YYYY-MM'
  plan_id       TEXT NOT NULL,
  status        TEXT NOT NULL,      -- 'draft' | 'finalized'
  subtotal_cents INTEGER NOT NULL,
  total_cents   INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (customer_id, period)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  invoice_id      TEXT NOT NULL REFERENCES invoices(id),
  sku_id          TEXT,            -- NULL for the base fee line
  description     TEXT NOT NULL,
  quantity        INTEGER NOT NULL,
  included_qty    INTEGER NOT NULL,
  billable_qty    INTEGER NOT NULL,
  amount_cents    INTEGER NOT NULL
);
