import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  evaluateModelGate,
  getExplainabilityReport,
  getModelEvaluationSummary,
  recordOfflineEvaluation,
  recordOnlineEvaluation,
  registerMlModel,
  runAiGoldenSetEvaluation,
  ModelEvaluationError
} from '../../workers/analytics/model-evaluation'
import {
  ADMIN_IDENTITY,
  NOW,
  OTHER_IDENTITY,
  PROD_DEGREASER,
  createPredictivePersonalizationWorld,
  type PredictivePersonalizationWorld
} from './predictive-personalization-fixture'

let world: PredictivePersonalizationWorld

beforeEach(async () => {
  world = await createPredictivePersonalizationWorld()
})

afterEach(() => {
  world.close()
})

const code = (e: unknown) => (e instanceof ModelEvaluationError ? e.code : `unknown:${String(e)}`)
const fails = (p: Promise<unknown>) => p.then(() => 'resolved', code)

describe('DAT-023: Propensity & Recommendation Models Evaluation (Margin/Retention)', () => {
  it('registers models with multi-objective weights prioritizing margin and retention', async () => {
    // Non-admin rejected
    expect(
      await fails(
        registerMlModel(world.db, {
          actorId: OTHER_IDENTITY,
          now: NOW,
          input: {
            id: 'mod-margin-retention-v1',
            modelName: 'B2B Chemical Repurchase & Margin Optimizer',
            modelVersion: '1.0.0',
            modelType: 'margin_recommendation',
            objective: 'margin_retention',
            weights: { margin: 0.5, retention: 0.3, clicks: 0.2 },
            fallbackStrategy: 'static_bestsellers'
          }
        })
      )
    ).toBe('forbidden')

    // Admin succeeds
    const model = await registerMlModel(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        id: 'mod-margin-retention-v1',
        modelName: 'B2B Chemical Repurchase & Margin Optimizer',
        modelVersion: '1.0.0',
        modelType: 'margin_recommendation',
        objective: 'margin_retention',
        weights: { margin: 0.5, retention: 0.3, clicks: 0.2 },
        fallbackStrategy: 'static_bestsellers'
      }
    })

    expect(model.id).toBe('mod-margin-retention-v1')
    expect(model.weights.margin).toBe(0.5)
    expect(model.weights.retention).toBe(0.3)
    expect(model.weights.clicks).toBe(0.2)
  })

  it('records offline and online evaluations, computing drift and bias metrics', async () => {
    await registerMlModel(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        id: 'mod-repurchase-v1',
        modelName: 'Repurchase Propensity',
        modelVersion: '1.0.0',
        modelType: 'repurchase_propensity',
        objective: 'margin_retention',
        weights: { margin: 0.6, retention: 0.3, clicks: 0.1 },
        fallbackStrategy: 'category_margin_top'
      }
    })

    // Record offline evaluation (AUC, Precision, simulated margin lift)
    const offlineEval = await recordOfflineEvaluation(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      modelId: 'mod-repurchase-v1',
      metrics: {
        rocAuc: 0.88,
        precisionAtK: 0.82,
        recallAtK: 0.79,
        simulatedMarginLiftPercent: 14.5
      },
      driftPsi: 0.05,
      biasDisparateImpact: 0.94,
      sampleSize: 10000
    })

    expect(offlineEval.status).toBe('healthy')
    expect(offlineEval.evalType).toBe('offline')

    // Record online evaluation (CTR, conversion, margin lift, retention)
    const onlineEval = await recordOnlineEvaluation(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      modelId: 'mod-repurchase-v1',
      metrics: {
        ctr: 0.084,
        conversionRate: 0.038,
        retentionLiftPercent: 8.2,
        marginLiftPercent: 12.1
      },
      driftPsi: 0.06,
      biasDisparateImpact: 0.92,
      sampleSize: 25000
    })

    expect(onlineEval.status).toBe('healthy')
    expect(onlineEval.marginLiftPercent).toBe(12.1)

    // Summary aggregates both offline and online
    const summary = await getModelEvaluationSummary(world.db, {
      modelId: 'mod-repurchase-v1'
    })
    expect(summary.offline).toBeDefined()
    expect(summary.online).toBeDefined()
    expect(summary.healthy).toBe(true)
  })

  it('detects high drift when PSI exceeds threshold and flags degraded status', async () => {
    await registerMlModel(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        id: 'mod-drifted-v1',
        modelName: 'Drifted Model',
        modelVersion: '1.0.0',
        modelType: 'margin_recommendation',
        objective: 'margin_retention',
        weights: { margin: 0.5, retention: 0.3, clicks: 0.2 },
        fallbackStrategy: 'static_bestsellers'
      }
    })

    const evaluation = await recordOnlineEvaluation(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      modelId: 'mod-drifted-v1',
      metrics: { ctr: 0.02, conversionRate: 0.01 },
      driftPsi: 0.32, // High drift (> 0.25)
      biasDisparateImpact: 0.91,
      sampleSize: 5000
    })

    expect(evaluation.status).toBe('drift_detected')
  })

  it('provides explainability breakdown showing feature contributions and margin vs clicks weights', async () => {
    const report = await getExplainabilityReport({
      customerId: 'cust-turia',
      productId: PROD_DEGREASER,
      modelWeights: { margin: 0.5, retention: 0.3, clicks: 0.2 },
      features: {
        daysSinceLastOrder: 28,
        expectedReplenishmentCycleDays: 30,
        historicalSectorMarginPercent: 38,
        catalogPopularityScore: 0.75
      }
    })

    expect(report.topContributingFactors.length).toBeGreaterThan(0)
    expect(report.objectiveBreakdown.marginContribution).toBeGreaterThan(0)
    expect(report.objectiveBreakdown.retentionContribution).toBeGreaterThan(0)
    expect(report.objectiveBreakdown.marginContribution).toBeGreaterThan(report.objectiveBreakdown.clicksContribution)
  })
})

describe('TST-044: Continuous AI Model Evaluation & Quality Gate', () => {
  it('executes golden set evaluation verifying factuality, chemical safety, bias, latency and fallback', async () => {
    await registerMlModel(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        id: 'mod-copilot-candidate',
        modelName: 'Chemical Copilot Assistant',
        modelVersion: '2.1.0',
        modelType: 'catalog_copilot_assistant',
        objective: 'factuality_safety',
        weights: { margin: 0.4, retention: 0.3, clicks: 0.3 },
        fallbackStrategy: 'rules_safety_default'
      }
    })

    // Execute golden set evaluation
    const evalRun = await runAiGoldenSetEvaluation(world.db, {
      actorId: ADMIN_IDENTITY,
      modelId: 'mod-copilot-candidate',
      suiteName: 'neteco_chemical_golden_suite_v1',
      now: NOW
    })

    expect(evalRun.factualityScore).toBeGreaterThanOrEqual(0.95)
    expect(evalRun.safetyScore).toBe(1.0)
    expect(evalRun.safetyViolationsCount).toBe(0)
    expect(evalRun.latencyP95Ms).toBeLessThanOrEqual(150)
    expect(evalRun.fallbackTested).toBe(1)
    expect(evalRun.fallbackPassed).toBe(1)
    expect(evalRun.gateVerdict).toBe('passed')
  })

  it('rejects gate promotion if chemical safety is violated (e.g. hazardous bleach + acid mix)', async () => {
    await registerMlModel(world.db, {
      actorId: ADMIN_IDENTITY,
      now: NOW,
      input: {
        id: 'mod-unsafe-candidate',
        modelName: 'Unsafe Candidate Model',
        modelVersion: '0.9.0',
        modelType: 'catalog_copilot_assistant',
        objective: 'factuality_safety',
        weights: { margin: 0.4, retention: 0.3, clicks: 0.3 },
        fallbackStrategy: 'rules_safety_default'
      }
    })

    // Simulated evaluation with safety violation
    const gateVerdict = evaluateModelGate({
      factualityScore: 0.98,
      safetyScore: 0.85,
      safetyViolationsCount: 1, // Violates safety requirement!
      biasDisparateImpact: 0.95,
      driftPsi: 0.04,
      latencyP95Ms: 80,
      costEstimateEur: 0.002,
      fallbackTested: true,
      fallbackPassed: true
    })

    expect(gateVerdict.passed).toBe(false)
    expect(gateVerdict.reasons).toContain('safety_violations_detected')
  })

  it('rejects gate promotion if latency exceeds SLA or drift is elevated', async () => {
    const gateVerdict = evaluateModelGate({
      factualityScore: 0.96,
      safetyScore: 1.0,
      safetyViolationsCount: 0,
      biasDisparateImpact: 0.95,
      driftPsi: 0.28, // Drift > 0.20
      latencyP95Ms: 250, // Latency > 150ms
      costEstimateEur: 0.005,
      fallbackTested: true,
      fallbackPassed: true
    })

    expect(gateVerdict.passed).toBe(false)
    expect(gateVerdict.reasons).toContain('latency_sla_exceeded')
    expect(gateVerdict.reasons).toContain('drift_threshold_exceeded')
  })
})
