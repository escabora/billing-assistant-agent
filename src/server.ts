import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import { BillingRepo } from "./billing/repo";
import { BillingService } from "./billing/service";
import { createBillingTools } from "./billing/tools";
import { periodIdFor } from "./billing/period";

export { InvoiceRunWorkflow } from "./workflows/invoice-run";

// Workers AI model. Llama 3.3 70B supports tool calling and streams well.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

interface BillingAgentState {
  customerId: string;
  customerName: string | null;
  toolCalls: number;
}

/**
 * One Durable Object instance per customer (the DO name *is* the customer
 * id, see app.tsx). The instance owns:
 *   - chat history, persisted in the DO's SQLite (AIChatAgent)
 *   - small synced state (below) that the UI renders
 * Hibernates when idle, so an idle customer costs nothing.
 */
export class BillingAgent extends AIChatAgent<Env, BillingAgentState> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  initialState: BillingAgentState = {
    customerId: "",
    customerName: null,
    toolCalls: 0
  };

  private get customerId() {
    return this.name;
  }

  async onStart() {
    if (this.state.customerId !== this.customerId) {
      const customer = await new BillingRepo(this.env.DB).getCustomer(
        this.customerId
      );
      this.setState({
        customerId: this.customerId,
        customerName: customer?.name ?? null,
        toolCalls: 0
      });
    }
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const repo = new BillingRepo(this.env.DB);
    const service = new BillingService(repo);
    const customer = await repo.getCustomer(this.customerId);
    if (!customer) {
      return new Response(`Unknown customer '${this.customerId}'`, {
        status: 404
      });
    }

    const workersai = createWorkersAI({ binding: this.env.AI });
    const now = new Date();

    const result = streamText({
      model: workersai(MODEL, { sessionAffinity: this.sessionAffinity }),
      system: systemPrompt(customer.name, customer.plan_id, now),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: createBillingTools({
        customerId: this.customerId,
        service,
        repo,
        workflow: this.env.INVOICE_RUN
      }),
      onStepFinish: ({ toolCalls }) => {
        if (toolCalls.length) {
          this.setState({
            ...this.state,
            toolCalls: this.state.toolCalls + toolCalls.length
          });
        }
      },
      stopWhen: stepCountIs(8),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

function systemPrompt(customerName: string, planId: string, now: Date) {
  return `You are the Billing Assistant for a usage-based cloud platform. You are talking to ${customerName}, currently on the "${planId}" plan.
Today is ${now.toISOString().slice(0, 10)}; the current billing period is ${periodIdFor(now)}.

Your job: answer questions about usage, charges, allowances and plans using the tools. Never guess numbers — every figure you state must come from a tool result in this conversation.

Guidelines:
- Start with the bottom line (total, or the answer to the question), then the 2–4 lines that matter most. Skip products with zero usage unless asked.
- Amounts come pre-formatted (e.g. "$12.40"); quote them as-is. Quantities: use thousands separators and the unit (e.g. "6.6M requests", "38 GB-month").
- Explain charges with the rating rules: usage minus included allowance = billable; partial pricing units round up; base fee is flat.
- When the period is open, say so and use the projection to answer "how much will I pay".
- For "why did my bill change", call compare_periods, then get_daily_usage on the product with the biggest impact to look for spikes.
- For plan questions, call simulate_plan_change and give a clear recommendation based on the real numbers.
- close_billing_period writes data and needs the user's approval; only offer it for months that already ended.
- If a tool returns { error }, explain it plainly and suggest what to try.
- Be concise and friendly. Use short markdown tables when comparing more than two lines.`;
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Small REST surface for the UI (customer picker) and for smoke tests.
    if (url.pathname === "/api/customers") {
      const customers = await new BillingRepo(env.DB).listCustomers();
      return Response.json(customers);
    }
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, model: MODEL });
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
