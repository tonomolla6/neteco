import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createBaTestWorld,
  ADMIN_IDENTITY,
  ORDER_MGR_IDENTITY,
  UNPRIVILEGED_IDENTITY,
  FIXTURE_NOW,
  type BaTestWorld
} from './d1-ba-preview-diff-fixtures'
import {
  getRoleDashboardConfig,
  updateRoleDashboardConfig,
  saveRoleSavedView,
  listRoleSavedViews,
  archiveRoleSavedView,
  RoleDashboardError
} from '../../workers/admin/role-dashboard'
import { MANDATORY_WIDGET_IDS, type RoleDashboardWidgetConfig } from '../../shared/role-dashboard-config'

describe('ADM-025: Configurable dashboard by role with mandatory alert protection', () => {
  let world: BaTestWorld

  beforeEach(async () => {
    world = await createBaTestWorld()
  })

  afterEach(() => world.close())

  describe('getRoleDashboardConfig', () => {
    it('returns default layout for role including mandatory alerts enabled by default', async () => {
      const config = await getRoleDashboardConfig(world.db, {
        actorId: ORDER_MGR_IDENTITY,
        roleCode: 'order_manager',
        now: FIXTURE_NOW
      })

      expect(config.roleCode).toBe('order_manager')
      expect(config.widgets.length).toBeGreaterThan(0)

      // Verify mandatory widgets exist and are strictly visible
      for (const mandatoryId of MANDATORY_WIDGET_IDS) {
        const widget = config.widgets.find((w) => w.widgetId === mandatoryId)
        expect(widget).toBeDefined()
        expect(widget?.visible).toBe(true)
        expect(widget?.isMandatory).toBe(true)
      }
    })
  })

  describe('updateRoleDashboardConfig & Mandatory Alert Protection', () => {
    it('saves customized widget and column preferences when mandatory alerts are respected', async () => {
      const widgets: RoleDashboardWidgetConfig[] = [
        { widgetId: 'mandatory_alerts', visible: true, order: 1, colSpan: 12, isMandatory: true },
        { widgetId: 'orders_summary', visible: true, order: 2, colSpan: 6 },
        { widgetId: 'inventory_shortages', visible: false, order: 3, colSpan: 6 }
      ]

      const updated = await updateRoleDashboardConfig(world.db, {
        commandId: 'cmd-dashboard-config-001',
        actorId: ORDER_MGR_IDENTITY,
        roleCode: 'order_manager',
        expectedVersion: 0, // initial create
        widgets,
        columnPreferences: {
          ordersTable: ['createdAt', 'customer', 'total', 'paymentStatus']
        },
        now: FIXTURE_NOW
      })

      expect(updated.version).toBe(1)
      expect(updated.widgets.find((w) => w.widgetId === 'orders_summary')?.visible).toBe(true)
      expect(updated.widgets.find((w) => w.widgetId === 'inventory_shortages')?.visible).toBe(false)
      expect(updated.columnPreferences.ordersTable).toContain('total')
    })

    it('STRICTLY REJECTS attempts to hide or disable mandatory alerts', async () => {
      const maliciousWidgets: RoleDashboardWidgetConfig[] = [
        // Attempt to hide mandatory alerts
        { widgetId: 'mandatory_alerts', visible: false, order: 1, colSpan: 12, isMandatory: true },
        { widgetId: 'orders_summary', visible: true, order: 2, colSpan: 12 }
      ]

      await expect(
        updateRoleDashboardConfig(world.db, {
          commandId: 'cmd-dashboard-config-malicious',
          actorId: ORDER_MGR_IDENTITY,
          roleCode: 'order_manager',
          expectedVersion: 0,
          widgets: maliciousWidgets,
          columnPreferences: {},
          now: FIXTURE_NOW
        })
      ).rejects.toThrow('mandatory_alerts_cannot_be_hidden')
    })

    it('STRICTLY REJECTS omitting mandatory alert widget from the layout payload', async () => {
      const omittedWidgets: RoleDashboardWidgetConfig[] = [
        // Mandatory alert widget completely missing
        { widgetId: 'orders_summary', visible: true, order: 1, colSpan: 12 }
      ]

      await expect(
        updateRoleDashboardConfig(world.db, {
          commandId: 'cmd-dashboard-config-omitted',
          actorId: ORDER_MGR_IDENTITY,
          roleCode: 'order_manager',
          expectedVersion: 0,
          widgets: omittedWidgets,
          columnPreferences: {},
          now: FIXTURE_NOW
        })
      ).rejects.toThrow('mandatory_alerts_required')
    })

    it('enforces CAS version concurrency control on concurrent updates', async () => {
      const baseWidgets: RoleDashboardWidgetConfig[] = [
        { widgetId: 'mandatory_alerts', visible: true, order: 1, colSpan: 12, isMandatory: true },
        { widgetId: 'orders_summary', visible: true, order: 2, colSpan: 12 }
      ]

      // Step 1: create v1
      await updateRoleDashboardConfig(world.db, {
        commandId: 'cmd-cas-1',
        actorId: ADMIN_IDENTITY,
        roleCode: 'admin',
        expectedVersion: 0,
        widgets: baseWidgets,
        columnPreferences: {},
        now: FIXTURE_NOW
      })

      // Step 2: update with expectedVersion: 1 -> succeeds
      await updateRoleDashboardConfig(world.db, {
        commandId: 'cmd-cas-2',
        actorId: ADMIN_IDENTITY,
        roleCode: 'admin',
        expectedVersion: 1,
        widgets: baseWidgets,
        columnPreferences: { ordersTable: ['customer'] },
        now: FIXTURE_NOW
      })

      // Step 3: stale update with expectedVersion: 1 -> fails CAS!
      await expect(
        updateRoleDashboardConfig(world.db, {
          commandId: 'cmd-cas-3',
          actorId: ADMIN_IDENTITY,
          roleCode: 'admin',
          expectedVersion: 1, // stale!
          widgets: baseWidgets,
          columnPreferences: {},
          now: FIXTURE_NOW
        })
      ).rejects.toThrow('dashboard_version_conflict')
    })
  })

  describe('Saved Views by Role and Scope', () => {
    it('creates, updates and lists role-shared and personal saved views', async () => {
      const view = await saveRoleSavedView(world.db, {
        commandId: 'cmd-view-01',
        actorId: ORDER_MGR_IDENTITY,
        roleCode: 'order_manager',
        viewType: 'orders',
        name: 'Pedidos Urgentes Químicos',
        scope: 'role_shared',
        isDefault: true,
        definition: {
          bucket: 'por_preparar',
          filters: { shippingMethod: 'own_delivery' },
          columns: ['createdAt', 'customer', 'total', 'shippingMethod'],
          sortKey: 'createdAt',
          sortDir: 'desc'
        },
        now: FIXTURE_NOW
      })

      expect(view.id).toBeDefined()
      expect(view.name).toBe('Pedidos Urgentes Químicos')
      expect(view.isDefault).toBe(true)

      const views = await listRoleSavedViews(world.db, {
        actorId: ORDER_MGR_IDENTITY,
        roleCode: 'order_manager',
        viewType: 'orders',
        now: FIXTURE_NOW
      })

      expect(views.length).toBe(1)
      expect(views[0].name).toBe('Pedidos Urgentes Químicos')

      // Archive view
      const archived = await archiveRoleSavedView(world.db, {
        commandId: 'cmd-archive-view-01',
        actorId: ORDER_MGR_IDENTITY,
        viewId: view.id,
        expectedVersion: view.version,
        now: FIXTURE_NOW
      })
      expect(archived.archived).toBe(true)

      const remainingViews = await listRoleSavedViews(world.db, {
        actorId: ORDER_MGR_IDENTITY,
        roleCode: 'order_manager',
        viewType: 'orders',
        now: FIXTURE_NOW
      })
      expect(remainingViews.length).toBe(0)
    })
  })

  describe('Authorization checks', () => {
    it('denies unprivileged user without dashboard.configure or administration.manage', async () => {
      await expect(
        updateRoleDashboardConfig(world.db, {
          commandId: 'cmd-unauth-01',
          actorId: UNPRIVILEGED_IDENTITY,
          roleCode: 'order_manager',
          expectedVersion: 0,
          widgets: [{ widgetId: 'mandatory_alerts', visible: true, order: 1, colSpan: 12, isMandatory: true }],
          columnPreferences: {},
          now: FIXTURE_NOW
        })
      ).rejects.toThrow(RoleDashboardError)
    })
  })
})
