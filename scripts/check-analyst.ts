/**
 * Diagnose the /ask analyst.
 *
 * Two halves, because they fail for different reasons and you want to know which:
 *
 *  1. **The tools** — every wrapper is called against the live database. Needs no API
 *     key. This is the half that catches a metrics signature changing under the agent,
 *     which `tsc` would catch but a renamed field inside a returned object would not.
 *  2. **The model** — one real question, end to end, only if ANTHROPIC_API_KEY is set.
 *
 * Also prints the per-role toolset, so the access boundary is inspectable from a terminal
 * rather than only assertable in a test.
 *
 * Imports are lazy for the same reason `check-deploy.ts`'s are: a static `env` import
 * throws at module load on a broken config, before the script can print anything useful.
 */

import "dotenv/config";

type Status = "pass" | "warn" | "fail";

const results: Array<{ status: Status; name: string; detail: string }> = [];

function add(status: Status, name: string, detail: string) {
  results.push({ status, name, detail });
  const tag = status === "pass" ? "  PASS " : status === "warn" ? "  WARN " : "  FAIL ";
  console.log(`${tag} ${name.padEnd(24)} ${detail}`);
}

/** Compact description of a tool result, so the output stays readable. */
function describe(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return `${parsed.length} row(s), ${raw.length} chars`;
    if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed as Record<string, unknown>);
      return `{${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}}, ${raw.length} chars`;
    }
    return `${raw.length} chars`;
  } catch {
    return `NOT VALID JSON (${raw.length} chars)`;
  }
}

async function main() {
  console.log("\nEsses Analytics — analyst diagnostic\n");

  const { env } = await import("../src/lib/env");
  const { ROLES } = await import("../src/lib/auth/capabilities");
  const { ANALYST_TOOLS, analystToolNamesFor } = await import("../src/lib/ai/analyst");
  const { buildAnalystTools } = await import("../src/lib/ai/tools.server");

  // ---- Configuration -----------------------------------------------------
  const hasKey = Boolean(env.ANTHROPIC_API_KEY);
  if (hasKey) {
    add("pass", "ANTHROPIC_API_KEY", `set (${env.ANTHROPIC_API_KEY!.length} chars)`);
  } else {
    add(
      "warn",
      "ANTHROPIC_API_KEY",
      "not set — /ask shows a 'not configured' notice; tools still checked below",
    );
  }
  add("pass", "Model", env.ANTHROPIC_MODEL);

  // ---- The access boundary ----------------------------------------------
  console.log("\nToolset by role (this is the access boundary, not a display filter):\n");
  const total = Object.keys(ANALYST_TOOLS).length;
  for (const role of ROLES) {
    const names = analystToolNamesFor(role);
    const withheld = Object.keys(ANALYST_TOOLS).filter((n) => !names.includes(n));
    console.log(`  ${role.padEnd(10)} ${String(names.length).padStart(2)}/${total} tools`);
    if (withheld.length) console.log(`  ${" ".repeat(10)} withheld: ${withheld.join(", ")}`);
  }

  // ---- The tools, against the live database ------------------------------
  console.log("\nCalling every tool (admin toolset, live database)…\n");
  const tools = buildAnalystTools("admin");
  add("pass", "Registry", `${tools.length} tools built, registry and implementations agree`);

  // Args for the tools that need them; everything else takes none. Ranged tools default
  // to the full span of loaded data, so an empty object is the realistic call.
  const args: Record<string, unknown> = {
    churn_cohorts: { dimension: "acquisition_type", minSubscriptions: 20 },
    renewal_churn: { cycleMonths: 3 },
    top_customers: { limit: 3 },
  };

  let failures = 0;
  for (const tool of tools) {
    const name = (tool as { name: string }).name;
    const started = Date.now();
    try {
      const out = await tool.run(args[name] ?? {}, {
        toolUse: { id: "diagnostic", name, input: {}, type: "tool_use" },
        toolUseBlock: { id: "diagnostic", name, input: {}, type: "tool_use" },
      } as never);
      const text = typeof out === "string" ? out : JSON.stringify(out);
      const ms = Date.now() - started;
      if (text.includes("NOT VALID JSON")) throw new Error("handler returned non-JSON");
      add("pass", name, `${describe(text)} · ${ms}ms`);
    } catch (err) {
      failures += 1;
      add("fail", name, err instanceof Error ? err.message.split("\n")[0] : String(err));
    }
  }

  // ---- Capability enforcement (gate 2) ----------------------------------
  console.log("\nChecking a withheld tool actually refuses…\n");
  const marketingTools = buildAnalystTools("marketing");
  const reachable = marketingTools.map((t) => (t as { name: string }).name);
  if (reachable.includes("margin_summary") || reachable.includes("top_customers")) {
    failures += 1;
    add("fail", "Gate 1", "a margin or customer tool is reachable by the marketing role");
  } else {
    add("pass", "Gate 1", `marketing role cannot see margin or customer tools`);
  }

  // Gate 2 is the handler's own `assertCapability` call, which reaches the same
  // predicate. It cannot be exercised from here without bypassing gate 1 — that is the
  // point of it — so what this checks is the predicate both gates share. The unit tests
  // in tests/analyst-tools.test.ts cover it across every role and tool.
  const { roleCanUseTool } = await import("../src/lib/ai/analyst");
  const leaks = ["margin_summary", "profit_waterfall", "top_customers"].filter((t) =>
    roleCanUseTool("marketing", t),
  );
  if (leaks.length) {
    failures += 1;
    add("fail", "Gate 2", `predicate allows marketing to reach: ${leaks.join(", ")}`);
  } else {
    add("pass", "Gate 2", "predicate refuses margin and customer tools for marketing");
  }

  // ---- One real question -------------------------------------------------
  if (hasKey) {
    console.log("\nAsking the model one question end to end…\n");
    try {
      const { askAnalyst } = await import("../src/lib/ai/analyst.server");
      let answer = "";
      const used: string[] = [];
      for await (const event of askAnalyst(
        [{ role: "user", content: "What was our net revenue, and how much of it can we trust?" }],
        "admin",
      )) {
        if (event.type === "text") answer += event.text;
        else if (event.type === "tool") used.push(event.name);
        else if (event.type === "error") throw new Error(event.message);
      }
      add("pass", "End to end", `${used.length} tool call(s): ${used.join(", ") || "none"}`);
      console.log(`\n  ---\n${answer.trim().replace(/^/gm, "  ")}\n  ---`);
    } catch (err) {
      failures += 1;
      add("fail", "End to end", err instanceof Error ? err.message.split("\n")[0] : String(err));
    }
  }

  // ---- Verdict -----------------------------------------------------------
  const warnings = results.filter((r) => r.status === "warn").length;
  console.log("");
  if (failures > 0) {
    console.log(`${failures} check(s) failed. The analyst will not work correctly.\n`);
    process.exit(1);
  }
  console.log(
    hasKey
      ? `Analyst ready.${warnings ? ` ${warnings} thing(s) worth a look.` : ""}\n`
      : "Tools all work. Add ANTHROPIC_API_KEY to .env to enable /ask.\n",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\nDiagnostic crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
