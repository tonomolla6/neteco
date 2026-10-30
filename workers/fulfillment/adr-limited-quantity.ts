import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { checkAdminAuthority, isConstraintFailure, isUuid, serverNow } from '../catalog/admin-command-authority'
import {
  AdrLqError,
  carrierCodeSchema,
  carrierRestrictionInputSchema,
  evaluateLimitedQuantityLine,
  hazardInfoFromSpec,
  shipmentInputSchema,
  specialistValidationInputSchema,
  summariseShipment,
  type AdrSpecFacts,
  type CarrierRuleFacts,
  type HazardInfo,
  type SpecialistValidationFacts
} from '../../shared/adr-limited-quantity'

interface Options {
  now?: () => string
}

async function requireAdmin(database: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  const authority = await checkAdminAuthority(database, claims, now)
  if (!authority.ok) throw new AdrLqError(authority.code)
  return authority.actorId
}

function parseJsonArray(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

interface SpecRow {
  specVersion: number | null
  unNumber: string
  properShippingName: string
  adrClass: AdrSpecFacts['adrClass']
  packingGroup: AdrSpecFacts['packingGroup']
  limitedQuantity: string
  pictograms: string
  signalWord: AdrSpecFacts['signalWord']
  hazardStatements: string
  precautionaryStatements: string
  ufiCode: string | null
  sdsVersion: string
}

function specFromRow(row: SpecRow): AdrSpecFacts | null {
  if (row.specVersion === null || row.specVersion === undefined) return null
  return {
    version: row.specVersion,
    unNumber: row.unNumber,
    properShippingName: row.properShippingName,
    adrClass: row.adrClass,
    packingGroup: row.packingGroup,
    limitedQuantity: row.limitedQuantity,
    pictograms: parseJsonArray(row.pictograms),
    signalWord: row.signalWord,
    hazardStatements: parseJsonArray(row.hazardStatements),
    precautionaryStatements: parseJsonArray(row.precautionaryStatements),
    ufiCode: row.ufiCode,
    sdsVersion: row.sdsVersion
  }
}

const SPEC_COLUMNS = `s.version AS specVersion, s.un_number AS unNumber, s.proper_shipping_name AS properShippingName,
  s.adr_class AS adrClass, s.packing_group AS packingGroup, s.limited_quantity AS limitedQuantity,
  s.pictograms_json AS pictograms, s.signal_word AS signalWord, s.hazard_statements_json AS hazardStatements,
  s.precautionary_statements_json AS precautionaryStatements, s.ufi_code AS ufiCode, s.sds_version AS sdsVersion`

/** Hazard information is public and independent of any shipping decision; unclassified is stated, never implied safe. */
export async function getHazardInfo(
  database: D1Database,
  variantId: unknown
): Promise<HazardInfo & { variantId: string }> {
  if (typeof variantId !== 'string' || variantId.length < 1 || variantId.length > 64)
    throw new AdrLqError('invalid_input')
  const row = await database
    .prepare(
      `SELECT v.id AS variantId, ${SPEC_COLUMNS}
       FROM variants v LEFT JOIN variant_adr_specifications s ON s.variant_id = v.id WHERE v.id = ?1`
    )
    .bind(variantId)
    .first<SpecRow & { variantId: string }>()
  if (!row) throw new AdrLqError('not_found')
  return { variantId: row.variantId, ...hazardInfoFromSpec(specFromRow(row)) }
}

interface ValidationRow {
  version: number
  specVersion: number
  status: 'validated' | 'rejected'
  contentUnit: 'ml' | 'g'
  innerContentAmount: number
  unitsPerOuter: number
  outerGrossGrams: number
  grossLimitGrams: number
  specialistName: string
  certificateRef: string
  createdAt: string
}

const VALIDATION_COLUMNS = `val.version AS version, val.spec_version AS specVersion, val.status AS status,
  val.content_unit AS contentUnit, val.inner_content_amount AS innerContentAmount, val.units_per_outer AS unitsPerOuter,
  val.outer_gross_grams AS outerGrossGrams, val.gross_limit_grams AS grossLimitGrams,
  val.specialist_name AS specialistName, val.certificate_ref AS certificateRef, val.created_at AS createdAt`

const EVALUATION_VALIDATION_COLUMNS = `val.version AS valVersion, val.spec_version AS valSpecVersion, val.status AS status,
  val.content_unit AS contentUnit, val.inner_content_amount AS innerContentAmount, val.units_per_outer AS unitsPerOuter,
  val.outer_gross_grams AS outerGrossGrams, val.gross_limit_grams AS grossLimitGrams,
  val.specialist_name AS specialistName, val.certificate_ref AS certificateRef`

export async function getSpecialistValidation(database: D1Database, variantId: string) {
  return database
    .prepare(
      `SELECT ${VALIDATION_COLUMNS} FROM adr_specialist_validations val
       WHERE val.variant_id = ?1 ORDER BY val.version DESC LIMIT 1`
    )
    .bind(variantId)
    .first<ValidationRow>()
}

export async function listCarrierRestrictions(database: D1Database, carrierCodeInput: unknown) {
  const carrier = carrierCodeSchema.safeParse(carrierCodeInput)
  if (!carrier.success) throw new AdrLqError('invalid_input')
  const { results } = await database
    .prepare(
      `SELECT carrier_code AS carrierCode, adr_class AS adrClass, packing_group AS packingGroup,
              allows_limited_quantity AS allowsLimitedQuantity, max_gross_grams_per_package AS maxGrossGramsPerPackage,
              documentation_note AS documentationNote, version, updated_at AS updatedAt
       FROM adr_carrier_restrictions WHERE carrier_code = ?1 ORDER BY adr_class, packing_group`
    )
    .bind(carrier.data)
    .all<{ allowsLimitedQuantity: number } & Record<string, unknown>>()
  return results.map((row) => ({ ...row, allowsLimitedQuantity: row.allowsLimitedQuantity === 1 }))
}

export async function evaluateAdrShipment(database: D1Database, rawInput: unknown, _options?: Options) {
  const parsed = shipmentInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new AdrLqError('invalid_input')
  const { carrierCode, lines } = parsed.data

  const placeholders = lines.map((_, index) => `?${index + 1}`).join(',')
  const [variants, rules] = await Promise.all([
    database
      .prepare(
        `SELECT v.id AS variantId, ${SPEC_COLUMNS}, ${EVALUATION_VALIDATION_COLUMNS}
         FROM variants v
         LEFT JOIN variant_adr_specifications s ON s.variant_id = v.id
         LEFT JOIN adr_specialist_validations val ON val.variant_id = v.id
          AND val.version = (SELECT max(latest.version) FROM adr_specialist_validations latest WHERE latest.variant_id = v.id)
         WHERE v.id IN (${placeholders})`
      )
      .bind(...lines.map((line) => line.variantId))
      .all<
        SpecRow &
          Omit<ValidationRow, 'version' | 'specVersion' | 'createdAt'> & {
            variantId: string
            valVersion: number | null
            valSpecVersion: number | null
          }
      >(),
    database
      .prepare(
        `SELECT adr_class AS adrClass, packing_group AS packingGroup, allows_limited_quantity AS allows,
                max_gross_grams_per_package AS maxGross
         FROM adr_carrier_restrictions WHERE carrier_code = ?1`
      )
      .bind(carrierCode)
      .all<{
        adrClass: CarrierRuleFacts['adrClass']
        packingGroup: CarrierRuleFacts['packingGroup']
        allows: number
        maxGross: number | null
      }>()
  ])
  const byVariant = new Map(variants.results.map((row) => [row.variantId, row]))
  const carrierRules: CarrierRuleFacts[] = rules.results.map((rule) => ({
    adrClass: rule.adrClass,
    packingGroup: rule.packingGroup,
    allowsLimitedQuantity: rule.allows === 1,
    maxGrossGramsPerPackage: rule.maxGross
  }))

  const assessments = lines.map((line) => {
    const row = byVariant.get(line.variantId)
    if (!row) throw new AdrLqError('not_found')
    const validation: SpecialistValidationFacts | null =
      row.valVersion === null || row.valVersion === undefined
        ? null
        : {
            version: row.valVersion,
            specVersion: row.valSpecVersion!,
            status: row.status,
            contentUnit: row.contentUnit,
            innerContentAmount: row.innerContentAmount,
            unitsPerOuter: row.unitsPerOuter,
            outerGrossGrams: row.outerGrossGrams,
            grossLimitGrams: row.grossLimitGrams,
            specialistName: row.specialistName,
            certificateRef: row.certificateRef
          }
    return evaluateLimitedQuantityLine({
      variantId: line.variantId,
      quantity: line.quantity,
      carrierCode,
      spec: specFromRow(row),
      validation,
      carrierRules
    })
  })
  return summariseShipment(carrierCode, assessments)
}

export async function recordSpecialistValidation(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  rawInput: unknown,
  options?: Options
) {
  if (!isUuid(commandId)) throw new AdrLqError('invalid_input')
  const parsed = specialistValidationInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new AdrLqError('invalid_input')
  const input = parsed.data
  const now = serverNow(options?.now)
  const actorId = await requireAdmin(database, claims, now)
  const payloadHash = await canonicalPayloadHash({ actorId, ...input })

  const existing = await database
    .prepare(
      `SELECT c.payload_hash AS payloadHash, c.kind, ${VALIDATION_COLUMNS}, val.variant_id AS variantId
       FROM adr_lq_commands c LEFT JOIN adr_specialist_validations val ON val.command_id = c.command_id
       WHERE c.command_id = ?1`
    )
    .bind(commandId)
    .first<ValidationRow & { payloadHash: string; kind: string; variantId: string | null }>()
  if (existing) {
    if (existing.payloadHash !== payloadHash || existing.kind !== 'specialist_validation')
      throw new AdrLqError('conflict')
    return {
      commandId,
      variantId: input.variantId,
      version: existing.version,
      specVersion: existing.specVersion,
      status: existing.status,
      createdAt: existing.createdAt
    }
  }

  const spec = await database
    .prepare('SELECT version FROM variant_adr_specifications WHERE variant_id = ?1')
    .bind(input.variantId)
    .first<{ version: number }>()
  if (!spec) throw new AdrLqError('not_found')
  if (spec.version !== input.specVersion) throw new AdrLqError('conflict')
  const latest = await database
    .prepare('SELECT COALESCE(max(version), 0) AS latest FROM adr_specialist_validations WHERE variant_id = ?1')
    .bind(input.variantId)
    .first<{ latest: number }>()
  const expected = latest?.latest ?? 0

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO adr_lq_commands(command_id, kind, target_key, expected_version, result_version, actor_id, session_id, session_version, payload_hash, created_at)
           VALUES (?1, 'specialist_validation', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
        )
        .bind(
          commandId,
          `validation:${input.variantId}`,
          expected,
          expected + 1,
          actorId,
          claims!.sessionId,
          claims!.sessionVersion,
          payloadHash,
          now
        ),
      database
        .prepare(
          `INSERT INTO adr_specialist_validations(
             id, variant_id, version, spec_version, status, specialist_name, certificate_ref, content_unit,
             inner_content_amount, units_per_outer, outer_gross_grams, gross_limit_grams, rejection_reason, command_id, created_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
        )
        .bind(
          crypto.randomUUID(),
          input.variantId,
          expected + 1,
          input.specVersion,
          input.status,
          input.specialistName,
          input.certificateRef,
          input.contentUnit,
          input.innerContentAmount,
          input.unitsPerOuter,
          input.outerGrossGrams,
          input.grossLimitGrams,
          input.rejectionReason ?? null,
          commandId,
          now
        )
    ])
  } catch (error) {
    if (isConstraintFailure(error, 'authority')) throw new AdrLqError('forbidden')
    if (isConstraintFailure(error, 'stale_spec', 'conflict', 'UNIQUE', 'PRIMARY KEY')) throw new AdrLqError('conflict')
    throw error
  }
  return {
    commandId,
    variantId: input.variantId,
    version: expected + 1,
    specVersion: input.specVersion,
    status: input.status,
    createdAt: now
  }
}

export async function setCarrierRestriction(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  rawInput: unknown,
  options?: Options
) {
  if (!isUuid(commandId)) throw new AdrLqError('invalid_input')
  const parsed = carrierRestrictionInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new AdrLqError('invalid_input')
  const input = parsed.data
  const now = serverNow(options?.now)
  const actorId = await requireAdmin(database, claims, now)
  const payloadHash = await canonicalPayloadHash({ actorId, ...input })
  const targetKey = `carrier:${input.carrierCode}:${input.adrClass}:${input.packingGroup}`
  const result = (version: number, createdAt: string) => ({
    commandId,
    carrierCode: input.carrierCode,
    adrClass: input.adrClass,
    packingGroup: input.packingGroup,
    version,
    createdAt
  })

  const existing = await database
    .prepare(
      'SELECT payload_hash AS payloadHash, kind, result_version AS version, created_at AS createdAt FROM adr_lq_commands WHERE command_id = ?1'
    )
    .bind(commandId)
    .first<{ payloadHash: string; kind: string; version: number; createdAt: string }>()
  if (existing) {
    if (existing.payloadHash !== payloadHash || existing.kind !== 'carrier_restriction')
      throw new AdrLqError('conflict')
    return result(existing.version, existing.createdAt)
  }

  const current = await database
    .prepare(
      'SELECT version FROM adr_carrier_restrictions WHERE carrier_code = ?1 AND adr_class = ?2 AND packing_group = ?3'
    )
    .bind(input.carrierCode, input.adrClass, input.packingGroup)
    .first<{ version: number }>()
  if ((current?.version ?? 0) !== input.expectedVersion) throw new AdrLqError('conflict')

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO adr_lq_commands(command_id, kind, target_key, expected_version, result_version, actor_id, session_id, session_version, payload_hash, created_at)
           VALUES (?1, 'carrier_restriction', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
        )
        .bind(
          commandId,
          targetKey,
          input.expectedVersion,
          input.expectedVersion + 1,
          actorId,
          claims!.sessionId,
          claims!.sessionVersion,
          payloadHash,
          now
        ),
      database
        .prepare(
          `INSERT INTO adr_carrier_restrictions(carrier_code, adr_class, packing_group, allows_limited_quantity, max_gross_grams_per_package, documentation_note, version, updated_by, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT(carrier_code, adr_class, packing_group) DO UPDATE SET
             allows_limited_quantity = excluded.allows_limited_quantity,
             max_gross_grams_per_package = excluded.max_gross_grams_per_package,
             documentation_note = excluded.documentation_note,
             version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at
           WHERE adr_carrier_restrictions.version = excluded.version - 1`
        )
        .bind(
          input.carrierCode,
          input.adrClass,
          input.packingGroup,
          input.allowsLimitedQuantity ? 1 : 0,
          input.maxGrossGramsPerPackage,
          input.documentationNote ?? null,
          input.expectedVersion + 1,
          actorId,
          now
        )
    ])
  } catch (error) {
    if (isConstraintFailure(error, 'authority')) throw new AdrLqError('forbidden')
    if (isConstraintFailure(error, 'conflict', 'UNIQUE', 'PRIMARY KEY')) throw new AdrLqError('conflict')
    throw error
  }
  return result(input.expectedVersion + 1, now)
}
