import {
  adrTransportDocumentSchema,
  generatedClpLabelSchema,
  variantAdrSpecSchema,
  warehouseHandlingInstructionsSchema,
  warehouseLotRecordSchema,
  upsertVariantAdrSpecInputSchema,
  createWarehouseLotInputSchema,
  generateAdrTransportDocumentInputSchema,
  type AdrTransportDocument,
  type AdrTransportLine,
  type GeneratedClpLabel,
  type VariantAdrSpec,
  type WarehouseHandlingInstructions,
  type WarehouseLotRecord
} from '../../shared/warehouse-adr-assets'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

export class WarehouseAdrError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'qa_quarantine_blocked'
      | 'qa_rejected_blocked'
      | 'internal_error'
  ) {
    super(code)
  }
}

function fail(code: WarehouseAdrError['code']): never {
  throw new WarehouseAdrError(code)
}

async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

interface AdrSpecRow {
  id: string
  variant_id: string
  un_number: string
  proper_shipping_name: string
  adr_class: '8' | '3' | '5.1' | '6.1' | '9' | 'NONE'
  packing_group: 'I' | 'II' | 'III' | 'NONE'
  tunnel_code: '(E)' | '(D/E)' | '(B/D)' | 'NONE'
  limited_quantity: string
  adr_points_factor: 0 | 1 | 3 | 20 | 50
  pictograms_json: string
  signal_word: 'PELIGRO' | 'ATENCIÓN' | 'NONE'
  hazard_statements_json: string
  precautionary_statements_json: string
  ufi_code: string | null
  handling_instructions_json: string
  sds_version: string
  version: number
  created_at: string
  updated_at: string
}

function specRowToDto(row: AdrSpecRow): VariantAdrSpec {
  return variantAdrSpecSchema.parse({
    id: row.id,
    variantId: row.variant_id,
    unNumber: row.un_number,
    properShippingName: row.proper_shipping_name,
    adrClass: row.adr_class,
    packingGroup: row.packing_group,
    tunnelCode: row.tunnel_code,
    limitedQuantity: row.limited_quantity,
    adrPointsFactor: row.adr_points_factor,
    pictograms: JSON.parse(row.pictograms_json),
    signalWord: row.signal_word,
    hazardStatements: JSON.parse(row.hazard_statements_json),
    precautionaryStatements: JSON.parse(row.precautionary_statements_json),
    ufiCode: row.ufi_code,
    handlingInstructions: JSON.parse(row.handling_instructions_json),
    sdsVersion: row.sds_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

interface LotRow {
  id: string
  lot_number: string
  variant_id: string
  spec_version: number
  manufacturing_date: string
  expiry_date: string
  units_produced: number
  qa_release_status: 'approved' | 'quarantine' | 'rejected'
  qa_released_by: string | null
  qa_released_at: string | null
  created_at: string
}

function lotRowToDto(row: LotRow): WarehouseLotRecord {
  return warehouseLotRecordSchema.parse({
    id: row.id,
    lotNumber: row.lot_number,
    variantId: row.variant_id,
    specVersion: row.spec_version,
    manufacturingDate: row.manufacturing_date,
    expiryDate: row.expiry_date,
    unitsProduced: row.units_produced,
    qaReleaseStatus: row.qa_release_status,
    qaReleasedBy: row.qa_released_by,
    qaReleasedAt: row.qa_released_at,
    createdAt: row.created_at
  })
}

export async function upsertVariantAdrSpec(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: {
    commandId: string
    variantId: string
    unNumber: string
    properShippingName: string
    adrClass: '8' | '3' | '5.1' | '6.1' | '9' | 'NONE'
    packingGroup: 'I' | 'II' | 'III' | 'NONE'
    tunnelCode: '(E)' | '(D/E)' | '(B/D)' | 'NONE'
    limitedQuantity: string
    adrPointsFactor: 0 | 1 | 3 | 20 | 50
    pictograms: string[]
    signalWord: 'PELIGRO' | 'ATENCIÓN' | 'NONE'
    hazardStatements: string[]
    precautionaryStatements: string[]
    ufiCode: string | null
    handlingInstructions: string[]
    sdsVersion: string
  },
  executionNow?: string
): Promise<VariantAdrSpec> {
  const now = executionNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const auth = await authorizeD1Session(database, claims, 'fulfillment.manage', { now })
  if (!auth.allowed) {
    const admAuth = await authorizeD1Session(database, claims, 'administration.manage', { now })
    if (!admAuth.allowed) fail(auth.code === 'forbidden' ? 'forbidden' : 'unauthenticated')
  }

  const parsed = upsertVariantAdrSpecInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const payloadHash = await sha256Hex(JSON.stringify(input))
  const existing = await database
    .prepare('SELECT * FROM variant_adr_specifications WHERE variant_id = ?')
    .bind(input.variantId)
    .first<AdrSpecRow>()

  if (existing) {
    const nextVersion = existing.version + 1
    await database.batch([
      database
        .prepare(
          `UPDATE variant_adr_specifications SET
            un_number = ?, proper_shipping_name = ?, adr_class = ?, packing_group = ?, tunnel_code = ?,
            limited_quantity = ?, adr_points_factor = ?, pictograms_json = ?, signal_word = ?,
            hazard_statements_json = ?, precautionary_statements_json = ?, ufi_code = ?,
            handling_instructions_json = ?, sds_version = ?, version = ?, updated_at = ?
          WHERE id = ? AND version = ?`
        )
        .bind(
          rawInput.unNumber,
          rawInput.properShippingName,
          rawInput.adrClass,
          rawInput.packingGroup,
          rawInput.tunnelCode,
          rawInput.limitedQuantity,
          rawInput.adrPointsFactor,
          JSON.stringify(rawInput.pictograms),
          rawInput.signalWord,
          JSON.stringify(rawInput.hazardStatements),
          JSON.stringify(rawInput.precautionaryStatements),
          rawInput.ufiCode,
          JSON.stringify(rawInput.handlingInstructions),
          rawInput.sdsVersion,
          nextVersion,
          now,
          existing.id,
          existing.version
        ),
      database
        .prepare(
          `INSERT INTO warehouse_adr_commands (
            command_id, actor_id, action, target_id, expected_version, result_version, payload_hash, input_json, created_at
          ) VALUES (?, ?, 'upsert_spec', ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          rawInput.commandId,
          claims.identityId,
          rawInput.variantId,
          existing.version,
          nextVersion,
          payloadHash,
          JSON.stringify(rawInput),
          now
        )
    ])
  } else {
    const id = crypto.randomUUID()
    await database.batch([
      database
        .prepare(
          `INSERT INTO variant_adr_specifications (
            id, variant_id, un_number, proper_shipping_name, adr_class, packing_group, tunnel_code,
            limited_quantity, adr_points_factor, pictograms_json, signal_word, hazard_statements_json,
            precautionary_statements_json, ufi_code, handling_instructions_json, sds_version,
            version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .bind(
          id,
          rawInput.variantId,
          rawInput.unNumber,
          rawInput.properShippingName,
          rawInput.adrClass,
          rawInput.packingGroup,
          rawInput.tunnelCode,
          rawInput.limitedQuantity,
          rawInput.adrPointsFactor,
          JSON.stringify(rawInput.pictograms),
          rawInput.signalWord,
          JSON.stringify(rawInput.hazardStatements),
          JSON.stringify(rawInput.precautionaryStatements),
          rawInput.ufiCode,
          JSON.stringify(rawInput.handlingInstructions),
          rawInput.sdsVersion,
          now,
          now
        ),
      database
        .prepare(
          `INSERT INTO warehouse_adr_commands (
            command_id, actor_id, action, target_id, expected_version, result_version, payload_hash, input_json, created_at
          ) VALUES (?, ?, 'upsert_spec', ?, 0, 1, ?, ?, ?)`
        )
        .bind(rawInput.commandId, claims.identityId, rawInput.variantId, payloadHash, JSON.stringify(rawInput), now)
    ])
  }

  const row = await database
    .prepare('SELECT * FROM variant_adr_specifications WHERE variant_id = ?')
    .bind(rawInput.variantId)
    .first<AdrSpecRow>()
  if (!row) fail('not_found')
  return specRowToDto(row)
}

export async function getVariantAdrSpec(database: D1Database, variantId: string): Promise<VariantAdrSpec | null> {
  const row = await database
    .prepare('SELECT * FROM variant_adr_specifications WHERE variant_id = ?')
    .bind(variantId)
    .first<AdrSpecRow>()
  if (!row) return null
  return specRowToDto(row)
}

export async function createWarehouseLotRecord(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: {
    commandId: string
    lotNumber: string
    variantId: string
    specVersion: number
    manufacturingDate: string
    expiryDate: string
    unitsProduced: number
    qaReleaseStatus: 'approved' | 'quarantine' | 'rejected'
  },
  executionNow?: string
): Promise<WarehouseLotRecord> {
  const now = executionNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const auth = await authorizeD1Session(database, claims, 'fulfillment.manage', { now })
  if (!auth.allowed) {
    const admAuth = await authorizeD1Session(database, claims, 'administration.manage', { now })
    if (!admAuth.allowed) fail(auth.code === 'forbidden' ? 'forbidden' : 'unauthenticated')
  }

  const parsed = createWarehouseLotInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const id = crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(input))

  await database.batch([
    database
      .prepare(
        `INSERT INTO warehouse_lot_records (
          id, lot_number, variant_id, spec_version, manufacturing_date, expiry_date,
          units_produced, qa_release_status, qa_released_by, qa_released_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        rawInput.lotNumber,
        rawInput.variantId,
        rawInput.specVersion,
        rawInput.manufacturingDate,
        rawInput.expiryDate,
        rawInput.unitsProduced,
        rawInput.qaReleaseStatus,
        rawInput.qaReleaseStatus === 'approved' ? claims.identityId : null,
        rawInput.qaReleaseStatus === 'approved' ? now : null,
        now
      ),
    database
      .prepare(
        `INSERT INTO warehouse_adr_commands (
          command_id, actor_id, action, target_id, expected_version, result_version, payload_hash, input_json, created_at
        ) VALUES (?, ?, 'create_lot', ?, 0, 1, ?, ?, ?)`
      )
      .bind(rawInput.commandId, claims.identityId, rawInput.lotNumber, payloadHash, JSON.stringify(rawInput), now)
  ])

  const row = await database.prepare('SELECT * FROM warehouse_lot_records WHERE id = ?').bind(id).first<LotRow>()
  if (!row) fail('not_found')
  return lotRowToDto(row)
}

export async function getWarehouseLotRecord(
  database: D1Database,
  lotNumber: string
): Promise<WarehouseLotRecord | null> {
  const row = await database
    .prepare('SELECT * FROM warehouse_lot_records WHERE lot_number = ?')
    .bind(lotNumber)
    .first<LotRow>()
  if (!row) return null
  return lotRowToDto(row)
}

export async function generateClpContainerLabel(
  database: D1Database,
  variantId: string,
  lotNumber: string,
  now?: string
): Promise<GeneratedClpLabel> {
  const currentInstant = now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // Join product and variant
  const productRow = await database
    .prepare(
      `SELECT p.name AS product_name, v.format AS variant_format, v.sku
       FROM variants v JOIN products p ON p.id = v.product_id
       WHERE v.id = ?`
    )
    .bind(variantId)
    .first<{ product_name: string; variant_format: string; sku: string }>()
  if (!productRow) fail('not_found')

  const spec = await getVariantAdrSpec(database, variantId)
  if (!spec) fail('not_found')

  const lot = await getWarehouseLotRecord(database, lotNumber)
  if (!lot) fail('not_found')

  if (lot.qaReleaseStatus === 'quarantine') fail('qa_quarantine_blocked')
  if (lot.qaReleaseStatus === 'rejected') fail('qa_rejected_blocked')

  const barcodeData = `01${productRow.sku}10${lot.lotNumber}17${lot.expiryDate.replace(/-/g, '')}`

  return generatedClpLabelSchema.parse({
    source: 'cloudflare',
    variantId,
    lotNumber: lot.lotNumber,
    productName: productRow.product_name,
    variantLabel: productRow.variant_format,
    netQuantity: productRow.variant_format,
    unNumber: spec.unNumber,
    properShippingName: spec.properShippingName,
    signalWord: spec.signalWord,
    pictograms: spec.pictograms,
    hazardStatements: spec.hazardStatements,
    precautionaryStatements: spec.precautionaryStatements,
    ufiCode: spec.ufiCode,
    emergencyPhone: '+34 91 562 04 20', // Instituto Nacional de Toxicología y Ciencias Forenses
    supplierInfo: {
      name: 'Neteco Professional Cleaning S.L.',
      address: 'Polígono Industrial Los Ángeles, 28906 Getafe, Madrid, España',
      vatNumber: 'ES-B84920194'
    },
    manufacturingDate: lot.manufacturingDate,
    expiryDate: lot.expiryDate,
    specVersion: spec.version,
    sdsVersion: spec.sdsVersion,
    barcodeData,
    generatedAt: currentInstant
  })
}

export async function generateAdrTransportDocument(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: {
    commandId: string
    shipmentItems: Array<{
      lotNumber: string
      packagesCount: number
      packageType: string
      litersOrKgPerPackage: number
    }>
  },
  executionNow?: string
): Promise<AdrTransportDocument> {
  const now = executionNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const auth = await authorizeD1Session(database, claims, 'fulfillment.manage', { now })
  if (!auth.allowed) {
    const admAuth = await authorizeD1Session(database, claims, 'administration.manage', { now })
    if (!admAuth.allowed) fail(auth.code === 'forbidden' ? 'forbidden' : 'unauthenticated')
  }

  const parsed = generateAdrTransportDocumentInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const manifestId = crypto.randomUUID()
  const lines: AdrTransportLine[] = []
  let totalPoints = 0

  for (const item of input.shipmentItems) {
    const lot = await getWarehouseLotRecord(database, item.lotNumber)
    if (!lot) fail('not_found')

    const spec = await getVariantAdrSpec(database, lot.variantId)
    if (!spec) fail('not_found')

    const totalLitersOrKg = item.packagesCount * item.litersOrKgPerPackage
    const isDangerousGoods = spec.unNumber !== 'NONE' && spec.adrClass !== 'NONE'

    // ADR 1.1.3.6 points calculation
    const factor = isDangerousGoods ? spec.adrPointsFactor : 0
    const points = totalLitersOrKg * factor
    totalPoints += points

    // Transport category derived from factor: factor 50 -> cat 1, factor 3 -> cat 2, factor 1 -> cat 3, factor 0 -> cat 4
    let transportCategory = 4
    if (factor === 50) transportCategory = 1
    else if (factor === 3) transportCategory = 2
    else if (factor === 1) transportCategory = 3

    lines.push({
      unNumber: spec.unNumber,
      properShippingName: spec.properShippingName,
      adrClass: spec.adrClass,
      packingGroup: spec.packingGroup,
      tunnelCode: spec.tunnelCode,
      packagesCount: item.packagesCount,
      packageType: item.packageType,
      totalLitersOrKg,
      transportCategory,
      adrFactor: factor,
      calculatedPoints: points,
      isDangerousGoods
    })
  }

  // ADR 1.1.3.6 threshold is 1000 points
  const isExempt = totalPoints <= 1000
  const mandatoryDeclaration = isExempt
    ? 'Carga no excede los límites de exención prescritos en el apartado 1.1.3.6 del ADR. transporte que no sobrepasa los límites fijados en el 1.1.3.6.'
    : 'Transporte de mercancías peligrosas sujeto a la totalidad de las prescripciones del ADR. Conductor con certificado ADR obligatorio.'

  const payloadHash = await sha256Hex(JSON.stringify(rawInput))

  await database
    .prepare(
      `INSERT INTO warehouse_adr_commands (
        command_id, actor_id, action, target_id, expected_version, result_version, payload_hash, input_json, created_at
      ) VALUES (?, ?, 'generate_transport_document', ?, 0, 1, ?, ?, ?)`
    )
    .bind(rawInput.commandId, claims.identityId, manifestId, payloadHash, JSON.stringify(rawInput), now)
    .run()

  return adrTransportDocumentSchema.parse({
    source: 'cloudflare',
    manifestId,
    lotNumbers: rawInput.shipmentItems.map((i) => i.lotNumber),
    lines,
    totalCalculatedPoints: totalPoints,
    isExemptUnder1136: isExempt,
    mandatoryDeclaration,
    carrierInstructions: [
      'Estiba y sujeción de la carga conforme a la norma EN 12195-1.',
      'Prohibido fumar y utilizar llamas abiertas durante las operaciones de carga/descarga.',
      'Extintor de polvo de 2 kg mínimo en cabina para transporte bajo exención 1.1.3.6.'
    ],
    generatedAt: now
  })
}

export async function getWarehouseHandlingInstructions(
  database: D1Database,
  variantId: string,
  lotNumber?: string,
  now?: string
): Promise<WarehouseHandlingInstructions> {
  const currentInstant = now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const spec = await getVariantAdrSpec(database, variantId)
  if (!spec) fail('not_found')

  return warehouseHandlingInstructionsSchema.parse({
    source: 'cloudflare',
    variantId,
    lotNumber: lotNumber ?? null,
    unNumber: spec.unNumber,
    storageConditions: spec.handlingInstructions,
    incompatibleMaterials: [
      'Incompatible con ácidos fuertes: libera gas cloro tóxico.',
      'Incompatible con amoníaco y derivados amoniacales.',
      'Mantener alejado de metales oxidables y materias combustibles.'
    ],
    requiredPpe: [
      'Guantes de nitrilo o neopreno EN 374-1',
      'Gafas de montura integral contra salpicaduras químicas EN 166',
      'Calzado de seguridad S3 resistente a químicos',
      'Máscara con filtro para gases/vapores inorgánicos tipo B-P2 si ventilación insuficiente'
    ],
    spillResponseSteps: [
      'Delimitar el área y prohibir el acceso a personal no autorizado.',
      'Contener el derrame mediante sepiolita o absorbente inerte sintético. NUNCA usar serrín.',
      'Neutralizar cuidadosamente según ficha de seguridad SDS antes de su recogida.',
      'Recoger en contenedores plásticos homologados debidamente identificados como residuo peligroso.'
    ],
    firstAidSummary: [
      'Contacto con ojos: Aclarar inmediatamente con abundante agua templada durante mínimo 15 min.',
      'Contacto con piel: Retirar ropa contaminada y lavar con agua y jabón.',
      'Inhalación: Trasladar a la persona al aire libre y mantener en reposo.',
      'Teléfono Emergencias Toxicológicas (INTCF): +34 91 562 04 20'
    ],
    specVersion: spec.version,
    generatedAt: currentInstant
  })
}
