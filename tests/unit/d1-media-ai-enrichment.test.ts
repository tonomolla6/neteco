import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aiTestFixture,
  ADMIN_CLAIMS,
  UNAUTHORIZED_CLAIMS,
  TEST_ASSET_ID
} from './d1-ai-test-fixture'
import type {
  ProposeMediaEnrichmentInput,
  DecideMediaEnrichmentInput,
  ApplyMediaEnrichmentInput
} from '../../shared/media-ai-enrichment'
import {
  proposeD1MediaAiEnrichment,
  decideD1MediaAiEnrichment,
  applyD1MediaAiEnrichment,
  readD1MediaAiEnrichment,
  listD1MediaAiEnrichments
} from '../../workers/catalog/media-ai-enrichment'

const NOW = '2026-10-29T12:00:00Z'

describe('MED-023: Assisted visual enrichment under human approval', () => {
  let f: Awaited<ReturnType<typeof aiTestFixture>>

  beforeEach(async () => {
    f = await aiTestFixture()
  })

  afterEach(() => {
    f.sqlite.close()
  })

  it('generates background removal, crops and alt-text proposals under pending approval', async () => {
    const input: ProposeMediaEnrichmentInput = {
      assetId: TEST_ASSET_ID,
      enrichmentType: 'full_visual_enrichment',
      options: {
        contextProductName: 'Desengrasante Alcalino Extra Fuerte',
        targetAspectRatio: '1:1'
      }
    }

    const proposal = await proposeD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-media-prop-1',
      now: () => NOW
    })

    expect(proposal.id).toBeDefined()
    expect(proposal.approvalStatus).toBe('pending_approval')
    expect(proposal.requiresHumanApproval).toBe(true)

    // Background removal proposal
    expect(proposal.backgroundRemoval).toBeDefined()
    expect(proposal.backgroundRemoval?.backgroundType).toBe('transparent')
    expect(proposal.backgroundRemoval?.noPackagingInvented).toBe(true)

    // Crops proposal
    expect(proposal.proposedCrops).toBeDefined()
    expect(proposal.proposedCrops?.some((c) => c.ratio === '1:1')).toBe(true)

    // Proposed metadata
    expect(proposal.proposedMetadata).toBeDefined()
    expect(proposal.proposedMetadata?.suggestedAltText).toContain('Desengrasante')
    expect(proposal.proposedMetadata?.noFictionalClaimsOrBadges).toBe(true)

    // Prohibited invention check
    expect(proposal.prohibitedInventionCheck.passed).toBe(true)
    expect(proposal.prohibitedInventionCheck.noInventedPackaging).toBe(true)
    expect(proposal.prohibitedInventionCheck.noInventedClaims).toBe(true)
  })

  it('strictly rejects prompts attempting to invent packaging, claims, or uncertified uses', async () => {
    const prohibitedInput: ProposeMediaEnrichmentInput = {
      assetId: TEST_ASSET_ID,
      enrichmentType: 'full_visual_enrichment',
      options: {
        instruction: 'inventar envase virtual 3D con sello 100% ecológico garantizado'
      }
    }

    await expect(
      proposeD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, prohibitedInput, {
        idempotencyKey: 'idemp-prohibited-invention',
        now: () => NOW
      })
    ).rejects.toThrow(/prohibited_invention_detected|inventar/i)
  })

  it('blocks applying enrichment to media asset without prior human approval', async () => {
    const input: ProposeMediaEnrichmentInput = {
      assetId: TEST_ASSET_ID,
      enrichmentType: 'propose_metadata'
    }

    const proposal = await proposeD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-unapproved-media-apply',
      now: () => NOW
    })

    const applyInput: ApplyMediaEnrichmentInput = {
      expectedVersion: proposal.version,
      targetAssetId: TEST_ASSET_ID
    }

    await expect(
      applyD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, proposal.id, applyInput, {
        idempotencyKey: 'idemp-media-apply-fail',
        now: () => NOW
      })
    ).rejects.toThrow(/not_approved|aprobad/i)
  })

  it('allows human decision and applies approved alt-text and crops to media asset', async () => {
    const input: ProposeMediaEnrichmentInput = {
      assetId: TEST_ASSET_ID,
      enrichmentType: 'full_visual_enrichment'
    }

    const proposal = await proposeD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-media-decision-flow',
      now: () => NOW
    })

    // Decision: approve with customized alt text
    const decision: DecideMediaEnrichmentInput = {
      expectedVersion: proposal.version,
      decision: 'modify_and_approve',
      humanNotes: 'Verificado que no inventa envases ni claims comerciales',
      modifiedAltText: 'Garrafa homologada de 5L con precinto de seguridad'
    }

    const decided = await decideD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, proposal.id, decision, {
      idempotencyKey: 'idemp-media-decision-ok',
      now: () => NOW
    })

    expect(decided.approvalStatus).toBe('modified_and_approved')
    expect(decided.humanDeciderId).toBe(ADMIN_CLAIMS.identityId)

    // Now apply to asset
    const applyInput: ApplyMediaEnrichmentInput = {
      expectedVersion: decided.version,
      targetAssetId: TEST_ASSET_ID
    }

    const applied = await applyD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, proposal.id, applyInput, {
      idempotencyKey: 'idemp-media-apply-success',
      now: () => NOW
    })

    expect(applied.applied).toBe(true)
    expect(applied.assetId).toBe(TEST_ASSET_ID)

    // Verify media_assets in D1 was updated
    const assetRow = f.sqlite
      .prepare('SELECT alt_text, metadata FROM media_assets WHERE id = ?')
      .get(TEST_ASSET_ID) as { alt_text: string; metadata: string }

    expect(assetRow.alt_text).toBe('Garrafa homologada de 5L con precinto de seguridad')
    expect(assetRow.metadata).toContain('aiEnrichment')
  })

  it('rejects unauthorized actors without media permissions', async () => {
    const input: ProposeMediaEnrichmentInput = {
      assetId: TEST_ASSET_ID,
      enrichmentType: 'propose_crops'
    }

    await expect(
      proposeD1MediaAiEnrichment(f.database, UNAUTHORIZED_CLAIMS, input, {
        idempotencyKey: 'idemp-media-unauth',
        now: () => NOW
      })
    ).rejects.toThrow(/unauthorized|permisos/i)
  })

  it('guarantees append-only immutable commands in D1 trigger', async () => {
    const input: ProposeMediaEnrichmentInput = {
      assetId: TEST_ASSET_ID,
      enrichmentType: 'remove_background'
    }

    await proposeD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-media-trigger-test',
      now: () => NOW
    })

    expect(() => {
      f.sqlite.exec("UPDATE media_ai_enrichment_commands SET action = 'tampered'")
    }).toThrow(/immutable/)

    expect(() => {
      f.sqlite.exec('DELETE FROM media_ai_enrichment_commands')
    }).toThrow(/immutable/)
  })
})
