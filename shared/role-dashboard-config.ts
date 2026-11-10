import { z } from 'zod'

export const MANDATORY_WIDGET_IDS = ['mandatory_alerts', 'operational_critical_alerts'] as const

export const SYSTEM_ROLE_CODES = [
  'admin',
  'content_manager',
  'order_manager',
  'warehouse_operator',
  'marketing_manager',
  'support_agent',
  'finance_analyst'
] as const

export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number]

export interface RoleDashboardWidgetConfig {
  widgetId: string
  visible: boolean
  order: number
  colSpan: number
  isMandatory?: boolean
  config?: Record<string, unknown>
}

export interface RoleDashboardConfig {
  roleCode: string
  widgets: RoleDashboardWidgetConfig[]
  columnPreferences: Record<string, string[]>
  version: number
  updatedAt?: string
  updatedBy?: string
}

export interface RoleSavedView {
  id: string
  roleCode?: string | null
  ownerId?: string | null
  viewType: 'orders' | 'catalog' | 'campaigns' | 'inventory' | 'alerts'
  name: string
  isDefault: boolean
  scope: 'role_shared' | 'personal'
  definition: Record<string, unknown>
  version: number
  archived?: boolean
  createdAt?: string
  updatedAt?: string
}

export const roleDashboardWidgetSchema = z
  .object({
    widgetId: z.string().min(2).max(64),
    visible: z.boolean(),
    order: z.number().int().min(1).max(100),
    colSpan: z.number().int().min(1).max(12).default(12),
    isMandatory: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional()
  })
  .strict()

export const updateRoleDashboardInputSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    roleCode: z.string().min(2).max(64),
    expectedVersion: z.number().int().min(0),
    widgets: z.array(roleDashboardWidgetSchema).min(1).max(50),
    columnPreferences: z.record(z.string(), z.array(z.string().min(1).max(64))),
    now: z.string().optional()
  })
  .strict()

export const saveRoleSavedViewInputSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    viewId: z.string().uuid().optional(),
    roleCode: z.string().min(2).max(64).optional(),
    viewType: z.enum(['orders', 'catalog', 'campaigns', 'inventory', 'alerts']),
    name: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .refine((v) => !/[<>{}\\]/.test(v), 'Carácter no válido'),
    scope: z.enum(['role_shared', 'personal']),
    isDefault: z.boolean().default(false),
    definition: z.record(z.string(), z.unknown()),
    expectedVersion: z.number().int().min(0).optional(),
    now: z.string().optional()
  })
  .strict()

export function validateMandatoryAlertInvariants(widgets: RoleDashboardWidgetConfig[]): void {
  const map = new Map<string, RoleDashboardWidgetConfig>()
  for (const w of widgets) {
    map.set(w.widgetId, w)
  }

  // Mandatory alert MUST be present
  const primaryMandatory = map.get('mandatory_alerts')
  if (!primaryMandatory) {
    throw new Error('mandatory_alerts_required')
  }

  // All mandatory alerts present MUST have visible === true
  for (const mandatoryId of MANDATORY_WIDGET_IDS) {
    const item = map.get(mandatoryId)
    if (item && !item.visible) {
      throw new Error('mandatory_alerts_cannot_be_hidden')
    }
  }
}

export function getDefaultWidgetsForRole(roleCode: string): RoleDashboardWidgetConfig[] {
  const base: RoleDashboardWidgetConfig[] = [
    {
      widgetId: 'mandatory_alerts',
      visible: true,
      order: 1,
      colSpan: 12,
      isMandatory: true
    },
    {
      widgetId: 'operational_critical_alerts',
      visible: true,
      order: 2,
      colSpan: 12,
      isMandatory: true
    }
  ]

  switch (roleCode) {
    case 'order_manager':
      return [
        ...base,
        { widgetId: 'orders_summary', visible: true, order: 3, colSpan: 6 },
        { widgetId: 'orders_recent_table', visible: true, order: 4, colSpan: 6 },
        { widgetId: 'shipping_exceptions', visible: true, order: 5, colSpan: 12 }
      ]
    case 'warehouse_operator':
      return [
        ...base,
        { widgetId: 'inventory_shortages', visible: true, order: 3, colSpan: 6 },
        { widgetId: 'warehouse_telemetry', visible: true, order: 4, colSpan: 6 },
        { widgetId: 'urgent_pick_batches', visible: true, order: 5, colSpan: 12 }
      ]
    case 'marketing_manager':
      return [
        ...base,
        { widgetId: 'active_commercial_campaigns', visible: true, order: 3, colSpan: 6 },
        { widgetId: 'campaign_conflict_monitor', visible: true, order: 4, colSpan: 6 },
        { widgetId: 'commercial_calendar_widget', visible: true, order: 5, colSpan: 12 }
      ]
    default:
      return [
        ...base,
        { widgetId: 'orders_summary', visible: true, order: 3, colSpan: 4 },
        { widgetId: 'inventory_shortages', visible: true, order: 4, colSpan: 4 },
        { widgetId: 'active_commercial_campaigns', visible: true, order: 5, colSpan: 4 },
        { widgetId: 'system_health', visible: true, order: 6, colSpan: 12 }
      ]
  }
}
