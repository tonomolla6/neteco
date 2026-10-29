import type { AdminAuditFamily } from '../../shared/admin-audit'

/** Only static, governed SQL projections enter this registry. No free-text,
 * response JSON, credentials, email, evidence references or document bodies leave it. */
type Source = {
  family: AdminAuditFamily
  from: string
  id?: string
  actor?: string
  resource: string
  action?: string
  at?: string
  command?: string
  session?: string
  ip?: string
  where?: string
  reason?: boolean
  changes?: string
  before?: boolean
  after?: boolean
  integrity?: string
}
const version = (before = 'c.expected_version', after = 'c.result_version') =>
  `json_array(json_object('field','version','before',${before},'after',${after}))`
const paired = (table: string, audit: string, proof: string, key = 'id') =>
  `${table} c LEFT JOIN ${audit} a ON a.command_id=c.${key} AND a.actor_id=c.actor_id AND a.created_at=c.created_at AND ${proof}`
const same = (fields: string[]) => fields.map((field) => `a.${field} IS c.${field}`).join(' AND ')
const commands: Source[] = [
  {
    family: 'catalog_metadata',
    from: paired(
      'catalog_draft_commands',
      'catalog_draft_audit',
      'a.product_id=c.product_id AND a.before_version=c.expected_version AND a.after_version=c.result_version AND a.before_metadata=c.before_metadata AND a.after_metadata=c.after_metadata AND a.reason=c.reason'
    ),
    resource: 'c.product_id',
    action: "'update_metadata'",
    changes: version(),
    reason: true
  },
  {
    family: 'catalog_status',
    from: paired(
      'catalog_product_status_commands',
      'catalog_product_status_audit',
      same(['product_id', 'before_status', 'after_status', 'before_product', 'after_product', 'reason']) +
        ' AND a.before_version=c.expected_version AND a.after_version=c.result_version'
    ),
    resource: 'c.product_id',
    action: 'c.after_status',
    changes: `json_array(json_object('field','status','before',c.before_status,'after',c.after_status))`,
    reason: true
  },
  {
    family: 'catalog_policy',
    from: paired(
      'catalog_policy_commands',
      'catalog_policy_audit',
      same([
        'action',
        'entity_id',
        'resource_id',
        'expected_version',
        'result_version',
        'input',
        'before_state',
        'after_state',
        'response'
      ])
    ),
    resource: 'c.resource_id',
    changes: version(),
    reason: true
  },
  {
    family: 'catalog_authoring',
    from: paired(
      'catalog_draft_authoring_commands',
      'catalog_draft_authoring_audit',
      same([
        'action',
        'product_uuid',
        'expected_version',
        'result_version',
        'input',
        'before_state',
        'after_state',
        'response'
      ])
    ),
    resource: 'c.product_uuid',
    changes: version(),
    reason: true
  },
  {
    family: 'catalog_price',
    from: paired(
      'catalog_price_commands',
      'catalog_price_audit',
      same(['action', 'variant_id', 'price_id', 'input', 'before_state', 'after_state', 'response'])
    ),
    resource: 'c.variant_id',
    reason: true,
    before: true,
    after: true
  },
  {
    family: 'catalog_category',
    from: paired(
      'catalog_category_commands',
      'catalog_category_audit',
      same([
        'action',
        'category_uuid',
        'expected_version',
        'result_version',
        'input',
        'before_state',
        'after_state',
        'response'
      ])
    ),
    resource: 'c.category_uuid',
    changes: version(),
    reason: true
  },
  {
    family: 'catalog_editorial',
    from: 'catalog_editorial_commands c',
    resource: 'c.preview_id',
    integrity: 'EXISTS(SELECT 1 FROM catalog_editorial_audit a WHERE a.command_id=c.id)',
    reason: true,
    before: true,
    after: true
  },
  {
    family: 'catalog_native',
    from: 'catalog_native_commands c LEFT JOIN catalog_native_audit a ON a.command_id=c.id',
    resource: 'c.preview_id',
    reason: true,
    before: true,
    after: true
  },
  {
    family: 'catalog_import',
    from: 'catalog_import_job_commands c',
    resource: 'c.job_id',
    integrity: 'EXISTS(SELECT 1 FROM catalog_import_job_command_audit a WHERE a.command_id=c.id)',
    reason: true,
    before: true,
    after: true
  },
  {
    family: 'catalog_attributes',
    from: paired(
      'catalog_typed_attribute_commands',
      'catalog_typed_attribute_audit',
      same([
        'action',
        'definition_id',
        'expected_revision',
        'result_revision',
        'input',
        'before_state',
        'after_state',
        'response'
      ])
    ),
    resource: 'c.definition_id',
    changes: version('c.expected_revision', 'c.result_revision'),
    reason: true
  },
  {
    family: 'search_synonym',
    from: 'search_synonym_commands c',
    resource: 'c.synonym_id',
    session: 'c.session_id',
    changes: version('c.expected_version', 'c.version'),
    reason: true
  },
  {
    family: 'catalog_relation',
    from: 'catalog_relation_commands c LEFT JOIN catalog_relation_revisions r ON r.command_id=c.command_id AND r.actor_id=c.actor_id AND r.product_id=c.product_id AND r.version=c.result_version AND r.payload_hash=c.payload_hash AND r.recorded_at=c.recorded_at',
    integrity: 'r.command_id IS NOT NULL',
    id: "c.actor_id||':'||c.command_id",
    command: 'c.command_id',
    resource: 'c.product_id',
    at: 'c.recorded_at',
    action: "'replace_relations'",
    changes: version(),
    reason: true
  },
  {
    family: 'media_rights',
    from: 'media_rights_decisions c',
    resource: 'c.upload_id',
    action: 'c.decision',
    command: 'NULL',
    reason: true
  },
  {
    family: 'media_publication',
    from: "product_media_publications c LEFT JOIN media_rights_decisions r ON r.id=c.rights_decision_id AND r.upload_id=c.upload_id AND r.decision='approved' LEFT JOIN media_scan_receipts s ON s.id=c.scan_receipt_id AND s.upload_id=c.upload_id",
    integrity: 'r.id IS NOT NULL AND s.id IS NOT NULL',
    resource: 'c.product_id',
    action: "'publish'",
    command: 'NULL',
    after: true
  },
  {
    family: 'media_withdrawal',
    from: 'product_media_publication_events c LEFT JOIN product_media_publications p ON p.id=c.publication_id',
    integrity: 'p.id IS NOT NULL',
    resource: 'p.product_id',
    action: 'c.event_type',
    command: 'NULL',
    reason: true
  },
  {
    family: 'cms_draft',
    from: paired(
      'content_draft_commands',
      'content_draft_audit',
      same(['action', 'page_id', 'expected_version', 'result_version', 'before_state', 'after_state', 'response'])
    ),
    resource: 'c.page_id',
    changes: version(),
    reason: true
  },
  {
    family: 'cms_publication',
    from: paired(
      'content_publication_commands',
      'content_publication_audit',
      same(['action', 'page_id', 'before_state', 'after_state', 'response'])
    ),
    resource: 'c.page_id',
    reason: true,
    changes: version("json_extract(c.before_state,'$.revision')", "json_extract(c.after_state,'$.revision')")
  },
  {
    family: 'inventory',
    from: paired(
      'inventory_admin_commands',
      'inventory_admin_audit',
      same(['action', 'variant_id', 'expected_version', 'result_version', 'before_state', 'after_state', 'response'])
    ),
    resource: 'c.variant_id',
    reason: true,
    changes: `json_array(json_object('field','physicalQuantity','before',c.physical_before,'after',c.physical_after),json_object('field','version','before',c.expected_version,'after',c.result_version))`
  },
  {
    family: 'fulfillment',
    from: paired(
      'order_fulfillment_commands',
      'order_fulfillment_audit',
      same(['action', 'order_id', 'expected_version', 'result_version', 'from_state', 'to_state', 'input', 'response'])
    ),
    resource: 'c.order_id',
    reason: true,
    changes: `json_array(json_object('field','state','before',c.from_state,'after',c.to_state))`
  },
  {
    family: 'returns',
    from: paired(
      'order_return_commands',
      'order_return_events',
      'a.action=c.action AND a.return_id=c.return_id AND a.order_id=c.order_id AND a.actor_type=c.actor_type AND a.version=c.result_version AND a.input=c.input AND a.response=c.response'
    ),
    resource: 'c.return_id',
    where: "c.actor_type='admin'",
    reason: true,
    changes: version()
  },
  {
    family: 'cancellation',
    from: "payment_commands c LEFT JOIN order_events a ON a.order_id=c.order_id AND a.event_type='order.cancelled' AND a.correlation_id=c.command_id AND a.created_at=c.created_at AND json_extract(a.payload_json,'$.commandId')=c.command_id AND json_extract(a.payload_json,'$.payloadHash')=c.payload_hash AND json_extract(a.payload_json,'$.receipt')=json_extract(c.response_body,'$.receipt') AND json_extract(a.payload_json,'$.actorId')=json_extract(c.response_body,'$.actorId') AND json_extract(a.payload_json,'$.kind')=json_extract(c.response_body,'$.kind') AND json_extract(a.payload_json,'$.input')=json_extract(c.response_body,'$.input') AND json_extract(a.payload_json,'$.auditContext')=json_extract(c.response_body,'$.auditContext')",
    id: "c.order_id||':'||c.command_id",
    command: 'c.command_id',
    actor: "json_extract(c.response_body,'$.actorId')",
    resource: 'c.order_id',
    session: "json_extract(c.response_body,'$.auditContext.sessionId')",
    ip: "json_extract(c.response_body,'$.auditContext.ipHash')",
    action: "'cancel'",
    where:
      "json_extract(c.response_body,'$.auditContext.audience')='admin' AND json_extract(c.response_body,'$.kind')='unpaid-order-cancellation'",
    reason: true,
    integrity: 'a.id IS NOT NULL',
    changes: "json_array(json_object('field','status','before','awaiting_payment','after','cancelled'))"
  },
  {
    family: 'order_annotation',
    from: 'order_annotation_commands c',
    id: "c.order_id||':'||c.command_id",
    command: 'c.command_id',
    resource: 'c.order_id',
    session: 'c.session_id',
    action: "'annotate'",
    changes: version('c.expected_version', 'c.version')
  },
  {
    family: 'order_packing',
    from: paired(
      'order_packing_commands',
      'order_packing_audit',
      same([
        'order_id',
        'action',
        'payload_hash',
        'expected_version',
        'result_version',
        'input',
        'parcels',
        'dispatch',
        'response'
      ]),
      'command_id'
    ),
    id: 'c.command_id',
    command: 'c.command_id',
    resource: 'c.order_id',
    reason: true,
    changes: version()
  },
  {
    family: 'inventory_alert',
    from: 'inventory_alert_commands c',
    resource: 'c.target_id',
    where: "c.source='admin'",
    integrity:
      "json_extract(c.response,'$.commandId')=c.id AND json_extract(c.response,'$.payloadHash')=c.payload_hash",
    reason: true,
    before: true,
    after: true
  },
  {
    family: 'inventory_count_import',
    from: paired(
      'inventory_count_import_commands',
      'inventory_count_import_audit',
      same(['action', 'import_id', 'payload_hash', 'response'])
    ),
    resource: 'c.import_id',
    reason: true,
    changes: version("json_extract(c.response,'$.expectedVersion')", "json_extract(c.response,'$.version')")
  },
  {
    family: 'shipping_calendar',
    from: 'shipping_calendar_commands c',
    id: "c.actor_id||':'||c.command_id",
    command: 'c.command_id',
    resource: "'shipping_calendar'",
    at: 'c.recorded_at',
    action: "'configure'",
    reason: true,
    changes: version()
  },
  // Actor-bearing immutable events, not automated provider transitions. Never
  // infer a command correlation from matching timestamps or current roles.
  {
    family: 'fiscal',
    from: 'fiscal_issuance_events c',
    resource: 'COALESCE(c.intent_id,c.policy_id)',
    action: 'c.event_type',
    command: 'NULL',
    where:
      "c.actor_id IS NOT NULL AND c.event_type IN('policy_approved','policy_withdrawn','queued','reconciliation_started','reconciled','reconciliation_blocked')",
    reason: true
  },
  {
    family: 'financial',
    from: 'financial_events c',
    resource: 'c.target_id',
    action: 'c.event_kind',
    command: 'NULL',
    where: 'c.actor_id IS NOT NULL',
    reason: true
  },
  {
    family: 'support',
    from: paired(
      'support_commands',
      'support_events',
      'a.id=c.id AND a.type=c.action AND a.ticket_id=c.ticket_id AND a.state=c.to_state',
      'id'
    ).replace('a.command_id=c.id', 'a.id=c.id'),
    resource: 'c.ticket_id',
    where: "c.actor_type='admin'",
    reason: true,
    changes: version()
  },
  {
    family: 'support_macro',
    from: 'support_macro_commands c',
    resource: 'c.macro_id',
    reason: true,
    changes: version('c.expected_version', 'c.version')
  },
  {
    family: 'support_escalation',
    from: 'support_escalation_commands c',
    resource: 'c.target_id',
    reason: true,
    changes: version('c.expected_version', 'c.version')
  },
  {
    family: 'newsletter_editorial',
    from: paired(
      'newsletter_editorial_commands',
      'newsletter_editorial_audit',
      same(['scope', 'action', 'resource_id', 'input', 'before_state', 'after_state', 'response'])
    ),
    resource: 'c.resource_id',
    where: "c.scope='admin'",
    reason: true,
    changes: version('c.expected_revision', 'c.expected_revision+1')
  },
  {
    family: 'company_review',
    from: 'company_admin_review_commands c',
    id: 'c.command_id',
    command: 'c.command_id',
    resource: 'c.company_id',
    session: 'c.session_id',
    action: "'review'",
    reason: true,
    changes: `json_array(json_object('field','status','before',c.from_status,'after',c.to_status))`
  },
  {
    family: 'promotion',
    from: paired(
      'promotion_admin_commands',
      'promotion_admin_audit',
      'a.rule_id=c.rule_id AND a.version=c.applied_version AND a.rule_hash=c.rule_hash AND a.payload_hash=c.payload_hash',
      'command_id'
    ),
    id: 'c.command_id',
    command: 'c.command_id',
    resource: 'c.rule_id',
    session: 'c.session_id',
    action: "'configure'",
    reason: true,
    changes: version('c.expected_version', 'c.applied_version')
  },
  {
    family: 'communication_history',
    from: 'communication_history_commands c',
    resource: 'c.event_id',
    session: 'c.session_id',
    action: "'retry_preparation'",
    reason: true
  },
  {
    family: 'admin_invitation',
    from: 'admin_invitation_commands c',
    resource: 'c.invitation_id',
    session: 'c.actor_session_id',
    reason: true,
    changes: `json_array(json_object('field','roleCode','before',NULL,'after',json_extract(c.receipt_json,'$.roleCode')))`
  },
  {
    family: 'admin_bootstrap',
    from: 'admin_bootstrap_commands c',
    id: 'c.command_id',
    command: 'c.command_id',
    resource: 'c.identity_id',
    actor: 'c.identity_id',
    session: 'c.session_id',
    at: 'c.recorded_at',
    action: "'bootstrap'",
    reason: true,
    changes: `json_array(json_object('field','permissionCount','before',0,'after',json_array_length(c.permissions_json)))`
  },
  {
    family: 'admin_audit',
    from: 'admin_audit_commands c',
    resource: 'COALESCE(c.event_id,c.id)',
    session: 'c.session_id',
    ip: 'c.ip_hash',
    reason: true,
    after: true
  }
]
export const ADMIN_AUDIT_SOURCE_FAMILIES = commands.map(({ family }) => family)
const projections = commands.map(
  (source) => `SELECT '${source.family}:'||${source.id ?? 'c.id'} AS id,
  '${source.family}' AS family,${source.action ?? 'c.action'} AS action,
  strftime('%Y-%m-%dT%H:%M:%fZ',${source.at ?? 'c.created_at'}) AS createdAt,
  ${source.actor ?? 'c.actor_id'} AS actorId,CAST(${source.resource} AS TEXT) AS resourceId,
  ${source.command ?? source.id ?? 'c.id'} AS commandId,${source.session ?? 'NULL'} AS sessionId,${source.ip ?? 'NULL'} AS ipHash,
  '${source.reason ? 'redacted' : 'unknown'}' AS reason,'${source.before || source.changes ? 'redacted' : 'unknown'}' AS before,
  '${source.after || source.changes ? 'redacted' : 'unknown'}' AS after,${source.changes ?? "'[]'"} AS changes,
  CASE WHEN ${source.integrity ?? (source.from.includes(' LEFT JOIN ') ? (source.family === 'support' ? 'a.id IS NOT NULL' : 'a.command_id IS NOT NULL') : '1=1')} THEN 1 ELSE 0 END AS integrity
  FROM ${source.from} WHERE ${source.where ?? '1=1'}`
)
// Workerd's compound SELECT limit is lower than SQLite's: groups of four.
const groups = Array.from(
  { length: Math.ceil(projections.length / 4) },
  (_, index) => `audit_source_${index} AS (${projections.slice(index * 4, index * 4 + 4).join(' UNION ALL ')})`
)
const groupNames = groups.map((_, index) => `SELECT * FROM audit_source_${index}`)
const halves = [groupNames.slice(0, 4), groupNames.slice(4, 8), groupNames.slice(8)].map(
  (names, index) => `audit_half_${index} AS (${names.join(' UNION ALL ')})`
)
export const adminAuditSourcesCte = `${groups.join(',')},${halves.join(',')},
  audit_events AS (SELECT * FROM audit_half_0 UNION ALL SELECT * FROM audit_half_1 UNION ALL SELECT * FROM audit_half_2)`
