import { z } from 'zod'
import type { VerifiedSessionClaims } from './authorization'
import { canonicalPayloadHash } from './cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
export class CheckoutMarketError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'unavailable'
  ) {
    super(code)
  }
}
const uuid = z.string().uuid()
const methods = z
  .array(z.enum(['card', 'bank_transfer', 'credit']))
  .min(1)
  .max(3)
  .refine((value) => new Set(value).size === value.length)
const schema = z
  .object({
    market: z.string().regex(/^[A-Z]{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    exchangeNumerator: z.number().int().min(1).max(1000000),
    exchangeDenominator: z.number().int().min(1).max(1000000),
    goodsTaxBps: z.number().int().min(0).max(10000),
    shippingNetMinor: z.number().int().min(0).max(100000000),
    shippingTaxBps: z.number().int().min(0).max(10000),
    termsVersion: z.string().regex(/^[a-zA-Z0-9_-]{3,100}$/),
    paymentMethods: methods
  })
  .strict()
type Options = { now?: () => string }
type Profile = z.infer<typeof schema> & { version: number }
interface Stored {
  command_id: string
  market: string
  currency: string
  exchange_numerator: number
  exchange_denominator: number
  goods_tax_bps: number
  shipping_net_minor: number
  shipping_tax_bps: number
  terms_version: string
  payment_methods: string
  payload_hash: string
  expected_version: number
  version: number
  created_at: string
}
function fail(code: CheckoutMarketError['code']): never {
  throw new CheckoutMarketError(code)
}
const cte = `WITH clock AS MATERIALIZED (SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now), authority AS MATERIALIZED (
 SELECT i.id actorId,s.mfa_verified mfaVerified,(i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM clock)) emailVerified,
 EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=(SELECT now FROM clock) AND (r.expires_at IS NULL OR r.expires_at>(SELECT now FROM clock))) permitted
 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND i.session_version=s.session_version AND i.status IN('pending','active') AND s.revoked_at IS NULL AND s.created_at<=(SELECT now FROM clock) AND s.expires_at>(SELECT now FROM clock))`
function params(claims: VerifiedSessionClaims | null, options: Options) {
  if (
    !claims ||
    !uuid.safeParse(claims.identityId).success ||
    !uuid.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    fail('unauthenticated')
  const now = options.now?.() ?? null
  if (now !== null && !catalogPolicyInstantSchema.safeParse(now).success) fail('unavailable')
  return [now, claims.sessionId, claims.identityId, claims.sessionVersion]
}
async function authority(db: D1Database, claims: VerifiedSessionClaims | null, options: Options) {
  const row = await db
    .prepare(`${cte} SELECT * FROM authority`)
    .bind(...params(claims, options))
    .first<{ actorId: string; emailVerified: number; mfaVerified: number; permitted: number }>()
  if (!row) fail('unauthenticated')
  if (!row.emailVerified) fail('email_unverified')
  if (!row.mfaVerified) fail('mfa_required')
  if (!row.permitted) fail('forbidden')
  return row.actorId
}
export async function assertCheckoutMarketAuthority(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: Options = {}
) {
  await authority(db, claims, options)
}
function profile(row: Stored): Profile {
  return schema.extend({ version: z.number().int().positive() }).parse({
    market: row.market,
    currency: row.currency,
    expectedVersion: row.expected_version,
    version: row.version,
    exchangeNumerator: row.exchange_numerator,
    exchangeDenominator: row.exchange_denominator,
    goodsTaxBps: row.goods_tax_bps,
    shippingNetMinor: row.shipping_net_minor,
    shippingTaxBps: row.shipping_tax_bps,
    termsVersion: row.terms_version,
    paymentMethods: JSON.parse(row.payment_methods)
  })
}
function receipt(row: Stored) {
  return {
    source: 'cloudflare' as const,
    commandId: row.command_id,
    market: row.market,
    version: row.version,
    createdAt: row.created_at
  }
}
export async function readCheckoutMarket(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  market: string,
  options: Options = {}
) {
  if (!/^[A-Z]{2}$/.test(market)) fail('invalid_input')
  await authority(db, claims, options)
  const row = await db
    .prepare(
      `${cte} SELECT c.* FROM checkout_market_commands c,authority WHERE emailVerified=1 AND mfaVerified=1 AND permitted=1 AND c.market=?5 ORDER BY c.version DESC LIMIT 1`
    )
    .bind(...params(claims, options), market)
    .first<Stored>()
  await authority(db, claims, options)
  if (!row) fail('not_found')
  return profile(row)
}
export async function configureCheckoutMarket(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  raw: unknown,
  options: Options = {}
) {
  const parsed = schema.safeParse(raw)
  if (!parsed.success || !uuid.safeParse(commandId).success) fail('invalid_input')
  const actor = await authority(db, claims, options),
    v = parsed.data,
    hash = await canonicalPayloadHash({ actorId: actor, ...v })
  const lookup = async () =>
    db
      .prepare(
        `${cte} SELECT c.* FROM checkout_market_commands c,authority WHERE emailVerified=1 AND mfaVerified=1 AND permitted=1 AND c.command_id=?5`
      )
      .bind(...params(claims, options), commandId)
      .first<Stored>()
  const previous = await lookup()
  if (previous) {
    if (previous.payload_hash !== hash) fail('conflict')
    await authority(db, claims, options)
    return receipt(previous)
  }
  try {
    await db.batch([
      db
        .prepare(
          `${cte} INSERT INTO checkout_market_commands(command_id,market,currency,exchange_numerator,exchange_denominator,goods_tax_bps,shipping_net_minor,shipping_tax_bps,terms_version,payment_methods,actor_id,session_id,session_version,payload_hash,expected_version,version,created_at)
 SELECT ?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,actorId,?2,?4,?15,?16,?16+1,(SELECT now FROM clock) FROM authority WHERE emailVerified=1 AND mfaVerified=1 AND permitted=1`
        )
        .bind(
          ...params(claims, options),
          commandId,
          v.market,
          v.currency,
          v.exchangeNumerator,
          v.exchangeDenominator,
          v.goodsTaxBps,
          v.shippingNetMinor,
          v.shippingTaxBps,
          v.termsVersion,
          JSON.stringify(v.paymentMethods),
          hash,
          v.expectedVersion
        )
    ])
  } catch (cause) {
    await authority(db, claims, options)
    const raced = await lookup()
    if (raced) {
      if (raced.payload_hash !== hash) fail('conflict')
      return receipt(raced)
    }
    if (cause instanceof Error && cause.message.includes('market_conflict')) fail('conflict')
    fail('unavailable')
  }
  const row = await lookup()
  await authority(db, claims, options)
  if (!row) fail('unavailable')
  return receipt(row)
}
export function calculateCheckoutMarket(raw: unknown, goodsNetEurMinor: number) {
  const parsed = schema.extend({ version: z.number().int().positive() }).safeParse(raw)
  if (!parsed.success || !Number.isSafeInteger(goodsNetEurMinor) || goodsNetEurMinor < 0) fail('invalid_input')
  const p = parsed.data,
    round = (amount: bigint, num: number, den: number) =>
      (amount * BigInt(num) + BigInt(Math.floor(den / 2))) / BigInt(den)
  const goods = round(BigInt(goodsNetEurMinor), p.exchangeNumerator, p.exchangeDenominator),
    tax = round(goods, p.goodsTaxBps, 10000),
    shipping = BigInt(p.shippingNetMinor),
    shippingTax = round(shipping, p.shippingTaxBps, 10000),
    total = goods + tax + shipping + shippingTax
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_input')
  return {
    market: p.market,
    currency: p.currency,
    version: p.version,
    goodsNetMinor: Number(goods),
    goodsTaxMinor: Number(tax),
    shippingNetMinor: Number(shipping),
    shippingTaxMinor: Number(shippingTax),
    totalMinor: Number(total),
    termsVersion: p.termsVersion,
    paymentMethods: p.paymentMethods
  }
}

/** Latest immutable profile of a market. Server-side only: no authority, never exposes actors or sessions. */
export async function loadCheckoutMarketProfile(db: D1Database, market: string) {
  if (!/^[A-Z]{2}$/.test(market)) fail('invalid_input')
  const row = await db
    .prepare('SELECT * FROM checkout_market_commands WHERE market=?1 ORDER BY version DESC LIMIT 1')
    .bind(market)
    .first<Stored>()
  return row ? profile(row) : null
}

/**
 * EUR ledger amounts persisted on the order (payments stay in EUR). Shipping is configured in the market currency,
 * so it is converted back with the same explicit rate; every step is integer, half-up arithmetic.
 */
export function calculateMarketLedger(raw: unknown, goodsNetEurMinor: number) {
  const parsed = schema.extend({ version: z.number().int().positive() }).safeParse(raw)
  if (!parsed.success || !Number.isSafeInteger(goodsNetEurMinor) || goodsNetEurMinor < 0) fail('invalid_input')
  const p = parsed.data,
    round = (amount: bigint, num: number, den: number) =>
      (amount * BigInt(num) + BigInt(Math.floor(den / 2))) / BigInt(den)
  const goods = BigInt(goodsNetEurMinor),
    tax = round(goods, p.goodsTaxBps, 10000),
    shipping = round(BigInt(p.shippingNetMinor), p.exchangeDenominator, p.exchangeNumerator),
    shippingTax = round(shipping, p.shippingTaxBps, 10000),
    total = goods + tax + shipping + shippingTax
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_input')
  return {
    goodsNetMinor: Number(goods),
    goodsTaxMinor: Number(tax),
    shippingNetMinor: Number(shipping),
    shippingTaxMinor: Number(shippingTax),
    totalMinor: Number(total)
  }
}
