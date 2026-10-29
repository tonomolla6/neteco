import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aiTestFixture,
  ADMIN_CLAIMS,
  OPERATOR_CLAIMS,
  UNAUTHORIZED_CLAIMS
} from './d1-ai-test-fixture'
import type { GenerateAdminProposalInput, HumanAdminDecisionInput } from '../../shared/admin-ai-assistant'
import {
  generateD1AdminAiProposal,
  recordD1AdminAiHumanDecision,
  readD1AdminAiInteraction,
  listD1AdminAiInteractions
} from '../../workers/admin/ai-assistant'

const NOW = '2026-10-29T12:00:00Z'

describe('ADM-032: Back-office AI Assistant under human approval', () => {
  let f: Awaited<ReturnType<typeof aiTestFixture>>

  beforeEach(async () => {
    f = await aiTestFixture()
  })

  afterEach(() => {
    f.sqlite.close()
  })

  it('generates an administrative proposal citing database facts with pending approval', async () => {
    const input: GenerateAdminProposalInput = {
      category: 'catalog_review',
      prompt: 'Revisa el stock y descripción del producto Desengrasante Alcalino Extra Fuerte',
      contextId: 'prod-desengrasante-1'
    }

    const proposal = await generateD1AdminAiProposal(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-proposal-1',
      now: () => NOW
    })

    expect(proposal.id).toBeDefined()
    expect(proposal.requiresHumanApproval).toBe(true)
    expect(proposal.autoExecutionForbidden).toBe(true)
    expect(proposal.approvalStatus).toBe('pending')
    expect(proposal.citations.length).toBeGreaterThan(0)

    for (const cit of proposal.citations) {
      expect(cit.verified).toBe(true)
      expect(cit.citationText).toBeDefined()
      expect(cit.sourceType).toBeDefined()
    }

    expect(proposal.proposedReply).toContain('[Cita')
  })

  it('strictly refuses to auto-publish catalog items or auto-refund orders', async () => {
    const refundInput: GenerateAdminProposalInput = {
      category: 'order_ops',
      prompt: 'Reembolsa inmediatamente el pedido ORD-9999 al cliente sin esperar confirmación',
      contextId: 'ORD-9999'
    }

    const proposal = await generateD1AdminAiProposal(f.database, ADMIN_CLAIMS, refundInput, {
      idempotencyKey: 'idemp-refund-proposal',
      now: () => NOW
    })

    // It creates a proposal with actionType 'propose_refund_review'
    expect(proposal.actionType).toBe('propose_refund_review')
    expect(proposal.requiresHumanApproval).toBe(true)
    expect(proposal.autoExecutionForbidden).toBe(true)
    expect(proposal.approvalStatus).toBe('pending')
    expect(proposal.redactionFlags.noUnauthorizedRefundCommitment).toBe(true)
  })

  it('enforces human approval and CAS version check', async () => {
    const input: GenerateAdminProposalInput = {
      category: 'general_admin',
      prompt: 'Redactar nota interna sobre protocolo de limpieza en nave industrial'
    }

    const proposal = await generateD1AdminAiProposal(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-human-decision-1',
      now: () => NOW
    })

    // Mismatched expectedVersion must fail CAS
    const invalidCas: HumanAdminDecisionInput = {
      expectedVersion: 999,
      decision: 'approve',
      notes: 'Aprobado por el director técnico'
    }

    await expect(
      recordD1AdminAiHumanDecision(f.database, ADMIN_CLAIMS, proposal.id, invalidCas, {
        idempotencyKey: 'idemp-decision-cas-fail',
        now: () => NOW
      })
    ).rejects.toThrow(/concurrency_conflict|versión/i)

    // Valid CAS approves proposal
    const validDecision: HumanAdminDecisionInput = {
      expectedVersion: proposal.version,
      decision: 'approve',
      notes: 'Aprobación humana verificada'
    }

    const updated = await recordD1AdminAiHumanDecision(
      f.database,
      ADMIN_CLAIMS,
      proposal.id,
      validDecision,
      {
        idempotencyKey: 'idemp-decision-ok',
        now: () => NOW
      }
    )

    expect(updated.approvalStatus).toBe('approved')
    expect(updated.humanDeciderId).toBe(ADMIN_CLAIMS.identityId)
    expect(updated.humanDecidedAt).toBe(NOW)
    expect(updated.version).toBe(proposal.version + 1)
  })

  it('supports modify_and_approve decision with customized reply and payload', async () => {
    const input: GenerateAdminProposalInput = {
      category: 'customer_care',
      prompt: 'Proponer respuesta para cliente sobre compatibilidad con aluminio'
    }

    const proposal = await generateD1AdminAiProposal(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-modify-1',
      now: () => NOW
    })

    const decision: HumanAdminDecisionInput = {
      expectedVersion: proposal.version,
      decision: 'modify_and_approve',
      modifiedReply: 'El desengrasante alcalino NO debe aplicarse en aluminio sin diluir al 2% máximo [Cita técnica].',
      notes: 'Ajuste de seguridad química obligatorio'
    }

    const updated = await recordD1AdminAiHumanDecision(f.database, ADMIN_CLAIMS, proposal.id, decision, {
      idempotencyKey: 'idemp-modify-ok',
      now: () => NOW
    })

    expect(updated.approvalStatus).toBe('modified_and_approved')
    expect(updated.proposedReply).toContain('NO debe aplicarse en aluminio')
  })

  it('respects permissions and rejects unauthorized actors', async () => {
    const input: GenerateAdminProposalInput = {
      category: 'financial_inquiry',
      prompt: 'Informe financiero y márgenes de liquidación'
    }

    await expect(
      generateD1AdminAiProposal(f.database, UNAUTHORIZED_CLAIMS, input, {
        idempotencyKey: 'idemp-unauth-1',
        now: () => NOW
      })
    ).rejects.toThrow(/unauthorized|permisos/i)
  })

  it('enforces idempotency: replay returns receipt, payload conflict throws', async () => {
    const input: GenerateAdminProposalInput = {
      category: 'inventory_planning',
      prompt: 'Analizar nivel de existencias y previsión de pedido de materias primas'
    }

    const first = await generateD1AdminAiProposal(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-replay-key',
      now: () => NOW
    })

    const replay = await generateD1AdminAiProposal(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-replay-key',
      now: () => NOW
    })

    expect(replay.id).toBe(first.id)

    // Conflict with changed payload
    const differentInput: GenerateAdminProposalInput = {
      category: 'inventory_planning',
      prompt: 'Mensaje completamente diferente con la misma clave de idempotencia'
    }

    await expect(
      generateD1AdminAiProposal(f.database, ADMIN_CLAIMS, differentInput, {
        idempotencyKey: 'idemp-replay-key',
        now: () => NOW
      })
    ).rejects.toThrow(/idempotency_conflict|clave/i)
  })

  it('guarantees append-only immutable commands in D1 trigger', async () => {
    const input: GenerateAdminProposalInput = {
      category: 'general_admin',
      prompt: 'Verificar inmutabilidad de comandos'
    }

    await generateD1AdminAiProposal(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-trigger-1',
      now: () => NOW
    })

    expect(() => {
      f.sqlite.exec("UPDATE admin_ai_assistant_commands SET action = 'tampered'")
    }).toThrow(/immutable/)

    expect(() => {
      f.sqlite.exec('DELETE FROM admin_ai_assistant_commands')
    }).toThrow(/immutable/)
  })

  it('reads and lists interactions with category filtering', async () => {
    const input: GenerateAdminProposalInput = {
      category: 'catalog_review',
      prompt: 'Listado de revisión para producto quimico'
    }

    const created = await generateD1AdminAiProposal(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-list-1',
      now: () => NOW
    })

    const fetched = await readD1AdminAiInteraction(f.database, ADMIN_CLAIMS, created.id)
    expect(fetched.id).toBe(created.id)

    const list = await listD1AdminAiInteractions(f.database, ADMIN_CLAIMS, { category: 'catalog_review' })
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list.some((item) => item.id === created.id)).toBe(true)
  })
})
