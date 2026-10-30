import { z } from 'zod'
import {
  calculateConnectorMetrics,
  configureConnectorSchema,
  dispatchConnectorSchema,
  encryptSecret,
  hashSecret,
  installConnectorSchema,
  maskSecret,
  proposeConnectorSchema,
  type RawMetricEvent,
  reviewConnectorSchema,
  rotateSecretSchema,
  uninstallConnectorSchema
} from '../../shared/connector-marketplace'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { verifySessionCookie, type SessionCookieConfiguration } from '../auth/session-cookie'

export interface ConnectorsDependencies {
  database: D1Database
  sessionCookieConfiguration: SessionCookieConfiguration
  origin: string
  secretPepper: string
  now?: string
}

interface CatalogRow {
  id: string
  name: string
  category: string
  description: string
  version: string
  provider_type: string
  allowed_scopes: string
  config_schema_json: string
  governance_status: string
  review_notes: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}

interface SecretRow {
  installation_id: string
  secret_key: string
  masked_preview: string
  version: number
  updated_at: string
}

interface InstallationRow {
  id: string
  connector_id: string
  display_name: string
  status: string
  granted_scopes: string
  config_json: string
  version: number
  installed_by: string
  installed_at: string
  updated_at: string
  uninstalled_at: string | null
  uninstalled_by: string | null
  connector_name: string
  category: string
  provider_type: string
}

const RESPONSE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: RESPONSE_HEADERS })
}

function error(code: string, status: number): Response {
  return json({ error: { code } }, status)
}

export function ownsConnectorsNamespace(pathname: string): boolean {
  for (let i = 0; i < 4; i++) {
    if (/^\/api\/admin\/connectors(?:[/\\%]|$)/i.test(pathname)) return true
    try {
      const next = decodeURIComponent(pathname)
      if (next === pathname) break
      pathname = next
    } catch {
      break
    }
  }
  return false
}

async function readJsonBody(request: Request): Promise<unknown | null> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) || !request.body) {
    return null
  }
  const reader = request.body.getReader()
  const bytes = new Uint8Array(65536)
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      if (size + part.value.length > bytes.length) {
        await reader.cancel()
        return null
      }
      bytes.set(part.value, size)
      size += part.value.length
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}

async function hashPayload(payload: unknown): Promise<string> {
  const str = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function checkAuth(
  database: D1Database,
  claims: VerifiedSessionClaims,
  permission: string,
  options: { now: string; requireMfa: boolean }
) {
  const specific = await authorizeD1Session(database, claims, permission, options)
  if (specific.allowed) return specific
  if (specific.code === 'forbidden' && permission !== 'administration.manage') {
    const admin = await authorizeD1Session(database, claims, 'administration.manage', options)
    if (admin.allowed) return admin
  }
  return specific
}

export async function handleConnectorsHttp(request: Request, deps: ConnectorsDependencies): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsConnectorsNamespace(url.pathname)) return null

  // Origin / CSRF checks
  const originHeader = request.headers.get('origin')
  if (request.method !== 'GET') {
    if (!originHeader || originHeader !== deps.origin) {
      return error('csrf_rejected', 403)
    }
  } else if (originHeader && originHeader !== deps.origin) {
    return error('csrf_rejected', 403)
  }

  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return error('csrf_rejected', 403)
  }

  // Session authentication
  const claims = await verifySessionCookie(request, deps.sessionCookieConfiguration)
  if (!claims) return error('unauthenticated', 401)

  const now = deps.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // Routing
  const path = url.pathname.replace(/\/+$/, '')

  // 1. Catalog endpoints
  // GET /api/admin/connectors/catalog
  if (path === '/api/admin/connectors/catalog' && request.method === 'GET') {
    const auth = await checkAuth(deps.database, claims, 'connectors.view', { now, requireMfa: false })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const category = url.searchParams.get('category')
    const status = url.searchParams.get('status')

    let query = `SELECT id, name, category, description, version, provider_type, allowed_scopes, config_schema_json, governance_status, review_notes, reviewed_by, reviewed_at, created_at, updated_at FROM connector_catalog WHERE 1=1`
    const binds: unknown[] = []

    if (category) {
      query += ` AND category = ?`
      binds.push(category)
    }
    if (status) {
      query += ` AND governance_status = ?`
      binds.push(status)
    }
    query += ` ORDER BY category, name`

    const stmt = deps.database.prepare(query)
    const result = binds.length > 0 ? await stmt.bind(...binds).all<CatalogRow>() : await stmt.all<CatalogRow>()

    // Live auth check after read
    const postAuth = await checkAuth(deps.database, claims, 'connectors.view', { now, requireMfa: false })
    if (!postAuth.allowed) return error('forbidden', 403)

    const items = (result.results ?? []).map((row) => ({
      ...row,
      allowed_scopes: JSON.parse(row.allowed_scopes),
      config_schema_json: JSON.parse(row.config_schema_json)
    }))

    return json({ items })
  }

  // POST /api/admin/connectors/catalog (propose new connector)
  if (path === '/api/admin/connectors/catalog' && request.method === 'POST') {
    const auth = await checkAuth(deps.database, claims, 'connectors.install', { now, requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const idempotencyKey = request.headers.get('idempotency-key') ?? ''
    if (!z.string().uuid().safeParse(idempotencyKey).success) {
      return error('invalid_idempotency_key', 400)
    }

    const rawBody = await readJsonBody(request)
    const parsed = proposeConnectorSchema.safeParse(rawBody)
    if (!parsed.success) return error('invalid_input', 422)

    const input = parsed.data
    const digest = await hashPayload({ ...input, allowedScopes: [...input.allowedScopes].sort() })

    // Check prior command
    const prior = await deps.database
      .prepare('SELECT payload_hash, response_json FROM connector_commands WHERE actor_id = ? AND command_id = ?')
      .bind(claims.identityId, idempotencyKey)
      .first<{ payload_hash: string; response_json: string }>()

    if (prior) {
      if (prior.payload_hash !== digest) return error('idempotency_conflict', 409)
      return json(JSON.parse(prior.response_json), 200)
    }

    // Check if ID already exists
    const existing = await deps.database.prepare('SELECT id FROM connector_catalog WHERE id = ?').bind(input.id).first()
    if (existing) return error('connector_already_exists', 409)

    const responsePayload = { id: input.id, governanceStatus: 'in_review' }
    const responseJson = JSON.stringify(responsePayload)

    await deps.database.batch([
      deps.database
        .prepare(
          `INSERT INTO connector_catalog (
            id, name, category, description, version, provider_type,
            allowed_scopes, config_schema_json, governance_status,
            created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_review', ?, ?, ?)`
        )
        .bind(
          input.id,
          input.name,
          input.category,
          input.description,
          input.version,
          input.providerType,
          JSON.stringify(input.allowedScopes),
          JSON.stringify(input.configSchema),
          claims.identityId,
          now,
          now
        ),
      deps.database
        .prepare(
          `INSERT INTO connector_commands (actor_id, command_id, payload_hash, action, resource_id, response_json, created_at)
           VALUES (?, ?, ?, 'catalog_propose', ?, ?, ?)`
        )
        .bind(claims.identityId, idempotencyKey, digest, input.id, responseJson, now),
      deps.database
        .prepare(
          `INSERT INTO connector_audit_events (id, actor_id, command_id, action, resource_id, details_json, created_at)
           VALUES (?, ?, ?, 'catalog_propose', ?, ?, ?)`
        )
        .bind(crypto.randomUUID(), claims.identityId, idempotencyKey, input.id, JSON.stringify(input), now)
    ])

    const postAuth = await checkAuth(deps.database, claims, 'connectors.install', { now, requireMfa: true })
    if (!postAuth.allowed) return error('forbidden', 403)

    return json(responsePayload, 201)
  }

  // GET /api/admin/connectors/catalog/:id
  const catalogDetailMatch = path.match(/^\/api\/admin\/connectors\/catalog\/([a-z0-9_-]+)$/i)
  if (catalogDetailMatch && request.method === 'GET') {
    const connectorId = catalogDetailMatch[1]!
    const auth = await checkAuth(deps.database, claims, 'connectors.view', { now, requireMfa: false })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const row = await deps.database
      .prepare(
        `SELECT id, name, category, description, version, provider_type,
                allowed_scopes, config_schema_json, governance_status,
                review_notes, reviewed_by, reviewed_at, created_by, created_at, updated_at
         FROM connector_catalog WHERE id = ?`
      )
      .bind(connectorId)
      .first<CatalogRow>()

    if (!row) return error('not_found', 404)

    const postAuth = await checkAuth(deps.database, claims, 'connectors.view', { now, requireMfa: false })
    if (!postAuth.allowed) return error('forbidden', 403)

    return json({
      ...row,
      allowed_scopes: JSON.parse(row.allowed_scopes),
      config_schema_json: JSON.parse(row.config_schema_json)
    })
  }

  // POST /api/admin/connectors/catalog/:id/review
  const catalogReviewMatch = path.match(/^\/api\/admin\/connectors\/catalog\/([a-z0-9_-]+)\/review$/i)
  if (catalogReviewMatch && request.method === 'POST') {
    const connectorId = catalogReviewMatch[1]!
    const auth = await checkAuth(deps.database, claims, 'connectors.review', { now, requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const idempotencyKey = request.headers.get('idempotency-key') ?? ''
    if (!z.string().uuid().safeParse(idempotencyKey).success) {
      return error('invalid_idempotency_key', 400)
    }

    const rawBody = await readJsonBody(request)
    const parsed = reviewConnectorSchema.safeParse(rawBody)
    if (!parsed.success) return error('invalid_input', 422)

    const input = parsed.data
    const digest = await hashPayload({ connectorId, ...input })

    const prior = await deps.database
      .prepare('SELECT payload_hash, response_json FROM connector_commands WHERE actor_id = ? AND command_id = ?')
      .bind(claims.identityId, idempotencyKey)
      .first<{ payload_hash: string; response_json: string }>()

    if (prior) {
      if (prior.payload_hash !== digest) return error('idempotency_conflict', 409)
      return json(JSON.parse(prior.response_json), 200)
    }

    const row = await deps.database
      .prepare('SELECT id, governance_status FROM connector_catalog WHERE id = ?')
      .bind(connectorId)
      .first<{ id: string; governance_status: string }>()

    if (!row) return error('not_found', 404)

    const newStatus = input.decision === 'approve' ? 'approved' : 'rejected'
    const responsePayload = {
      id: connectorId,
      governanceStatus: newStatus,
      reviewedBy: claims.identityId
    }
    const responseJson = JSON.stringify(responsePayload)

    await deps.database.batch([
      deps.database
        .prepare(
          `UPDATE connector_catalog
           SET governance_status = ?, review_notes = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .bind(newStatus, input.reviewNotes, claims.identityId, now, now, connectorId),
      deps.database
        .prepare(
          `INSERT INTO connector_commands (actor_id, command_id, payload_hash, action, resource_id, response_json, created_at)
           VALUES (?, ?, ?, 'catalog_review', ?, ?, ?)`
        )
        .bind(claims.identityId, idempotencyKey, digest, connectorId, responseJson, now),
      deps.database
        .prepare(
          `INSERT INTO connector_audit_events (id, actor_id, command_id, action, resource_id, details_json, created_at)
           VALUES (?, ?, ?, 'catalog_review', ?, ?, ?)`
        )
        .bind(crypto.randomUUID(), claims.identityId, idempotencyKey, connectorId, JSON.stringify(input), now)
    ])

    const postAuth = await checkAuth(deps.database, claims, 'connectors.review', { now, requireMfa: true })
    if (!postAuth.allowed) return error('forbidden', 403)

    return json(responsePayload, 200)
  }

  // 2. Installations endpoints
  // GET /api/admin/connectors/installations
  if (path === '/api/admin/connectors/installations' && request.method === 'GET') {
    const auth = await checkAuth(deps.database, claims, 'connectors.view', { now, requireMfa: false })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const installations = await deps.database
      .prepare(
        `SELECT i.id, i.connector_id, i.display_name, i.status, i.granted_scopes,
                i.config_json, i.version, i.installed_by, i.installed_at, i.updated_at,
                i.uninstalled_at, i.uninstalled_by,
                c.name AS connector_name, c.category, c.provider_type
         FROM connector_installations i
         JOIN connector_catalog c ON c.id = i.connector_id
         ORDER BY i.installed_at DESC`
      )
      .all<InstallationRow>()

    const secrets = await deps.database
      .prepare(
        `SELECT installation_id, secret_key, masked_preview, version, updated_at
         FROM connector_secrets`
      )
      .all<SecretRow>()

    const postAuth = await checkAuth(deps.database, claims, 'connectors.view', { now, requireMfa: false })
    if (!postAuth.allowed) return error('forbidden', 403)

    const secretsByInst: Record<
      string,
      Array<{ secretKey: string; maskedPreview: string; version: number; updatedAt: string }>
    > = {}
    for (const sec of secrets.results ?? []) {
      if (!secretsByInst[sec.installation_id]) secretsByInst[sec.installation_id] = []
      secretsByInst[sec.installation_id]!.push({
        secretKey: sec.secret_key,
        maskedPreview: sec.masked_preview,
        version: sec.version,
        updatedAt: sec.updated_at
      })
    }

    const items = (installations.results ?? []).map((inst) => ({
      ...inst,
      granted_scopes: JSON.parse(inst.granted_scopes),
      config_json: JSON.parse(inst.config_json),
      secrets: secretsByInst[inst.id] ?? []
    }))

    return json({ items })
  }

  // POST /api/admin/connectors/installations
  if (path === '/api/admin/connectors/installations' && request.method === 'POST') {
    const auth = await checkAuth(deps.database, claims, 'connectors.install', { now, requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const idempotencyKey = request.headers.get('idempotency-key') ?? ''
    if (!z.string().uuid().safeParse(idempotencyKey).success) {
      return error('invalid_idempotency_key', 400)
    }

    const rawBody = await readJsonBody(request)
    const parsed = installConnectorSchema.safeParse(rawBody)
    if (!parsed.success) return error('invalid_input', 422)

    const input = parsed.data
    const canonicalPayload = {
      ...input,
      grantedScopes: [...input.grantedScopes].sort(),
      secrets: Object.keys(input.secrets)
        .sort()
        .reduce<Record<string, string>>((acc, k) => {
          acc[k] = input.secrets[k]!
          return acc
        }, {})
    }
    const digest = await hashPayload(canonicalPayload)

    const prior = await deps.database
      .prepare('SELECT payload_hash, response_json FROM connector_commands WHERE actor_id = ? AND command_id = ?')
      .bind(claims.identityId, idempotencyKey)
      .first<{ payload_hash: string; response_json: string }>()

    if (prior) {
      if (prior.payload_hash !== digest) return error('idempotency_conflict', 409)
      return json(JSON.parse(prior.response_json), 200)
    }

    // Check connector in catalog
    const catalogItem = await deps.database
      .prepare(`SELECT id, allowed_scopes, governance_status FROM connector_catalog WHERE id = ?`)
      .bind(input.connectorId)
      .first<{ id: string; allowed_scopes: string; governance_status: string }>()

    if (!catalogItem) return error('connector_not_found', 404)
    if (catalogItem.governance_status !== 'approved') return error('connector_not_approved', 422)

    const allowedScopes = JSON.parse(catalogItem.allowed_scopes) as string[]
    const scopesValid = input.grantedScopes.every((sc) => allowedScopes.includes(sc))
    if (!scopesValid) return error('invalid_scopes', 422)

    // Check if connector is already actively installed
    const activeInstall = await deps.database
      .prepare(`SELECT id FROM connector_installations WHERE connector_id = ? AND status != 'uninstalled'`)
      .bind(input.connectorId)
      .first()

    if (activeInstall) return error('already_installed', 409)

    const installationId = crypto.randomUUID()
    const secretPreviews: Array<{ secretKey: string; maskedPreview: string; version: number }> = []
    const secretStatements: D1PreparedStatement[] = []

    for (const [key, val] of Object.entries(input.secrets)) {
      const masked = maskSecret(val)
      const secHash = await hashSecret(val, deps.secretPepper)
      const encrypted = await encryptSecret(val, deps.secretPepper)
      secretPreviews.push({ secretKey: key, maskedPreview: masked, version: 1 })

      secretStatements.push(
        deps.database
          .prepare(
            `INSERT INTO connector_secrets (
              installation_id, secret_key, secret_hash, masked_preview,
              encrypted_value, version, created_at, updated_at, updated_by
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
          )
          .bind(installationId, key, secHash, masked, encrypted, now, now, claims.identityId)
      )
    }

    const responsePayload = {
      id: installationId,
      connectorId: input.connectorId,
      displayName: input.displayName,
      status: 'active',
      grantedScopes: input.grantedScopes,
      config: input.config,
      version: 1,
      secrets: secretPreviews
    }
    const responseJson = JSON.stringify(responsePayload)

    await deps.database.batch([
      deps.database
        .prepare(
          `INSERT INTO connector_installations (
            id, connector_id, display_name, status, granted_scopes,
            config_json, version, installed_by, installed_at, updated_at
          ) VALUES (?, ?, ?, 'active', ?, ?, 1, ?, ?, ?)`
        )
        .bind(
          installationId,
          input.connectorId,
          input.displayName,
          JSON.stringify(input.grantedScopes),
          JSON.stringify(input.config),
          claims.identityId,
          now,
          now
        ),
      ...secretStatements,
      deps.database
        .prepare(
          `INSERT INTO connector_commands (actor_id, command_id, payload_hash, action, resource_id, response_json, created_at)
           VALUES (?, ?, ?, 'install', ?, ?, ?)`
        )
        .bind(claims.identityId, idempotencyKey, digest, installationId, responseJson, now),
      deps.database
        .prepare(
          `INSERT INTO connector_audit_events (id, actor_id, command_id, action, resource_id, details_json, created_at)
           VALUES (?, ?, ?, 'install', ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          claims.identityId,
          idempotencyKey,
          installationId,
          JSON.stringify({
            connectorId: input.connectorId,
            displayName: input.displayName,
            grantedScopes: input.grantedScopes
          }),
          now
        )
    ])

    const postAuth = await checkAuth(deps.database, claims, 'connectors.install', { now, requireMfa: true })
    if (!postAuth.allowed) return error('forbidden', 403)

    return json(responsePayload, 201)
  }

  // GET /api/admin/connectors/installations/:id
  const instDetailMatch = path.match(/^\/api\/admin\/connectors\/installations\/([0-9a-f-]+)$/i)
  if (instDetailMatch && request.method === 'GET') {
    const installationId = instDetailMatch[1]!
    const auth = await checkAuth(deps.database, claims, 'connectors.view', { now, requireMfa: false })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const row = await deps.database
      .prepare(
        `SELECT i.id, i.connector_id, i.display_name, i.status, i.granted_scopes,
                i.config_json, i.version, i.installed_by, i.installed_at, i.updated_at,
                i.uninstalled_at, i.uninstalled_by,
                c.name AS connector_name, c.category, c.provider_type
         FROM connector_installations i
         JOIN connector_catalog c ON c.id = i.connector_id
         WHERE i.id = ?`
      )
      .bind(installationId)
      .first<InstallationRow>()

    if (!row) return error('not_found', 404)

    const secrets = await deps.database
      .prepare(
        `SELECT secret_key, masked_preview, version, updated_at
         FROM connector_secrets WHERE installation_id = ?`
      )
      .bind(installationId)
      .all<SecretRow>()

    const postAuth = await checkAuth(deps.database, claims, 'connectors.view', { now, requireMfa: false })
    if (!postAuth.allowed) return error('forbidden', 403)

    return json({
      ...row,
      grantedScopes: JSON.parse(row.granted_scopes),
      config: JSON.parse(row.config_json),
      secrets: (secrets.results ?? []).map((s) => ({
        secretKey: s.secret_key,
        maskedPreview: s.masked_preview,
        version: s.version,
        updatedAt: s.updated_at
      }))
    })
  }

  // POST /api/admin/connectors/installations/:id/configure
  const instConfigureMatch = path.match(/^\/api\/admin\/connectors\/installations\/([0-9a-f-]+)\/configure$/i)
  if (instConfigureMatch && request.method === 'POST') {
    const installationId = instConfigureMatch[1]!
    const auth = await checkAuth(deps.database, claims, 'connectors.install', { now, requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const idempotencyKey = request.headers.get('idempotency-key') ?? ''
    if (!z.string().uuid().safeParse(idempotencyKey).success) {
      return error('invalid_idempotency_key', 400)
    }

    const rawBody = await readJsonBody(request)
    const parsed = configureConnectorSchema.safeParse(rawBody)
    if (!parsed.success) return error('invalid_input', 422)

    const input = parsed.data
    const digest = await hashPayload({ installationId, ...input })

    const prior = await deps.database
      .prepare('SELECT payload_hash, response_json FROM connector_commands WHERE actor_id = ? AND command_id = ?')
      .bind(claims.identityId, idempotencyKey)
      .first<{ payload_hash: string; response_json: string }>()

    if (prior) {
      if (prior.payload_hash !== digest) return error('idempotency_conflict', 409)
      return json(JSON.parse(prior.response_json), 200)
    }

    const inst = await deps.database
      .prepare('SELECT id, status, version, config_json FROM connector_installations WHERE id = ?')
      .bind(installationId)
      .first<{ id: string; status: string; version: number; config_json: string }>()

    if (!inst) return error('not_found', 404)
    if (inst.status === 'uninstalled') return error('connector_uninstalled', 410)
    if (inst.version !== input.expectedVersion) return error('version_conflict', 409)

    let nextStatus = inst.status
    if (input.action === 'pause') nextStatus = 'paused'
    else if (input.action === 'resume') nextStatus = 'active'

    const nextConfig = input.config
      ? JSON.stringify({ ...JSON.parse(inst.config_json), ...input.config })
      : inst.config_json
    const nextVersion = inst.version + 1

    const responsePayload = {
      id: installationId,
      status: nextStatus,
      version: nextVersion
    }
    const responseJson = JSON.stringify(responsePayload)

    await deps.database.batch([
      deps.database
        .prepare(
          `UPDATE connector_installations
           SET status = ?, config_json = ?, version = ?, updated_at = ?
           WHERE id = ? AND version = ?`
        )
        .bind(nextStatus, nextConfig, nextVersion, now, installationId, input.expectedVersion),
      deps.database
        .prepare(
          `INSERT INTO connector_commands (actor_id, command_id, payload_hash, action, resource_id, response_json, created_at)
           VALUES (?, ?, ?, 'configure', ?, ?, ?)`
        )
        .bind(claims.identityId, idempotencyKey, digest, installationId, responseJson, now),
      deps.database
        .prepare(
          `INSERT INTO connector_audit_events (id, actor_id, command_id, action, resource_id, details_json, created_at)
           VALUES (?, ?, ?, 'configure', ?, ?, ?)`
        )
        .bind(crypto.randomUUID(), claims.identityId, idempotencyKey, installationId, JSON.stringify(input), now)
    ])

    const postAuth = await checkAuth(deps.database, claims, 'connectors.install', { now, requireMfa: true })
    if (!postAuth.allowed) return error('forbidden', 403)

    return json(responsePayload, 200)
  }

  // POST /api/admin/connectors/installations/:id/secrets
  const instSecretsMatch = path.match(/^\/api\/admin\/connectors\/installations\/([0-9a-f-]+)\/secrets$/i)
  if (instSecretsMatch && request.method === 'POST') {
    const installationId = instSecretsMatch[1]!
    const auth = await checkAuth(deps.database, claims, 'connectors.secrets', { now, requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const idempotencyKey = request.headers.get('idempotency-key') ?? ''
    if (!z.string().uuid().safeParse(idempotencyKey).success) {
      return error('invalid_idempotency_key', 400)
    }

    const rawBody = await readJsonBody(request)
    const parsed = rotateSecretSchema.safeParse(rawBody)
    if (!parsed.success) return error('invalid_input', 422)

    const input = parsed.data
    const digest = await hashPayload({ installationId, ...input })

    const prior = await deps.database
      .prepare('SELECT payload_hash, response_json FROM connector_commands WHERE actor_id = ? AND command_id = ?')
      .bind(claims.identityId, idempotencyKey)
      .first<{ payload_hash: string; response_json: string }>()

    if (prior) {
      if (prior.payload_hash !== digest) return error('idempotency_conflict', 409)
      return json(JSON.parse(prior.response_json), 200)
    }

    const inst = await deps.database
      .prepare('SELECT id, status, version FROM connector_installations WHERE id = ?')
      .bind(installationId)
      .first<{ id: string; status: string; version: number }>()

    if (!inst) return error('not_found', 404)
    if (inst.status === 'uninstalled') return error('connector_uninstalled', 410)
    if (inst.version !== input.expectedVersion) return error('version_conflict', 409)

    const masked = maskSecret(input.secretValue)
    const secHash = await hashSecret(input.secretValue, deps.secretPepper)
    const encrypted = await encryptSecret(input.secretValue, deps.secretPepper)

    const existingSecret = await deps.database
      .prepare('SELECT version FROM connector_secrets WHERE installation_id = ? AND secret_key = ?')
      .bind(installationId, input.secretKey)
      .first<{ version: number }>()

    const newSecretVersion = (existingSecret?.version ?? 0) + 1
    const nextInstVersion = inst.version + 1

    const responsePayload = {
      installationVersion: nextInstVersion,
      secret: {
        secretKey: input.secretKey,
        version: newSecretVersion,
        maskedPreview: masked
      }
    }
    const responseJson = JSON.stringify(responsePayload)

    await deps.database.batch([
      deps.database
        .prepare(
          `INSERT INTO connector_secrets (
            installation_id, secret_key, secret_hash, masked_preview,
            encrypted_value, version, created_at, updated_at, updated_by
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
          ON CONFLICT(installation_id, secret_key) DO UPDATE SET
            secret_hash = excluded.secret_hash,
            masked_preview = excluded.masked_preview,
            encrypted_value = excluded.encrypted_value,
            version = connector_secrets.version + 1,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`
        )
        .bind(installationId, input.secretKey, secHash, masked, encrypted, now, now, claims.identityId),
      deps.database
        .prepare(
          `UPDATE connector_installations
           SET version = ?, updated_at = ?
           WHERE id = ? AND version = ?`
        )
        .bind(nextInstVersion, now, installationId, input.expectedVersion),
      deps.database
        .prepare(
          `INSERT INTO connector_commands (actor_id, command_id, payload_hash, action, resource_id, response_json, created_at)
           VALUES (?, ?, ?, 'rotate_secret', ?, ?, ?)`
        )
        .bind(claims.identityId, idempotencyKey, digest, installationId, responseJson, now),
      deps.database
        .prepare(
          `INSERT INTO connector_audit_events (id, actor_id, command_id, action, resource_id, details_json, created_at)
           VALUES (?, ?, ?, 'rotate_secret', ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          claims.identityId,
          idempotencyKey,
          installationId,
          JSON.stringify({ secretKey: input.secretKey, newVersion: newSecretVersion }),
          now
        )
    ])

    const postAuth = await checkAuth(deps.database, claims, 'connectors.secrets', { now, requireMfa: true })
    if (!postAuth.allowed) return error('forbidden', 403)

    return json(responsePayload, 200)
  }

  // POST /api/admin/connectors/installations/:id/dispatch
  const instDispatchMatch = path.match(/^\/api\/admin\/connectors\/installations\/([0-9a-f-]+)\/dispatch$/i)
  if (instDispatchMatch && request.method === 'POST') {
    const installationId = instDispatchMatch[1]!
    const auth = await checkAuth(deps.database, claims, 'connectors.install', { now, requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const rawBody = await readJsonBody(request)
    const parsed = dispatchConnectorSchema.safeParse(rawBody)
    if (!parsed.success) return error('invalid_input', 422)

    const input = parsed.data

    const inst = await deps.database
      .prepare('SELECT id, status, granted_scopes FROM connector_installations WHERE id = ?')
      .bind(installationId)
      .first<{ id: string; status: string; granted_scopes: string }>()

    if (!inst) return error('not_found', 404)
    if (inst.status === 'uninstalled') return error('connector_uninstalled', 410)
    if (inst.status === 'paused') return error('connector_paused', 409)

    const grantedScopes = JSON.parse(inst.granted_scopes) as string[]
    if (!grantedScopes.includes(input.requiredScope)) {
      return error('missing_scope', 403)
    }

    // Execute adapter dispatch simulation
    const latencyMs = 12
    const eventId = crypto.randomUUID()

    await deps.database
      .prepare(
        `INSERT INTO connector_metric_events (id, installation_id, operation, status, latency_ms, error_code, invoked_at, invoked_by)
         VALUES (?, ?, ?, 'success', ?, NULL, ?, ?)`
      )
      .bind(eventId, installationId, input.operation, latencyMs, now, claims.identityId)
      .run()

    return json({
      status: 'success',
      operation: input.operation,
      latencyMs,
      timestamp: now
    })
  }

  // GET /api/admin/connectors/installations/:id/metrics
  const instMetricsMatch = path.match(/^\/api\/admin\/connectors\/installations\/([0-9a-f-]+)\/metrics$/i)
  if (instMetricsMatch && request.method === 'GET') {
    const installationId = instMetricsMatch[1]!
    const auth = await checkAuth(deps.database, claims, 'connectors.view', { now, requireMfa: false })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const inst = await deps.database
      .prepare('SELECT id FROM connector_installations WHERE id = ?')
      .bind(installationId)
      .first()

    if (!inst) return error('not_found', 404)

    const events = await deps.database
      .prepare(
        `SELECT status, latency_ms, error_code, invoked_at
         FROM connector_metric_events
         WHERE installation_id = ?
         ORDER BY invoked_at DESC
         LIMIT 100`
      )
      .bind(installationId)
      .all<RawMetricEvent>()

    const postAuth = await checkAuth(deps.database, claims, 'connectors.view', { now, requireMfa: false })
    if (!postAuth.allowed) return error('forbidden', 403)

    const rawList = events.results ?? []
    const summary = calculateConnectorMetrics(rawList)

    return json({ summary, recentEvents: rawList })
  }

  // POST /api/admin/connectors/installations/:id/uninstall
  const instUninstallMatch = path.match(/^\/api\/admin\/connectors\/installations\/([0-9a-f-]+)\/uninstall$/i)
  if (instUninstallMatch && request.method === 'POST') {
    const installationId = instUninstallMatch[1]!
    const auth = await checkAuth(deps.database, claims, 'connectors.install', { now, requireMfa: true })
    if (!auth.allowed) return error(auth.code, auth.code === 'unauthenticated' ? 401 : 403)

    const idempotencyKey = request.headers.get('idempotency-key') ?? ''
    if (!z.string().uuid().safeParse(idempotencyKey).success) {
      return error('invalid_idempotency_key', 400)
    }

    const rawBody = await readJsonBody(request)
    const parsed = uninstallConnectorSchema.safeParse(rawBody)
    if (!parsed.success) return error('invalid_input', 422)

    const input = parsed.data
    const digest = await hashPayload({ installationId, ...input })

    const prior = await deps.database
      .prepare('SELECT payload_hash, response_json FROM connector_commands WHERE actor_id = ? AND command_id = ?')
      .bind(claims.identityId, idempotencyKey)
      .first<{ payload_hash: string; response_json: string }>()

    if (prior) {
      if (prior.payload_hash !== digest) return error('idempotency_conflict', 409)
      return json(JSON.parse(prior.response_json), 200)
    }

    const inst = await deps.database
      .prepare('SELECT id, status, version FROM connector_installations WHERE id = ?')
      .bind(installationId)
      .first<{ id: string; status: string; version: number }>()

    if (!inst) return error('not_found', 404)
    if (inst.status === 'uninstalled') return error('already_uninstalled', 409)
    if (inst.version !== input.expectedVersion) return error('version_conflict', 409)

    const secretCountRow = await deps.database
      .prepare('SELECT count(*) AS count FROM connector_secrets WHERE installation_id = ?')
      .bind(installationId)
      .first<{ count: number }>()

    const secretsWiped = secretCountRow?.count ?? 0
    const nextVersion = inst.version + 1

    const responsePayload = {
      status: 'uninstalled',
      uninstalledAt: now,
      secretsWiped
    }
    const responseJson = JSON.stringify(responsePayload)

    await deps.database.batch([
      // Clean uninstallation: wipe all secrets completely
      deps.database.prepare('DELETE FROM connector_secrets WHERE installation_id = ?').bind(installationId),
      // Mark installation as uninstalled, revoke scopes
      deps.database
        .prepare(
          `UPDATE connector_installations
           SET status = 'uninstalled', granted_scopes = '[]', version = ?, uninstalled_at = ?, uninstalled_by = ?, updated_at = ?
           WHERE id = ? AND version = ?`
        )
        .bind(nextVersion, now, claims.identityId, now, installationId, input.expectedVersion),
      deps.database
        .prepare(
          `INSERT INTO connector_commands (actor_id, command_id, payload_hash, action, resource_id, response_json, created_at)
           VALUES (?, ?, ?, 'uninstall', ?, ?, ?)`
        )
        .bind(claims.identityId, idempotencyKey, digest, installationId, responseJson, now),
      deps.database
        .prepare(
          `INSERT INTO connector_audit_events (id, actor_id, command_id, action, resource_id, details_json, created_at)
           VALUES (?, ?, ?, 'uninstall', ?, ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          claims.identityId,
          idempotencyKey,
          installationId,
          JSON.stringify({ reason: input.reason ?? 'clean_uninstall', secretsWiped }),
          now
        )
    ])

    const postAuth = await checkAuth(deps.database, claims, 'connectors.install', { now, requireMfa: true })
    if (!postAuth.allowed) return error('forbidden', 403)

    return json(responsePayload, 200)
  }

  return error('not_found', 404)
}
