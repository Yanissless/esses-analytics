/**
 * Unified customer resolution (Section 6). Connectors call `resolveCustomer` to
 * get a single customer row for a person seen in any source. Dedup precedence:
 *   1. match on the provided source id (shopify/stripe/skio) — exact
 *   2. else match on lower(email) and attach the source id
 *   3. else create a new unified customer
 *
 * This progressively links a person's Shopify + Stripe + Skio identities onto
 * one row. When a source id already belongs to a different row than the email
 * match, we keep them separate and warn (a dedicated merge pass can reconcile).
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { customers } from "../db/schema";
import { logger } from "../lib/logger";

export interface CustomerRef {
  email?: string | null;
  name?: string | null;
  phone?: string | null;
  shopifyCustomerId?: string | null;
  stripeCustomerId?: string | null;
  skioStorefrontUserId?: string | null;
}

function normEmail(email?: string | null): string | null {
  const e = email?.trim().toLowerCase();
  return e ? e : null;
}

async function findBySourceId(ref: CustomerRef) {
  if (ref.shopifyCustomerId) {
    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.shopifyCustomerId, ref.shopifyCustomerId))
      .limit(1);
    if (row) return row;
  }
  if (ref.stripeCustomerId) {
    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.stripeCustomerId, ref.stripeCustomerId))
      .limit(1);
    if (row) return row;
  }
  if (ref.skioStorefrontUserId) {
    const [row] = await db
      .select()
      .from(customers)
      .where(eq(customers.skioStorefrontUserId, ref.skioStorefrontUserId))
      .limit(1);
    if (row) return row;
  }
  return null;
}

/** Only set a source id / field if the existing value is empty (never clobber). */
function fillPatch(
  existing: typeof customers.$inferSelect,
  ref: CustomerRef,
  email: string | null,
) {
  const patch: Partial<typeof customers.$inferInsert> = {};
  if (!existing.email && email) patch.email = email;
  if (!existing.name && ref.name) patch.name = ref.name;
  if (!existing.phone && ref.phone) patch.phone = ref.phone;
  if (!existing.shopifyCustomerId && ref.shopifyCustomerId)
    patch.shopifyCustomerId = ref.shopifyCustomerId;
  if (!existing.stripeCustomerId && ref.stripeCustomerId)
    patch.stripeCustomerId = ref.stripeCustomerId;
  if (!existing.skioStorefrontUserId && ref.skioStorefrontUserId)
    patch.skioStorefrontUserId = ref.skioStorefrontUserId;
  return patch;
}

/** True if `email` is unused, or only used by `selfId`. Guards the unique email
 *  constraint — Stripe allows multiple customers to share an email, we don't. */
async function emailFreeFor(email: string, selfId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.email, email))
    .limit(1);
  return !row || row.id === selfId;
}

export async function resolveCustomer(ref: CustomerRef): Promise<string> {
  const email = normEmail(ref.email);

  // 1. Exact source-id match.
  const bySource = await findBySourceId(ref);
  if (bySource) {
    const patch = fillPatch(bySource, ref, email);
    // Don't move an email onto this row if another customer already owns it.
    if (patch.email && !(await emailFreeFor(patch.email, bySource.id))) {
      delete patch.email;
      logger.warn("Email already owned by another customer — left unset", {
        email,
        customerId: bySource.id,
      });
    }
    if (Object.keys(patch).length) {
      await db.update(customers).set(patch).where(eq(customers.id, bySource.id));
    }
    return bySource.id;
  }

  // 2. Email match — attach the new source id to the existing person.
  if (email) {
    const [byEmail] = await db
      .select()
      .from(customers)
      .where(eq(customers.email, email))
      .limit(1);
    if (byEmail) {
      const patch = fillPatch(byEmail, ref, email);
      if (Object.keys(patch).length) {
        await db.update(customers).set(patch).where(eq(customers.id, byEmail.id));
      }
      return byEmail.id;
    }
  }

  // 3. Create.
  const [created] = await db
    .insert(customers)
    .values({
      email,
      name: ref.name ?? null,
      phone: ref.phone ?? null,
      shopifyCustomerId: ref.shopifyCustomerId ?? null,
      stripeCustomerId: ref.stripeCustomerId ?? null,
      skioStorefrontUserId: ref.skioStorefrontUserId ?? null,
    })
    .returning({ id: customers.id });

  if (!email && !ref.shopifyCustomerId && !ref.stripeCustomerId) {
    logger.warn("Created customer with no email or source id", { name: ref.name });
  }
  return created.id;
}
