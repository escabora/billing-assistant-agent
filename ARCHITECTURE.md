# Architecture notes

This document explains _why_ the project is shaped the way it is. The code is small on purpose; the decisions are the interesting part.

## 1. Request flow

```
Browser (React, WebSocket)
   │  useAgent({ agent: "BillingAgent", name: customerId })
   ▼
Worker fetch ──▶ routeAgentRequest ──▶ Durable Object "BillingAgent:<customerId>"
                                          │  AIChatAgent: persists messages in DO SQLite
                                          │  streamText(model = Workers AI Llama 3.3, tools)
                                          │
                       ┌──────────────────┼──────────────────────┐
                       ▼                  ▼                      ▼
                 BillingService      BillingService        env.INVOICE_RUN.create()
                 .usageSummary()     .simulatePlanChange()      (Workflow)
                       │                  │                      │
                       ▼                  ▼                      ▼
                 BillingRepo (D1)    BillingRepo (D1)      InvoiceRunWorkflow
                 GROUP BY sku_id     GROUP BY sku_id       validate → rate → persist
```

## 2. Key decisions and trade-offs

### One Durable Object per customer

The DO **name is the customer id**. That gives isolation (customer A can never see customer B's history), locality (all of a customer's chat state in one place), and hibernation (idle customers cost nothing). The alternative — one DO per browser session — would make history disappear on reload and would let a single customer spread across many instances. Trade-off: the demo has no auth, so the customer picker is a trusted input; in production the id would come from a verified session, never from the client.

### Aggregation on read, materialisation on close

`usage_events` is append-only raw metering. Interactive tools aggregate on the fly with `GROUP BY sku_id` over a `(customer_id, occurred_at)` index — at this scale (thousands of rows per customer-month) it is a few milliseconds and always fresh. Closing a period materialises the result into `invoices`/`invoice_lines`. This mirrors the real split between a metering layer (high write volume, no interpretation) and a billing layer (low volume, financial meaning). At Cloudflare scale you would insert a pre-aggregation step (hourly/daily rollups) so that reads never touch raw events; the rating engine would not change.

### Rating engine is pure

`rating.ts` has no I/O. `UsageTotal[] + Catalog → RatedInvoice`. This is what makes the engine unit-testable (see `rating.test.ts`), deterministic, and reusable by both the chat tools and the workflow. The rounding rule (partial pricing units round **up**) and the two aggregation modes (`sum` for counters, `avg_daily` for gauges such as GB stored) are explicit data on the SKU, not scattered `if`s.

### Money as integer cents

Floating point has no place in invoices. All prices and amounts are integers; formatting to `$12.40` happens at the edge, in `formatMoney`.

### One service, two callers

`BillingService` is used by the tools (interactive) and by the workflow (batch). The single most important property of a billing system is that "the number the customer saw" equals "the number on the invoice"; sharing the code path is the cheapest way to get it.

### Workflows for the write path

Reading is cheap and safe to repeat. Writing an invoice is not: it must not run twice, and it must not stop half-way. Cloudflare Workflows gives each step durable checkpoints and independent retries. The rated invoice is _returned from_ the aggregation step, so a retry of the persist step reuses the checkpointed numbers instead of re-aggregating (which could drift if a late event arrived). Validation errors throw `NonRetryableError` — retrying a bad period is pointless. Idempotency is layered: the workflow instance id is `<customerId>_<period>` (a second `create` is rejected), and `saveInvoice` upserts on the `(customer_id, period)` unique constraint inside a single `db.batch`, which D1 runs atomically.

### Human in the loop on the only destructive tool

`close_billing_period` is the only tool that writes. It uses the AI SDK's `needsApproval`, so the model proposes and the human approves in the UI. Everything else is read-only and auto-executes.

### Tools return `{ error }` instead of throwing

A thrown error inside a tool aborts the stream and the user sees a broken message. Returning `{ error: "Unknown plan 'enterprise'" }` lets the model recover ("we only have Free, Pro and Business — did you mean Business?").

### LLM never does arithmetic

The system prompt says: every figure must come from a tool result. Tool results are pre-formatted (`"$4.50 per 1,000,000 operations"`), so the model's job is explanation, not calculation. This is the difference between an assistant that is _usually_ right and one that is _auditably_ right.

### Model choice

Llama 3.3 70B on Workers AI: no API keys, no egress, tool calling works, and the pricing model (neurons) is itself usage-based — appropriate for a billing demo. Swapping to an external model is a one-line change in `server.ts` via AI Gateway.

## 3. Data model

```
plans ──< plan_prices >── skus          customers ──< usage_events
  │                                         │
  └──────────── customers.plan_id           └──< invoices ──< invoice_lines
```

- `usage_events.idempotency_key` UNIQUE — producers can retry blindly.
- `skus.aggregation` — how samples become a billable quantity.
- `plan_prices.included_qty` / `unit_price_cents` — allowance and overage per plan × SKU.
- `invoices UNIQUE(customer_id, period)` — one invoice per customer-month, ever.

## 4. Testing strategy

- **Unit** (`vitest`): rating rules, rounding, gauge vs. counter aggregation, projection, period parsing, determinism.
- **Schema/seed**: CI applies the migration and seed to a fresh local D1 and counts rows.
- **Manual smoke**: the demo script in the README exercises every tool; the debug toggle in the UI shows the raw tool I/O.
- Not covered (deliberately, for scope): LLM output quality. In production I would add an eval set of question → expected tool calls/figures and run it on prompt or model changes.

## 5. From demo to production

Things I left out on purpose, in the order I would add them:

1. **Auth** — customer id from a verified session; the agent name derived server-side.
2. **Pre-aggregation** — hourly/daily rollup tables written by a scheduled Workflow or Queue consumer; interactive queries read rollups, invoicing reads rollups + late-arriving raw events.
3. **Exactly-once ingestion** — the `idempotency_key` is there; add a Queue in front of D1 with batching and dead-lettering.
4. **Period close semantics** — grace period for late events, `draft → finalized` transition, immutable finalized invoices, credit notes instead of edits.
5. **Currency, tax, proration** on plan changes mid-month.
6. **Ledger / revenue recognition hooks** as additional workflow steps.
7. **Observability** — tool latency, D1 query time, tokens per answer, and a "figures quoted vs. tool results" consistency check.
8. **Evals** for the assistant (see §4).
