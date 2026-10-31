import {
  authorizePartnerInputSchema,
  brandAssetSchema,
  brandAuthorizationSchema,
  brandCenterViewSchema,
  createCertificationInputSchema,
  officialCertificationSchema,
  type BrandAsset,
  type BrandAuthorization,
  type BrandCenterView,
  type OfficialCertification
} from '../../shared/brand-certifications'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

export class BrandCenterError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'unaccredited_claim'
      | 'internal_error'
  ) {
    super(code)
  }
}

function fail(code: BrandCenterError['code']): never {
  throw new BrandCenterError(code)
}

async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

interface CertificationRow {
  id: string
  standard_code: string
  title: string
  issuer: string
  certificate_number: string
  scope: string
  valid_from: string
  valid_until: string
  verification_url: string
  document_url: string
  status: 'active' | 'expired' | 'suspended'
  version: number
  audited_by: string
  created_at: string
  updated_at: string
}

function certRowToDto(row: CertificationRow): OfficialCertification {
  return officialCertificationSchema.parse({
    id: row.id,
    standardCode: row.standard_code,
    title: row.title,
    issuer: row.issuer,
    certificateNumber: row.certificate_number,
    scope: row.scope,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    verificationUrl: row.verification_url,
    documentUrl: row.document_url,
    status: row.status,
    version: row.version,
    auditedBy: row.audited_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

interface BrandAssetRow {
  id: string
  name: string
  category: 'logo' | 'symbol' | 'guideline' | 'typography' | 'palette'
  format: 'svg' | 'png' | 'pdf' | 'json'
  variant: 'primary' | 'monochrome' | 'negative' | 'symbol' | 'spec'
  url: string
  min_clearspace_px: number
  prohibited_uses_json: string
  status: 'active' | 'deprecated'
  version: number
  updated_at: string
}

function assetRowToDto(row: BrandAssetRow): BrandAsset {
  return brandAssetSchema.parse({
    id: row.id,
    name: row.name,
    category: row.category,
    format: row.format,
    variant: row.variant,
    url: row.url,
    minClearspacePx: row.min_clearspace_px,
    prohibitedUses: JSON.parse(row.prohibited_uses_json),
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at
  })
}

interface BrandAuthRow {
  id: string
  partner_name: string
  authorized_domain: string
  scope: 'distribuidor_oficial' | 'partner_logistico' | 'proveedor_homologado' | 'prensa_medios'
  status: 'active' | 'revoked' | 'expired'
  version: number
  valid_from: string
  valid_until: string | null
  authorized_by: string
  created_at: string
  updated_at: string
}

function authRowToDto(row: BrandAuthRow): BrandAuthorization {
  return brandAuthorizationSchema.parse({
    id: row.id,
    partnerName: row.partner_name,
    authorizedDomain: row.authorized_domain,
    scope: row.scope,
    status: row.status,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    authorizedBy: row.authorized_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
}

export async function createOfficialCertification(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  executionNow?: string
): Promise<OfficialCertification> {
  const now = executionNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  if (!auth.allowed) {
    const pubAuth = await authorizeD1Session(database, claims, 'catalog.publish', { now })
    if (!pubAuth.allowed) fail(auth.code === 'forbidden' ? 'forbidden' : 'unauthenticated')
  }

  const parsed = createCertificationInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const id = crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(input))

  try {
    const res = await database.batch([
      database
        .prepare(
          `INSERT INTO official_certifications (
            id, standard_code, title, issuer, certificate_number, scope,
            valid_from, valid_until, verification_url, document_url, status,
            version, audited_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`
        )
        .bind(
          id,
          input.standardCode,
          input.title,
          input.issuer,
          input.certificateNumber,
          input.scope,
          input.validFrom,
          input.validUntil,
          input.verificationUrl,
          input.documentUrl,
          input.auditedBy,
          now,
          now
        ),
      database
        .prepare(
          `INSERT INTO brand_center_commands (
            command_id, entity_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
          ) VALUES (?, ?, ?, 'create_certification', 0, 1, ?, ?, ?)`
        )
        .bind(input.commandId, id, claims.identityId, payloadHash, JSON.stringify(input), now)
    ])
    if (!res.every((r) => r.success)) fail('internal_error')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('UNIQUE constraint failed') || message.includes('already exists')) {
      fail('idempotency_conflict')
    }
    throw err
  }

  const row = await database
    .prepare('SELECT * FROM official_certifications WHERE id = ?')
    .bind(id)
    .first<CertificationRow>()
  if (!row) fail('not_found')
  return certRowToDto(row)
}

export async function updateOfficialCertification(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: {
    commandId: string
    certificationId: string
    expectedVersion: number
    title: string
    scope: string
    validFrom: string
    validUntil: string
    verificationUrl: string
    documentUrl: string
    auditedBy: string
  },
  executionNow?: string
): Promise<OfficialCertification> {
  const now = executionNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  if (!auth.allowed) fail(auth.code === 'forbidden' ? 'forbidden' : 'unauthenticated')

  if (rawInput.validUntil <= rawInput.validFrom) fail('invalid_input')
  const payloadHash = await sha256Hex(JSON.stringify(rawInput))

  const existing = await database
    .prepare('SELECT * FROM official_certifications WHERE id = ?')
    .bind(rawInput.certificationId)
    .first<CertificationRow>()
  if (!existing) fail('not_found')
  if (existing.version !== rawInput.expectedVersion) fail('version_conflict')

  const nextVersion = existing.version + 1
  try {
    const res = await database.batch([
      database
        .prepare(
          `UPDATE official_certifications SET
            title = ?, scope = ?, valid_from = ?, valid_until = ?, verification_url = ?,
            document_url = ?, audited_by = ?, version = ?, updated_at = ?
          WHERE id = ? AND version = ?`
        )
        .bind(
          rawInput.title,
          rawInput.scope,
          rawInput.validFrom,
          rawInput.validUntil,
          rawInput.verificationUrl,
          rawInput.documentUrl,
          rawInput.auditedBy,
          nextVersion,
          now,
          rawInput.certificationId,
          rawInput.expectedVersion
        ),
      database
        .prepare(
          `INSERT INTO brand_center_commands (
            command_id, entity_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
          ) VALUES (?, ?, ?, 'update_certification', ?, ?, ?, ?, ?)`
        )
        .bind(
          rawInput.commandId,
          rawInput.certificationId,
          claims.identityId,
          rawInput.expectedVersion,
          nextVersion,
          payloadHash,
          JSON.stringify(rawInput),
          now
        )
    ])
    if (!res.every((r) => r.success)) fail('internal_error')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('version_conflict')) fail('version_conflict')
    throw err
  }

  const updated = await database
    .prepare('SELECT * FROM official_certifications WHERE id = ?')
    .bind(rawInput.certificationId)
    .first<CertificationRow>()
  if (!updated) fail('not_found')
  return certRowToDto(updated)
}

export async function getOfficialCertificationByNumber(
  database: D1Database,
  certificateNumber: string
): Promise<OfficialCertification | null> {
  const row = await database
    .prepare("SELECT * FROM official_certifications WHERE certificate_number = ? AND status = 'active'")
    .bind(certificateNumber)
    .first<CertificationRow>()
  if (!row) return null
  return certRowToDto(row)
}

export async function listOfficialCertifications(database: D1Database, now?: string): Promise<OfficialCertification[]> {
  const currentInstant = now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const rows = await database
    .prepare(
      `SELECT * FROM official_certifications
       WHERE status = 'active' AND valid_until > ?
       ORDER BY standard_code ASC`
    )
    .bind(currentInstant)
    .all<CertificationRow>()
  return (rows.results ?? []).map(certRowToDto)
}

export async function upsertBrandAsset(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: {
    commandId: string
    name: string
    category: 'logo' | 'symbol' | 'guideline' | 'typography' | 'palette'
    format: 'svg' | 'png' | 'pdf' | 'json'
    variant: 'primary' | 'monochrome' | 'negative' | 'symbol' | 'spec'
    url: string
    minClearspacePx: number
    prohibitedUses: string[]
  },
  executionNow?: string
): Promise<BrandAsset> {
  const now = executionNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  if (!auth.allowed) fail(auth.code === 'forbidden' ? 'forbidden' : 'unauthenticated')

  const id = crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(rawInput))

  await database.batch([
    database
      .prepare(
        `INSERT INTO brand_assets (
          id, name, category, format, variant, url, min_clearspace_px, prohibited_uses_json, status, version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?)`
      )
      .bind(
        id,
        rawInput.name,
        rawInput.category,
        rawInput.format,
        rawInput.variant,
        rawInput.url,
        rawInput.minClearspacePx,
        JSON.stringify(rawInput.prohibitedUses),
        now
      ),
    database
      .prepare(
        `INSERT INTO brand_center_commands (
          command_id, entity_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
        ) VALUES (?, ?, ?, 'upsert_brand_asset', 0, 1, ?, ?, ?)`
      )
      .bind(rawInput.commandId, id, claims.identityId, payloadHash, JSON.stringify(rawInput), now)
  ])

  const row = await database.prepare('SELECT * FROM brand_assets WHERE id = ?').bind(id).first<BrandAssetRow>()
  if (!row) fail('not_found')
  return assetRowToDto(row)
}

export async function authorizeBrandPartner(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: unknown,
  executionNow?: string
): Promise<BrandAuthorization> {
  const now = executionNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  if (!auth.allowed) fail(auth.code === 'forbidden' ? 'forbidden' : 'unauthenticated')

  const parsed = authorizePartnerInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const id = crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(input))

  await database.batch([
    database
      .prepare(
        `INSERT INTO brand_authorizations (
          id, partner_name, authorized_domain, scope, status, valid_from, valid_until, authorized_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.partnerName,
        input.authorizedDomain,
        input.scope,
        input.validFrom,
        input.validUntil,
        claims.identityId,
        now,
        now
      ),
    database
      .prepare(
        `INSERT INTO brand_center_commands (
          command_id, entity_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
        ) VALUES (?, ?, ?, 'authorize_partner', 0, 1, ?, ?, ?)`
      )
      .bind(input.commandId, id, claims.identityId, payloadHash, JSON.stringify(input), now)
  ])

  const row = await database.prepare('SELECT * FROM brand_authorizations WHERE id = ?').bind(id).first<BrandAuthRow>()
  if (!row) fail('not_found')
  return authRowToDto(row)
}

export async function revokeBrandPartner(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: { commandId: string; authorizationId: string },
  executionNow?: string
): Promise<BrandAuthorization> {
  const now = executionNow ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const auth = await authorizeD1Session(database, claims, 'administration.manage', { now })
  if (!auth.allowed) fail(auth.code === 'forbidden' ? 'forbidden' : 'unauthenticated')

  const existing = await database
    .prepare('SELECT * FROM brand_authorizations WHERE id = ?')
    .bind(rawInput.authorizationId)
    .first<BrandAuthRow>()
  if (!existing) fail('not_found')

  const payloadHash = await sha256Hex(JSON.stringify(rawInput))
  const nextVersion = existing.version + 1

  await database.batch([
    database
      .prepare(
        "UPDATE brand_authorizations SET status = 'revoked', version = ?, updated_at = ? WHERE id = ? AND version = ?"
      )
      .bind(nextVersion, now, rawInput.authorizationId, existing.version),
    database
      .prepare(
        `INSERT INTO brand_center_commands (
          command_id, entity_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
        ) VALUES (?, ?, ?, 'revoke_partner', ?, ?, ?, ?, ?)`
      )
      .bind(
        rawInput.commandId,
        rawInput.authorizationId,
        claims.identityId,
        existing.version,
        nextVersion,
        payloadHash,
        JSON.stringify(rawInput),
        now
      )
  ])

  const row = await database
    .prepare('SELECT * FROM brand_authorizations WHERE id = ?')
    .bind(rawInput.authorizationId)
    .first<BrandAuthRow>()
  if (!row) fail('not_found')
  return authRowToDto(row)
}

export async function getBrandCenterView(database: D1Database, now?: string): Promise<BrandCenterView> {
  const currentInstant = now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  const [assetsRes, certsRes, authsRes] = await Promise.all([
    database.prepare("SELECT * FROM brand_assets WHERE status = 'active' ORDER BY name ASC").all<BrandAssetRow>(),
    database
      .prepare("SELECT * FROM official_certifications WHERE status = 'active' ORDER BY standard_code ASC")
      .all<CertificationRow>(),
    database
      .prepare("SELECT * FROM brand_authorizations WHERE status = 'active' ORDER BY partner_name ASC")
      .all<BrandAuthRow>()
  ])

  const brandAssets = (assetsRes.results ?? []).map(assetRowToDto)
  const certifications = (certsRes.results ?? []).map(certRowToDto)
  const authorizations = (authsRes.results ?? []).map(authRowToDto)

  return brandCenterViewSchema.parse({
    source: 'cloudflare',
    brandAssets,
    certifications,
    authorizations,
    usageGuidelines: {
      generalRules: [
        'Utilizar únicamente los archivos vectoriales SVG oficiales sin alteraciones.',
        'Respetar el área de protección mínima indicada para cada logotipo.',
        'No reproducir la marca sobre fondos con contraste inferior a 4.5:1.',
        'Toda mención de certificaciones debe incluir el número de registro oficial y alcance verificable.'
      ],
      minimumClearspaceFormula: 'X = Altura del imagotipo "N". Mantener mínimo X/2 a los 4 lados.',
      unauthorizedPractices: [
        'Queda estrictamente prohibido el uso de sellos ecológicos vagos o auto-declarados sin certificación externa.',
        'No distorsionar, inclinar ni aplicar efectos de sombra o biselado a la marca.',
        'No co-brandear sin autorización explícita vigente registrada en el Centro de Marca.'
      ]
    },
    generatedAt: currentInstant
  })
}
