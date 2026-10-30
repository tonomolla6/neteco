import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminConnectorsMarketplace from '../../app/components/AdminConnectorsMarketplace.vue'
import '#app/nuxt-vitest-app-entry'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => request)

const mockCatalog = [
  {
    id: 'erp-holded',
    name: 'Holded ERP Connector',
    category: 'erp',
    description: 'Sincronización oficial de pedidos y existencias con Holded.',
    version: '1.2.0',
    provider_type: 'internal_adapter',
    allowed_scopes: ['orders.read', 'inventory.read'],
    config_schema_json: { declaredSecrets: ['api_key'] },
    governance_status: 'approved'
  },
  {
    id: 'crm-hubspot-draft',
    name: 'HubSpot CRM Sync',
    category: 'crm',
    description: 'Integración CRM de contactos comerciales B2B.',
    version: '0.9.0',
    provider_type: 'rest_sync',
    allowed_scopes: ['customers.read_masked'],
    config_schema_json: { declaredSecrets: ['client_secret'] },
    governance_status: 'in_review'
  }
]

const mockInstallations = [
  {
    id: '80000000-0000-4000-8000-000000000001',
    connector_id: 'erp-holded',
    connector_name: 'Holded ERP Connector',
    category: 'erp',
    provider_type: 'internal_adapter',
    display_name: 'Holded Producción',
    status: 'active',
    granted_scopes: ['orders.read'],
    config_json: {},
    version: 1,
    secrets: [{ secretKey: 'api_key', maskedPreview: 'sk_••••••1234', version: 1 }],
    installed_at: '2026-10-29T10:00:00Z'
  }
]

describe('AdminConnectorsMarketplace component (INT-023)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('muestra estado de carga mientras se obtienen los datos', async () => {
    request.mockImplementation(() => new Promise(() => {})) // nunca resuelve inmediatamente
    const wrapper = await mountSuspended(AdminConnectorsMarketplace)
    expect(wrapper.find('[role="status"]').text()).toContain('Cargando marketplace de conectores')
  })

  it('muestra estado de error accesible con botón para reintentar', async () => {
    request.mockRejectedValueOnce({ data: { error: { code: 'service_unavailable' } } })
    const wrapper = await mountSuspended(AdminConnectorsMarketplace)
    await flushPromises()

    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('service_unavailable')

    // Reintentar
    request.mockImplementation(async (url: string) => {
      if (url.includes('/catalog')) return { items: mockCatalog }
      if (url.includes('/installations')) return { items: mockInstallations }
      return {}
    })
    const retryBtn = alert.find('button')
    await retryBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Holded ERP Connector')
  })

  it('renderiza catálogo gobernado con badges de estado y botones de instalación', async () => {
    request.mockImplementation(async (url: string) => {
      if (url.includes('/catalog')) return { items: mockCatalog }
      if (url.includes('/installations')) return { items: mockInstallations }
      return {}
    })
    const wrapper = await mountSuspended(AdminConnectorsMarketplace)
    await flushPromises()

    expect(wrapper.text()).toContain('Holded ERP Connector')
    expect(wrapper.text()).toContain('HubSpot CRM Sync')

    // Conector aprobado muestra botón de instalar
    const installButtons = wrapper.findAll('button').filter((b) => b.text().includes('Instalar Conector'))
    expect(installButtons.length).toBe(1)

    // Conector en revisión no muestra botón de instalar
    expect(wrapper.text()).toContain('Pendiente de aprobación')
  })

  it('filtra por búsqueda de texto y por categoría', async () => {
    request.mockImplementation(async (url: string) => {
      if (url.includes('/catalog')) return { items: mockCatalog }
      if (url.includes('/installations')) return { items: mockInstallations }
      return {}
    })
    const wrapper = await mountSuspended(AdminConnectorsMarketplace)
    await flushPromises()

    const searchInput = wrapper.find('input[type="search"]')
    await searchInput.setValue('Holded')
    await flushPromises()

    expect(wrapper.text()).toContain('Holded ERP Connector')
    expect(wrapper.text()).not.toContain('HubSpot CRM Sync')

    await searchInput.setValue('Inexistente')
    await flushPromises()
    expect(wrapper.text()).toContain('No hay conectores disponibles')
  })

  it('conmuta a la pestaña de conectores instalados y muestra credenciales enmascaradas', async () => {
    request.mockImplementation(async (url: string) => {
      if (url.includes('/catalog')) return { items: mockCatalog }
      if (url.includes('/installations')) return { items: mockInstallations }
      return {}
    })
    const wrapper = await mountSuspended(AdminConnectorsMarketplace)
    await flushPromises()

    const tabs = wrapper.findAll('nav button')
    const installedTab = tabs.find((b) => b.text().includes('Conectores Instalados'))
    expect(installedTab).toBeDefined()
    await installedTab!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Holded Producción')
    expect(wrapper.text()).toContain('sk_••••••1234')
    expect(wrapper.text()).toContain('Activo')
  })

  it('abre diálogo de telemetría y muestra métricas agregadas', async () => {
    request.mockImplementation(async (url: string) => {
      if (url.includes('/metrics')) {
        return {
          summary: {
            totalInvocations: 15,
            successCount: 15,
            errorCount: 0,
            errorRate: 0,
            avgLatencyMs: 25,
            p95LatencyMs: 40,
            minLatencyMs: 10,
            maxLatencyMs: 50,
            lastInvokedAt: '2026-10-29T11:00:00Z',
            lastSuccessAt: '2026-10-29T11:00:00Z',
            lastErrorAt: null,
            lastErrorCode: null
          }
        }
      }
      if (url.includes('/catalog')) return { items: mockCatalog }
      if (url.includes('/installations')) return { items: mockInstallations }
      return {}
    })
    const wrapper = await mountSuspended(AdminConnectorsMarketplace)
    await flushPromises()

    // Ir a instalados
    const tabs = wrapper.findAll('nav button')
    await tabs[1]!.trigger('click')
    await flushPromises()

    const metricsBtn = wrapper.findAll('button').find((b) => b.text().includes('Telemetría & Métricas'))
    expect(metricsBtn).toBeDefined()
    await metricsBtn!.trigger('click')
    await flushPromises()

    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('Telemetría: Holded Producción')
    expect(dialog.text()).toContain('15')
    expect(dialog.text()).toContain('40 ms')
  })

  it('abre modal de desinstalación limpia con advertencia de purga de secretos', async () => {
    request.mockImplementation(async (url: string) => {
      if (url.includes('/catalog')) return { items: mockCatalog }
      if (url.includes('/installations')) return { items: mockInstallations }
      return {}
    })
    const wrapper = await mountSuspended(AdminConnectorsMarketplace)
    await flushPromises()

    // Ir a instalados
    const tabs = wrapper.findAll('nav button')
    await tabs[1]!.trigger('click')
    await flushPromises()

    const uninstallBtn = wrapper.findAll('button').find((b) => b.text().includes('Desinstalación Limpia'))
    expect(uninstallBtn).toBeDefined()
    await uninstallBtn!.trigger('click')
    await flushPromises()

    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.text()).toContain('destruirá todos los secretos')
    expect(dialog.find('button.bg-red-600').text()).toContain('Confirmar y Purgar Secretos')
  })
})
