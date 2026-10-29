import {
  decideD1AiopsRecommendation,
  ingestD1AiopsSignal,
  listD1AiopsRecommendations,
  listD1AiopsSignals,
  readD1AiopsPrecision,
  recordD1AiopsOutcome,
  runD1AiopsCorrelation
} from './aiops'
import {
  correlateSchema,
  decideRecommendationSchema,
  ingestSignalSchema,
  recordOutcomeSchema
} from '../../shared/aiops-recommendations'
import {
  errorJson,
  guard,
  json,
  mapError,
  ownsPath,
  parseBody,
  type InsightsHttpDependencies
} from '../performance/http-common'

const PREFIX = /^\/api\/admin\/observability\/aiops(?:\/|$)/

export function ownsAiopsNamespace(path: string): boolean {
  return ownsPath(path, PREFIX)
}

/** OBS-030 admin API. Recommendation only: no endpoint executes an operational action. */
export async function handleAiopsHttp(request: Request, deps: InsightsHttpDependencies): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (!ownsAiopsNamespace(path)) return null
  try {
    const checked = await guard(request, deps)
    if (checked instanceof Response) return checked
    const { claims, now } = checked
    const options = { now }
    const sub = path.replace(/^\/api\/admin\/observability\/aiops\/?/, '').replace(/\/$/, '')
    if (request.method === 'GET') {
      if (sub === 'signals') return json({ signals: await listD1AiopsSignals(deps.database) })
      if (sub === 'recommendations' || sub === '')
        return json({ recommendations: await listD1AiopsRecommendations(deps.database) })
      if (sub === 'precision') return json({ precision: await readD1AiopsPrecision(deps.database) })
      return errorJson('not_found', 404)
    }
    if (request.method === 'POST') {
      switch (sub) {
        case 'signals':
          return json({
            signal: await ingestD1AiopsSignal(
              deps.database,
              claims,
              await parseBody(request, ingestSignalSchema),
              options
            )
          })
        case 'correlate':
          return json(
            await runD1AiopsCorrelation(deps.database, claims, await parseBody(request, correlateSchema), options)
          )
        case 'recommendations/decide':
          return json({
            recommendation: await decideD1AiopsRecommendation(
              deps.database,
              claims,
              await parseBody(request, decideRecommendationSchema),
              options
            )
          })
        case 'recommendations/outcome':
          return json({
            recommendation: await recordD1AiopsOutcome(
              deps.database,
              claims,
              await parseBody(request, recordOutcomeSchema),
              options
            )
          })
        default:
          return errorJson('not_found', 404)
      }
    }
    return errorJson('method_not_allowed', 405)
  } catch (error) {
    return mapError(error)
  }
}
