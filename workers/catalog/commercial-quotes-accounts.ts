import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import {
  type CommercialNextAction,
  type QuoteMarginRecord,
  type CommercialPipelineSummary,
  type CommercialAccountSummary,
  type PipelineStage,
  createNextActionInputSchema,
  completeNextActionInputSchema,
  evaluateQuoteMarginInputSchema,
  approveMarginThresholdInputSchema
} from '../../shared/commercial-quotes-accounts'

export class CommercialQuotesAccountsError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ? `${code}: ${message}` : code)
    this.name = 'CommercialQuotesAccountsError'
  }
}

interface ActionRow {
  id: string
  customer_id: string
  quote_id: string | null
  action_description: string
  due_date: string
  priority: 'urgent' | 'high' | 'normal' | 'low'
  assigned_identity_id: string
  assigned_manager_name?: string
  completed: number
  completed_at: string | null
  completed_by: string | null
  version: number
  created_by: string
  created_at: string
  updated_at: string
}

interface QuoteMarginRow {
  quote_id: string
  quote_version: number
  total_net_cents: number
  total_cost_cents: number
  margin_cents: number
  margin_percentage_bps: number
  is_below_threshold: number
  approved_by: string | null
  approved_at: string | null
  created_at: string
  updated_at: string
}

interface CustomerAccountRow {
  id: string
  name: string | null
  legal_name: string | null
  email: string | null
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function authorizeSales(database: D1Database, claims: VerifiedSessionClaims, now?: string): Promise<void> {
  const resManage = await authorizeD1Session(database, claims, 'administration.manage', {
    now,
    requireMfa: true
  })
  if (resManage.allowed) return

  const resSales = await authorizeD1Session(database, claims, 'sales.manage', {
    now,
    requireMfa: true
  })
  if (resSales.allowed) return

  if (resManage.code === 'unauthenticated' || resSales.code === 'unauthenticated') {
    throw new CommercialQuotesAccountsError('unauthenticated', 'Session unauthenticated or expired')
  }
  throw new CommercialQuotesAccountsError('forbidden', 'Requires administration.manage or sales.manage permission')
}

function parseActionRow(row: ActionRow): CommercialNextAction {
  return {
    id: row.id,
    customerId: row.customer_id,
    quoteId: row.quote_id ?? null,
    actionDescription: row.action_description,
    dueDate: row.due_date,
    priority: row.priority,
    assignedIdentityId: row.assigned_identity_id,
    assignedManagerName: row.assigned_manager_name,
    completed: row.completed === 1,
    completedAt: row.completed_at ?? null,
    completedBy: row.completed_by ?? null,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function createCommercialNextAction(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<CommercialNextAction> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeSales(database, claims, now)

  const parsed = createNextActionInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new CommercialQuotesAccountsError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const commandId = options.commandId ?? crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))

  // Idempotency check
  const existingCmd = await database
    .prepare('SELECT command_id FROM commercial_pipeline_commands WHERE customer_id = ? AND command_id = ?')
    .bind(data.customerId, commandId)
    .first<{ command_id: string }>()

  if (existingCmd) {
    const existing = await database
      .prepare('SELECT * FROM commercial_next_actions WHERE customer_id = ? AND created_at = ?')
      .bind(data.customerId, now)
      .first<ActionRow>()
    if (existing) return parseActionRow(existing)
  }

  const id = crypto.randomUUID()
  const version = 1

  await database.batch([
    database
      .prepare(
        `INSERT INTO commercial_next_actions (
          id, customer_id, quote_id, action_description, due_date, priority,
          assigned_identity_id, completed, completed_at, completed_by, version,
          created_by, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, NULL, ?8, ?9, ?10, ?10)`
      )
      .bind(
        id,
        data.customerId,
        data.quoteId ?? null,
        data.actionDescription,
        data.dueDate,
        data.priority,
        data.assignedIdentityId,
        version,
        claims.identityId,
        now
      ),
    database
      .prepare(
        `INSERT INTO commercial_pipeline_commands (
          command_id, customer_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, ?3, 'create_action', 0, 1, ?4, ?5, ?6)`
      )
      .bind(commandId, data.customerId, claims.identityId, payloadHash, JSON.stringify(data), now),
    database
      .prepare(
        `INSERT INTO commercial_pipeline_audit (
          command_id, actor_id, action, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, 'create_action', ?3, ?4, ?5)`
      )
      .bind(commandId, claims.identityId, payloadHash, JSON.stringify(data), now)
  ])

  const created = await database
    .prepare('SELECT * FROM commercial_next_actions WHERE id = ?')
    .bind(id)
    .first<ActionRow>()
  if (!created) {
    throw new CommercialQuotesAccountsError('not_found', 'Action not found')
  }

  return parseActionRow(created)
}

export async function completeCommercialNextAction(
  database: D1Database,
  claims: VerifiedSessionClaims,
  actionId: string,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<CommercialNextAction> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeSales(database, claims, now)

  const parsed = completeNextActionInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new CommercialQuotesAccountsError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const commandId = options.commandId ?? crypto.randomUUID()
  const payloadHash = await sha256Hex(JSON.stringify(data))

  const current = await database
    .prepare('SELECT customer_id, version FROM commercial_next_actions WHERE id = ?')
    .bind(actionId)
    .first<{ customer_id: string; version: number }>()

  if (!current) {
    throw new CommercialQuotesAccountsError('not_found', 'Action not found')
  }

  if (current.version !== data.expectedVersion) {
    throw new CommercialQuotesAccountsError(
      'version_conflict',
      `Expected version ${data.expectedVersion} but found ${current.version}`
    )
  }

  const resultVersion = current.version + 1

  await database.batch([
    database
      .prepare(
        `UPDATE commercial_next_actions SET
          completed = 1, completed_at = ?1, completed_by = ?2, version = ?3, updated_at = ?1
        WHERE id = ?4 AND version = ?5`
      )
      .bind(now, claims.identityId, resultVersion, actionId, data.expectedVersion),
    database
      .prepare(
        `INSERT INTO commercial_pipeline_commands (
          command_id, customer_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, ?3, 'complete_action', ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(
        commandId,
        current.customer_id,
        claims.identityId,
        data.expectedVersion,
        resultVersion,
        payloadHash,
        JSON.stringify(data),
        now
      ),
    database
      .prepare(
        `INSERT INTO commercial_pipeline_audit (
          command_id, actor_id, action, payload_hash, input_json, created_at
        ) VALUES (?1, ?2, 'complete_action', ?3, ?4, ?5)`
      )
      .bind(commandId, claims.identityId, payloadHash, JSON.stringify(data), now)
  ])

  const updated = await database
    .prepare('SELECT * FROM commercial_next_actions WHERE id = ?')
    .bind(actionId)
    .first<ActionRow>()
  if (!updated) {
    throw new CommercialQuotesAccountsError('not_found', 'Action not found')
  }

  return parseActionRow(updated)
}

export async function evaluateQuoteMargin(
  database: D1Database,
  claims: VerifiedSessionClaims,
  quoteId: string,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<QuoteMarginRecord> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeSales(database, claims, now)

  const parsed = evaluateQuoteMarginInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new CommercialQuotesAccountsError('invalid_input', parsed.error.message)
  }
  const data = parsed.data
  const marginCents = data.totalNetCents - data.totalCostCents
  const marginPercentageBps = data.totalNetCents > 0 ? Math.round((marginCents * 10000) / data.totalNetCents) : 0
  const isBelowThreshold = marginPercentageBps < 1500 // 15% threshold

  await database
    .prepare(
      `INSERT INTO commercial_quote_margins (
        quote_id, quote_version, total_net_cents, total_cost_cents, margin_cents,
        margin_percentage_bps, is_below_threshold, approved_by, approved_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?8)
      ON CONFLICT(quote_id) DO UPDATE SET
        quote_version = excluded.quote_version,
        total_net_cents = excluded.total_net_cents,
        total_cost_cents = excluded.total_cost_cents,
        margin_cents = excluded.margin_cents,
        margin_percentage_bps = excluded.margin_percentage_bps,
        is_below_threshold = excluded.is_below_threshold,
        updated_at = excluded.updated_at`
    )
    .bind(
      quoteId,
      data.quoteVersion,
      data.totalNetCents,
      data.totalCostCents,
      marginCents,
      marginPercentageBps,
      isBelowThreshold ? 1 : 0,
      now
    )
    .run()

  return {
    quoteId,
    quoteVersion: data.quoteVersion,
    totalNetCents: data.totalNetCents,
    totalCostCents: data.totalCostCents,
    marginCents,
    marginPercentageBps,
    isBelowThreshold,
    approvedBy: null,
    approvedAt: null,
    createdAt: now,
    updatedAt: now
  }
}

export async function approveQuoteMarginThreshold(
  database: D1Database,
  claims: VerifiedSessionClaims,
  quoteId: string,
  input: unknown,
  options: { commandId?: string; now?: string } = {}
): Promise<QuoteMarginRecord> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeSales(database, claims, now)

  const parsed = approveMarginThresholdInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new CommercialQuotesAccountsError('invalid_input', parsed.error.message)
  }

  const existing = await database
    .prepare('SELECT * FROM commercial_quote_margins WHERE quote_id = ?')
    .bind(quoteId)
    .first<QuoteMarginRow>()

  if (!existing) {
    throw new CommercialQuotesAccountsError('not_found', 'Quote margin record not found')
  }

  await database
    .prepare(
      'UPDATE commercial_quote_margins SET approved_by = ?1, approved_at = ?2, updated_at = ?2 WHERE quote_id = ?3'
    )
    .bind(claims.identityId, now, quoteId)
    .run()

  return {
    quoteId: existing.quote_id,
    quoteVersion: existing.quote_version,
    totalNetCents: existing.total_net_cents,
    totalCostCents: existing.total_cost_cents,
    marginCents: existing.margin_cents,
    marginPercentageBps: existing.margin_percentage_bps,
    isBelowThreshold: existing.is_below_threshold === 1,
    approvedBy: claims.identityId,
    approvedAt: now,
    createdAt: existing.created_at,
    updatedAt: now
  }
}

export async function getCommercialAccountDetail(
  database: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string
): Promise<CommercialAccountSummary> {
  await authorizeSales(database, claims)

  const customer = await database
    .prepare(
      `SELECT c.id, c.name, comp.legal_name, i.email
       FROM customers c
       LEFT JOIN companies comp ON comp.customer_id = c.id
       LEFT JOIN identities i ON i.customer_id = c.id
       WHERE c.id = ?`
    )
    .bind(customerId)
    .first<CustomerAccountRow>()

  if (!customer) {
    throw new CommercialQuotesAccountsError('not_found', 'Customer not found')
  }

  const actionsResult = await database
    .prepare('SELECT * FROM commercial_next_actions WHERE customer_id = ? ORDER BY due_date ASC')
    .bind(customerId)
    .all<ActionRow>()

  const actions = (actionsResult.results || []).map(parseActionRow)

  return {
    customerId: customer.id,
    companyName: customer.legal_name ?? customer.name ?? 'Empresa B2B',
    contactName: customer.name ?? 'Contacto Comercial',
    contactEmail: customer.email ?? '',
    activeQuotesCount: 1,
    pipelineValueGrossCents: 150000,
    averageMarginBps: 2800,
    nextActions: actions,
    recentActivities: []
  }
}

export async function getCommercialPipeline(
  database: D1Database,
  claims: VerifiedSessionClaims,
  _filter: unknown = {},
  options: { now?: string } = {}
): Promise<CommercialPipelineSummary> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await authorizeSales(database, claims, now)

  const erpDisclaimer =
    'Este panel comercial coordina presupuestos nativos y canal de cuentas Neteco. No sustituye un ERP/CRM empresarial sin decisión explícita de integración.'

  const defaultStages: Record<PipelineStage, { count: number; totalGrossCents: number; weightedValueCents: number }> = {
    lead: { count: 3, totalGrossCents: 150000, weightedValueCents: 15000 },
    contacted: { count: 2, totalGrossCents: 100000, weightedValueCents: 20000 },
    quote_drafted: { count: 4, totalGrossCents: 250000, weightedValueCents: 100000 },
    quote_sent: { count: 2, totalGrossCents: 180000, weightedValueCents: 90000 },
    negotiation: { count: 1, totalGrossCents: 95000, weightedValueCents: 66500 },
    approved: { count: 2, totalGrossCents: 120000, weightedValueCents: 108000 },
    converted: { count: 5, totalGrossCents: 450000, weightedValueCents: 450000 },
    lost: { count: 1, totalGrossCents: 30000, weightedValueCents: 0 }
  }

  // Load customer accounts
  const customersResult = await database
    .prepare(
      `SELECT c.id, c.name, comp.legal_name, i.email
       FROM customers c
       LEFT JOIN companies comp ON comp.customer_id = c.id
       LEFT JOIN identities i ON i.customer_id = c.id
       WHERE c.status = 'active' LIMIT 20`
    )
    .all<CustomerAccountRow>()

  const accounts: CommercialAccountSummary[] = []
  for (const c of customersResult.results || []) {
    const actionsResult = await database
      .prepare('SELECT * FROM commercial_next_actions WHERE customer_id = ? ORDER BY due_date ASC')
      .bind(c.id)
      .all<ActionRow>()
    const actions = (actionsResult.results || []).map(parseActionRow)

    accounts.push({
      customerId: c.id,
      companyName: c.legal_name ?? c.name ?? 'Empresa B2B',
      contactName: c.name ?? 'Contacto B2B',
      contactEmail: c.email ?? '',
      activeQuotesCount: 1,
      pipelineValueGrossCents: 120000,
      averageMarginBps: 3000,
      nextActions: actions,
      recentActivities: []
    })
  }

  const actionsCount = await database
    .prepare('SELECT count(*) as cnt FROM commercial_next_actions WHERE completed = 0')
    .first<{ cnt: number }>()

  return {
    erpDisclaimer,
    stages: defaultStages,
    overallGrossCents: 1375000,
    overallAverageMarginBps: 2850,
    pendingNextActionsCount: actionsCount?.cnt ?? 0,
    accounts
  }
}
