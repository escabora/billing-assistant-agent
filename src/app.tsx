import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { BillingAgent } from "./server";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Switch,
  Text
} from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BugIcon,
  ReceiptIcon,
  CaretDownIcon
} from "@phosphor-icons/react";

// ── Types ─────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  name: string;
  plan_id: string;
}

interface BillingAgentState {
  customerId: string;
  customerName: string | null;
  toolCalls: number;
}

const SUGGESTIONS = [
  "How much have I spent this month?",
  "Why was my August bill higher than July?",
  "What if I switch to the Business plan?",
  "How much of my included allowance is left?",
  "Close the billing period for 2026-08"
];

const TOOL_LABELS: Record<string, string> = {
  get_usage_summary: "Aggregating usage",
  compare_periods: "Comparing periods",
  get_daily_usage: "Scanning daily usage",
  simulate_plan_change: "Simulating plan change",
  list_plans: "Loading plans",
  list_invoices: "Loading invoices",
  close_billing_period: "Closing billing period",
  get_invoice_run_status: "Checking invoice run"
};

// ── Small components ──────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    try {
      localStorage.setItem("theme", mode);
    } catch {
      /* private mode */
    }
  }, [dark]);
  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

function CustomerPicker({
  customers,
  value,
  onChange
}: {
  customers: Customer[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Customer"
      className="px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-accent"
    >
      {customers.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} · {c.plan_id}
        </option>
      ))}
    </select>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text || text === "{}") return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-kumo-subtle select-none">
        {label}
      </summary>
      <pre className="mt-1 font-mono text-xs text-kumo-subtle whitespace-pre-wrap overflow-auto max-h-64">
        {text}
      </pre>
    </details>
  );
}

function ToolPartView({
  part,
  addToolApprovalResponse
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);
  const label = TOOL_LABELS[toolName] ?? toolName;

  if (part.state === "output-available") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <GearIcon size={14} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary" bold>
              {label}
            </Text>
            <Badge variant="secondary">{toolName}</Badge>
          </div>
          <JsonBlock label="Input" value={part.input} />
          <JsonBlock label="Result" value={part.output} />
        </Surface>
      </div>
    );
  }

  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
          <div className="flex items-center gap-2 mb-2">
            <ReceiptIcon size={14} className="text-kumo-warning" />
            <Text size="sm" bold>
              Approval needed: {label}
            </Text>
          </div>
          <Text size="xs" variant="secondary">
            This will generate and persist an invoice for period{" "}
            <span className="font-mono">
              {(part.input as { period?: string })?.period}
            </span>
            . Continue?
          </Text>
          <div className="flex gap-2 mt-3">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() =>
                approvalId &&
                addToolApprovalResponse({ id: approvalId, approved: true })
              }
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() =>
                approvalId &&
                addToolApprovalResponse({ id: approvalId, approved: false })
              }
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  if (
    part.state === "output-denied" ||
    ("approval" in part &&
      (part.approval as { approved?: boolean })?.approved === false)
  ) {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {label}
            </Text>
            <Badge variant="secondary">Rejected</Badge>
          </div>
        </Surface>
      </div>
    );
  }

  if (part.state === "output-error") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring-2 ring-kumo-danger">
          <div className="flex items-center gap-2 mb-1">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {label}
            </Text>
            <Badge variant="destructive">Error</Badge>
          </div>
          <Text size="xs" variant="secondary">
            {part.errorText || "Tool call failed"}
          </Text>
        </Surface>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <GearIcon size={14} className="text-kumo-inactive animate-spin" />
            <Text size="xs" variant="secondary">
              {label}...
            </Text>
          </div>
        </Surface>
      </div>
    );
  }
  return null;
}

// ── Chat (one instance per selected customer) ─────────────────────────

function Chat({ customer }: { customer: Customer }) {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [agentState, setAgentState] = useState<BillingAgentState | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The Durable Object name is the customer id: each customer gets its own
  // isolated agent instance, chat history and state.
  const agent = useAgent<BillingAgent, BillingAgentState>({
    agent: "BillingAgent",
    name: customer.id,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onStateUpdate: useCallback((s: BillingAgentState) => setAgentState(s), []),
    onError: useCallback((e: Event) => console.error("WebSocket error:", e), [])
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming) textareaRef.current?.focus();
  }, [isStreaming]);

  const sendText = useCallback(
    (text: string) => {
      if (!text.trim() || isStreaming) return;
      sendMessage({
        role: "user",
        parts: [{ type: "text", text: text.trim() }]
      });
    },
    [isStreaming, sendMessage]
  );

  const send = useCallback(() => {
    sendText(input);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, sendText]);

  return (
    <>
      {/* Sub-header: customer context */}
      <div className="px-5 py-2 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between text-xs text-kumo-subtle">
          <span>
            Talking as{" "}
            <span className="font-medium text-kumo-default">
              {customer.name}
            </span>{" "}
            · plan <span className="font-mono">{customer.plan_id}</span>
          </span>
          <span className="flex items-center gap-3">
            <span>{agentState?.toolCalls ?? 0} tool calls</span>
            <span className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              {connected ? "Connected" : "Disconnected"}
            </span>
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {messages.length === 0 && (
            <Empty
              icon={<ReceiptIcon size={32} />}
              title="Ask anything about your usage and bill"
              contents={
                <div className="flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((prompt) => (
                    <Button
                      key={prompt}
                      variant="outline"
                      size="sm"
                      disabled={isStreaming}
                      onClick={() => sendText(prompt)}
                    >
                      {prompt}
                    </Button>
                  ))}
                </div>
              }
            />
          )}

          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;
            return (
              <div key={message.id} className="space-y-2">
                {showDebug && (
                  <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                    {JSON.stringify(message, null, 2)}
                  </pre>
                )}
                {message.parts.map((part, i) => {
                  const key = `${message.id}-${i}`;
                  if (isToolUIPart(part)) {
                    return (
                      <ToolPartView
                        key={key}
                        part={part}
                        addToolApprovalResponse={addToolApprovalResponse}
                      />
                    );
                  }
                  if (part.type === "reasoning") {
                    if (!part.text.trim()) return null;
                    return (
                      <div key={key} className="flex justify-start">
                        <details className="max-w-[85%] w-full">
                          <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-kumo-control text-sm select-none">
                            <span className="font-medium text-kumo-default">
                              Reasoning
                            </span>
                            <CaretDownIcon
                              size={14}
                              className="ml-auto text-kumo-inactive"
                            />
                          </summary>
                          <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs whitespace-pre-wrap overflow-auto max-h-64">
                            {part.text}
                          </pre>
                        </details>
                      </div>
                    );
                  }
                  if (part.type === "text") {
                    if (!part.text) return null;
                    if (isUser) {
                      return (
                        <div key={key} className="flex justify-end">
                          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                            {part.text}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={key} className="flex justify-start">
                        <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                          <Streamdown
                            className="sd-theme rounded-2xl rounded-bl-md p-3"
                            plugins={{ code }}
                            controls={false}
                            isAnimating={isLastAssistant && isStreaming}
                          >
                            {part.text}
                          </Streamdown>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder="Ask about your usage, charges or plans..."
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop"
                icon={<StopIcon size={18} />}
                onClick={stop}
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send"
                disabled={!input.trim() || !connected}
                icon={<PaperPlaneRightIcon size={18} />}
              />
            )}
          </div>
          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-1.5">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Debug"
              />
              <Text size="xs" variant="secondary">
                Debug
              </Text>
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={<TrashIcon size={14} />}
              onClick={clearHistory}
            >
              Clear history
            </Button>
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </>
  );
}

// ── Shell: loads customers, owns the selection ────────────────────────

function Shell() {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [customerId, setCustomerId] = useState<string>(() => {
    try {
      return localStorage.getItem("customerId") ?? "";
    } catch {
      return "";
    }
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/customers")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<Customer[]>)
          : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((list: Customer[]) => {
        setCustomers(list);
        setCustomerId((prev) =>
          list.some((c) => c.id === prev) ? prev : (list[0]?.id ?? "")
        );
      })
      .catch((e: Error) =>
        setError(
          `Could not load customers: ${e.message}. Did you run the D1 migrations and seed?`
        )
      );
  }, []);

  const select = (id: string) => {
    setCustomerId(id);
    try {
      localStorage.setItem("customerId", id);
    } catch {
      /* ignore */
    }
  };

  const customer = customers?.find((c) => c.id === customerId);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default flex items-center gap-2">
              <ReceiptIcon size={20} /> Billing Assistant
            </h1>
            <Badge variant="secondary">Workers AI · D1 · Workflows</Badge>
          </div>
          <div className="flex items-center gap-2">
            {customers && (
              <CustomerPicker
                customers={customers}
                value={customerId}
                onChange={select}
              />
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      {error && (
        <div className="max-w-3xl mx-auto mt-6 px-5">
          <Surface className="p-4 rounded-xl ring-2 ring-kumo-danger">
            <Text size="sm">{error}</Text>
          </Surface>
        </div>
      )}
      {!error && !customer && (
        <div className="flex-1 flex items-center justify-center text-kumo-inactive">
          Loading customers...
        </div>
      )}
      {customer && <Chat key={customer.id} customer={customer} />}
    </div>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen text-kumo-inactive">
          Loading...
        </div>
      }
    >
      <Shell />
    </Suspense>
  );
}
