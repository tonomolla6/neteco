/** PER-026: optimisation backlog driven by field data (RUM p75 per template and
 * cohort, plus real queue lag). Lab scores are only an annotation: they never
 * rank, add or hide an item. */

export type RumMetric = 'LCP' | 'INP' | 'CLS'
export type RumTemplate = 'home' | 'category' | 'product' | 'search' | 'cart' | 'checkout' | 'other'

export interface RumVital {
  path: string
  metric: RumMetric
  value: number
  navigationType?: string
  deviceClass?: string
}
export interface RumQueueSample {
  queue: string
  lagMs: number
}
export interface LabScore {
  template: RumTemplate
  metric: RumMetric
  value: number
}
export interface RumBacklogItem {
  kind: 'vital' | 'queue'
  scope: 'template' | 'cohort' | 'queue'
  template?: RumTemplate
  cohort?: string
  queue?: string
  metric: RumMetric | 'QUEUE_LAG_MS'
  p75: number
  threshold: number
  samples: number
  priority: number
  labDisagrees?: boolean
}
export interface RumBacklog {
  items: RumBacklogItem[]
  insufficient: Array<{ template?: RumTemplate; queue?: string; metric: string; samples: number }>
  rejectedSamples: number
}

export const RUM_THRESHOLDS: Record<RumMetric, number> = { LCP: 2500, INP: 200, CLS: 0.1 }
export const RUM_QUEUE_LAG_THRESHOLD_MS = 60_000
export const RUM_MIN_SAMPLES = 30

export function classifyTemplate(path: string): RumTemplate {
  const clean = path.split(/[?#]/)[0] ?? ''
  if (clean === '/' || clean === '') return 'home'
  const head = clean.split('/')[1]
  switch (head) {
    case 'catalogo':
      return 'category'
    case 'producto':
      return 'product'
    case 'buscar':
      return 'search'
    case 'carrito':
      return 'cart'
    case 'checkout':
      return 'checkout'
    default:
      return 'other'
  }
}

function p75(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(0.75 * sorted.length) - 1)]!
}
const priority = (value: number, threshold: number, samples: number) =>
  Math.round((value / threshold - 1) * Math.log2(1 + samples) * 1000) / 1000
const isMetric = (m: unknown): m is RumMetric => m === 'LCP' || m === 'INP' || m === 'CLS'
const validNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

export function buildRumBacklog(input: {
  vitals: RumVital[]
  queues: RumQueueSample[]
  lab?: LabScore[]
  minSamples?: number
}): RumBacklog {
  const min = input.minSamples ?? RUM_MIN_SAMPLES
  let rejectedSamples = 0
  const byTemplate = new Map<string, number[]>()
  const byCohort = new Map<string, number[]>()
  const push = (map: Map<string, number[]>, key: string, value: number) => {
    const list = map.get(key)
    if (list) list.push(value)
    else map.set(key, [value])
  }
  for (const sample of input.vitals) {
    if (!isMetric(sample.metric) || !validNumber(sample.value) || typeof sample.path !== 'string') {
      rejectedSamples += 1
      continue
    }
    const template = classifyTemplate(sample.path)
    const cohort = `${sample.deviceClass || 'unknown'}/${sample.navigationType || 'unknown'}`
    push(byTemplate, `${template}|${sample.metric}`, sample.value)
    push(byCohort, `${template}|${sample.metric}|${cohort}`, sample.value)
  }
  const byQueue = new Map<string, number[]>()
  for (const sample of input.queues) {
    if (!sample.queue || !validNumber(sample.lagMs)) rejectedSamples += 1
    else push(byQueue, sample.queue, sample.lagMs)
  }

  const items: RumBacklogItem[] = []
  const insufficient: RumBacklog['insufficient'] = []
  const flaggedTemplates = new Map<string, number>()
  const lab = new Map((input.lab ?? []).map((entry) => [`${entry.template}|${entry.metric}`, entry.value]))

  for (const [key, values] of byTemplate) {
    const [template, metric] = key.split('|') as [RumTemplate, RumMetric]
    if (values.length < min) {
      insufficient.push({ template, metric, samples: values.length })
      continue
    }
    const value = p75(values)
    const threshold = RUM_THRESHOLDS[metric]
    if (value <= threshold) continue
    flaggedTemplates.set(key, value)
    const labValue = lab.get(key)
    items.push({
      kind: 'vital',
      scope: 'template',
      template,
      metric,
      p75: value,
      threshold,
      samples: values.length,
      priority: priority(value, threshold, values.length),
      ...(labValue !== undefined && labValue <= threshold ? { labDisagrees: true } : {})
    })
  }
  for (const [key, values] of byCohort) {
    if (values.length < min) continue
    const [template, metric, cohort] = key.split('|') as [RumTemplate, RumMetric, string]
    const value = p75(values)
    const threshold = RUM_THRESHOLDS[metric]
    if (value <= threshold) continue
    const aggregate = flaggedTemplates.get(`${template}|${metric}`)
    // A cohort that merely repeats an already-flagged template adds no information.
    if (aggregate !== undefined && value <= aggregate * 1.1) continue
    const labValue = lab.get(`${template}|${metric}`)
    items.push({
      kind: 'vital',
      scope: 'cohort',
      template,
      cohort,
      metric,
      p75: value,
      threshold,
      samples: values.length,
      priority: priority(value, threshold, values.length),
      ...(labValue !== undefined && labValue <= threshold ? { labDisagrees: true } : {})
    })
  }
  for (const [queue, values] of byQueue) {
    if (values.length < min) {
      insufficient.push({ queue, metric: 'QUEUE_LAG_MS', samples: values.length })
      continue
    }
    const value = p75(values)
    if (value <= RUM_QUEUE_LAG_THRESHOLD_MS) continue
    items.push({
      kind: 'queue',
      scope: 'queue',
      queue,
      metric: 'QUEUE_LAG_MS',
      p75: value,
      threshold: RUM_QUEUE_LAG_THRESHOLD_MS,
      samples: values.length,
      priority: priority(value, RUM_QUEUE_LAG_THRESHOLD_MS, values.length)
    })
  }
  const label = (item: { template?: string; queue?: string; cohort?: string; metric: string }) =>
    `${item.template ?? item.queue}|${item.metric}|${item.cohort ?? ''}`
  items.sort((a, b) => b.priority - a.priority || (label(a) < label(b) ? -1 : 1))
  insufficient.sort((a, b) =>
    (a.template ?? a.queue ?? '') + a.metric < (b.template ?? b.queue ?? '') + b.metric ? -1 : 1
  )
  return { items, insufficient, rejectedSamples }
}

export function rumBacklogMarkdown(backlog: RumBacklog): string {
  const lines = ['# RUM optimisation backlog', '']
  if (!backlog.items.length) lines.push('No field regressions above threshold.', '')
  else {
    lines.push(
      '| # | Template/queue | Metric | Cohort | p75 | Threshold | Samples | Priority |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |'
    )
    backlog.items.forEach((item, index) => {
      lines.push(
        `| ${index + 1} | ${item.template ?? item.queue} | ${item.metric} | ${item.cohort ?? 'all'} | ${item.p75} | ${item.threshold} | ${item.samples} | ${item.priority}${item.labDisagrees ? ' (lab says OK)' : ''} |`
      )
    })
    lines.push('')
  }
  if (backlog.insufficient.length)
    lines.push(`Insufficient data: ${backlog.insufficient.length} group(s) below the sample minimum.`, '')
  if (backlog.rejectedSamples) lines.push(`Rejected invalid samples: ${backlog.rejectedSamples}.`, '')
  return `${lines.join('\n')}\n`
}
