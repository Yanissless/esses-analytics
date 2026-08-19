import "dotenv/config";
import { runSync } from "../src/lib/sync/run-sync";
async function main() {
  // First run establishes a cursor if none exists; time the SECOND, which is the steady state.
  console.log("run 1 (may be a full load if no cursor yet)...");
  let t = Date.now();
  let r = await runSync({ sources: ["skio"], skipMetrics: true });
  console.log(`  ${Date.now() - t} ms  rows=${r.results[0]?.rows} warnings=${JSON.stringify(r.results[0]?.error ?? "")}`);

  console.log("run 2 (steady-state incremental)...");
  t = Date.now();
  r = await runSync({ sources: ["skio"], skipMetrics: true });
  console.log(`  ${Date.now() - t} ms  rows=${r.results[0]?.rows}`);
}
main().then(() => process.exit(0)).catch(e => { console.error(String(e).slice(0,300)); process.exit(1); });
