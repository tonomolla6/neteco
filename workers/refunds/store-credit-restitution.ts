import { STORE_CREDIT_POLICY } from '../../shared/store-credit'
import type { RefundContract, RefundReceipt } from '../../shared/order-refunds'
import { refundReceiptSchema } from '../../shared/order-refunds'
import { checked, guard, hash } from './authority'

/**
 * PRI-018 downstream: the store-credit share of a completed refund is given back as store credit.
 *
 * It is a NEW `refund_credit` grant (source_ref `refund:<refundId>`, so the original grants, their expiry
 * and the credit applied to the order stay immutable evidence) with an append-only `issue` ledger entry.
 * The pricing command id IS the refund id: one restitution per refund, enforced by the primary keys and
 * by `refund_store_credit_restitutions` (0153), whose trigger also caps the order's restitutions at the
 * credit applied to it. Expiry: the later of the latest expiry among the grants spent on the order and
 * now + the policy minimum, so a refund never returns credit that is already (or almost) expired.
 * The statements run inside the refund completion batch: the refund completes only together with them.
 */
export async function storeCreditRestitutionStatements(
  database: D1Database,
  contract: RefundContract,
  actorId: string,
  now: string
): Promise<D1PreparedStatement[]> {
  const cents = contract.tender?.storeCreditCents ?? 0
  if (cents < 1) return []
  const refundId = contract.refundId,
    orderId = contract.orderId,
    grantId = crypto.randomUUID(),
    payloadHash = await hash({ action: 'refund_restore', refundId, orderId, cents }),
    customer = '(SELECT customer_id FROM orders WHERE id=?ORDER)'
  const sql = (text: string, order: number) => text.replaceAll('?ORDER', `?${order}`)
  return [
    database
      .prepare(
        sql(
          `INSERT INTO pricing_commands(command_id,actor_id,domain,action,target_id,idempotency_key,expected_version,applied_version,payload_hash,receipt_json,created_at)
           SELECT ?1,?2,'store_credit','refund_restore',a.customer_id,'refund-credit:'||?1,0,a.version+1,?3,
             json_object('commandId',?1,'domain','store_credit','action','refund_restore','targetId',a.customer_id,
               'appliedVersion',a.version+1,'payloadHash',?3,'recordedAt',?4,
               'result',json_object('orderId',?5,'refundId',?1,'grantId',?6,'restoredCents',?7,'source','refund')),?4
           FROM store_credit_accounts a WHERE a.customer_id=${customer}`,
          5
        )
      )
      .bind(refundId, actorId, payloadHash, now, orderId, grantId, cents),
    database
      .prepare(
        sql(
          `INSERT INTO store_credit_grants(id,customer_id,kind,source_ref,amount_cents,remaining_cents,reason,issued_by,issued_at,expires_at)
           SELECT ?1,${customer},'refund_credit','refund:'||?2,?3,?3,?4,?5,?6,
             max(COALESCE((SELECT MAX(g.expires_at) FROM store_credit_ledger l JOIN store_credit_grants g ON g.id=l.grant_id
               WHERE l.order_ref=?7 AND l.entry_type='redeem'),''),
               strftime('%Y-%m-%dT%H:%M:%SZ',?6,'+${STORE_CREDIT_POLICY.minExpiryDays} days'))`,
          7
        )
      )
      .bind(grantId, refundId, cents, `Restitución de saldo de la devolución ${refundId}`, actorId, now, orderId),
    database
      .prepare(
        sql(
          `INSERT INTO store_credit_ledger(customer_id,grant_id,entry_type,amount_cents,order_ref,command_id,created_at)
           SELECT ${customer},?1,'issue',?2,NULL,?3,?4`,
          5
        )
      )
      .bind(grantId, cents, refundId, now, orderId),
    database
      .prepare(
        `UPDATE store_credit_accounts SET
           balance_cents=(SELECT COALESCE(SUM(remaining_cents),0) FROM store_credit_grants
                          WHERE customer_id=store_credit_accounts.customer_id AND voided_at IS NULL),
           version=version+1, updated_at=max(?2,updated_at)
         WHERE customer_id=(SELECT customer_id FROM orders WHERE id=?1)`
      )
      .bind(orderId, now),
    database
      .prepare(
        `INSERT INTO pricing_audit(domain,target_id,action,actor_id,outcome,detail_json,created_at)
         SELECT 'store_credit',customer_id,'refund_restore',?1,'applied',
           json_object('commandId',?2,'refundId',?2,'orderId',?3,'grantId',?4,'restoredCents',?5,'source','refund'),?6
         FROM orders WHERE id=?3`
      )
      .bind(actorId, refundId, orderId, grantId, cents, now),
    database
      .prepare(
        `INSERT INTO refund_store_credit_restitutions(refund_id,order_id,customer_id,grant_id,command_id,amount_cents,created_at)
         SELECT ?1,id,customer_id,?2,?1,?3,?4 FROM orders WHERE id=?5`
      )
      .bind(refundId, grantId, cents, now, orderId),
    // Never complete the refund while silently skipping its store-credit share.
    guard(database, 'EXISTS(SELECT 1 FROM refund_store_credit_restitutions WHERE refund_id=?1 AND amount_cents=?2)', [
      refundId,
      cents
    ])
  ]
}

/** Receipt of a refund with no card share: nothing is sent to the payment provider. */
export function storeCreditOnlyReceipt(contract: RefundContract, fingerprint: string): RefundReceipt {
  return checked(refundReceiptSchema, {
    providerReference: `store-credit:${contract.refundId}`,
    status: 'succeeded',
    amountCents: 0,
    currency: 'EUR',
    merchantOrder: contract.capture.merchantOrder,
    contractFingerprint: fingerprint,
    validationOnly: contract.validationOnly
  }) as RefundReceipt
}
