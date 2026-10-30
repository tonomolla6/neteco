import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import {
  internationalShippingPolicyInputSchema,
  InternationalShippingError,
  type InternationalShippingEvaluation,
  type InternationalShippingPolicy,
  type InternationalShippingPolicyInput,
  type ShippingEvaluationItem
} from '../../shared/catalog-markets'

const uuidSchema = z.string().uuid()

interface Options {
  now?: () => string
}

function getNow(options?: Options): string {
  if (options?.now) return options.now()
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const authorityCte = `
  WITH clock AS MATERIALIZED (SELECT COALESCE(?1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) as now),
  authority AS MATERIALIZED (
    SELECT i.id as actorId, s.mfa_verified as mfaVerified,
           (i.email_verified_at IS NOT NULL AND i.email_verified_at <= (SELECT now FROM clock)) as emailVerified,
           EXISTS(
             SELECT 1 FROM identity_roles r
             JOIN role_permissions p ON p.role_code = r.role_code
             WHERE r.identity_id = i.id
               AND p.permission_code = 'administration.manage'
               AND r.granted_at <= (SELECT now FROM clock)
               AND (r.expires_at IS NULL OR r.expires_at > (SELECT now FROM clock))
           ) as permitted
    FROM auth_sessions s
    JOIN identities i ON i.id = s.identity_id
    WHERE s.id = ?2
      AND s.identity_id = ?3
      AND s.session_version = ?4
      AND i.session_version = s.session_version
      AND i.status IN ('pending', 'active')
      AND s.revoked_at IS NULL
      AND s.created_at <= (SELECT now FROM clock)
      AND s.expires_at > (SELECT now FROM clock)
  )
`

async function checkAuthority(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  options?: Options
): Promise<{ actorId: string }> {
  if (
    !claims ||
    !uuidSchema.safeParse(claims.identityId).success ||
    !uuidSchema.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  ) {
    throw new InternationalShippingError('unauthenticated')
  }

  const now = getNow(options)
  const row = await database
    .prepare(`${authorityCte} SELECT * FROM authority`)
    .bind(now, claims.sessionId, claims.identityId, claims.sessionVersion)
    .first<{ actorId: string; emailVerified: number; mfaVerified: number; permitted: number }>()

  if (!row) throw new InternationalShippingError('unauthenticated')
  if (!row.emailVerified || !row.mfaVerified || !row.permitted) throw new InternationalShippingError('forbidden')
  return row
}

export async function readInternationalShippingPolicy(
  database: D1Database,
  marketCode: string
): Promise<InternationalShippingPolicy | null> {
  const row = await database
    .prepare(
      `SELECT market_code as marketCode, version,
              customs_declared_value_required as customsDeclaredValueRequired,
              duty_collection_type as dutyCollectionType,
              hs_tariff_code_required as hsTariffCodeRequired,
              de_minimis_threshold_cents as deMinimisThresholdCents,
              estimated_duty_rate_bps as estimatedDutyRateBps,
              customs_handling_fee_cents as customsHandlingFeeCents,
              required_documents as requiredDocuments,
              customs_declaration_notes as customsDeclarationNotes,
              adr_allowed as adrAllowed,
              max_hazard_class as maxHazardClass,
              prohibited_un_numbers as prohibitedUnNumbers,
              max_dangerous_goods_volume_liters as maxDangerousGoodsVolumeLiters,
              requires_special_adr_carrier as requiresSpecialAdrCarrier,
              returns_permitted as returnsPermitted,
              return_window_days as returnWindowDays,
              hazardous_returns_allowed as hazardousReturnsAllowed,
              return_carrier_code as returnCarrierCode,
              customer_return_fee_cents as customerReturnFeeCents,
              return_policy_notes as returnPolicyNotes,
              created_at as createdAt,
              updated_at as updatedAt
       FROM international_shipping_market_policies
       WHERE market_code = ?`
    )
    .bind(marketCode)
    .first<Record<string, unknown>>()

  if (!row) return null

  return {
    ...(row as unknown as InternationalShippingPolicy),
    requiredDocuments:
      typeof row.requiredDocuments === 'string'
        ? JSON.parse(row.requiredDocuments)
        : (row.requiredDocuments as string[]),
    prohibitedUnNumbers:
      typeof row.prohibitedUnNumbers === 'string'
        ? JSON.parse(row.prohibitedUnNumbers)
        : (row.prohibitedUnNumbers as string[])
  }
}

export async function configureInternationalShippingPolicy(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  rawInput: unknown,
  options?: Options
): Promise<{ commandId: string; marketCode: string; version: number; createdAt: string }> {
  if (!uuidSchema.safeParse(commandId).success) {
    throw new InternationalShippingError('invalid_input')
  }

  const parsed = internationalShippingPolicyInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new InternationalShippingError('invalid_input')
  }
  const input: InternationalShippingPolicyInput = parsed.data

  const actor = await checkAuthority(database, claims, options)
  const now = getNow(options)

  const payloadHash = await canonicalPayloadHash({
    marketCode: input.marketCode,
    actorId: actor.actorId,
    ...input
  })

  // Check idempotency
  const existingCommand = await database
    .prepare(
      'SELECT command_id, market_code, payload_hash, version, created_at FROM international_shipping_commands WHERE command_id = ?'
    )
    .bind(commandId)
    .first<{ command_id: string; market_code: string; payload_hash: string; version: number; created_at: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash || existingCommand.market_code !== input.marketCode) {
      throw new InternationalShippingError('conflict')
    }
    return {
      commandId: existingCommand.command_id,
      marketCode: existingCommand.market_code,
      version: existingCommand.version,
      createdAt: existingCommand.created_at
    }
  }

  const currentPolicy = await database
    .prepare('SELECT version FROM international_shipping_market_policies WHERE market_code = ?')
    .bind(input.marketCode)
    .first<{ version: number }>()

  const currentVersion = currentPolicy?.version ?? 0
  if (currentVersion !== input.expectedVersion) {
    throw new InternationalShippingError('conflict')
  }

  const newVersion = input.expectedVersion + 1
  const requiredDocumentsJson = JSON.stringify(input.requiredDocuments ?? [])
  const prohibitedUnNumbersJson = JSON.stringify(input.prohibitedUnNumbers ?? [])

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO international_shipping_commands(
            command_id, market_code, action, actor_id, session_id,
            session_version, payload_hash, expected_version, version, created_at
          ) VALUES (?, ?, 'configure_policy', ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          commandId,
          input.marketCode,
          actor.actorId,
          claims!.sessionId,
          claims!.sessionVersion,
          payloadHash,
          input.expectedVersion,
          newVersion,
          now
        ),
      database
        .prepare(
          `INSERT INTO international_shipping_market_policies(
            market_code, version, customs_declared_value_required, duty_collection_type,
            hs_tariff_code_required, de_minimis_threshold_cents, estimated_duty_rate_bps,
            customs_handling_fee_cents, required_documents, customs_declaration_notes,
            adr_allowed, max_hazard_class, prohibited_un_numbers, max_dangerous_goods_volume_liters,
            requires_special_adr_carrier, returns_permitted, return_window_days,
            hazardous_returns_allowed, return_carrier_code, customer_return_fee_cents,
            return_policy_notes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(market_code) DO UPDATE SET
            version = excluded.version,
            customs_declared_value_required = excluded.customs_declared_value_required,
            duty_collection_type = excluded.duty_collection_type,
            hs_tariff_code_required = excluded.hs_tariff_code_required,
            de_minimis_threshold_cents = excluded.de_minimis_threshold_cents,
            estimated_duty_rate_bps = excluded.estimated_duty_rate_bps,
            customs_handling_fee_cents = excluded.customs_handling_fee_cents,
            required_documents = excluded.required_documents,
            customs_declaration_notes = excluded.customs_declaration_notes,
            adr_allowed = excluded.adr_allowed,
            max_hazard_class = excluded.max_hazard_class,
            prohibited_un_numbers = excluded.prohibited_un_numbers,
            max_dangerous_goods_volume_liters = excluded.max_dangerous_goods_volume_liters,
            requires_special_adr_carrier = excluded.requires_special_adr_carrier,
            returns_permitted = excluded.returns_permitted,
            return_window_days = excluded.return_window_days,
            hazardous_returns_allowed = excluded.hazardous_returns_allowed,
            return_carrier_code = excluded.return_carrier_code,
            customer_return_fee_cents = excluded.customer_return_fee_cents,
            return_policy_notes = excluded.return_policy_notes,
            updated_at = excluded.updated_at`
        )
        .bind(
          input.marketCode,
          newVersion,
          input.customsDeclaredValueRequired ? 1 : 0,
          input.dutyCollectionType,
          input.hsTariffCodeRequired ? 1 : 0,
          input.deMinimisThresholdCents,
          input.estimatedDutyRateBps,
          input.customsHandlingFeeCents,
          requiredDocumentsJson,
          input.customsDeclarationNotes ?? null,
          input.adrAllowed ? 1 : 0,
          input.maxHazardClass,
          prohibitedUnNumbersJson,
          input.maxDangerousGoodsVolumeLiters,
          input.requiresSpecialAdrCarrier ? 1 : 0,
          input.returnsPermitted ? 1 : 0,
          input.returnWindowDays,
          input.hazardousReturnsAllowed ? 1 : 0,
          input.returnCarrierCode ?? null,
          input.customerReturnFeeCents,
          input.returnPolicyNotes ?? null,
          now,
          now
        )
    ])
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('conflict')) {
      throw new InternationalShippingError('conflict')
    }
    throw error
  }

  return {
    commandId,
    marketCode: input.marketCode,
    version: newVersion,
    createdAt: now
  }
}

export async function evaluateInternationalShipping(
  database: D1Database,
  request: {
    marketCode: string
    declaredValueCents: number
    items: ShippingEvaluationItem[]
  }
): Promise<InternationalShippingEvaluation> {
  const policy = await readInternationalShippingPolicy(database, request.marketCode)

  const activePolicy: InternationalShippingPolicy = policy ?? {
    marketCode: request.marketCode,
    version: 1,
    customsDeclaredValueRequired: 0,
    dutyCollectionType: 'exempt',
    hsTariffCodeRequired: 0,
    deMinimisThresholdCents: 15000,
    estimatedDutyRateBps: 0,
    customsHandlingFeeCents: 0,
    requiredDocuments: [],
    adrAllowed: 1,
    maxHazardClass: 'unrestricted',
    prohibitedUnNumbers: [],
    maxDangerousGoodsVolumeLiters: 100,
    requiresSpecialAdrCarrier: 0,
    returnsPermitted: 1,
    returnWindowDays: 14,
    hazardousReturnsAllowed: 0,
    customerReturnFeeCents: 0,
    createdAt: '',
    updatedAt: ''
  }

  const violations: string[] = []
  let blockReason: InternationalShippingEvaluation['blockReason'] = null

  // Evaluate chemical / ADR restrictions
  let totalDangerousGoodsVolumeLiters = 0
  for (const item of request.items) {
    if (item.isDangerousGoods) {
      if (!activePolicy.adrAllowed) {
        blockReason = blockReason ?? 'adr_not_allowed_in_market'
        violations.push(`Dangerous goods (ADR) transport is prohibited to destination market ${request.marketCode}.`)
      }

      if (item.unNumber && activePolicy.prohibitedUnNumbers.includes(item.unNumber.toUpperCase())) {
        blockReason = blockReason ?? 'prohibited_chemical_un_number'
        violations.push(`Chemical UN number ${item.unNumber} is prohibited for export to ${request.marketCode}.`)
      }

      totalDangerousGoodsVolumeLiters += (item.volumeLiters ?? 0) * (item.quantity ?? 1)

      if (activePolicy.maxHazardClass === 'none') {
        blockReason = blockReason ?? 'hazard_class_exceeded'
        violations.push(`Hazard class ${item.hazardClass ?? 'dangerous_goods'} exceeds maximum allowed (none).`)
      }
    }
  }

  if (
    activePolicy.maxDangerousGoodsVolumeLiters > 0 &&
    totalDangerousGoodsVolumeLiters > activePolicy.maxDangerousGoodsVolumeLiters
  ) {
    blockReason = blockReason ?? 'dangerous_goods_volume_limit_exceeded'
    violations.push(
      `Total dangerous goods volume (${totalDangerousGoodsVolumeLiters}L) exceeds maximum allowed for ${request.marketCode} (${activePolicy.maxDangerousGoodsVolumeLiters}L).`
    )
  }

  const allowed = violations.length === 0

  // Duties calculation
  const exceedsDeMinimis =
    activePolicy.deMinimisThresholdCents > 0 && request.declaredValueCents > activePolicy.deMinimisThresholdCents
  const estimatedDutyCents =
    exceedsDeMinimis && activePolicy.estimatedDutyRateBps > 0
      ? Math.round((request.declaredValueCents * activePolicy.estimatedDutyRateBps) / 10000)
      : 0
  const customsHandlingFeeCents =
    activePolicy.dutyCollectionType !== 'exempt' ? activePolicy.customsHandlingFeeCents : 0
  const totalCustomsFeesCents = estimatedDutyCents + customsHandlingFeeCents

  return {
    marketCode: request.marketCode,
    allowed,
    blockReason: allowed ? null : blockReason,
    violations,
    duties: {
      declaredValueRequired: activePolicy.customsDeclaredValueRequired === 1,
      dutyCollectionType: activePolicy.dutyCollectionType,
      exceedsDeMinimis,
      estimatedDutyCents,
      customsHandlingFeeCents,
      totalCustomsFeesCents
    },
    documentation: {
      requiredDocuments: activePolicy.requiredDocuments,
      customsNotes: activePolicy.customsDeclarationNotes
    },
    returns: {
      returnsPermitted: activePolicy.returnsPermitted === 1,
      returnWindowDays: activePolicy.returnWindowDays,
      hazardousReturnsAllowed: activePolicy.hazardousReturnsAllowed === 1,
      returnFeeCents: activePolicy.customerReturnFeeCents,
      returnCarrierCode: activePolicy.returnCarrierCode
    }
  }
}
