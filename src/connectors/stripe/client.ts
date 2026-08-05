/** Stripe SDK client (lazy singleton). Auto-retries + auto-pagination come from
 *  the SDK; we just guard on configuration. */
import Stripe from "stripe";
import { env } from "../../lib/env";

export class StripeConfigError extends Error {}

let cached: Stripe | null = null;

export function stripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new StripeConfigError("Stripe not configured — set STRIPE_SECRET_KEY in .env");
  }
  if (!cached) {
    cached = new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 3 });
  }
  return cached;
}
