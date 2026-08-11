/**
 * POST /api/ai/ask — ask the analyst a question, stream the answer back.
 *
 * The role comes from the verified session cookie, never from the request body, and it
 * is what decides which tools the agent is given. A client that posts `{role: "admin"}`
 * changes nothing.
 */

import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/current-user";
import { askAnalyst } from "@/lib/ai/analyst.server";
import type { AskEvent, AskTurn } from "@/lib/ai/analyst";

// The Anthropic SDK and the Postgres driver both need the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Keeps one runaway paste from becoming a large bill. */
const MAX_TURNS = 40;
const MAX_CHARS = 8_000;

function parseTurns(value: unknown): AskTurn[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TURNS) return null;
  const turns: AskTurn[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const { role, content } = raw as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string" || content.length === 0 || content.length > MAX_CHARS) return null;
    turns.push({ role, content });
  }
  // The API requires the first turn to be a user turn.
  return turns[0].role === "user" ? turns : null;
}

export async function POST(request: Request) {
  // Any signed-in role may ask; the toolset is what differs. requireUser() re-checks the
  // account on every call, so a deactivated user loses access immediately rather than
  // waiting out a 7-day cookie.
  const user = await requireUser();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const turns = parseTurns((body as { turns?: unknown })?.turns);
  if (!turns) {
    return NextResponse.json(
      { error: `Expected { turns: [{ role, content }] } — up to ${MAX_TURNS} turns, starting with a user turn.` },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AskEvent) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        for await (const event of askAnalyst(turns, user.role)) send(event);
      } catch (err) {
        // askAnalyst yields its own error events; this catches a failure in the
        // generator's own plumbing so the stream always terminates cleanly.
        send({
          type: "error",
          message: err instanceof Error ? err.message : "The analyst stream failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // Stops a proxy from buffering the whole answer and defeating the streaming.
      "X-Accel-Buffering": "no",
    },
  });
}
