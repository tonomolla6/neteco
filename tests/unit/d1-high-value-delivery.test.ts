import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { executeHighValueConsent } from '../../workers/communications/high-value-consent'
import { dispatchHighValueMessage } from '../../workers/communications/high-value-delivery'
let f: Awaited<ReturnType<typeof returnsFixture>>
const consentId='11111111-1111-4111-8111-111111111111', key='22222222-2222-4222-8222-222222222222', second='33333333-3333-4333-8333-333333333333', event='44444444-4444-4444-8444-444444444444'
const options = () => ({ now: () => utc(), pricing: { smsCostMinor: 5, dailyBudgetMinor: 5 }, transport: 'local-fake' as const })
const input = { eventId: event, event: 'recall', channel: 'sms', consentVersion: 1 } as const
beforeEach(async () => { f=await returnsFixture(); f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql','utf8')); f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql','utf8')) })
afterEach(() => f?.sqlite.close())
const grant = () => executeHighValueConsent(f.database, CLAIMS, CUSTOMER, consentId, { channel:'sms', expectedVersion:0, action:'grant', proof:'case-verified-123' }, options())
const send = (raw: unknown=input, id=key, claims=CLAIMS) => dispatchHighValueMessage(f.database,claims,CUSTOMER,id,raw,options())
it('fails closed without a consent record', async () => { await expect(send()).rejects.toMatchObject({ code:'consent_required' }) })
it('stores one deterministic fake dispatch and exact replay', async () => { await grant(); const result=await send(); expect(result).toMatchObject({ status:'simulated', costMinor:5, channel:'sms' }); expect(await send()).toEqual(result); expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_delivery_commands').get()).toEqual({ n:1 }) })
it('rejects reused commands with changed payload and a duplicate event with another key', async () => { await grant(); await send(); await expect(send({ ...input, event:'security_alert' })).rejects.toMatchObject({ code:'conflict' }); await expect(send(input,second)).rejects.toMatchObject({ code:'conflict' }) })
it('enforces the shared daily budget without consuming more', async () => { await grant(); await send(); await expect(send({ ...input, eventId: '55555555-5555-4555-8555-555555555555' },second)).rejects.toMatchObject({ code:'budget_exceeded' }); expect(f.sqlite.prepare('SELECT sum(cost_minor) total FROM high_value_delivery_commands').get()).toEqual({ total:5 }) })
it('checks opt-out before each dispatch', async () => { await grant(); await executeHighValueConsent(f.database, CLAIMS, CUSTOMER, second, { channel:'sms', expectedVersion:1, action:'revoke', proof:'case-revoked-123' }, options()); await expect(send()).rejects.toMatchObject({ code:'consent_required' }) })
it('rejects a stale consent version', async () => { await grant(); await expect(send({ ...input, consentVersion:0 })).rejects.toMatchObject({ code:'consent_required' }) })
it('checks authorization live', async () => { await grant(); await expect(send(input,key,BUYER_CLAIMS)).rejects.toMatchObject({ code:'mfa_required' }) })
it.each([{...input,event:'promotion'}, {...input,eventId:'bad'}, {...input,costMinor:0}, {...input,consentVersion:-1}, {...input,channel:'whatsapp'}])('rejects invalid client input %j', async raw => { await grant(); await expect(send(raw)).rejects.toMatchObject({ code:'invalid_input' }) })
it('fails closed on disabled or forged transport configuration', async () => { await grant(); await expect(dispatchHighValueMessage(f.database,CLAIMS,CUSTOMER,key,input,{ ...options(), transport:'disabled' })).rejects.toMatchObject({ code:'delivery_disabled' }) })
it('rechecks consent at the atomic write after a concurrent revocation', async () => { await grant(); const batch=f.database.batch.bind(f.database); let first=true; f.database.batch=async statements => { if(first) { first=false; await executeHighValueConsent(f.database,CLAIMS,CUSTOMER,second,{ channel:'sms', expectedVersion:1, action:'revoke', proof:'case-revoked-123' },options()) }; return batch(statements) }; await expect(send()).rejects.toMatchObject({ code:'consent_required' }); expect(f.sqlite.prepare('SELECT count(*) n FROM high_value_delivery_commands').get()).toEqual({ n:0 }) })
