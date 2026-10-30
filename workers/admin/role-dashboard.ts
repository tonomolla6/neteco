import {
  getDefaultWidgetsForRole,
  validateMandatoryAlertInvariants,
  type RoleDashboardConfig,
  type RoleDashboardWidgetConfig,
  type RoleSavedView
} from '../../shared/role-dashboard-config'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { sha256Hex } from '../catalog/inventory'

export class RoleDashboardError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'RoleDashboardError'
  }
}

async function verifyDashboardPermission(db: D1Database, actorId: string, now: string): Promise<void> {
  const session = await db
    .prepare(
      'SELECT id, session_version FROM auth_sessions WHERE identity_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC'
    )
    .bind(actorId)
    .first<{ id: string; session_version: number }>()

  const claims: VerifiedSessionClaims = {
    sessionId: session?.id ?? '20000000-0000-4000-8000-000000000001',
    identityId: actorId,
    sessionVersion: session?.session_version ?? 1
  }

  const primary = await authorizeD1Session(db, claims, 'dashboard.configure', { now, requireMfa: false })
  if (primary.allowed) return

  const fallback = await authorizeD1Session(db, claims, 'administration.manage', { now, requireMfa: false })
  if (!fallback.allowed) {
    throw new RoleDashboardError('forbidden')
  }
}

export async function getRoleDashboardConfig(
  db: D1Database,
  options: { actorId: string; roleCode: string; now?: string }
): Promise<RoleDashboardConfig> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyDashboardPermission(db, options.actorId, now)

  const row = await db
    .prepare(
      'SELECT id, role_code, widget_layout_json, column_preferences_json, version, updated_at, updated_by FROM admin_role_dashboards WHERE role_code = ?1'
    )
    .bind(options.roleCode)
    .first<{
      id: string
      role_code: string
      widget_layout_json: string
      column_preferences_json: string
      version: number
      updated_at: string
      updated_by: string
    }>()

  if (!row) {
    const defaultWidgets = getDefaultWidgetsForRole(options.roleCode)
    return {
      roleCode: options.roleCode,
      widgets: defaultWidgets,
      columnPreferences: {},
      version: 0
    }
  }

  const widgets = JSON.parse(row.widget_layout_json) as RoleDashboardWidgetConfig[]
  // Guarantee mandatory alerts integrity even on read
  validateMandatoryAlertInvariants(widgets)

  return {
    roleCode: row.role_code,
    widgets,
    columnPreferences: JSON.parse(row.column_preferences_json) as Record<string, string[]>,
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  }
}

export async function updateRoleDashboardConfig(
  db: D1Database,
  options: {
    commandId: string
    actorId: string
    roleCode: string
    expectedVersion: number
    widgets: RoleDashboardWidgetConfig[]
    columnPreferences: Record<string, string[]>
    now?: string
  }
): Promise<RoleDashboardConfig> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyDashboardPermission(db, options.actorId, now)

  // 1. Strictly enforce mandatory alert invariants
  try {
    validateMandatoryAlertInvariants(options.widgets)
  } catch (err) {
    if (err instanceof Error) {
      throw new RoleDashboardError(err.message)
    }
    throw err
  }

  // 2. Idempotency check
  const payloadHash = await sha256Hex(
    JSON.stringify({
      roleCode: options.roleCode,
      widgets: options.widgets,
      columnPreferences: options.columnPreferences
    })
  )

  const existingCmd = await db
    .prepare('SELECT payload_hash FROM admin_dashboard_commands WHERE command_id = ?1')
    .bind(options.commandId)
    .first<{ payload_hash: string }>()

  if (existingCmd) {
    if (existingCmd.payload_hash !== payloadHash) {
      throw new RoleDashboardError('command_id_conflict')
    }
    return getRoleDashboardConfig(db, { actorId: options.actorId, roleCode: options.roleCode, now })
  }

  // 3. Current version check (CAS)
  const existing = await db
    .prepare('SELECT id, version FROM admin_role_dashboards WHERE role_code = ?1')
    .bind(options.roleCode)
    .first<{ id: string; version: number }>()

  const currentVersion = existing ? existing.version : 0
  if (currentVersion !== options.expectedVersion) {
    throw new RoleDashboardError('dashboard_version_conflict')
  }

  const nextVersion = currentVersion + 1
  const id = existing ? existing.id : crypto.randomUUID()

  // 4. Update or Insert
  if (existing) {
    await db
      .prepare(
        `
        UPDATE admin_role_dashboards
        SET widget_layout_json = ?1, column_preferences_json = ?2, version = ?3, updated_at = ?4, updated_by = ?5
        WHERE id = ?6
      `
      )
      .bind(
        JSON.stringify(options.widgets),
        JSON.stringify(options.columnPreferences),
        nextVersion,
        now,
        options.actorId,
        id
      )
      .run()
  } else {
    await db
      .prepare(
        `
        INSERT INTO admin_role_dashboards (id, role_code, widget_layout_json, column_preferences_json, version, created_at, updated_at, updated_by)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      `
      )
      .bind(
        id,
        options.roleCode,
        JSON.stringify(options.widgets),
        JSON.stringify(options.columnPreferences),
        nextVersion,
        now,
        now,
        options.actorId
      )
      .run()
  }

  // 5. Append-only command log
  await db
    .prepare(
      `
      INSERT INTO admin_dashboard_commands (id, command_id, actor_id, action, target_id, payload_hash, payload_json, created_at)
      VALUES (?1, ?2, ?3, 'save_role_dashboard', ?4, ?5, ?6, ?7)
    `
    )
    .bind(
      crypto.randomUUID(),
      options.commandId,
      options.actorId,
      options.roleCode,
      payloadHash,
      JSON.stringify({ widgets: options.widgets, columnPreferences: options.columnPreferences }),
      now
    )
    .run()

  return {
    roleCode: options.roleCode,
    widgets: options.widgets,
    columnPreferences: options.columnPreferences,
    version: nextVersion,
    updatedAt: now,
    updatedBy: options.actorId
  }
}

export async function saveRoleSavedView(
  db: D1Database,
  options: {
    commandId: string
    actorId: string
    viewId?: string
    roleCode?: string
    viewType: 'orders' | 'catalog' | 'campaigns' | 'inventory' | 'alerts'
    name: string
    scope: 'role_shared' | 'personal'
    isDefault?: boolean
    definition: Record<string, unknown>
    expectedVersion?: number
    now?: string
  }
): Promise<RoleSavedView> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyDashboardPermission(db, options.actorId, now)

  const viewId = options.viewId ?? crypto.randomUUID()
  const isDefault = options.isDefault ? 1 : 0

  if (isDefault === 1 && options.roleCode) {
    // Reset other defaults for same role & type
    await db
      .prepare('UPDATE admin_role_saved_views SET is_default = 0 WHERE view_type = ?1 AND role_code = ?2')
      .bind(options.viewType, options.roleCode)
      .run()
  }

  const existing = await db
    .prepare('SELECT id, version FROM admin_role_saved_views WHERE id = ?1')
    .bind(viewId)
    .first<{ id: string; version: number }>()

  let nextVersion = 1
  if (existing) {
    if (options.expectedVersion !== undefined && existing.version !== options.expectedVersion) {
      throw new RoleDashboardError('view_version_conflict')
    }
    nextVersion = existing.version + 1
    await db
      .prepare(
        `
        UPDATE admin_role_saved_views
        SET name = ?1, is_default = ?2, scope = ?3, definition_json = ?4, version = ?5, updated_at = ?6
        WHERE id = ?7
      `
      )
      .bind(options.name, isDefault, options.scope, JSON.stringify(options.definition), nextVersion, now, viewId)
      .run()
  } else {
    await db
      .prepare(
        `
        INSERT INTO admin_role_saved_views (id, role_code, owner_id, view_type, name, is_default, scope, definition_json, version, archived, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 0, ?9, ?10)
      `
      )
      .bind(
        viewId,
        options.roleCode ?? null,
        options.actorId,
        options.viewType,
        options.name,
        isDefault,
        options.scope,
        JSON.stringify(options.definition),
        now,
        now
      )
      .run()
  }

  return {
    id: viewId,
    roleCode: options.roleCode,
    ownerId: options.actorId,
    viewType: options.viewType,
    name: options.name,
    isDefault: Boolean(isDefault),
    scope: options.scope,
    definition: options.definition,
    version: nextVersion,
    createdAt: now,
    updatedAt: now
  }
}

export async function listRoleSavedViews(
  db: D1Database,
  options: {
    actorId: string
    roleCode: string
    viewType: 'orders' | 'catalog' | 'campaigns' | 'inventory' | 'alerts'
    now?: string
  }
): Promise<RoleSavedView[]> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyDashboardPermission(db, options.actorId, now)

  const { results } = await db
    .prepare(
      `
      SELECT id, role_code, owner_id, view_type, name, is_default, scope, definition_json, version, created_at, updated_at
      FROM admin_role_saved_views
      WHERE view_type = ?1 AND archived = 0 AND (role_code = ?2 OR owner_id = ?3)
      ORDER BY is_default DESC, name ASC
    `
    )
    .bind(options.viewType, options.roleCode, options.actorId)
    .all<{
      id: string
      role_code: string | null
      owner_id: string | null
      view_type: 'orders' | 'catalog' | 'campaigns' | 'inventory' | 'alerts'
      name: string
      is_default: number
      scope: 'role_shared' | 'personal'
      definition_json: string
      version: number
      created_at: string
      updated_at: string
    }>()

  return (results ?? []).map((r) => ({
    id: r.id,
    roleCode: r.role_code,
    ownerId: r.owner_id,
    viewType: r.view_type,
    name: r.name,
    isDefault: Boolean(r.is_default),
    scope: r.scope,
    definition: JSON.parse(r.definition_json) as Record<string, unknown>,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export async function archiveRoleSavedView(
  db: D1Database,
  options: { commandId: string; actorId: string; viewId: string; expectedVersion: number; now?: string }
): Promise<{ archived: true; id: string }> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyDashboardPermission(db, options.actorId, now)

  const existing = await db
    .prepare('SELECT id, version FROM admin_role_saved_views WHERE id = ?1 AND archived = 0')
    .bind(options.viewId)
    .first<{ id: string; version: number }>()

  if (!existing) {
    throw new RoleDashboardError('view_not_found')
  }

  if (existing.version !== options.expectedVersion) {
    throw new RoleDashboardError('view_version_conflict')
  }

  await db
    .prepare('UPDATE admin_role_saved_views SET archived = 1, version = version + 1, updated_at = ?1 WHERE id = ?2')
    .bind(now, options.viewId)
    .run()

  return { archived: true, id: options.viewId }
}
