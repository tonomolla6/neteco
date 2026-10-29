import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { readHighValueConsent } from './high-value-consent'

export class HighValueDeliveryError extends Error {
 constructor(readonly code: 'invalid_input'|'consent_required'|'conflict'|'budget_exceeded'|'delivery_disabled'|'unavailable') { super(code) }
}
const uuid=z.string().uuid()
const schema=z.object({ eventId:uuid, event:z.enum(['recall','delivery_exception','security_alert']), channel:z.literal('sms'), consentVersion:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict()
const pricingSchema=z.object({ smsCostMinor:z.number().int().nonnegative().max(1000000), dailyBudgetMinor:z.number().int().nonnegative().max(1000000) }).strict()
interface Options { now?:()=>string; pricing:unknown; transport:string }
interface Row { command_id:string; event_id:string; customer_id:string; channel:string; event_type:string; payload_hash:string; cost_minor:number; created_at:string }
function fail(code:HighValueDeliveryError['code']):never { throw new HighValueDeliveryError(code) }
function receipt(row:Row) { return { source:'cloudflare' as const, status:'simulated' as const, commandId:row.command_id, eventId:row.event_id, customerId:row.customer_id, channel:row.channel, costMinor:row.cost_minor, createdAt:row.created_at, fakeReceipt:`fake:${row.command_id}` } }
export async function dispatchHighValueMessage(db:D1Database, claims:VerifiedSessionClaims|null, customerId:string, commandId:string, raw:unknown, options:Options) {
 const parsed=schema.safeParse(raw), pricing=pricingSchema.safeParse(options.pricing)
 if(!parsed.success || !uuid.safeParse(customerId).success || !uuid.safeParse(commandId).success || !pricing.success) fail('invalid_input')
 if(options.transport!=='local-fake') fail('delivery_disabled')
 const input=parsed.data, consent=await readHighValueConsent(db,claims,customerId,input.channel,options)
 if (!consent.granted || consent.version!==input.consentVersion) fail('consent_required')
 if (!claims) fail('unavailable')
 const hash=await canonicalPayloadHash({ customerId, actorId:claims.identityId, ...input, pricing:pricing.data })
 const lookup=async()=>db.prepare('SELECT * FROM high_value_delivery_commands WHERE command_id=?').bind(commandId).first<Row>()
 const previous=await lookup()
 if(previous) { if(previous.payload_hash!==hash || previous.customer_id!==customerId) fail('conflict'); await readHighValueConsent(db,claims,customerId,input.channel,options); return receipt(previous) }
 const now=options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/,'Z')
 try { await db.batch([db.prepare(`INSERT INTO high_value_delivery_commands(command_id,event_id,customer_id,channel,event_type,actor_id,session_id,session_version,payload_hash,consent_version,cost_minor,budget_minor,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(commandId,input.eventId,customerId,input.channel,input.event,claims.identityId,claims.sessionId,claims.sessionVersion,hash,input.consentVersion,pricing.data.smsCostMinor,pricing.data.dailyBudgetMinor,now)]) }
 catch(cause) {
  const current=await readHighValueConsent(db,claims,customerId,input.channel,options)
  if(!current.granted || current.version!==input.consentVersion) fail('consent_required')
  const raced=await lookup()
  if(raced) { if(raced.payload_hash!==hash || raced.customer_id!==customerId) fail('conflict'); return receipt(raced) }
  const duplicate=await db.prepare('SELECT 1 FROM high_value_delivery_commands WHERE event_id=? AND channel=?').bind(input.eventId,input.channel).first()
  if(duplicate) fail('conflict')
  if(cause instanceof Error && cause.message.includes('budget_exceeded')) fail('budget_exceeded')
  fail('unavailable')
 }
 const row=await lookup()
 await readHighValueConsent(db,claims,customerId,input.channel,options)
 if(!row) fail('unavailable')
 return receipt(row)
}
