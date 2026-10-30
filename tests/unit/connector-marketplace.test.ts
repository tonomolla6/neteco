import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIXTURE_NOW,
  SESSION_CONFIG,
  setupConnectorsTestDb,
  TEST_ORIGIN,
  TEST_PEPPER,
  type TestActors
} from './connector-marketplace-fixture'
import { handleConnectorsHttp } from '../../workers/developer-platform/connector-marketplace'

describe('Marketplace interno de conectores gobernado (INT-023)', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let actors: TestActors

  const makeRequest = (
    path: string,
    options: {
      method?: string
      cookie?: string
      body?: unknown
      idempotencyKey?: string
      origin?: string
      secFetchSite?: string
    } = {}
  ) => {
    const headers = new Headers({
      origin: options.origin ?? TEST_ORIGIN,
      'content-type': 'application/json'
    })
    if (options.cookie !== undefined) {
      if (options.cookie !== '') headers.set('cookie', options.cookie)
    } else {
      headers.set('cookie', actors.adminCookie)
    }
    if (options.idempotencyKey !== undefined) {
      if (options.idempotencyKey !== '') headers.set('idempotency-key', options.idempotencyKey)
    }
    if (options.secFetchSite) {
      headers.set('sec-fetch-site', options.secFetchSite)
    }

    const init: RequestInit = {
      method: options.method ?? (options.body ? 'POST' : 'GET'),
      headers
    }
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body)
    }

    return new Request(`${TEST_ORIGIN}${path}`, init)
  }

  const call = async (
    path: string,
    options: {
      method?: string
      cookie?: string
      body?: unknown
      idempotencyKey?: string
      origin?: string
      secFetchSite?: string
    } = {}
  ) => {
    const req = makeRequest(path, options)
    return handleConnectorsHttp(req, {
      database,
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: TEST_ORIGIN,
      secretPepper: TEST_PEPPER,
      now: FIXTURE_NOW
    })
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FIXTURE_NOW))
    const fixture = await setupConnectorsTestDb()
    sqlite = fixture.sqlite
    database = fixture.database
    actors = fixture.actors
  })

  afterEach(() => {
    sqlite?.close()
    vi.useRealTimers()
  })

  describe('1. Catálogo de conectores y revisión de gobernanza (no plugins arbitrarios)', () => {
    it('lista conectores del catálogo para rol con permiso connectors.view', async () => {
      const res = await call('/api/admin/connectors/catalog', { cookie: actors.viewerCookie })
      expect(res).not.toBeNull()
      expect(res!.status).toBe(200)
      const data = (await res!.json()) as { items: Array<{ id: string; name: string; governance_status: string }> }
      expect(data.items.length).toBeGreaterThanOrEqual(3)
      const holded = data.items.find((c) => c.id === 'erp-holded')
      expect(holded).toBeDefined()
      expect(holded?.governance_status).toBe('approved')
    })

    it('permite filtrar catálogo por categoría y estado de gobernanza', async () => {
      const res = await call('/api/admin/connectors/catalog?category=erp&status=approved', {
        cookie: actors.viewerCookie
      })
      expect(res!.status).toBe(200)
      const data = (await res!.json()) as { items: Array<{ id: string; category: string; governance_status: string }> }
      expect(data.items.every((c) => c.category === 'erp' && c.governance_status === 'approved')).toBe(true)
    })

    it('obtiene detalle de conector por id en el catálogo', async () => {
      const res = await call('/api/admin/connectors/catalog/carrier-correos-express', {
        cookie: actors.viewerCookie
      })
      expect(res!.status).toBe(200)
      const item = (await res!.json()) as { id: string; provider_type: string; allowed_scopes: string[] }
      expect(item.id).toBe('carrier-correos-express')
      expect(item.provider_type).toBe('internal_adapter')
      expect(item.allowed_scopes).toContain('shipping.read')
    })

    it('devuelve 404 si el conector no existe en catálogo', async () => {
      const res = await call('/api/admin/connectors/catalog/no-existe', { cookie: actors.viewerCookie })
      expect(res!.status).toBe(404)
    })

    it('propone nuevo conector en catálogo (estado draft/in_review)', async () => {
      const body = {
        id: 'crm-salesforce-adapter',
        name: 'Salesforce CRM Adapter',
        category: 'crm',
        description: 'Conector certificado para sincronizar cuentas y oportunidades B2B.',
        version: '1.0.0',
        providerType: 'rest_sync',
        allowedScopes: ['customers.read_masked'],
        configSchema: {
          endpointUrl: 'https://salesforce.example/api',
          declaredSecrets: ['client_secret', 'refresh_token']
        }
      }
      const res = await call('/api/admin/connectors/catalog', {
        body,
        idempotencyKey: '90000000-0000-4000-8000-000000000001',
        cookie: actors.adminCookie
      })
      expect(res!.status).toBe(201)
      const data = (await res!.json()) as { id: string; governanceStatus: string }
      expect(data.id).toBe('crm-salesforce-adapter')
      expect(data.governanceStatus).toBe('in_review')

      // Verificar en DB
      const row = sqlite.prepare('SELECT governance_status FROM connector_catalog WHERE id = ?').get(data.id) as {
        governance_status: string
      }
      expect(row.governance_status).toBe('in_review')
    })

    it('rechaza plugins arbitrarios no certificados (no plugins arbitrarios)', async () => {
      const body = {
        id: 'malicious-plugin',
        name: 'Plugin no seguro',
        category: 'erp',
        description: 'Intento de cargar código o tipo de proveedor arbitrario.',
        version: '1.0.0',
        providerType: 'arbitrary_eval_script', // Inválido!
        allowedScopes: ['orders.read'],
        configSchema: { declaredSecrets: ['secret'] }
      }
      const res = await call('/api/admin/connectors/catalog', {
        body,
        idempotencyKey: '90000000-0000-4000-8000-000000000002',
        cookie: actors.adminCookie
      })
      expect(res!.status).toBe(422)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('invalid_input')
    })

    it('revisor aprueba conector en catálogo con notas de auditoría', async () => {
      const res = await call('/api/admin/connectors/catalog/webhook-exporter/review', {
        body: {
          decision: 'approve',
          reviewNotes: 'Revisión técnica de seguridad completada con éxito. Cumple estándares Neteco.'
        },
        idempotencyKey: '90000000-0000-4000-8000-000000000003',
        cookie: actors.reviewerCookie
      })
      expect(res!.status).toBe(200)
      const data = (await res!.json()) as { id: string; governanceStatus: string; reviewedBy: string }
      expect(data.governanceStatus).toBe('approved')

      const row = sqlite
        .prepare('SELECT governance_status, review_notes FROM connector_catalog WHERE id = ?')
        .get('webhook-exporter') as { governance_status: string; review_notes: string }
      expect(row.governance_status).toBe('approved')
      expect(row.review_notes).toContain('Revisión técnica de seguridad')
    })

    it('revisor rechaza conector con notas', async () => {
      const res = await call('/api/admin/connectors/catalog/crm-hubspot-draft/review', {
        body: {
          decision: 'reject',
          reviewNotes: 'Falta documentación de endpoints de rotación de tokens.'
        },
        idempotencyKey: '90000000-0000-4000-8000-000000000004',
        cookie: actors.reviewerCookie
      })
      expect(res!.status).toBe(200)
      const data = (await res!.json()) as { governanceStatus: string }
      expect(data.governanceStatus).toBe('rejected')
    })

    it('rechaza revisión si las notas son demasiado cortas (< 10 caracteres)', async () => {
      const res = await call('/api/admin/connectors/catalog/webhook-exporter/review', {
        body: {
          decision: 'approve',
          reviewNotes: 'ok' // demasiado corta
        },
        idempotencyKey: '90000000-0000-4000-8000-000000000005',
        cookie: actors.reviewerCookie
      })
      expect(res!.status).toBe(422)
    })

    it('deniega revisión a usuarios sin permiso connectors.review', async () => {
      const res = await call('/api/admin/connectors/catalog/webhook-exporter/review', {
        body: {
          decision: 'approve',
          reviewNotes: 'Intento de revisión no autorizada.'
        },
        idempotencyKey: '90000000-0000-4000-8000-000000000006',
        cookie: actors.installerCookie // instalador no tiene connectors.review
      })
      expect(res!.status).toBe(403)
    })
  })

  describe('2. Instalación y scopes gobernados', () => {
    it('instala conector aprobado con scopes válidos y secretos iniciales', async () => {
      const body = {
        connectorId: 'erp-holded',
        displayName: 'Holded ERP Primario',
        grantedScopes: ['orders.read', 'inventory.read'],
        config: { environment: 'production', syncIntervalMinutes: 15 },
        secrets: { api_key: 'sk_live_neteco_holded_secret_key_12345' }
      }
      const res = await call('/api/admin/connectors/installations', {
        body,
        idempotencyKey: '80000000-0000-4000-8000-000000000001',
        cookie: actors.installerCookie
      })
      expect(res!.status).toBe(201)
      const data = (await res!.json()) as {
        id: string
        connectorId: string
        status: string
        version: number
        secrets: Array<{ secretKey: string; maskedPreview: string }>
      }
      expect(data.connectorId).toBe('erp-holded')
      expect(data.status).toBe('active')
      expect(data.version).toBe(1)
      expect(data.secrets).toHaveLength(1)
      expect(data.secrets[0]!.secretKey).toBe('api_key')
      expect(data.secrets[0]!.maskedPreview).toContain('••••')
      expect(data.secrets[0]!.maskedPreview).not.toBe('sk_live_neteco_holded_secret_key_12345')

      // Verificar que el secreto NUNCA se guardó en texto claro
      const secretRow = sqlite
        .prepare('SELECT encrypted_value, secret_hash, masked_preview FROM connector_secrets WHERE installation_id = ?')
        .get(data.id) as { encrypted_value: string; secret_hash: string; masked_preview: string }
      expect(secretRow.encrypted_value).not.toContain('sk_live_neteco_holded_secret_key_12345')
      expect(secretRow.masked_preview).toContain('••••')
    })

    it('rechaza instalación si el conector no está aprobado (está en draft o in_review)', async () => {
      const body = {
        connectorId: 'crm-hubspot-draft',
        displayName: 'HubSpot Test',
        grantedScopes: ['customers.read_masked'],
        config: {},
        secrets: { client_secret: 'secret_value_12345678' }
      }
      const res = await call('/api/admin/connectors/installations', {
        body,
        idempotencyKey: '80000000-0000-4000-8000-000000000002',
        cookie: actors.installerCookie
      })
      expect(res!.status).toBe(422)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('connector_not_approved')
    })

    it('rechaza instalación si solicita scopes no permitidos por el conector', async () => {
      const body = {
        connectorId: 'carrier-correos-express', // solo permite shipping.read y shipping.write
        displayName: 'Correos Intento no autorizado',
        grantedScopes: ['shipping.read', 'orders.write'], // orders.write no está en allowed_scopes!
        config: {},
        secrets: { api_key: 'correos_api_key_valid_1234' }
      }
      const res = await call('/api/admin/connectors/installations', {
        body,
        idempotencyKey: '80000000-0000-4000-8000-000000000003',
        cookie: actors.installerCookie
      })
      expect(res!.status).toBe(422)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('invalid_scopes')
    })

    it('rechaza duplicar instalación activa de un mismo conector', async () => {
      const body = {
        connectorId: 'carrier-correos-express',
        displayName: 'Correos Express 1',
        grantedScopes: ['shipping.read'],
        config: {},
        secrets: { api_key: 'correos_key_12345678' }
      }
      const first = await call('/api/admin/connectors/installations', {
        body,
        idempotencyKey: '80000000-0000-4000-8000-000000000004',
        cookie: actors.installerCookie
      })
      expect(first!.status).toBe(201)

      const second = await call('/api/admin/connectors/installations', {
        body: { ...body, displayName: 'Correos Express 2' },
        idempotencyKey: '80000000-0000-4000-8000-000000000005',
        cookie: actors.installerCookie
      })
      expect(second!.status).toBe(409)
      const err = (await second!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('already_installed')
    })
  })

  describe('3. Consulta, enmascaramiento de secretos y configuración', () => {
    let installationId: string

    beforeEach(async () => {
      const res = await call('/api/admin/connectors/installations', {
        body: {
          connectorId: 'erp-holded',
          displayName: 'Holded ERP Primario',
          grantedScopes: ['orders.read'],
          config: { syncMode: 'polling' },
          secrets: { api_key: 'sk_live_topsecret_9876543210' }
        },
        idempotencyKey: '80000000-0000-4000-8000-000000000010',
        cookie: actors.installerCookie
      })
      const data = (await res!.json()) as { id: string }
      installationId = data.id
    })

    it('lista instalaciones ocultando secretos reales (solo previews enmascarados)', async () => {
      const res = await call('/api/admin/connectors/installations', { cookie: actors.viewerCookie })
      expect(res!.status).toBe(200)
      const rawText = await res!.text()
      expect(rawText).not.toContain('sk_live_topsecret_9876543210')
      expect(rawText).toContain('••••')
      const json = JSON.parse(rawText) as { items: Array<{ id: string; display_name: string }> }
      expect(json.items.some((i) => i.id === installationId)).toBe(true)
    })

    it('obtiene detalle de instalación con metadatos de configuración y secretos', async () => {
      const res = await call(`/api/admin/connectors/installations/${installationId}`, {
        cookie: actors.viewerCookie
      })
      expect(res!.status).toBe(200)
      const data = (await res!.json()) as {
        id: string
        config: { syncMode: string }
        secrets: Array<{ secretKey: string; maskedPreview: string; version: number }>
      }
      expect(data.id).toBe(installationId)
      expect(data.config.syncMode).toBe('polling')
      expect(data.secrets[0]!.secretKey).toBe('api_key')
      expect(data.secrets[0]!.version).toBe(1)
    })

    it('permite pausar y reanudar el conector mediante CAS con expectedVersion', async () => {
      // Pausar con versión correcta
      const pauseRes = await call(`/api/admin/connectors/installations/${installationId}/configure`, {
        body: { action: 'pause', expectedVersion: 1 },
        idempotencyKey: '80000000-0000-4000-8000-000000000011',
        cookie: actors.installerCookie
      })
      expect(pauseRes!.status).toBe(200)
      const pausedData = (await pauseRes!.json()) as { status: string; version: number }
      expect(pausedData.status).toBe('paused')
      expect(pausedData.version).toBe(2)

      // Reanudar con versión correcta
      const resumeRes = await call(`/api/admin/connectors/installations/${installationId}/configure`, {
        body: { action: 'resume', expectedVersion: 2 },
        idempotencyKey: '80000000-0000-4000-8000-000000000012',
        cookie: actors.installerCookie
      })
      expect(resumeRes!.status).toBe(200)
      const resumedData = (await resumeRes!.json()) as { status: string; version: number }
      expect(resumedData.status).toBe('active')
      expect(resumedData.version).toBe(3)
    })

    it('rechaza actualización si expectedVersion no coincide (conflicto CAS)', async () => {
      const res = await call(`/api/admin/connectors/installations/${installationId}/configure`, {
        body: { action: 'pause', expectedVersion: 99 },
        idempotencyKey: '80000000-0000-4000-8000-000000000013',
        cookie: actors.installerCookie
      })
      expect(res!.status).toBe(409)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('version_conflict')
    })
  })

  describe('4. Gestión de secretos y rotación', () => {
    let installationId: string

    beforeEach(async () => {
      const res = await call('/api/admin/connectors/installations', {
        body: {
          connectorId: 'carrier-correos-express',
          displayName: 'Correos Rotación Test',
          grantedScopes: ['shipping.read'],
          config: {},
          secrets: { api_key: 'sk_correos_initial_secret_1234' }
        },
        idempotencyKey: '80000000-0000-4000-8000-000000000020',
        cookie: actors.installerCookie
      })
      const data = (await res!.json()) as { id: string }
      installationId = data.id
    })

    it('rota secreto correctamente con permiso connectors.secrets y CAS', async () => {
      const res = await call(`/api/admin/connectors/installations/${installationId}/secrets`, {
        body: {
          action: 'rotate_secret',
          secretKey: 'api_key',
          secretValue: 'sk_correos_rotated_secret_999999',
          expectedVersion: 1
        },
        idempotencyKey: '80000000-0000-4000-8000-000000000021',
        cookie: actors.secretsMgrCookie
      })
      expect(res!.status).toBe(200)
      const data = (await res!.json()) as {
        installationVersion: number
        secret: { secretKey: string; version: number; maskedPreview: string }
      }
      expect(data.installationVersion).toBe(2)
      expect(data.secret.secretKey).toBe('api_key')
      expect(data.secret.version).toBe(2)
      expect(data.secret.maskedPreview).toContain('••••')
      expect(data.secret.maskedPreview).not.toBe('sk_correos_rotated_secret_999999')

      // Verificar que se registró auditoría de la rotación
      const audit = sqlite
        .prepare('SELECT action FROM connector_audit_events WHERE resource_id = ? AND action = ?')
        .get(installationId, 'rotate_secret') as { action: string }
      expect(audit).toBeDefined()
    })

    it('deniega rotación de secretos a usuario sin permiso connectors.secrets', async () => {
      const res = await call(`/api/admin/connectors/installations/${installationId}/secrets`, {
        body: {
          action: 'rotate_secret',
          secretKey: 'api_key',
          secretValue: 'sk_correos_rotated_secret_999999',
          expectedVersion: 1
        },
        idempotencyKey: '80000000-0000-4000-8000-000000000022',
        cookie: actors.installerCookie // instalador no tiene connectors.secrets
      })
      expect(res!.status).toBe(403)
    })
  })

  describe('5. Métricas de telemetría y ejecución gobernada', () => {
    let installationId: string

    beforeEach(async () => {
      const res = await call('/api/admin/connectors/installations', {
        body: {
          connectorId: 'erp-holded',
          displayName: 'Holded Telemetría',
          grantedScopes: ['orders.read'],
          config: {},
          secrets: { api_key: 'holded_sec_12345678' }
        },
        idempotencyKey: '80000000-0000-4000-8000-000000000030',
        cookie: actors.installerCookie
      })
      const data = (await res!.json()) as { id: string }
      installationId = data.id
    })

    it('ejecuta despacho con scope concedido y registra métricas', async () => {
      const res = await call(`/api/admin/connectors/installations/${installationId}/dispatch`, {
        body: {
          operation: 'sync_orders',
          payload: { limit: 10 },
          requiredScope: 'orders.read'
        },
        cookie: actors.adminCookie
      })
      expect(res!.status).toBe(200)
      const data = (await res!.json()) as { status: string; latencyMs: number }
      expect(data.status).toBe('success')
      expect(data.latencyMs).toBeGreaterThanOrEqual(0)

      // Consultar endpoint de métricas
      const metricsRes = await call(`/api/admin/connectors/installations/${installationId}/metrics`, {
        cookie: actors.viewerCookie
      })
      expect(metricsRes!.status).toBe(200)
      const metrics = (await metricsRes!.json()) as {
        summary: { totalInvocations: number; successCount: number; errorRate: number }
        recentEvents: unknown[]
      }
      expect(metrics.summary.totalInvocations).toBe(1)
      expect(metrics.summary.successCount).toBe(1)
      expect(metrics.summary.errorRate).toBe(0)
    })

    it('rechaza despacho si falta el scope necesario en los granted_scopes', async () => {
      // Intentar ejecutar con requiredScope inventory.write (que no fue concedido)
      const res = await call(`/api/admin/connectors/installations/${installationId}/dispatch`, {
        body: {
          operation: 'update_stock',
          payload: { sku: 'PROD-1', quantity: 50 },
          requiredScope: 'inventory.write'
        },
        cookie: actors.adminCookie
      })
      expect(res!.status).toBe(403)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('missing_scope')
    })

    it('rechaza despacho si el conector está pausado', async () => {
      // Pausar
      await call(`/api/admin/connectors/installations/${installationId}/configure`, {
        body: { action: 'pause', expectedVersion: 1 },
        idempotencyKey: '80000000-0000-4000-8000-000000000031',
        cookie: actors.installerCookie
      })

      const res = await call(`/api/admin/connectors/installations/${installationId}/dispatch`, {
        body: {
          operation: 'sync_orders',
          payload: {},
          requiredScope: 'orders.read'
        },
        cookie: actors.adminCookie
      })
      expect(res!.status).toBe(409)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('connector_paused')
    })
  })

  describe('6. Desinstalación limpia (Clean Uninstallation)', () => {
    let installationId: string

    beforeEach(async () => {
      const res = await call('/api/admin/connectors/installations', {
        body: {
          connectorId: 'erp-holded',
          displayName: 'Holded para Desinstalar',
          grantedScopes: ['orders.read'],
          config: { active: true },
          secrets: { api_key: 'sk_live_erase_me_cleanly_1234' }
        },
        idempotencyKey: '80000000-0000-4000-8000-000000000040',
        cookie: actors.installerCookie
      })
      const data = (await res!.json()) as { id: string }
      installationId = data.id
    })

    it('ejecuta desinstalación limpia completa: elimina secretos, revoca scopes y registra auditoría', async () => {
      // Verificar que el secreto existe antes
      const secretBefore = sqlite
        .prepare('SELECT count(*) AS count FROM connector_secrets WHERE installation_id = ?')
        .get(installationId) as { count: number }
      expect(secretBefore.count).toBe(1)

      const uninstallRes = await call(`/api/admin/connectors/installations/${installationId}/uninstall`, {
        body: { action: 'uninstall', expectedVersion: 1, reason: 'Migración a otro conector' },
        idempotencyKey: '80000000-0000-4000-8000-000000000041',
        cookie: actors.installerCookie
      })
      expect(uninstallRes!.status).toBe(200)
      const result = (await uninstallRes!.json()) as {
        status: string
        uninstalledAt: string
        secretsWiped: number
      }
      expect(result.status).toBe('uninstalled')
      expect(result.secretsWiped).toBe(1)

      // Comprobar que en DB los secretos fueron totalmente destruidos (desinstalación limpia)
      const secretAfter = sqlite
        .prepare('SELECT count(*) AS count FROM connector_secrets WHERE installation_id = ?')
        .get(installationId) as { count: number }
      expect(secretAfter.count).toBe(0)

      // Comprobar que granted_scopes fue revocado a []
      const instRow = sqlite
        .prepare(
          'SELECT status, granted_scopes, uninstalled_at, uninstalled_by FROM connector_installations WHERE id = ?'
        )
        .get(installationId) as {
        status: string
        granted_scopes: string
        uninstalled_at: string
        uninstalled_by: string
      }
      expect(instRow.status).toBe('uninstalled')
      expect(instRow.granted_scopes).toBe('[]')
      expect(instRow.uninstalled_at).toBe(FIXTURE_NOW)

      // Comprobar auditoría append-only
      const audit = sqlite
        .prepare('SELECT action FROM connector_audit_events WHERE resource_id = ? AND action = ?')
        .get(installationId, 'uninstall') as { action: string }
      expect(audit).toBeDefined()
    })

    it('impide invocar / despachar sobre conector desinstalado (410 Gone)', async () => {
      await call(`/api/admin/connectors/installations/${installationId}/uninstall`, {
        body: { action: 'uninstall', expectedVersion: 1 },
        idempotencyKey: '80000000-0000-4000-8000-000000000042',
        cookie: actors.installerCookie
      })

      const res = await call(`/api/admin/connectors/installations/${installationId}/dispatch`, {
        body: {
          operation: 'sync_orders',
          payload: {},
          requiredScope: 'orders.read'
        },
        cookie: actors.adminCookie
      })
      expect(res!.status).toBe(410)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('connector_uninstalled')
    })

    it('rechaza desinstalar un conector que ya fue desinstalado (409 Conflict)', async () => {
      await call(`/api/admin/connectors/installations/${installationId}/uninstall`, {
        body: { action: 'uninstall', expectedVersion: 1 },
        idempotencyKey: '80000000-0000-4000-8000-000000000043',
        cookie: actors.installerCookie
      })

      const res2 = await call(`/api/admin/connectors/installations/${installationId}/uninstall`, {
        body: { action: 'uninstall', expectedVersion: 2 },
        idempotencyKey: '80000000-0000-4000-8000-000000000044',
        cookie: actors.installerCookie
      })
      expect(res2!.status).toBe(409)
      const err = (await res2!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('already_uninstalled')
    })
  })

  describe('7. Seguridad, Autorización viva, Idempotencia y Bordes', () => {
    it('rechaza sin cookie de sesión (401 unauthenticated)', async () => {
      const res = await call('/api/admin/connectors/catalog', { cookie: '' })
      expect(res!.status).toBe(401)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('unauthenticated')
    })

    it('rechaza si falta MFA en operaciones mutantes (403 mfa_required)', async () => {
      const res = await call('/api/admin/connectors/installations', {
        body: {
          connectorId: 'erp-holded',
          displayName: 'Holded MFA Fail',
          grantedScopes: ['orders.read'],
          config: {},
          secrets: { api_key: 'sk_live_mfa_test_1234' }
        },
        idempotencyKey: '70000000-0000-4000-8000-000000000001',
        cookie: actors.nomfaCookie
      })
      expect(res!.status).toBe(403)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('mfa_required')
    })

    it('rechaza origen cruzado (CSRF protection) (403 csrf_rejected)', async () => {
      const res = await call('/api/admin/connectors/catalog', {
        origin: 'https://attacker.site',
        cookie: actors.adminCookie
      })
      expect(res!.status).toBe(403)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('csrf_rejected')
    })

    it('rechaza sec-fetch-site cross-site', async () => {
      const res = await call('/api/admin/connectors/catalog', {
        secFetchSite: 'cross-site',
        cookie: actors.adminCookie
      })
      expect(res!.status).toBe(403)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('csrf_rejected')
    })

    it('requiere cabecera idempotency-key UUID en mutaciones', async () => {
      const res = await call('/api/admin/connectors/installations', {
        body: {
          connectorId: 'erp-holded',
          displayName: 'Holded Sin Idempotency',
          grantedScopes: ['orders.read'],
          config: {},
          secrets: {}
        },
        idempotencyKey: 'clave-no-uuid',
        cookie: actors.installerCookie
      })
      expect(res!.status).toBe(400)
      const err = (await res!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('invalid_idempotency_key')
    })

    it('reintento con misma idempotency-key y mismo payload devuelve respuesta idéntica', async () => {
      const payload = {
        connectorId: 'erp-holded',
        displayName: 'Holded Idempotente',
        grantedScopes: ['orders.read'],
        config: { poll: true },
        secrets: { api_key: 'sk_live_same_key_test_1234' }
      }
      const key = '70000000-0000-4000-8000-000000000002'

      const first = await call('/api/admin/connectors/installations', {
        body: payload,
        idempotencyKey: key,
        cookie: actors.installerCookie
      })
      expect(first!.status).toBe(201)
      const data1 = (await first!.json()) as { id: string }

      const retry = await call('/api/admin/connectors/installations', {
        body: payload,
        idempotencyKey: key,
        cookie: actors.installerCookie
      })
      expect(retry!.status).toBe(200)
      const data2 = (await retry!.json()) as { id: string }
      expect(data2.id).toBe(data1.id)

      // No se duplicó en DB
      const count = sqlite
        .prepare('SELECT count(*) AS n FROM connector_installations WHERE display_name = ?')
        .get('Holded Idempotente') as { n: number }
      expect(count.n).toBe(1)
    })

    it('reintento con misma idempotency-key pero payload alterado da conflicto (409)', async () => {
      const key = '70000000-0000-4000-8000-000000000003'
      await call('/api/admin/connectors/installations', {
        body: {
          connectorId: 'carrier-correos-express',
          displayName: 'Correos Primer Payload',
          grantedScopes: ['shipping.read'],
          config: {},
          secrets: { api_key: 'correos_key_first_1234' }
        },
        idempotencyKey: key,
        cookie: actors.installerCookie
      })

      const conflicting = await call('/api/admin/connectors/installations', {
        body: {
          connectorId: 'carrier-correos-express',
          displayName: 'Correos Payload Modificado', // diferente!
          grantedScopes: ['shipping.read'],
          config: {},
          secrets: { api_key: 'correos_key_first_1234' }
        },
        idempotencyKey: key,
        cookie: actors.installerCookie
      })
      expect(conflicting!.status).toBe(409)
      const err = (await conflicting!.json()) as { error: { code: string } }
      expect(err.error.code).toBe('idempotency_conflict')
    })

    it('previene traversal de URI y desnormalizaciones de URL', async () => {
      const res = await call('/api/admin/%2e%2e/connectors/catalog', { cookie: actors.adminCookie })
      expect(res).toBeNull() // no coincide con el namespace
    })
  })
})
