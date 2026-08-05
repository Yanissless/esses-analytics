/**
 * Minimal structured logger. JSON lines in production, readable in dev.
 *
 * `logger.alert()` is the loud-failure path (Section 14): it logs at error level
 * and will post to Slack once the Slack connector is wired (Phase 9/14). The
 * Slack call is stubbed here and guarded on SLACK_BOT_TOKEN so nothing throws
 * when it isn't configured yet.
 */
type Level = "debug" | "info" | "warn" | "error";

type Meta = Record<string, unknown>;

function emit(level: Level, message: string, meta?: Meta) {
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    process.stdout.write(
      JSON.stringify({ level, message, ...meta, ts: new Date().toISOString() }) + "\n",
    );
  } else {
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`[${level}] ${message}`, meta ?? "");
  }
}

async function postSlackStub(message: string, meta?: Meta) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_ALERT_CHANNEL;
  if (!token || !channel) {
    emit("warn", `alert not delivered (Slack not configured): ${message}`, meta);
    return;
  }
  // TODO(Phase 9/14): POST to Slack chat.postMessage via the Slack connector.
  emit("info", `[slack:${channel}] ${message}`, meta);
}

export const logger = {
  debug: (m: string, meta?: Meta) => emit("debug", m, meta),
  info: (m: string, meta?: Meta) => emit("info", m, meta),
  warn: (m: string, meta?: Meta) => emit("warn", m, meta),
  error: (m: string, meta?: Meta) => emit("error", m, meta),
  /** Log an error AND (once wired) page the team via Slack. */
  alert: async (m: string, meta?: Meta) => {
    emit("error", m, meta);
    await postSlackStub(m, meta);
  },
};
