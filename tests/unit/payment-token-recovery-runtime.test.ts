import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BUYER_CLAIMS, CUSTOMER, returnsFixture, utc } from './d1-returns-fixture'
import { requestPaymentTokenRemoval } from '../../workers/payments/token-removal'
import { runConfiguredTokenRemovalRecovery } from '../../workers/payments/token-removal-runtime'
let f: Awaited<ReturnType<typeof returnsFixture>>
const id='40000000-0000-4000-8000-000000000022',key='50000000-0000-4000-8000-000000000022'
beforeEach(async()=>{
 f=await returnsFixture()
 f.sqlite.exec(await readFile('db/d1/migrations/0126_payment_extended.sql','utf8'))
 f.sqlite.prepare(`INSERT INTO payment_saved_tokens(id,customer_id,provider_token,status,version,consent_version,consented_at,created_at,updated_at) VALUES(?,?,?,'active',1,'v1',?,?,?)`).run(id,CUSTOMER,'synthetic-reference',utc(),utc(),utc())
 await requestPaymentTokenRemoval(f.database,BUYER_CLAIMS,{tokenId:id,expectedVersion:1,commandId:key},{now:()=>utc()})
})
afterEach(()=>f?.sqlite.close())
it('never calls a provider when disabled',async()=>{
 const fetch=vi.fn()
 expect(await runConfiguredTokenRemovalRecovery({DB:f.database,PAYMENT_TOKEN_REMOVAL_ENABLED:'false',PAYMENT_TOKEN_DELETION:{fetch}},utc())).toEqual({enabled:false})
 expect(fetch).not.toHaveBeenCalled()
})
it('fails closed if enabled without an internal service binding',async()=>{
 await expect(runConfiguredTokenRemovalRecovery({DB:f.database,PAYMENT_TOKEN_REMOVAL_ENABLED:'true'},utc())).rejects.toMatchObject({code:'unavailable'})
 expect(f.sqlite.prepare('SELECT status FROM payment_saved_tokens WHERE id=?').get(id)).toMatchObject({status:'removal_pending'})
})
it('dispatches via injected internal binding and records only provider confirmation',async()=>{
 const fetch=vi.fn(async(request:Request)=>{
  expect(new URL(request.url).host).toBe('payment-token-deletion.internal')
  expect(await request.json()).toEqual({providerToken:'synthetic-reference',idempotencyKey:`payment-token-removal:${id}`})
  return Response.json({outcome:'deleted'})
 })
 const result=await runConfiguredTokenRemovalRecovery({DB:f.database,PAYMENT_TOKEN_REMOVAL_ENABLED:'true',PAYMENT_TOKEN_DELETION:{fetch}},utc())
 expect(result).toEqual({enabled:true,claimed:1,removed:1,pending:0,failed:0})
 expect(f.sqlite.prepare('SELECT status,provider_token FROM payment_saved_tokens WHERE id=?').get(id)).toMatchObject({status:'removed',provider_token:null})
})
it.each([500,401])('does not confirm provider deletion for HTTP %s',async(status)=>{
 const fetch=vi.fn(async()=>Response.json({outcome:'deleted'},{status}))
 expect(await runConfiguredTokenRemovalRecovery({DB:f.database,PAYMENT_TOKEN_REMOVAL_ENABLED:'true',PAYMENT_TOKEN_DELETION:{fetch}},utc())).toMatchObject({failed:1,removed:0})
 expect(f.sqlite.prepare('SELECT status FROM payment_saved_tokens WHERE id=?').get(id)).toMatchObject({status:'removal_pending'})
})
it.each([{outcome:'deleted',extra:'x'}, {outcome:'unknown'}, null])('rejects invalid adapter response %#',async(body)=>{
 const fetch=vi.fn(async()=>Response.json(body))
 expect(await runConfiguredTokenRemovalRecovery({DB:f.database,PAYMENT_TOKEN_REMOVAL_ENABLED:'true',PAYMENT_TOKEN_DELETION:{fetch}},utc())).toMatchObject({failed:1,removed:0})
})
