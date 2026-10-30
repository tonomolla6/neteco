import { z } from 'zod'

export class AdrLqError extends Error {
  constructor(readonly code: 'invalid_input' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict') {
    super(code)
    this.name = 'AdrLqError'
  }
}

export type AdrClass = '8' | '3' | '5.1' | '6.1' | '9' | 'NONE'
export type PackingGroup = 'I' | 'II' | 'III' | 'NONE'

export const MAX_LINE_QUANTITY = 100_000
export const MAX_SHIPMENT_LINES = 100
/** ADR 3.4.11 caps the gross mass of a limited-quantity outer package; the specialist records the real figure below it. */
export const MAX_LQ_GROSS_GRAMS = 30_000

export type AdrBlocker =
  | 'invalid_quantity'
  | 'adr_data_missing'
  | 'adr_data_incomplete'
  | 'hazard_info_missing'
  | 'specialist_validation_missing'
  | 'specialist_validation_stale'
  | 'specialist_validation_rejected'
  | 'lq_not_permitted'
  | 'lq_code_invalid'
  | 'lq_unit_mismatch'
  | 'lq_inner_limit_exceeded'
  | 'lq_gross_limit_exceeded'
  | 'carrier_unknown'
  | 'carrier_rule_missing'
  | 'carrier_prohibits_limited_quantity'
  | 'carrier_package_weight_exceeded'

export interface AdrSpecFacts {
  version: number
  unNumber: string
  properShippingName: string
  adrClass: AdrClass
  packingGroup: PackingGroup
  limitedQuantity: string
  pictograms: string[]
  signalWord: 'PELIGRO' | 'ATENCIÓN' | 'NONE'
  hazardStatements: string[]
  precautionaryStatements: string[]
  ufiCode: string | null
  sdsVersion: string
}

export interface SpecialistValidationFacts {
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
}

export interface CarrierRuleFacts {
  adrClass: AdrClass
  packingGroup: PackingGroup
  allowsLimitedQuantity: boolean
  maxGrossGramsPerPackage: number | null
}

export interface AdrLineFacts {
  variantId: string
  quantity: number
  carrierCode: string
  spec: AdrSpecFacts | null
  validation: SpecialistValidationFacts | null
  /** Every rule the carrier has; an empty list means the carrier is unknown to us. */
  carrierRules: CarrierRuleFacts[]
}

export interface HazardInfo {
  classified: boolean
  unNumber: string | null
  properShippingName: string | null
  adrClass: AdrClass | null
  packingGroup: PackingGroup | null
  pictograms: string[]
  signalWord: 'PELIGRO' | 'ATENCIÓN' | 'NONE' | null
  hazardStatements: string[]
  precautionaryStatements: string[]
  ufiCode: string | null
  sdsVersion: string | null
}

export interface AdrLineAssessment {
  variantId: string
  quantity: number
  allowed: boolean
  blockers: AdrBlocker[]
  /** Always present: hazard information is never hidden because a shipment is blocked. */
  hazard: HazardInfo
  packagesRequired: number | null
  labeling: { limitedQuantityMarkRequired: true; specialistCertificateRef: string } | null
}

export function hazardInfoFromSpec(spec: AdrSpecFacts | null): HazardInfo {
  if (!spec)
    return {
      classified: false,
      unNumber: null,
      properShippingName: null,
      adrClass: null,
      packingGroup: null,
      pictograms: [],
      signalWord: null,
      hazardStatements: [],
      precautionaryStatements: [],
      ufiCode: null,
      sdsVersion: null
    }
  return {
    classified: true,
    unNumber: spec.unNumber,
    properShippingName: spec.properShippingName,
    adrClass: spec.adrClass,
    packingGroup: spec.packingGroup,
    pictograms: spec.pictograms,
    signalWord: spec.signalWord,
    hazardStatements: spec.hazardStatements,
    precautionaryStatements: spec.precautionaryStatements,
    ufiCode: spec.ufiCode,
    sdsVersion: spec.sdsVersion
  }
}

export function parseLimitedQuantity(
  text: string
): { contentUnit: 'ml' | 'g'; limit: number } | 'not_permitted' | 'invalid' {
  const trimmed = text.trim()
  if (trimmed === '0') return 'not_permitted'
  const match = /^(\d{1,4}(?:[.,]\d{1,3})?) ?(L|ml|kg|g)$/i.exec(trimmed)
  if (!match) return 'invalid'
  const amount = Number(match[1]!.replace(',', '.'))
  if (!(amount > 0)) return 'invalid'
  const unit = match[2]!.toLowerCase()
  const factor = unit === 'l' || unit === 'kg' ? 1000 : 1
  return { contentUnit: unit === 'l' || unit === 'ml' ? 'ml' : 'g', limit: Math.round(amount * factor) }
}

function classificationComplete(spec: AdrSpecFacts): boolean {
  if (spec.adrClass === 'NONE') return spec.unNumber === 'NONE' && spec.packingGroup === 'NONE'
  if (spec.unNumber === 'NONE') return false
  return spec.adrClass === '9' || spec.packingGroup !== 'NONE'
}

/**
 * Pure safety decision for one shipment line. Everything not positively proven blocks:
 * missing data, stale or negative specialist validation, unreadable codes, unknown carriers.
 */
export function evaluateLimitedQuantityLine(facts: AdrLineFacts): AdrLineAssessment {
  const blockers: AdrBlocker[] = []
  const { spec, validation } = facts
  const quantityValid =
    Number.isSafeInteger(facts.quantity) && facts.quantity >= 1 && facts.quantity <= MAX_LINE_QUANTITY
  if (!quantityValid) blockers.push('invalid_quantity')

  if (!spec) {
    blockers.push('adr_data_missing')
    return finish(facts, blockers, null)
  }
  const dangerous = spec.adrClass !== 'NONE'
  if (!classificationComplete(spec)) blockers.push('adr_data_incomplete')
  if (dangerous && (spec.pictograms.length === 0 || spec.hazardStatements.length === 0 || spec.signalWord === 'NONE'))
    blockers.push('hazard_info_missing')

  let current: SpecialistValidationFacts | null = null
  if (!validation) blockers.push('specialist_validation_missing')
  else if (validation.specVersion !== spec.version) blockers.push('specialist_validation_stale')
  else if (validation.status === 'rejected') blockers.push('specialist_validation_rejected')
  else current = validation

  if (dangerous) {
    const code = parseLimitedQuantity(spec.limitedQuantity)
    if (code === 'not_permitted') blockers.push('lq_not_permitted')
    else if (code === 'invalid') blockers.push('lq_code_invalid')
    else if (current) {
      if (current.contentUnit !== code.contentUnit) blockers.push('lq_unit_mismatch')
      else if (current.innerContentAmount > code.limit) blockers.push('lq_inner_limit_exceeded')
      if (current.outerGrossGrams > current.grossLimitGrams || current.outerGrossGrams > MAX_LQ_GROSS_GRAMS)
        blockers.push('lq_gross_limit_exceeded')
    }

    if (facts.carrierRules.length === 0) blockers.push('carrier_unknown')
    else {
      const rule = facts.carrierRules.find((r) => r.adrClass === spec.adrClass && r.packingGroup === spec.packingGroup)
      if (!rule) blockers.push('carrier_rule_missing')
      else if (!rule.allowsLimitedQuantity) blockers.push('carrier_prohibits_limited_quantity')
      else if (
        rule.maxGrossGramsPerPackage === null ||
        (current && current.outerGrossGrams > rule.maxGrossGramsPerPackage)
      )
        blockers.push('carrier_package_weight_exceeded')
    }
  }
  return finish(facts, blockers, current)
}

function finish(
  facts: AdrLineFacts,
  blockers: AdrBlocker[],
  current: SpecialistValidationFacts | null
): AdrLineAssessment {
  const allowed = blockers.length === 0
  const dangerous = !!facts.spec && facts.spec.adrClass !== 'NONE'
  const quantityValid = Number.isSafeInteger(facts.quantity) && facts.quantity >= 1
  return {
    variantId: facts.variantId,
    quantity: facts.quantity,
    allowed,
    blockers,
    hazard: hazardInfoFromSpec(facts.spec),
    packagesRequired: current && quantityValid ? Math.ceil(facts.quantity / current.unitsPerOuter) : null,
    labeling:
      allowed && dangerous && current
        ? { limitedQuantityMarkRequired: true, specialistCertificateRef: current.certificateRef }
        : null
  }
}

export function summariseShipment(carrierCode: string, lines: AdrLineAssessment[]) {
  return {
    carrierCode,
    allowed: lines.length > 0 && lines.every((line) => line.allowed),
    blockers: lines.flatMap((line) => line.blockers.map((code) => ({ variantId: line.variantId, code }))),
    lines
  }
}

export const carrierCodeSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9_]+$/)

export const shipmentInputSchema = z
  .object({
    carrierCode: carrierCodeSchema,
    lines: z
      .array(z.object({ variantId: z.string().min(1).max(64), quantity: z.number() }).strict())
      .min(1)
      .max(MAX_SHIPMENT_LINES)
  })
  .strict()
  .refine((value) => new Set(value.lines.map((line) => line.variantId)).size === value.lines.length)

export const carrierRestrictionInputSchema = z
  .object({
    carrierCode: carrierCodeSchema,
    adrClass: z.enum(['8', '3', '5.1', '6.1', '9', 'NONE']),
    packingGroup: z.enum(['I', 'II', 'III', 'NONE']),
    allowsLimitedQuantity: z.boolean(),
    maxGrossGramsPerPackage: z.number().int().min(1).max(MAX_LQ_GROSS_GRAMS).nullable(),
    documentationNote: z.string().trim().max(500).optional(),
    expectedVersion: z.number().int().min(0).max(1_000_000)
  })
  .strict()
  .refine((value) => !value.allowsLimitedQuantity || value.maxGrossGramsPerPackage !== null)

export const specialistValidationInputSchema = z
  .object({
    variantId: z.string().min(1).max(64),
    specVersion: z.number().int().min(1).max(1_000_000),
    status: z.enum(['validated', 'rejected']),
    specialistName: z.string().trim().min(2).max(120),
    certificateRef: z.string().trim().min(3).max(80),
    contentUnit: z.enum(['ml', 'g']),
    innerContentAmount: z.number().int().min(1).max(1_000_000),
    unitsPerOuter: z.number().int().min(1).max(10_000),
    outerGrossGrams: z.number().int().min(1).max(10_000_000),
    grossLimitGrams: z.number().int().min(1).max(MAX_LQ_GROSS_GRAMS),
    rejectionReason: z.string().trim().min(5).max(500).optional()
  })
  .strict()
  .refine((value) => value.status === 'validated' || value.rejectionReason !== undefined)
  .refine((value) => value.status === 'rejected' || value.outerGrossGrams <= value.grossLimitGrams)
