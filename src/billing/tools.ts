// Tools exposed to the LLM. Thin adapters: validate input with zod, call the
// service, return JSON the model can explain. All errors are returned as
// `{ error }` so the model can recover instead of the stream failing.

import { tool } from "ai";
import { z } from "zod";
import type { BillingService } from "./service";
import { formatMoney } from "./rating";
import type { BillingRepo } from "./repo";
import { periodFromId } from "./period";

const periodSchema = z
  .string()
  .optional()
  .describe(
    "Billing period as YYYY-MM. Omit for the current month. 'last month' is also accepted."
  );

async function safe<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ToolDeps {
  customerId: string;
  service: BillingService;
  repo: BillingRepo;
  workflow: Workflow;
}

export function createBillingTools({
  customerId,
  service,
  repo,
  workflow
}: ToolDeps) {
  return {
    get_usage_summary: tool({
      description:
        "Aggregate the customer's raw metering events for a billing period and price them under their current plan. Returns every metered product with quantity, included allowance, overage and amount, plus a month-end projection when the period is still open. Use for 'how much have I spent', 'what is my bill', 'how much of my allowance is left'.",
      inputSchema: z.object({ period: periodSchema }),
      execute: ({ period }) =>
        safe(() => service.usageSummary(customerId, period))
    }),

    compare_periods: tool({
      description:
        "Compare a period with the previous month, per product, sorted by impact on the bill. Use to explain why a bill went up or down.",
      inputSchema: z.object({ period: periodSchema }),
      execute: ({ period }) =>
        safe(() => service.comparePeriods(customerId, period))
    }),

    get_daily_usage: tool({
      description:
        "Daily usage series for ONE product in a period, with anomalous days flagged (more than 2x the median). Use to find spikes or explain a sudden increase. Valid sku_id values come from get_usage_summary.",
      inputSchema: z.object({
        sku_id: z
          .string()
          .describe("e.g. workers_requests, r2_storage_gb_month, ai_neurons"),
        period: periodSchema
      }),
      execute: ({ sku_id, period }) =>
        safe(() => service.dailyUsage(customerId, sku_id, period))
    }),

    simulate_plan_change: tool({
      description:
        "What-if: re-price the customer's real usage for a period under a different plan and show the difference. Nothing is changed. Use for 'what if I switch to Pro/Business/Free', 'is it worth upgrading'.",
      inputSchema: z.object({
        target_plan_id: z.enum(["free", "pro", "business"]),
        period: periodSchema
      }),
      execute: ({ target_plan_id, period }) =>
        safe(() =>
          service.simulatePlanChange(customerId, target_plan_id, period)
        )
    }),

    list_plans: tool({
      description:
        "List all plans with base fee, included allowances and overage prices.",
      inputSchema: z.object({}),
      execute: () => safe(() => service.plans())
    }),

    list_invoices: tool({
      description:
        "List invoices already generated (finalized) for this customer.",
      inputSchema: z.object({}),
      execute: () =>
        safe(async () => {
          const rows = await repo.listInvoices(customerId);
          return rows.length
            ? rows.map((r) => ({ ...r, total: formatMoney(r.total_cents) }))
            : {
                invoices: [],
                note: "No invoices generated yet. Closed months can be invoiced with close_billing_period."
              };
        })
    }),

    // Human-in-the-loop: writes data, so the user must approve in the UI.
    close_billing_period: tool({
      description:
        "Close a past billing period: runs the durable InvoiceRun workflow that aggregates, rates and persists the invoice. Requires user approval. Only for months that already ended. Returns a run id.",
      inputSchema: z.object({
        period: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .describe("Closed month as YYYY-MM")
      }),
      needsApproval: async () => true,
      execute: ({ period }) =>
        safe(async () => {
          // Fast feedback for the model; the workflow re-validates authoritatively.
          const p = periodFromId(period);
          if (new Date(p.end) > new Date()) {
            return {
              error: `Period ${period} has not ended yet. Only closed months can be invoiced.`
            };
          }
          const id = `${customerId}_${period}`;
          try {
            const instance = await workflow.create({
              id,
              params: { customerId, period }
            });
            return {
              run_id: instance.id,
              status: "queued",
              check_with: "get_invoice_run_status"
            };
          } catch (e) {
            // Same id => a run for this period already exists. Report it instead of failing.
            const existing = await workflow.get(id);
            const status = await existing.status();
            return {
              run_id: id,
              status: status.status,
              note: "A run for this period already existed.",
              detail: String(e)
            };
          }
        })
    }),

    get_invoice_run_status: tool({
      description:
        "Check the status/output of an InvoiceRun workflow by run id (format '<customerId>_<YYYY-MM>').",
      inputSchema: z.object({ run_id: z.string() }),
      execute: ({ run_id }) =>
        safe(async () => {
          const instance = await workflow.get(run_id);
          const status = await instance.status();
          return {
            run_id,
            status: status.status,
            output: status.output ?? null,
            error: status.error ?? null
          };
        })
    })
  };
}
