import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { supportFixture, CLAIMS } from './d1-support-fixture'
import type { GenerateDraftInput, HumanApprovalInput, EvaluateAccuracyInput } from '../../shared/support-copilot'
import {
  generateD1CopilotDraft,
  recordD1CopilotHumanApproval,
  recordD1CopilotAccuracyEvaluation,
  readD1CopilotInteraction
} from '../../workers/support/copilot'

const NOW = '2026-10-29T12:00:00Z'

describe('SUP-019: Support Copilot with citations, human approval, and accuracy evaluation', () => {
  let f: Awaited<ReturnType<typeof supportFixture>>
  let ticketId: string

  beforeEach(async () => {
    f = await supportFixture()
    f.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0110_rca_copilot_audiences.sql', import.meta.url), 'utf8')
    )
    const ticket = await f.ticket()
    const row = f.sqlite.prepare('SELECT id FROM support_tickets WHERE public_ref = ?').get(ticket.publicRef) as {
      id: string
    }
    ticketId = row.id
  })

  afterEach(() => {
    f.sqlite.close()
  })

  it('generates a draft citing ground-truth database facts and passes redaction checks', async () => {
    const input: GenerateDraftInput = {
      ticketId,
      query: 'El cliente pregunta si el pedido ya está en reparto y dónde está el albarán'
    }

    const draft = await generateD1CopilotDraft(f.database, CLAIMS, input, {
      idempotencyKey: 'idemp-draft-1',
      now: () => NOW
    })

    expect(draft.interactionId).toBeDefined()
    expect(draft.contextSummary).toContain('SOP-')

    // Citing facts: citations must not be empty and must reference verified data
    expect(draft.citations.length).toBeGreaterThan(0)
    for (const citation of draft.citations) {
      expect(citation.verified).toBe(true)
      expect(citation.factKey).toBeDefined()
      expect(citation.citationText).toBeDefined()
    }

    // Proposed reply must cite the facts and maintain professional tone
    expect(draft.proposedReply).toContain('[Cita')
    expect(draft.approvalStatus).toBe('pending')

    // Redaction flags check
    expect(draft.redactionFlags.noUnauthorizedRefundCommitment).toBe(true)
    expect(draft.redactionFlags.toneAppropriate).toBe(true)
    expect(draft.redactionFlags.safePiiMasking).toBe(true)
  })

  it('enforces human approval: operator modifies and approves draft', async () => {
    const input: GenerateDraftInput = {
      ticketId,
      query: 'Consulta de entrega'
    }

    const draft = await generateD1CopilotDraft(f.database, CLAIMS, input, {
      idempotencyKey: 'idemp-draft-2',
      now: () => NOW
    })

    const decisionInput: HumanApprovalInput = {
      expectedVersion: 1,
      decision: 'modify_and_approve',
      modifiedReply:
        'Estimado cliente, confirmamos que su pedido está preparado y con albarán emitido. Un cordial saludo, Equipo Neteco.'
    }

    const decision = await recordD1CopilotHumanApproval(f.database, CLAIMS, draft.interactionId, decisionInput, {
      idempotencyKey: 'idemp-decision-1',
      now: () => NOW
    })

    expect(decision.approvalStatus).toBe('modified_and_approved')
    expect(decision.finalSentReply).toBe(decisionInput.modifiedReply)
    expect(decision.humanApprovedAt).toBe(NOW)

    const stored = await readD1CopilotInteraction(f.database, draft.interactionId)
    expect(stored!.approvalStatus).toBe('modified_and_approved')
    expect(stored!.humanApproverId).toBe(CLAIMS.identityId)
  })

  it('enforces human rejection of a proposed draft', async () => {
    const input: GenerateDraftInput = {
      ticketId
    }

    const draft = await generateD1CopilotDraft(f.database, CLAIMS, input, {
      idempotencyKey: 'idemp-draft-reject',
      now: () => NOW
    })

    const decisionInput: HumanApprovalInput = {
      expectedVersion: 1,
      decision: 'reject',
      rejectionReason: 'El operador prefiere responder manualmente debido a solicitud comercial no estándar.'
    }

    const decision = await recordD1CopilotHumanApproval(f.database, CLAIMS, draft.interactionId, decisionInput, {
      idempotencyKey: 'idemp-decision-reject',
      now: () => NOW
    })

    expect(decision.approvalStatus).toBe('rejected')
    expect(decision.finalSentReply).toBeNull()
  })

  it('records accuracy evaluation after human review', async () => {
    const draft = await generateD1CopilotDraft(
      f.database,
      CLAIMS,
      { ticketId },
      {
        idempotencyKey: 'idemp-draft-eval',
        now: () => NOW
      }
    )

    await recordD1CopilotHumanApproval(
      f.database,
      CLAIMS,
      draft.interactionId,
      {
        expectedVersion: 1,
        decision: 'approve'
      },
      {
        idempotencyKey: 'idemp-approve-eval',
        now: () => NOW
      }
    )

    const evalInput: EvaluateAccuracyInput = {
      score: 5,
      evaluation: 'accurate',
      notes: 'Citas exactas de pedido, dirección y estado. No requirió edición.'
    }

    const evalResult = await recordD1CopilotAccuracyEvaluation(f.database, CLAIMS, draft.interactionId, evalInput, {
      idempotencyKey: 'idemp-eval-cmd',
      now: () => NOW
    })

    expect(evalResult.accuracyScore).toBe(5)
    expect(evalResult.accuracyEvaluation).toBe('accurate')

    const stored = await readD1CopilotInteraction(f.database, draft.interactionId)
    expect(stored!.accuracyScore).toBe(5)
    expect(stored!.accuracyEvaluation).toBe('accurate')
    expect(stored!.accuracyNotes).toContain('Citas exactas')
  })

  it('handles idempotency cleanly for copilot generation and decisions', async () => {
    const input: GenerateDraftInput = { ticketId }

    const res1 = await generateD1CopilotDraft(f.database, CLAIMS, input, {
      idempotencyKey: 'idemp-repeat-draft',
      now: () => NOW
    })

    const res2 = await generateD1CopilotDraft(f.database, CLAIMS, input, {
      idempotencyKey: 'idemp-repeat-draft',
      now: () => NOW
    })

    expect(res2.interactionId).toBe(res1.interactionId)
  })
})
