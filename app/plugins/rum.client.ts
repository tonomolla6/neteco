interface LargestContentfulPaintEntry extends PerformanceEntry {
  startTime: number
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number
  hadRecentInput: boolean
}

interface EventTimingEntry extends PerformanceEntry {
  duration: number
  interactionId: number
}

type Metric = 'LCP' | 'CLS' | 'INP'

function rating(metric: Metric, value: number) {
  const [good, poor] = metric === 'LCP' ? [2500, 4000] : metric === 'CLS' ? [0.1, 0.25] : [200, 500]
  return value <= good ? 'good' : value <= poor ? 'needs-improvement' : 'poor'
}

export default defineNuxtPlugin(() => {
  const { track } = useAnalytics()
  const route = useRoute()
  let lcp = 0
  let cls = 0
  let inp = 0
  let reported = false
  const observers: PerformanceObserver[] = []

  function observe(type: string, handler: PerformanceObserverCallback) {
    try {
      const observer = new PerformanceObserver(handler)
      observer.observe({ type, buffered: true })
      observers.push(observer)
    } catch {
      // The browser does not expose this optional performance entry type.
    }
  }

  observe('largest-contentful-paint', (list) => {
    for (const entry of list.getEntries() as LargestContentfulPaintEntry[]) lcp = Math.max(lcp, entry.startTime)
  })
  observe('layout-shift', (list) => {
    for (const entry of list.getEntries() as LayoutShiftEntry[]) if (!entry.hadRecentInput) cls += entry.value
  })
  observe('event', (list) => {
    for (const entry of list.getEntries() as EventTimingEntry[]) {
      if (entry.interactionId) inp = Math.max(inp, entry.duration)
    }
  })

  function report() {
    if (reported) return
    reported = true
    observers.forEach((observer) => observer.disconnect())
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const navigationType = navigation?.type ?? 'unknown'
    const values: Array<[Metric, number]> = [
      ['LCP', Math.round(lcp)],
      ['CLS', Math.round(cls * 1000) / 1000],
      ['INP', Math.round(inp)]
    ]
    for (const [metric, value] of values) {
      if (value <= 0) continue
      void track('web_vital', { metric, value, rating: rating(metric, value), path: route.path, navigationType })
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') report()
  }
  document.addEventListener('visibilitychange', onVisibility, { once: true })
  window.addEventListener('pagehide', report, { once: true })
})
