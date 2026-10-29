import {
  catalogImportJobCommandInputSchema,
  catalogImportJobReceiptSchema,
  type CatalogImportJobReceipt
} from '../../shared/catalog-import-job-commands'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import type { VerifiedSessionClaims } from './authorization'
import {
  readCatalogImportJob,
  catalogImportJobReferencesSql,
  catalogImportJobNoConflictsSql,
  catalogImportJobCountsSql,
  catalogImportJobTypedSourceSql
} from './import-job'
import {
  NativeCatalogImportError,
  authorizeNativeCatalogImport as authorize,
  nativeImportActorSql as actorSql,
  nativeImportParameters as parameters,
  nativeImportSha256 as sha256,
  nativeImportProductColumns as productColumns,
  nativeImportVariantColumns as variantColumns,
  nativeImportAssetColumns as assetColumns,
  nativeImportMediaColumns as mediaColumns,
  nativeImportPriceColumns as priceColumns,
  nativeImportBalanceColumns as balanceColumns,
  nativeImportMovementColumns as movementColumns,
  nativeImportRowObject as rowObject,
  nativeImportConjunction as conjunction,
  nativeImportTypedValidityCte,
  nativeImportTypedReferenceUnusedCte,
  nativeImportTypedGuardSql
} from './native-import'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'

type Options = { now?: string }
type Kind = 'products' | 'variants' | 'assets' | 'media' | 'prices' | 'balances' | 'movements'
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const j = (field: string) => `json_extract(item.value,'$.${field}')`
const camel = (field: string) => field.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
const owned = `WITH owned AS(SELECT c.*,j.warehouse_id FROM catalog_import_job_commands c
 JOIN catalog_import_jobs j ON j.id=c.job_id WHERE c.id=?1 AND c.nonce=?2)`
const items = (kind: string) => `${owned},items AS(SELECT e.item_id,e.payload AS value FROM owned c
 JOIN catalog_import_job_entries e ON e.job_id=c.job_id WHERE e.kind='${kind}')`
const ids = (job: string, kind: string) =>
  `SELECT item_id FROM catalog_import_job_entries WHERE job_id=${job} AND kind='${kind}'`
const specs: Array<{ kind: Kind; table: string; columns: string[]; key: string; identity: string }> = [
  { kind: 'products', table: 'products', columns: productColumns, key: 'r.id', identity: 'id' },
  { kind: 'variants', table: 'variants', columns: variantColumns, key: 'r.id', identity: 'id' },
  { kind: 'assets', table: 'media_assets', columns: assetColumns, key: 'r.id', identity: 'id' },
  {
    kind: 'media',
    table: 'product_media',
    columns: mediaColumns,
    key: 'json_array(r.product_id,r.variant_id,r.asset_id,r.role,r.version)',
    identity: 'product_id'
  },
  { kind: 'prices', table: 'variant_price_versions', columns: priceColumns, key: 'r.id', identity: 'id' },
  {
    kind: 'balances',
    table: 'inventory_balances',
    columns: balanceColumns,
    key: 'json_array(r.variant_id,r.location_id)',
    identity: 'variant_id'
  },
  { kind: 'movements', table: 'inventory_movements', columns: movementColumns, key: 'r.id', identity: 'id' }
]
function scope(kind: Kind, job: string) {
  if (kind === 'products' || kind === 'variants' || kind === 'assets') return `r.id IN(${ids(job, kind)})`
  if (kind === 'media') return `r.product_id IN(${ids(job, 'products')})`
  return `r.variant_id IN(${ids(job, 'variants')})`
}
function unused(job: string) {
  // Scan each usage row once and probe the immutable staging PK. Correlated
  // IN lists otherwise rebuild all 25k identities for every usage row when
  // the live table has no leading index for that reference (notably media).
  const referenced = (table: string, column: string, kind: string) =>
    `NOT EXISTS(SELECT 1 FROM ${table} CROSS JOIN catalog_import_job_entries entry
      ON entry.job_id=${job} AND entry.kind='${kind}' AND entry.item_id=${table}.${column})`
  return conjunction([
    referenced('cart_lines', 'variant_id', 'variants'),
    referenced('checkout_quote_lines', 'variant_id', 'variants'),
    referenced('inventory_reservation_lines', 'variant_id', 'variants'),
    referenced('product_media_publications', 'product_id', 'products'),
    `NOT EXISTS(SELECT 1 FROM product_media CROSS JOIN catalog_import_job_entries assets
      ON assets.job_id=${job} AND assets.kind='assets' AND assets.item_id=product_media.asset_id
      WHERE NOT EXISTS(SELECT 1 FROM catalog_import_job_entries products
        WHERE products.job_id=${job} AND products.kind='products' AND products.item_id=product_media.product_id))`,
    referenced('brands', 'logo_asset_id', 'assets')
  ])
}
function typedUnused(job: string) {
  return nativeImportTypedReferenceUnusedCte(
    `EXISTS(SELECT 1 FROM catalog_import_job_entries target WHERE target.job_id=${job}
      AND target.kind='products' AND target.item_id=json_extract(usage.value,'$.value'))`,
    `NOT EXISTS(SELECT 1 FROM catalog_import_job_entries own WHERE own.job_id=${job}
      AND own.kind='products' AND own.item_id=usage.id)`
  )
}
/** Compare every recorded field and the complete row set. There is no aggregate
 * 25k-row JSON blob: each snapshot remains below D1's per-row size limit. */
function unchanged(job: string) {
  const applied = `(SELECT id FROM catalog_import_job_commands WHERE job_id=${job} AND action='apply')`
  const joinKey = (kind: Kind, key: string) =>
    kind === 'balances'
      ? `r.variant_id=json_extract(a.item_id,'$[0]') AND r.location_id=json_extract(a.item_id,'$[1]')`
      : kind === 'media'
        ? `r.product_id=json_extract(a.item_id,'$[0]') AND r.variant_id IS json_extract(a.item_id,'$[1]')
          AND r.asset_id=json_extract(a.item_id,'$[2]') AND r.role=json_extract(a.item_id,'$[3]')
          AND r.version=json_extract(a.item_id,'$[4]')`
        : `${key}=a.item_id`
  return conjunction(
    specs.flatMap(({ kind, table, columns, key, identity }) => [
      `(SELECT count(*) FROM ${table} r WHERE ${scope(kind, job)})=
      (SELECT count(*) FROM catalog_import_job_command_audit WHERE command_id=${applied} AND kind='${kind}')`,
      `NOT EXISTS(SELECT 1 FROM catalog_import_job_command_audit a LEFT JOIN ${table} r ON ${joinKey(kind, key)}
      WHERE a.command_id=${applied} AND a.kind='${kind}' AND
       (r.${identity} IS NULL OR ${rowObject(columns, 'r')}<>a.after_state))`
    ])
  )
}
function mapped(columns: string[], overrides: Record<string, string> = {}) {
  return Object.fromEntries(columns.map((column) => [column, overrides[column] ?? j(camel(column))]))
}
// Resolve the exact identity before comparing the full row. Otherwise SQLite
// can choose an incidental nullable UNIQUE field (e.g. gtin IS NULL), scanning
// every MPN-only variant per source entry. Keep all null-safe comparisons but
// give the outer lookup one rowid, without relying on auto-generated index names.
function fullRows(
  table: string,
  columns: string[],
  values: Record<string, string>,
  group: string,
  join: string,
  predicate = '1'
) {
  const matching = conjunction(columns.map((column) => `r.${column} IS ${values[column]}`))
  const identity = join.replace(/\br\./g, 'identity.')
  return `(SELECT count(*) FROM (SELECT payload AS value FROM catalog_import_job_entries WHERE job_id=c.job_id AND kind='${group}') item
    CROSS JOIN ${table} r ON r.rowid=(SELECT identity.rowid FROM ${table} identity WHERE ${identity})
    WHERE ${predicate} AND ${matching})=
   (SELECT count(*) FROM (SELECT payload AS value FROM catalog_import_job_entries WHERE job_id=c.job_id AND kind='${group}') item WHERE ${predicate})`
}
function transformed(before: string, columns: string[], changes: Record<string, string>) {
  const updates = Object.entries(changes).flatMap(([column, value]) => {
    const index = columns.indexOf(column)
    if (index < 0) throw new Error('catalog_import_unknown_snapshot_column')
    return [`'${columns.length > 12 ? `$[${Math.floor(index / 12)}].${column}` : `$.${column}`}'`, value]
  })
  return updates.length ? `json_set(${before},${updates.join(',')})` : before
}
function precedingSnapshot(kind: Kind, key: string) {
  return `(SELECT a.after_state FROM catalog_import_job_commands prior
    JOIN catalog_import_job_command_audit a ON a.command_id=prior.id
    WHERE prior.job_id=c.job_id AND prior.action='apply' AND a.kind='${kind}' AND a.item_id=${key})`
}
async function replay(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  hash: string,
  options: Options
) {
  const row = await database
    .prepare(
      `WITH actor AS(${actorSql}) SELECT c.payload_hash,c.response FROM actor
    JOIN catalog_import_job_commands c ON c.actor_id=actor.id WHERE c.idempotency_key=?5`
    )
    .bind(...parameters(claims, options), key)
    .first<{ payload_hash: string; response: string }>()
  await authorize(database, claims, options)
  if (!row) return null
  if (row.payload_hash !== hash) throw new NativeCatalogImportError('idempotency_conflict')
  return catalogImportJobReceiptSchema.parse(JSON.parse(row.response))
}

/** One atomic D1 transaction creates or exactly compensates the whole sealed
 * job, including files over500rows. Inputs remain immutable source descriptors;
 * price/stock need live authority and publication/R2/scanner authority is absent. */
export async function executeCatalogImportJobCommand(
  database: D1Database,
  input: VerifiedSessionClaims | null,
  id: string,
  action: 'apply' | 'revert',
  raw: unknown,
  idempotencyKey: string,
  options: Options = {}
): Promise<CatalogImportJobReceipt> {
  if (
    !catalogPolicyUuidSchema.safeParse(id).success ||
    !['apply', 'revert'].includes(action) ||
    typeof idempotencyKey !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)
  )
    throw new NativeCatalogImportError('invalid_input')
  const body = catalogImportJobCommandInputSchema.safeParse(raw)
  if (!body.success) throw new NativeCatalogImportError('invalid_input')
  const claims = await authorize(database, input, options)
  const payloadHash = await sha256(JSON.stringify(['catalog-import-job.v1', id, action, body.data]))
  const prior = await replay(database, claims, idempotencyKey, payloadHash, options)
  if (prior) return prior
  const job = await readCatalogImportJob(database, claims, id, options)
  if (!job.hash || job.hash !== body.data.previewHash) throw new NativeCatalogImportError('version_conflict')
  if (action === 'apply' && job.status !== 'ready') throw new NativeCatalogImportError('already_applied')
  if (action === 'revert' && job.status !== 'applied')
    throw new NativeCatalogImportError(job.status === 'reverted' ? 'already_reverted' : 'not_applied')
  if (action === 'apply' && job.expiresAt <= (options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')))
    throw new NativeCatalogImportError('preview_expired')
  const commandId = crypto.randomUUID(),
    nonce = crypto.randomUUID()
  const receipt = catalogImportJobReceiptSchema.parse({
    source: 'cloudflare',
    action,
    jobId: id,
    jobHash: job.hash,
    commandId,
    counts: job.counts,
    updated: true
  })
  const binds = [
    ...parameters(claims, options),
    id,
    job.hash,
    commandId,
    nonce,
    idempotencyKey,
    payloadHash,
    body.data.reason,
    JSON.stringify(receipt),
    action
  ]
  const condition =
    action === 'apply'
      ? `s.expires_at>${clock} AND ${catalogImportJobReferencesSql('j')} AND ${catalogImportJobNoConflictsSql('j')}
       AND NOT EXISTS(SELECT 1 FROM catalog_import_job_commands WHERE job_id=j.id)`
      : `EXISTS(SELECT 1 FROM catalog_import_job_commands WHERE job_id=j.id AND action='apply')
       AND NOT EXISTS(SELECT 1 FROM catalog_import_job_commands WHERE job_id=j.id AND action='revert')
       AND ${unused('j.id')} AND ${unchanged('j.id')}`
  const typedCte = (job: string) =>
    action === 'apply' ? nativeImportTypedValidityCte(catalogImportJobTypedSourceSql(job)) : typedUnused(job)
  const claim = database
    .prepare(
      `WITH actor AS(${actorSql})
    INSERT INTO catalog_import_job_commands(id,nonce,actor_id,job_id,action,idempotency_key,payload_hash,reason,response,created_at)
    SELECT ?7,?8,actor.id,j.id,?13,?9,?10,?11,?12,${clock} FROM actor
    JOIN catalog_import_jobs j ON j.actor_id=actor.id JOIN catalog_import_job_seals s ON s.job_id=j.id
    WHERE j.id=?5 AND s.hash=?6 AND ${catalogImportJobCountsSql('j.id')}=s.counts
    AND (SELECT count(*) FROM catalog_import_job_pages WHERE job_id=j.id)=j.total_pages
    AND (SELECT sum(record_count) FROM catalog_import_job_pages WHERE job_id=j.id)=j.record_count
    AND (SELECT count(*) FROM catalog_import_job_rows WHERE job_id=j.id)=j.record_count
    AND ${condition}
    AND NOT EXISTS(SELECT 1 FROM catalog_import_job_commands WHERE actor_id=actor.id AND idempotency_key=?9)`
    )
    .bind(...binds)
  const mutations: string[] = [],
    checks: string[] = []
  const counts = new Map<Kind, string>([
    ['products', "json_extract(s.counts,'$.products')"],
    ['variants', "json_extract(s.counts,'$.variants')"],
    ['assets', "json_extract(s.counts,'$.assets')"],
    ['media', "json_extract(s.counts,'$.mappings')"],
    ['prices', "json_extract(s.counts,'$.variants')"],
    ['balances', "json_extract(s.counts,'$.variants')"],
    [
      'movements',
      `(SELECT count(*) FROM catalog_import_job_entries WHERE job_id=c.job_id AND kind='variants'
      AND json_extract(payload,'$.inventory[0].physicalQuantity')>0)`
    ]
  ])
  if (action === 'apply') {
    const valuesByKind: Array<[Kind, string, string[], Record<string, string>, string, string]> = [
      [
        'products',
        'products',
        productColumns,
        mapped(productColumns, {
          status: "'draft'",
          published_at: 'NULL',
          catalog_version: '1',
          created_at: 'c.created_at',
          updated_at: 'c.created_at'
        }),
        'products',
        `r.id=${j('id')}`
      ],
      [
        'variants',
        'variants',
        variantColumns,
        mapped(variantColumns, { status: "'draft'", created_at: 'c.created_at', updated_at: 'c.created_at' }),
        'variants',
        `r.id=${j('id')}`
      ],
      [
        'assets',
        'media_assets',
        assetColumns,
        mapped(assetColumns, {
          rights_status: "'pending'",
          quarantine_status: "'pending'",
          created_at: 'c.created_at'
        }),
        'assets',
        `r.id=${j('id')}`
      ],
      [
        'media',
        'product_media',
        mediaColumns,
        mapped(mediaColumns),
        'media',
        `r.product_id=${j('productId')} AND r.variant_id IS ${j('variantId')} AND r.asset_id=${j('assetId')}
          AND r.role=${j('role')} AND r.version=${j('version')}`
      ],
      [
        'prices',
        'variant_price_versions',
        priceColumns,
        mapped(priceColumns, {
          id: j('initialPriceId'),
          variant_id: j('id'),
          gross_cents: j('priceGrossCents'),
          compare_at_gross_cents: j('compareAtGrossCents'),
          reference_gross_cents_30d: 'NULL',
          volume_tiers: "'[]'",
          valid_from: 'c.created_at',
          valid_until: 'NULL',
          status: "'approved'",
          reason: 'c.reason',
          created_by: 'c.actor_id',
          created_at: 'c.created_at',
          cancelled_by: 'NULL',
          cancelled_at: 'NULL',
          cancellation_reason: 'NULL'
        }),
        'variants',
        `r.id=${j('initialPriceId')}`
      ],
      [
        'balances',
        'inventory_balances',
        balanceColumns,
        mapped(balanceColumns, {
          variant_id: j('id'),
          location_id: 'c.warehouse_id',
          physical_quantity: `COALESCE(${j('inventory[0].physicalQuantity')},0)`,
          blocked_quantity: `COALESCE(${j('inventory[0].blockedQuantity')},0)`,
          version: '1',
          created_at: 'c.created_at',
          updated_at: 'c.created_at'
        }),
        'variants',
        `r.variant_id=${j('id')} AND r.location_id=c.warehouse_id`
      ],
      [
        'movements',
        'inventory_movements',
        movementColumns,
        mapped(movementColumns, {
          id: j('initialMovementId'),
          variant_id: j('id'),
          location_id: 'c.warehouse_id',
          movement_type: "'initial'",
          physical_delta: j('inventory[0].physicalQuantity'),
          reserved_delta: '0',
          reference_type: "'catalog_native_import'",
          reference_id: 'c.id',
          idempotency_key: `c.id||':initial:'||${j('id')}`,
          correlation_id: 'c.job_id',
          reason: 'c.reason',
          created_at: 'c.created_at'
        }),
        'variants',
        `r.id=${j('initialMovementId')}`
      ]
    ]
    // FK order: products before variants; assets before their associations.
    for (const [kind, table, columns, values, group, join] of valuesByKind) {
      const predicate = kind === 'movements' ? `${j('inventory[0].physicalQuantity')}>0` : '1'
      mutations.push(`${items(group)} INSERT INTO ${table}(${columns.join(',')})
        SELECT ${columns.map((column) => values[column]).join(',')} FROM owned c,items item WHERE ${predicate}`)
      checks.push(fullRows(table, columns, values, group, join, predicate))
      if (['products', 'variants', 'assets', 'balances'].includes(kind)) {
        // Detect a silently skipped parent before dependent FK writes. Keep
        // genuine provider failures distinct; do not classify them by words.
        mutations.push(`${owned} INSERT INTO catalog_import_job_guards(id,satisfied) SELECT ?1||':${kind}',
          CASE WHEN EXISTS(SELECT 1 FROM owned c WHERE
           (SELECT count(*) FROM ${table} r WHERE ${scope(kind, 'c.job_id')})=
           (SELECT count(*) FROM catalog_import_job_entries WHERE job_id=c.job_id AND kind='${group}'))
          THEN 1 ELSE 0 END`)
      }
    }
    for (const [entity, group] of [
      ['product', 'products'],
      ['variant', 'variants']
    ] as const) {
      mutations.push(`${owned} UPDATE catalog_draft_legacy_counters SET last_id=
        (SELECT max(legacy_id) FROM catalog_import_job_entries WHERE job_id=(SELECT job_id FROM owned) AND kind='${group}')
        WHERE entity='${entity}' AND last_id<
        (SELECT max(legacy_id) FROM catalog_import_job_entries WHERE job_id=(SELECT job_id FROM owned) AND kind='${group}')`)
      checks.push(`EXISTS(SELECT 1 FROM catalog_draft_legacy_counters WHERE entity='${entity}' AND last_id>=
        (SELECT max(legacy_id) FROM catalog_import_job_entries WHERE job_id=c.job_id AND kind='${group}'))`)
    }
    checks.push(catalogImportJobReferencesSql('j'))
  } else {
    mutations.push(`${items('variants')} INSERT INTO inventory_movements(${movementColumns.join(',')}) SELECT
      ${j('compensationMovementId')},${j('id')},c.warehouse_id,'adjustment',-balance.physical_quantity,0,
      'catalog_native_import',c.id,c.id||':revert:'||${j('id')},c.job_id,c.reason,c.created_at
      FROM owned c,items item JOIN inventory_balances balance ON balance.variant_id=${j('id')}
      AND balance.location_id=c.warehouse_id WHERE balance.physical_quantity>0`)
    mutations.push(`${owned} UPDATE inventory_balances SET physical_quantity=0,blocked_quantity=0,version=version+1,
      updated_at=(SELECT created_at FROM owned) WHERE variant_id IN(${ids('(SELECT job_id FROM owned)', 'variants')})`)
    mutations.push(`${items('variants')} UPDATE variant_price_versions SET status='cancelled',cancelled_by=(SELECT actor_id FROM owned),
      cancelled_at=(SELECT created_at FROM owned),cancellation_reason=(SELECT reason FROM owned)
      WHERE id IN(SELECT ${j('initialPriceId')} FROM items item)`)
    mutations.push(`${owned} UPDATE variants SET status='discontinued',price_gross_cents=0,compare_at_gross_cents=NULL,
      updated_at=(SELECT created_at FROM owned) WHERE id IN(${ids('(SELECT job_id FROM owned)', 'variants')})`)
    mutations.push(`${owned} UPDATE products SET status='discontinued',catalog_version=catalog_version+1,
      updated_at=(SELECT created_at FROM owned) WHERE id IN(${ids('(SELECT job_id FROM owned)', 'products')})`)
    counts.set('movements', `2*${counts.get('movements')!}`)
    const changes: Partial<Record<Kind, Record<string, string>>> = {
      products: { status: "'discontinued'", catalog_version: '2', updated_at: 'c.created_at' },
      variants: {
        status: "'discontinued'",
        price_gross_cents: '0',
        compare_at_gross_cents: 'NULL',
        updated_at: 'c.created_at'
      },
      prices: {
        status: "'cancelled'",
        cancelled_by: 'c.actor_id',
        cancelled_at: 'c.created_at',
        cancellation_reason: 'c.reason'
      },
      balances: { physical_quantity: '0', blocked_quantity: '0', version: '2', updated_at: 'c.created_at' }
    }
    for (const { kind, columns } of specs) {
      // New compensating ledger rows have no predecessor; old rows are exact.
      checks.push(`NOT EXISTS(SELECT 1 FROM catalog_import_job_command_audit prior
        LEFT JOIN catalog_import_job_command_audit audit ON audit.command_id=c.id AND audit.kind=prior.kind AND audit.item_id=prior.item_id
        WHERE prior.command_id=(SELECT id FROM catalog_import_job_commands WHERE job_id=c.job_id AND action='apply')
        AND prior.kind='${kind}' AND (audit.command_id IS NULL OR audit.before_state IS NOT prior.after_state
          OR audit.after_state<>${transformed('prior.after_state', columns, changes[kind] ?? {})}))`)
    }
    const compensationValues = mapped(movementColumns, {
      id: j('compensationMovementId'),
      variant_id: j('id'),
      location_id: 'c.warehouse_id',
      movement_type: "'adjustment'",
      physical_delta: `-${j('inventory[0].physicalQuantity')}`,
      reserved_delta: '0',
      reference_type: "'catalog_native_import'",
      reference_id: 'c.id',
      idempotency_key: `c.id||':revert:'||${j('id')}`,
      correlation_id: 'c.job_id',
      reason: 'c.reason',
      created_at: 'c.created_at'
    })
    checks.push(
      fullRows(
        'inventory_movements',
        movementColumns,
        compensationValues,
        'variants',
        `r.id=${j('compensationMovementId')}`,
        `${j('inventory[0].physicalQuantity')}>0`
      )
    )
    checks.push(unused('c.job_id'))
  }
  // Per-row immutable snapshots: no two-megabyte whole-job state or N+1
  // network reads, and each fixed closed column list retains explicit nulls.
  const audits = specs.map(({ kind, table, columns, key }) =>
    database
      .prepare(
        `${owned}
    INSERT INTO catalog_import_job_command_audit(command_id,kind,item_id,before_state,after_state)
    SELECT c.id,'${kind}',${key},${action === 'apply' ? 'NULL' : precedingSnapshot(kind, key)},
      ${rowObject(columns, 'r')} FROM owned c JOIN ${table} r ON ${scope(kind, 'c.job_id')}`
      )
      .bind(commandId, nonce)
  )
  for (const { kind, table, columns, key } of specs) {
    checks.push(`(SELECT count(*) FROM ${table} r WHERE ${scope(kind, 'c.job_id')})=${counts.get(kind)!}`)
    checks.push(
      `(SELECT count(*) FROM catalog_import_job_command_audit WHERE command_id=c.id AND kind='${kind}')=${counts.get(kind)!}`
    )
    checks.push(`NOT EXISTS(SELECT 1 FROM ${table} r LEFT JOIN catalog_import_job_command_audit audit
      ON audit.command_id=c.id AND audit.kind='${kind}' AND audit.item_id=${key}
      WHERE ${scope(kind, 'c.job_id')} AND (audit.command_id IS NULL OR audit.after_state<>${rowObject(columns, 'r')}
       OR audit.before_state IS NOT ${action === 'apply' ? 'NULL' : precedingSnapshot(kind, key)}))`)
  }
  const guard = database
    .prepare(
      `WITH actor AS(${actorSql}),live_command AS(SELECT c.*,j.warehouse_id FROM catalog_import_job_commands c
       JOIN catalog_import_jobs j ON j.id=c.job_id) INSERT INTO catalog_import_job_guards(id,satisfied) SELECT ?5,
    CASE WHEN EXISTS(SELECT 1 FROM actor JOIN live_command c ON c.actor_id=actor.id
    JOIN catalog_import_jobs j ON j.id=c.job_id JOIN catalog_import_job_seals s ON s.job_id=j.id
    WHERE c.id=?5 AND c.nonce=?6 AND ${catalogImportJobCountsSql('j.id')}=s.counts AND ${conjunction(checks)}) THEN 1 ELSE 0 END`
    )
    .bind(...parameters(claims, options), commandId, nonce)
  try {
    await database.batch([
      database
        .prepare(
          nativeImportTypedGuardSql(
            'catalog_import_job_guards',
            typedCte('?5'),
            'JOIN catalog_import_jobs j ON j.actor_id=actor.id WHERE j.id=?5'
          )
        )
        .bind(...parameters(claims, options), job.id),
      claim,
      ...mutations.map((sql) => database.prepare(sql).bind(commandId, nonce)),
      ...audits,
      guard,
      database
        .prepare(
          nativeImportTypedGuardSql(
            'catalog_import_job_guards',
            typedCte('(SELECT job_id FROM catalog_import_job_commands WHERE id=?5 AND nonce=?6)'),
            'JOIN catalog_import_job_commands c ON c.actor_id=actor.id WHERE c.id=?5 AND c.nonce=?6'
          )
        )
        .bind(...parameters(claims, options), commandId, nonce),
      database
        .prepare(
          "DELETE FROM catalog_import_job_guards WHERE id IN(?1,?1||':products',?1||':variants',?1||':assets',?1||':balances')"
        )
        .bind(commandId)
    ])
  } catch (failure) {
    if (!isD1CheckConstraintFailure(failure)) throw failure
    await authorize(database, claims, options)
    const raced = await replay(database, claims, idempotencyKey, payloadHash, options)
    if (raced) return raced
    throw new NativeCatalogImportError('version_conflict')
  }
  await authorize(database, claims, options)
  return receipt
}
