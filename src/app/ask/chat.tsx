"use client";

/**
 * The analyst chat.
 *
 * ⚠️ Imports `@/lib/ai/analyst` for its types and labels — the pure module. It must NOT
 * import `analyst.server` or `tools.server`: those reach the database and the Anthropic
 * SDK, and pulling either into the client bundle fails the build with `Can't resolve
 * 'fs'`. `tsc` does not catch that; only `build` does. Rule 6.
 *
 * Tool calls are rendered as they arrive rather than hidden, for the same reason every
 * dashboard states its own coverage: an answer you can see the provenance of is worth
 * more than a confident paragraph you can't.
 */

import { useRef, useState } from "react";
import type { AskEvent, AskTurn } from "@/lib/ai/analyst";

interface Exchange {
  question: string;
  /** Tool labels in call order, deduped — "Checked X, Y and Z". */
  tools: string[];
  answer: string;
  error: string | null;
  streaming: boolean;
}

const SUGGESTIONS = [
  "How did last month compare with the one before?",
  "Which acquisition channel produces the best customers, and how confident can we be?",
  "What is our churn before the first renewal, holding the plan constant?",
  "How much of the margin figure is real cost versus estimate?",
];

export function AnalystChat({ configured }: { configured: boolean }) {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const listEnd = useRef<HTMLDivElement>(null);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || busy) return;

    // The model sees prior turns so follow-ups work ("and by channel?"). Only completed
    // exchanges are sent — a half-streamed answer would be a misleading premise.
    const history: AskTurn[] = exchanges
      .filter((e) => !e.streaming && !e.error && e.answer)
      .flatMap((e) => [
        { role: "user" as const, content: e.question },
        { role: "assistant" as const, content: e.answer },
      ]);

    const index = exchanges.length;
    setExchanges((prev) => [
      ...prev,
      { question: trimmed, tools: [], answer: "", error: null, streaming: true },
    ]);
    setDraft("");
    setBusy(true);

    const update = (patch: (e: Exchange) => Exchange) =>
      setExchanges((prev) => prev.map((e, i) => (i === index ? patch(e) : e)));

    try {
      const response = await fetch("/api/ai/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns: [...history, { role: "user", content: trimmed }] }),
      });

      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.error ?? `Request failed (${response.status}).`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // SSE frames are `data: {...}\n\n`. A chunk can split a frame anywhere, so hold
      // the remainder in `buffer` rather than parsing per chunk.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          let event: AskEvent;
          try {
            event = JSON.parse(line.slice(5).trim()) as AskEvent;
          } catch {
            continue;
          }
          if (event.type === "text") {
            update((e) => ({ ...e, answer: e.answer + event.text }));
          } else if (event.type === "tool") {
            update((e) =>
              e.tools.includes(event.label) ? e : { ...e, tools: [...e.tools, event.label] },
            );
          } else if (event.type === "error") {
            update((e) => ({ ...e, error: event.message, streaming: false }));
          } else if (event.type === "done") {
            update((e) => ({ ...e, streaming: false }));
          }
        }
      }
      update((e) => ({ ...e, streaming: false }));
    } catch (err) {
      update((e) => ({
        ...e,
        error: err instanceof Error ? err.message : "Something went wrong.",
        streaming: false,
      }));
    } finally {
      setBusy(false);
      listEnd.current?.scrollIntoView({ behavior: "smooth" });
    }
  }

  if (!configured) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-medium">The analyst is not configured.</p>
        <p className="mt-1">
          Add <code className="font-mono">ANTHROPIC_API_KEY</code> to <code className="font-mono">.env</code>{" "}
          and restart. Everything else on this page is ready — no other setup is needed.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {exchanges.length === 0 && (
        <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Ask about revenue, margin, churn, cohorts or channels. The analyst reads the same
            metrics the dashboards use — it can&apos;t see anything your role can&apos;t — and it
            names the caveat behind a number rather than rounding it off.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                className="rounded-lg border border-neutral-300 px-2.5 py-1.5 text-left text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {exchanges.map((exchange, i) => (
        <div key={i} className="space-y-2">
          <div className="flex justify-end">
            <p className="max-w-[85%] rounded-xl rounded-br-sm bg-neutral-900 px-3.5 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
              {exchange.question}
            </p>
          </div>

          <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            {exchange.tools.length > 0 && (
              <p className="mb-2 text-[11px] uppercase tracking-wide text-neutral-400">
                Checked {exchange.tools.join(" · ")}
              </p>
            )}
            {exchange.answer && (
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
                {exchange.answer}
              </div>
            )}
            {exchange.streaming && !exchange.answer && (
              <p className="text-sm text-neutral-400">
                {exchange.tools.length > 0 ? "Reading the numbers…" : "Thinking…"}
              </p>
            )}
            {exchange.error && (
              <p className="mt-2 text-sm text-red-600 dark:text-red-400">{exchange.error}</p>
            )}
          </div>
        </div>
      ))}
      <div ref={listEnd} />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
        }}
        className="flex items-end gap-2"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(draft);
            }
          }}
          rows={2}
          placeholder="Ask about the numbers…"
          className="min-h-[52px] flex-1 resize-y rounded-xl border border-neutral-300 bg-white px-3.5 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {busy ? "Asking…" : "Ask"}
        </button>
      </form>
    </div>
  );
}
