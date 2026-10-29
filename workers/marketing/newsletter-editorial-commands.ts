import { z } from 'zod'
import { newsletterCommandReceiptSchema, type NewsletterCommandReceipt } from '../../shared/newsletter-editorial'
import { catalogPolicyUuidSchema } from '../../shared/catalog-publication-policy'
import {
  NewsletterEditorialError,
  editorialSource,
  editorialJson,
  editorialHash,
  editorialNow,
  stableJson,
  assertBatch,
  keyValue,
  type NewsletterEditorialDependencies
} from './newsletter-editorial-core'

export async function editorialResourceId(actor: string, key: string, action: string) {
  const hash = await editorialHash(`neteco:newsletter:resource:v1:${actor}:${keyValue(key)}:${action}`)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}
export async function editorialReplay(
  deps: NewsletterEditorialDependencies,
  scope: 'admin' | 'subscription',
  actor: string,
  key: string,
  hash: string,
  authorize: () => Promise<void>
) {
  const row = await deps.database
    .prepare(
      `SELECT c.payload_hash,c.response,
 EXISTS(SELECT 1 FROM newsletter_editorial_audit a WHERE a.command_id=c.id AND a.scope=c.scope AND a.actor_id=c.actor_id
 AND a.action=c.action AND a.resource_id=c.resource_id AND a.input=c.input AND a.before_state=c.before_state
 AND a.after_state=c.after_state AND a.response=c.response AND a.created_at=c.created_at) AS completed
 FROM newsletter_editorial_commands c WHERE c.scope=? AND c.actor_id=? AND c.idempotency_key=?`
    )
    .bind(scope, actor, keyValue(key))
    .first()
  await authorize()
  if (row === null) return null
  const data = editorialSource(
    z
      .object({
        payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
        response: z.string().max(16384),
        completed: z.union([z.literal(0), z.literal(1)])
      })
      .strict(),
    row
  )
  if (data.completed !== 1) throw new NewsletterEditorialError('read_unconfirmed')
  if (data.payload_hash !== hash) throw new NewsletterEditorialError('idempotency_conflict')
  return editorialJson(newsletterCommandReceiptSchema, data.response)
}
export async function commitEditorialCommand(
  deps: NewsletterEditorialDependencies,
  command: {
    scope: 'admin' | 'subscription'
    actor: string
    key: string
    hash: string
    action: NewsletterCommandReceipt['action']
    resourceId: string
    expectedRevision: number
    input: unknown
    before: unknown
    after: unknown
    statements: D1PreparedStatement[]
    preSql: string
    preBinds: readonly (string | number | null)[]
    postSql: string
    postBinds: readonly (string | number | null)[]
    authorize: () => Promise<void>
  }
) {
  catalogPolicyUuidSchema.parse(command.resourceId)
  const id = crypto.randomUUID(),
    receipt = newsletterCommandReceiptSchema.parse({
      source: 'cloudflare',
      resourceId: command.resourceId,
      action: command.action,
      revision: command.expectedRevision + 1,
      updated: true
    })
  const statements = [
    deps.database
      .prepare(
        `INSERT INTO newsletter_editorial_guards SELECT ?${command.preBinds.length + 1},0 WHERE NOT(${command.preSql})`
      )
      .bind(...command.preBinds, id),
    ...command.statements
  ]
  statements.push(
    deps.database
      .prepare(
        `INSERT INTO newsletter_editorial_commands(id,scope,actor_id,action,resource_id,idempotency_key,payload_hash,input,expected_revision,before_state,after_state,response,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        id,
        command.scope,
        command.actor,
        command.action,
        command.resourceId,
        command.key,
        command.hash,
        stableJson(command.input),
        command.expectedRevision,
        stableJson(command.before),
        stableJson(command.after),
        stableJson(receipt),
        editorialNow(deps)
      )
  )
  statements.push(
    deps.database
      .prepare(
        `INSERT INTO newsletter_editorial_audit(command_id,scope,actor_id,action,resource_id,input,before_state,after_state,response,created_at)
 SELECT id,scope,actor_id,action,resource_id,input,before_state,after_state,response,created_at FROM newsletter_editorial_commands WHERE id=?`
      )
      .bind(id)
  )
  statements.push(
    deps.database
      .prepare(
        `INSERT INTO newsletter_editorial_guards SELECT ?${command.postBinds.length + 1},0 WHERE NOT(${command.postSql})`
      )
      .bind(...command.postBinds, id)
  )
  await command.authorize()
  try {
    assertBatch(await deps.database.batch(statements), statements.length)
  } catch (failure) {
    const winner = await editorialReplay(
      deps,
      command.scope,
      command.actor,
      command.key,
      command.hash,
      command.authorize
    )
    if (winner !== null) return winner
    await command.authorize()
    if (
      failure instanceof Error &&
      /^(?:D1_ERROR: )?(?:CHECK constraint failed|UNIQUE constraint failed|newsletter_editorial_)/.test(failure.message)
    )
      throw new NewsletterEditorialError('version_conflict')
    throw failure
  }
  const saved = await editorialReplay(deps, command.scope, command.actor, command.key, command.hash, command.authorize)
  if (saved === null || stableJson(saved) !== stableJson(receipt))
    throw new NewsletterEditorialError('write_unconfirmed')
  return saved
}
