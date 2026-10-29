import { z } from 'zod'
import {
  previewSchema,
  createRuleSchema,
  recordEvidenceSchema,
  ruleTransitionSchema
} from '../../shared/edge-personalization'
import { recordExperimentSchema, registerScriptSchema, removeScriptSchema } from '../../shared/third-party-value'
import { PerformanceInsightError } from '../../shared/performance-insights-error'
import { readD1CatalogCacheStats } from './b2b-catalog-cache'
import {
  createD1EdgeRule,
  disableD1EdgeRule,
  enableD1EdgeRule,
  listD1EdgeRules,
  recordD1EdgeEvidence,
  resolveD1EdgePersonalization
} from './edge-personalization'
import {
  listD1ThirdPartyScripts,
  readD1ThirdPartyManifest,
  recordD1ThirdPartyExperiment,
  registerD1ThirdPartyScript,
  removeD1ThirdPartyScript
} from './third-party-value'
import { errorJson, guard, json, mapError, ownsPath, parseBody, type InsightsHttpDependencies } from './http-common'

const PREFIX = /^\/api\/admin\/performance\/(?:third-parties|b2b-cache|edge-personalization)(?:\/|$)/
const ROOT = /^\/api\/admin\/performance\//
const runtimePreviewSchema = previewSchema.extend({ killSwitch: z.boolean().optional() }).strict()

export function ownsPerformanceInsightsNamespace(path: string): boolean {
  return ownsPath(path, PREFIX)
}

/** PER-022 / PER-023 / PER-025 admin API. */
export async function handlePerformanceInsightsHttp(
  request: Request,
  deps: InsightsHttpDependencies
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!ownsPerformanceInsightsNamespace(url.pathname)) return null
  try {
    const checked = await guard(request, deps)
    if (checked instanceof Response) return checked
    const { claims, now } = checked
    const options = { now }
    const route = url.pathname.replace(ROOT, '').replace(/\/$/, '')
    const method = request.method
    if (method !== 'GET' && method !== 'POST') return errorJson('method_not_allowed', 405)

    if (method === 'GET') {
      switch (route) {
        case 'third-parties':
          return json({ scripts: await listD1ThirdPartyScripts(deps.database) })
        case 'third-parties/manifest':
          return json({ scripts: await readD1ThirdPartyManifest(deps.database) })
        case 'b2b-cache/stats': {
          const raw = url.searchParams.get('days')
          let days: number | undefined
          if (raw !== null) {
            if (!/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > 90)
              throw new PerformanceInsightError('invalid_input', 400, 'days must be 1..90')
            days = Number(raw)
          }
          return json({ stats: await readD1CatalogCacheStats(deps.database, { now, days }) })
        }
        case 'edge-personalization/rules':
          return json({ rules: await listD1EdgeRules(deps.database) })
        default:
          return errorJson('not_found', 404)
      }
    }

    switch (route) {
      case 'third-parties/scripts':
        return json({
          script: await registerD1ThirdPartyScript(
            deps.database,
            claims,
            await parseBody(request, registerScriptSchema),
            options
          )
        })
      case 'third-parties/experiments':
        return json({
          experiment: await recordD1ThirdPartyExperiment(
            deps.database,
            claims,
            await parseBody(request, recordExperimentSchema),
            options
          )
        })
      case 'third-parties/remove':
        return json({
          script: await removeD1ThirdPartyScript(
            deps.database,
            claims,
            await parseBody(request, removeScriptSchema),
            options
          )
        })
      case 'edge-personalization/rules':
        return json({
          rule: await createD1EdgeRule(deps.database, claims, await parseBody(request, createRuleSchema), options)
        })
      case 'edge-personalization/rules/evidence':
        return json({
          evidence: await recordD1EdgeEvidence(
            deps.database,
            claims,
            await parseBody(request, recordEvidenceSchema),
            options
          )
        })
      case 'edge-personalization/rules/enable':
        return json({
          rule: await enableD1EdgeRule(deps.database, claims, await parseBody(request, ruleTransitionSchema), options)
        })
      case 'edge-personalization/rules/disable':
        return json({
          rule: await disableD1EdgeRule(deps.database, claims, await parseBody(request, ruleTransitionSchema), options)
        })
      case 'edge-personalization/preview':
        return json({
          resolution: await resolveD1EdgePersonalization(deps.database, await parseBody(request, runtimePreviewSchema))
        })
      default:
        return errorJson('not_found', 404)
    }
  } catch (error) {
    return mapError(error)
  }
}
