// InvoiceRun: closes a billing period for one customer.
//
// Why a Workflow and not just a function call inside the tool?
//  * Each step is durable and retried independently — if D1 hiccups while
//    persisting, we do not re-aggregate, and we never write half an invoice.
//  * The run has an id the user can poll for status from the chat.
//  * It is the natural place to add real-world steps later (tax lookup,
//    payment provider, ledger posting, email) without touching the agent.
//
// Idempotency: the instance id is `${customerId}_${period}` (Workflow ids allow only [A-Za-z0-9_-]), and
// BillingRepo.saveInvoice upserts on (customer_id, period), so re-running
// a close is safe.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { BillingRepo } from "../billing/repo";
import { BillingService } from "../billing/service";
import { periodFromId } from "../billing/period";
import type { RatedInvoice } from "../billing/types";

export interface InvoiceRunParams {
  customerId: string;
  period: string; // YYYY-MM
  /** Allow closing the current (open) month — used for demos only. */
  allowOpenPeriod?: boolean;
}

export class InvoiceRunWorkflow extends WorkflowEntrypoint<
  Env,
  InvoiceRunParams
> {
  async run(event: WorkflowEvent<InvoiceRunParams>, step: WorkflowStep) {
    const { customerId, period, allowOpenPeriod } = event.payload;
    const repo = new BillingRepo(this.env.DB);
    const service = new BillingService(repo);

    await step.do("validate", async () => {
      const p = periodFromId(period);
      // Bad input will not get better on retry: fail the run immediately.
      if (new Date(p.end) > new Date() && !allowOpenPeriod) {
        throw new NonRetryableError(
          `Period ${period} has not ended yet; refusing to close it.`
        );
      }
      const customer = await repo.getCustomer(customerId);
      if (!customer) {
        throw new NonRetryableError(`Customer ${customerId} not found`);
      }
      return { plan_id: customer.plan_id };
    });

    // Aggregate + rate. Returned value is checkpointed, so a retry of the
    // next step never recomputes (and never drifts from) these numbers.
    const rated: RatedInvoice = await step.do(
      "aggregate-and-rate",
      { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" } },
      () => service.rateForInvoice(customerId, period)
    );

    const invoiceId = await step.do(
      "persist-invoice",
      { retries: { limit: 5, delay: "1 second", backoff: "exponential" } },
      () => repo.saveInvoice(customerId, period, rated)
    );

    return {
      invoice_id: invoiceId,
      customer_id: customerId,
      period,
      total_cents: rated.total_cents,
      line_count: rated.lines.length
    };
  }
}
