# Billing Assistant Agent

An AI agent that answers questions about a customer's usage-based bill — "how much have I spent this month?", "why was August higher than July?", "what if I move to Business?" — by **aggregating raw metering events in D1, rating them against a plan, and letting Llama 3.3 explain the result**. Closing a billing period runs a durable **Workflow** that persists an invoice, gated by human approval in the chat.

Built for the Cloudflare _AI-powered application_ assignment. Every component asked for is here:

| Requirement             | What this project uses                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| LLM                     | **Workers AI** — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with tool calling (via `workers-ai-provider` + AI SDK)                     |
| Workflow / coordination | **Agents SDK on Durable Objects** (one `BillingAgent` instance per customer) + **Cloudflare Workflows** (`InvoiceRunWorkflow`)         |
| User input via chat     | **React chat UI** served as Worker static assets, WebSocket streaming                                                                  |
| Memory / state          | Chat history in the Durable Object's **SQLite**, synced agent state (`setState`), and **D1** as the metering/aggregation/invoice store |

> Prompt history for the AI-assisted build is in [`PROMPTS.md`](./PROMPTS.md). Architecture notes and trade-offs are in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Demo script

Pick a customer in the header (each one is a separate agent instance with its own history), then try:

- **"How much have I spent this month?"** → `get_usage_summary` aggregates ~250 raw events, prices them, and projects month-end because the period is still open.
- **"Why was my August bill higher than July?"** (as _Northwind Logistics_) → `compare_periods` ranks products by impact, then `get_daily_usage` finds the 11–12 Aug traffic spike (≈6× the daily median).
- **"What if I switch to the Business plan?"** (as _PixelForge AI_) → `simulate_plan_change` re-prices the real usage and gives a verdict.
- **"How much of my allowance is left?"** → every product shows quantity vs. included, with % used.
- **"Close the billing period for 2026-08"** → the agent asks for approval, starts the `InvoiceRun` workflow, and you can ask **"what's the status of that run?"** and then **"list my invoices"**.

## Run it locally

Prerequisites: Node 22+, a Cloudflare account (free tier is enough).

```bash
npm install
npx wrangler login              # one-time; Workers AI has no local simulator

# Metering store: local D1, schema + ~6,400 fake usage events
npm run db:setup:local

npm run dev                     # http://localhost:5173
```

`npm run dev` runs everything locally except inference, which is proxied to Workers AI on your account.

## Deploy

```bash
npm run db:create               # prints a database_id
#   -> paste it into wrangler.jsonc  (d1_databases[0].database_id)
npm run db:setup                # migrations + seed on the remote D1
npm run deploy                  # vite build && wrangler deploy
```

The Worker URL is printed at the end (`https://billing-assistant-agent.<your-subdomain>.workers.dev`).

## Project layout

```
src/
  server.ts               BillingAgent (AIChatAgent on a Durable Object) + Worker fetch handler
  app.tsx                 Chat UI (Kumo components), customer picker, tool/approval rendering
  billing/
    types.ts              Domain types (money is integer cents)
    period.ts             Calendar-month periods, "last month"/"August" resolution, projections
    rating.ts             PURE rating engine: aggregation -> allowance -> round-up -> amount
    repo.ts               All SQL. D1 aggregation queries + idempotent invoice upsert
    service.ts            Use-cases shared by tools and the workflow (summary, compare, simulate…)
    tools.ts              LLM tools (zod schemas, {error} instead of throws, approval gating)
    rating.test.ts        Unit tests for the engine and period math
  workflows/
    invoice-run.ts        InvoiceRunWorkflow: validate -> aggregate+rate -> persist (retries, idempotent)
migrations/0001_schema.sql   D1 schema (metering events, catalog, invoices)
scripts/generate-seed.mjs    Deterministic fake data generator -> seed/seed.sql
```

## How the numbers are produced

```
usage_events (raw, append-only)  ──SUM / avg-per-day per SKU──▶  UsageTotal[]
                                                                    │
plans + plan_prices + skus (catalog) ───────────────▶ rateUsage() ──┤
                                                                    ▼
             billable = max(0, qty − included) · units = ceil(billable / unit_size)
             amount   = units × unit_price      · total = base fee + Σ amounts
```

The **same** `BillingService.rateForInvoice` path is used by the interactive tools and by the workflow, so the number the assistant quotes in chat is the number that lands on the invoice.

## Scripts

| Command                               | Purpose                                                       |
| ------------------------------------- | ------------------------------------------------------------- |
| `npm run dev` / `npm run deploy`      | Local dev server / build and deploy                           |
| `npm test` · `npm run check`          | Unit tests · format + lint + typecheck + tests (CI runs this) |
| `npm run db:setup:local` / `db:setup` | Apply migrations and seed, local / remote                     |
| `npm run seed:generate`               | Regenerate `seed/seed.sql` (deterministic)                    |
| `npm run types`                       | Regenerate `env.d.ts` after changing `wrangler.jsonc`         |

## What I would do next in a real system

See [ARCHITECTURE.md → "From demo to production"](./ARCHITECTURE.md#from-demo-to-production): pre-aggregated rollups, exactly-once ingestion, currency/tax, ledger and revenue recognition hooks, evals for the assistant's answers, and observability on tool latency and cost.

## License

MIT — derived from [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter).
