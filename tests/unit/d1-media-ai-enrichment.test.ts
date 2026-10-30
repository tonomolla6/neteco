import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { aiTestFixture, ADMIN_CLAIMS, OPERATOR_CLAIMS, UNAUTHORIZED_CLAIMS, TEST_ASSET_ID } from './d1-ai-test-fixture'
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

  it('INT-7: an enrichment only applies to the asset it was proposed for', async () => {
    const other = 'aaaaaaaa-0000-4000-8000-00000000beef'
    f.sqlite.exec(
      `INSERT INTO media_assets(id, storage_key, original_name, mime_type, byte_size, checksum_sha256, owner_name,
         source_url, license, authorized_at, rights_status, quarantine_status, alt_text, metadata, created_at)
       SELECT '${other}', 'media/other.jpg', 'other.jpg', mime_type, byte_size, replace(checksum_sha256, '0123', 'fedc'), owner_name,
         source_url, license, authorized_at, rights_status, quarantine_status, 'Alt original', '{}', created_at
       FROM media_assets WHERE id = '${TEST_ASSET_ID}'`
    )
    const proposal = await proposeD1MediaAiEnrichment(
      f.database,
      ADMIN_CLAIMS,
      { assetId: TEST_ASSET_ID, enrichmentType: 'propose_metadata' },
      { idempotencyKey: 'idemp-int7-media-prop', now: () => NOW }
    )
    const decided = await decideD1MediaAiEnrichment(
      f.database,
      ADMIN_CLAIMS,
      proposal.id,
      { expectedVersion: proposal.version, decision: 'approve', humanNotes: 'Revisado por catalogo' },
      { idempotencyKey: 'idemp-int7-media-dec', now: () => NOW }
    )
    await expect(
      applyD1MediaAiEnrichment(
        f.database,
        ADMIN_CLAIMS,
        proposal.id,
        { expectedVersion: decided.version, targetAssetId: other },
        { idempotencyKey: 'idemp-int7-media-apply', now: () => NOW }
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const asset = f.sqlite.prepare('SELECT alt_text, metadata FROM media_assets WHERE id=?').get(other) as {
      alt_text: string
      metadata: string
    }
    expect(asset).toEqual({ alt_text: 'Alt original', metadata: '{}' })
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

  it('rejects unauthorized actors and limited operators without media permissions', async () => {
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

    // Operator lacks media permissions
    await expect(
      proposeD1MediaAiEnrichment(f.database, OPERATOR_CLAIMS, input, {
        idempotencyKey: 'idemp-media-op-unauth',
        now: () => NOW
      })
    ).rejects.toThrow(/unauthorized|permisos/i)
  })

  it('handles reject decision and CAS mismatch on decision and apply', async () => {
    const input: ProposeMediaEnrichmentInput = {
      assetId: TEST_ASSET_ID,
      enrichmentType: 'propose_crops'
    }

    const prop = await proposeD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-media-reject-cas',
      now: () => NOW
    })

    // CAS conflict on decision
    const invalidCas: DecideMediaEnrichmentInput = {
      expectedVersion: 99,
      decision: 'reject',
      humanNotes: 'Versión errónea'
    }

    await expect(
      decideD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, prop.id, invalidCas, {
        idempotencyKey: 'idemp-cas-fail-media-dec',
        now: () => NOW
      })
    ).rejects.toThrow(/concurrency_conflict|versión/i)

    // Valid reject
    const validReject: DecideMediaEnrichmentInput = {
      expectedVersion: prop.version,
      decision: 'reject',
      humanNotes: 'Los recortes cortan el tapón dosificador del envase'
    }

    const rejected = await decideD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, prop.id, validReject, {
      idempotencyKey: 'idemp-valid-reject-media',
      now: () => NOW
    })

    expect(rejected.approvalStatus).toBe('rejected')
    expect(rejected.humanNotes).toContain('tapón dosificador')

    // Cannot apply rejected enrichment
    const applyInput: ApplyMediaEnrichmentInput = {
      expectedVersion: rejected.version,
      targetAssetId: TEST_ASSET_ID
    }

    await expect(
      applyD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, prop.id, applyInput, {
        idempotencyKey: 'idemp-apply-media-rejected-fail',
        now: () => NOW
      })
    ).rejects.toThrow(/not_approved|aprobado/i)
  })

  it('reads and lists media enrichments with filters and handles not found', async () => {
    const input: ProposeMediaEnrichmentInput = {
      assetId: TEST_ASSET_ID,
      enrichmentType: 'remove_background'
    }

    const prop = await proposeD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-read-list-media',
      now: () => NOW
    })

    const read = await readD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, prop.id)
    expect(read.id).toBe(prop.id)
    expect(read.assetId).toBe(TEST_ASSET_ID)

    const list = await listD1MediaAiEnrichments(f.database, ADMIN_CLAIMS, { assetId: TEST_ASSET_ID })
    expect(list.length).toBeGreaterThanOrEqual(1)
    expect(list.some((item) => item.id === prop.id)).toBe(true)

    // Not found
    await expect(readD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, 'non-existent-media-enrich-999999')).rejects.toThrow(
      /not_found|no encontrad/i
    )
  })

  it('fails proposal when asset does not exist', async () => {
    const input: ProposeMediaEnrichmentInput = {
      assetId: 'non-existent-asset-999999999999',
      enrichmentType: 'propose_crops'
    }

    await expect(
      proposeD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, input, {
        idempotencyKey: 'idemp-missing-asset',
        now: () => NOW
      })
    ).rejects.toThrow(/not_found|no encontrado/i)
  })

  it('enforces idempotency replay and detects payload conflicts', async () => {
    const input: ProposeMediaEnrichmentInput = {
      assetId: TEST_ASSET_ID,
      enrichmentType: 'remove_background'
    }

    const first = await proposeD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-media-replay-key',
      now: () => NOW
    })

    const replay = await proposeD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, input, {
      idempotencyKey: 'idemp-media-replay-key',
      now: () => NOW
    })

    expect(replay.id).toBe(first.id)

    // Conflict with modified options
    const conflictingInput: ProposeMediaEnrichmentInput = {
      assetId: TEST_ASSET_ID,
      enrichmentType: 'propose_crops'
    }

    await expect(
      proposeD1MediaAiEnrichment(f.database, ADMIN_CLAIMS, conflictingInput, {
        idempotencyKey: 'idemp-media-replay-key',
        now: () => NOW
      })
    ).rejects.toThrow(/idempotency_conflict|clave/i)
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
