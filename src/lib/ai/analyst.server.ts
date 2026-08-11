/**
 * Drives the analyst: Anthropic client, the agent loop, and the event stream.
 *
 * Server-only — imports `env` and the tool layer, which reach the database. The chat
 * component must import `analyst.ts` instead (rule 6).
 *
 * The loop itself is the SDK's tool runner rather than a hand-written
 * `while (stop_reason === "tool_use")`. There is nothing to gain from owning it here:
 * the tools are ordinary read-only functions with no approval step, no retry semantics
 * and no side effects, so the only thing a manual loop would add is a second place for
 * the assistant/tool_result bookkeeping to drift out of step.
 */

import Anthropic from "@anthropic-ai/sdk";

import { env } from "../env";
import { logger } from "../logger";
import type { Role } from "../auth/capabilities";
import {
  ANALYST_MAX_ITERATIONS,
  ANALYST_MAX_TOKENS,
  ANALYST_SYSTEM_PROMPT,
  DEFAULT_ANALYST_MODEL,
  toolLabel,
  type AskEvent,
  type AskTurn,
} from "./analyst";
import { buildAnalystTools } from "./tools.server";

export class AnalystNotConfiguredError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is not set, so the analyst is unavailable. Add it to .env " +
        "(and to the deployment's environment) and restart.",
    );
    this.name = "AnalystNotConfiguredError";
  }
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw new AnalystNotConfiguredError();
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

export function analystConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * Runs one question and yields UI events as they happen.
 *
 * The caller's `role` decides the toolset, and therefore what the agent can reach at
 * all — see the two gates described in `tools.server.ts`. It is passed in from the
 * verified session, never from the request body.
 */
export async function* askAnalyst(
  turns: AskTurn[],
  role: Role,
): AsyncGenerator<AskEvent> {
  const tools = buildAnalystTools(role);
  const started = Date.now();
  let toolCalls = 0;

  try {
    const runner = getClient().beta.messages.toolRunner({
      model: env.ANTHROPIC_MODEL || DEFAULT_ANALYST_MODEL,
      max_tokens: ANALYST_MAX_TOKENS,
      // Static, so the prefix caches across every question and every user. Nothing
      // volatile belongs here — the agent learns freshness from `data_coverage`.
      system: [{ type: "text", text: ANALYST_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: turns.map((t) => ({ role: t.role, content: t.content })),
      tools,
      max_iterations: ANALYST_MAX_ITERATIONS,
      output_config: { effort: "high" },
      stream: true,
    });

    // Outer loop: one iteration per agent turn. Inner loop: that turn's stream.
    for await (const stream of runner) {
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          toolCalls += 1;
          yield {
            type: "tool",
            name: event.content_block.name,
            label: toolLabel(event.content_block.name),
          };
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }
    }

    const final = await runner.done();
    logger.info("analyst answered", {
      role,
      toolCalls,
      ms: Date.now() - started,
      stopReason: final.stop_reason,
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      cacheReadTokens: final.usage.cache_read_input_tokens,
    });

    // Opus 5's safety classifiers can decline a request: a normal 200 with an empty or
    // partial body. Without this branch the UI would just stop mid-answer with no reason.
    if (final.stop_reason === "refusal") {
      yield {
        type: "error",
        message: "The model declined to answer that. Try rephrasing the question.",
      };
      return;
    }

    yield { type: "done" };
  } catch (err) {
    logger.error("analyst failed", {
      role,
      toolCalls,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    yield {
      type: "error",
      message:
        err instanceof AnalystNotConfiguredError
          ? err.message
          : "The analyst hit an error. The details are in the server log.",
    };
  }
}
