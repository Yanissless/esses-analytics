/**
 * Split Stripe subscriptions/invoices into print vs digital (Section 3). Both
 * bill through the same Stripe account, so we classify by price/product ID
 * (configured via env) with a name-heuristic fallback and a safe default.
 *
 * Pure and unit-testable.
 */
import { env } from "../../lib/env";

export type SubscriptionLine = "print" | "digital";

function parseIds(csv?: string): Set<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const PRINT_IDS = parseIds(env.STRIPE_PRINT_PRICE_IDS);
const DIGITAL_IDS = parseIds(env.STRIPE_DIGITAL_PRICE_IDS);

export interface LineResolveInput {
  priceId?: string | null;
  productId?: string | null;
  /** nickname / product name / description used for the heuristic fallback. */
  text?: string | null;
}

export function resolveSubscriptionLine(input: LineResolveInput): SubscriptionLine {
  const { priceId, productId, text } = input;

  for (const id of [priceId, productId]) {
    if (!id) continue;
    if (PRINT_IDS.has(id)) return "print";
    if (DIGITAL_IDS.has(id)) return "digital";
  }

  const t = (text ?? "").toLowerCase();
  if (/\b(digital|web|online|e-?edition|pdf|ebook)\b/.test(t)) return "digital";
  if (/\b(print|magazine|issue|physical|hard\s?copy|paper)\b/.test(t)) return "print";

  return env.STRIPE_DEFAULT_LINE;
}
