<script setup lang="ts">
import {
  isMarketingModalProhibitedRoute,
  marketingModalEligibilityResponseSchema,
  type PublicMarketingModal
} from '~~/shared/marketing-modals'

/**
 * Administrable marketing modal host (MKT-009) with anti-annoyance rules (MKT-010).
 * The server is the source of truth: this component only decides when to ask, shows at most
 * the one modal the server returns, and keeps dismissal/conversion state in this browser.
 * Events reach the server only with analytical consent, and the server re-checks it.
 */
const props = defineProps<{
  /** Test and preview hook. Production derives the viewport from the media query. */
  forceViewport?: 'mobile' | 'desktop'
  /** Test and preview hook. Production derives reduced motion from the media query. */
  forceReducedMotion?: boolean
}>()

const ELIGIBILITY_PATH = '/api/marketing/modals/eligibility'
const EVENTS_PATH = '/api/marketing/modals/events'
const STORAGE_KEY = 'neteco-marketing-modals-v1'
const SESSION_KEY = 'neteco-marketing-session-v1'
const FIRST_DECISION_MS = 5_000
const MIN_SCROLL_RECHECK_MS = 1_500
// Backoff polls: time-based triggers may match later; capped to keep D1 reads bounded.
const POLL_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000]

interface LocalState {
  version: 1
  variantSeed: string
  dismissedModalIds: string[]
  convertedModalIds: string[]
  convertedObjectives: string[]
  lastDismissedAt: string | null
  impressionsByModal: Record<string, string[]>
}

interface SessionState {
  pageViews: number
  modalsShown: number
}

const route = useRoute()
const request = useRequestFetch()
const runtime = useRuntimeConfig()
const consent = useConsent()
const titleId = `marketing-modal-title-${useId()}`
const bodyId = `marketing-modal-body-${useId()}`

const modal = ref<PublicMarketingModal | null>(null)
const dialog = ref<HTMLElement | null>(null)
const isSheet = computed(() => modal.value?.presentation.layout === 'bottom_sheet')

let returnFocusTo: HTMLElement | null = null
let pageGeneration = 0
let pageStartedAt = 0
let pageShown = false
let evaluating = false
let attempts = 0
let scrollPercent = 0
let exitIntent = false
let lastScrollCheck = 0
let timer: ReturnType<typeof setTimeout> | undefined
let mountedHost = false

const instant = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const analyticsAllowed = () => consent.preferences.value?.analytics === true
const marketingAllowed = () => consent.preferences.value?.marketing === true

function readState(): LocalState {
  const fallback: LocalState = {
    version: 1,
    variantSeed: crypto.randomUUID(),
    dismissedModalIds: [],
    convertedModalIds: [],
    convertedObjectives: [],
    lastDismissedAt: null,
    impressionsByModal: {}
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<LocalState> | null
    // Persist the first seed: the A/B variant must stay stable for this browser across evaluations.
    if (!parsed || parsed.version !== 1) {
      writeState(fallback)
      return fallback
    }
    return {
      version: 1,
      variantSeed:
        typeof parsed.variantSeed === 'string' && /^[A-Za-z0-9._:-]{8,120}$/.test(parsed.variantSeed)
          ? parsed.variantSeed
          : fallback.variantSeed,
      dismissedModalIds: Array.isArray(parsed.dismissedModalIds) ? parsed.dismissedModalIds.slice(-100) : [],
      convertedModalIds: Array.isArray(parsed.convertedModalIds) ? parsed.convertedModalIds.slice(-100) : [],
      convertedObjectives: Array.isArray(parsed.convertedObjectives) ? parsed.convertedObjectives.slice(-10) : [],
      lastDismissedAt: typeof parsed.lastDismissedAt === 'string' ? parsed.lastDismissedAt : null,
      impressionsByModal:
        parsed.impressionsByModal && typeof parsed.impressionsByModal === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.impressionsByModal)
                .filter(([, value]) => Array.isArray(value))
                .map(([key, value]) => [key, (value as string[]).slice(-50)])
            )
          : {}
    }
  } catch {
    writeState(fallback)
    return fallback
  }
}

function writeState(state: LocalState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Storage can be blocked: the modal then behaves as if nothing was persisted.
  }
}

function readSession(): SessionState {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? 'null') as Partial<SessionState> | null
    return {
      pageViews: Math.min(1000, Math.max(0, Number(parsed?.pageViews) || 0)),
      modalsShown: Math.min(100, Math.max(0, Number(parsed?.modalsShown) || 0))
    }
  } catch {
    return { pageViews: 0, modalsShown: 0 }
  }
}

function writeSession(state: SessionState) {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(state))
  } catch {
    // Session counters are a per-viewer convenience only.
  }
}

function viewport(): 'mobile' | 'desktop' {
  if (props.forceViewport) return props.forceViewport
  return window.matchMedia?.('(max-width: 767px)').matches ? 'mobile' : 'desktop'
}

function reducedMotion(): boolean {
  if (props.forceReducedMotion !== undefined) return props.forceReducedMotion
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function sendEvent(current: PublicMarketingModal, eventType: 'impression' | 'dismiss' | 'convert') {
  // Without analytical consent nothing leaves the browser: frequency stays local.
  if (!analyticsAllowed()) return
  void request(EVENTS_PATH, {
    method: 'POST',
    body: {
      eventId: crypto.randomUUID(),
      modalId: current.id,
      modalVersion: current.version,
      variant: current.variant,
      eventType,
      objective: current.objective,
      analyticsConsent: true
    }
  }).catch(() => undefined)
}

function focusables(): HTMLElement[] {
  return Array.from(dialog.value?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])
}

function focusFirst() {
  focusables()[0]?.focus()
}

function show(next: PublicMarketingModal) {
  const active = document.activeElement
  returnFocusTo = active instanceof HTMLElement ? active : null
  modal.value = next
  pageShown = true
  const state = readState()
  state.impressionsByModal[next.id] = [...(state.impressionsByModal[next.id] ?? []), instant()].slice(-50)
  writeState(state)
  const session = readSession()
  writeSession({ ...session, modalsShown: session.modalsShown + 1 })
  sendEvent(next, 'impression')
  void nextTick(() => focusFirst())
}

function close() {
  modal.value = null
  const target = returnFocusTo
  returnFocusTo = null
  if (target?.isConnected) target.focus()
}

function dismiss() {
  const current = modal.value
  if (!current) return
  const state = readState()
  state.dismissedModalIds = [...new Set([...state.dismissedModalIds, current.id])].slice(-100)
  state.lastDismissedAt = instant()
  writeState(state)
  sendEvent(current, 'dismiss')
  close()
}

function convert() {
  const current = modal.value
  if (!current) return
  const state = readState()
  state.convertedModalIds = [...new Set([...state.convertedModalIds, current.id])].slice(-100)
  state.convertedObjectives = [...new Set([...state.convertedObjectives, current.objective])].slice(-10)
  state.lastDismissedAt = instant()
  writeState(state)
  sendEvent(current, 'convert')
  const destination = current.ctaPath
  close()
  void Promise.resolve(navigateTo(destination)).catch(() => undefined)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    dismiss()
    return
  }
  if (event.key !== 'Tab') return
  const items = focusables()
  if (items.length === 0) {
    event.preventDefault()
    return
  }
  const index = items.indexOf(document.activeElement as HTMLElement)
  const last = items.length - 1
  const next = event.shiftKey ? (index <= 0 ? last : index - 1) : index === -1 || index >= last ? 0 : index + 1
  event.preventDefault()
  items[next]!.focus()
}

function onFocusIn(event: FocusEvent) {
  // Keeps focus inside the open dialog even if something outside receives it.
  if (!modal.value || !dialog.value) return
  if (event.target instanceof Node && dialog.value.contains(event.target)) return
  focusFirst()
}

async function evaluate() {
  if (!mountedHost || modal.value || pageShown || evaluating) return
  if (runtime.public.serverRuntime !== 'cloudflare') return
  const path = route.path
  if (isMarketingModalProhibitedRoute(path)) return
  const elapsedSeconds = (Date.now() - pageStartedAt) / 1000
  if (elapsedSeconds * 1000 < FIRST_DECISION_MS) return

  const generation = pageGeneration
  const state = readState()
  const session = readSession()
  evaluating = true
  try {
    const raw = await request(ELIGIBILITY_PATH, {
      method: 'POST',
      body: {
        path,
        viewport: viewport(),
        timeOnPageSeconds: Math.round(elapsedSeconds * 100) / 100,
        scrollPercent,
        exitIntent: exitIntent && viewport() === 'desktop',
        pageViewsInSession: Math.max(1, session.pageViews),
        activeModalOpen: false,
        pageViewModalsShown: 0,
        sessionModalsShown: session.modalsShown,
        prefersReducedMotion: reducedMotion(),
        marketingConsent: marketingAllowed(),
        analyticsConsent: analyticsAllowed(),
        variantSeed: state.variantSeed,
        lastDismissedAt: state.lastDismissedAt,
        dismissedModalIds: state.dismissedModalIds,
        convertedModalIds: state.convertedModalIds,
        convertedObjectives: state.convertedObjectives,
        impressionsByModal: state.impressionsByModal
      }
    })
    const parsed = marketingModalEligibilityResponseSchema.safeParse(raw)
    if (generation !== pageGeneration || !mountedHost) return
    if (parsed.success && parsed.data.eligible && parsed.data.modal) {
      show(parsed.data.modal)
    }
  } catch {
    // Any failure means no modal: the anti-annoyance default is silence.
  } finally {
    evaluating = false
  }
}

function schedulePoll(delay: number) {
  if (timer !== undefined) clearTimeout(timer)
  timer = setTimeout(async () => {
    timer = undefined
    await evaluate()
    if (!modal.value && !pageShown && attempts < POLL_BACKOFF_MS.length) {
      schedulePoll(POLL_BACKOFF_MS[attempts++]!)
    }
  }, delay)
}

function resetPage() {
  pageGeneration++
  pageStartedAt = Date.now()
  pageShown = false
  attempts = 0
  scrollPercent = 0
  exitIntent = false
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  const session = readSession()
  writeSession({ ...session, pageViews: session.pageViews + 1 })
  schedulePoll(FIRST_DECISION_MS)
}

function onScroll() {
  const max = document.documentElement.scrollHeight - window.innerHeight
  scrollPercent = max <= 0 ? 100 : Math.min(100, Math.round((window.scrollY / max) * 100))
  const now = Date.now()
  if (scrollPercent >= 10 && now - lastScrollCheck >= MIN_SCROLL_RECHECK_MS) {
    lastScrollCheck = now
    void evaluate()
  }
}

function onMouseOut(event: MouseEvent) {
  // Exit intent is desktop only: a mobile pointer never leaves the page through the top edge.
  if (viewport() !== 'desktop' || event.relatedTarget !== null || event.clientY > 0) return
  exitIntent = true
  void evaluate()
}

onMounted(() => {
  if (runtime.public.serverRuntime !== 'cloudflare') return
  mountedHost = true
  window.addEventListener('scroll', onScroll, { passive: true })
  document.addEventListener('mouseout', onMouseOut)
  document.addEventListener('focusin', onFocusIn)
  resetPage()
})

onBeforeUnmount(() => {
  mountedHost = false
  if (timer !== undefined) clearTimeout(timer)
  window.removeEventListener('scroll', onScroll)
  document.removeEventListener('mouseout', onMouseOut)
  document.removeEventListener('focusin', onFocusIn)
})

watch(
  () => route.fullPath,
  () => {
    if (!mountedHost) return
    if (modal.value) close()
    resetPage()
  }
)
</script>

<template>
  <div v-if="modal" class="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/40 sm:items-center sm:p-4">
    <section
      ref="dialog"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-describedby="bodyId"
      :data-layout="modal.presentation.layout"
      :data-max-viewport-percent="String(modal.presentation.maxViewportHeightPercent)"
      :data-reduced-motion="String(modal.presentation.reducedMotion)"
      :class="[
        'w-full overflow-y-auto bg-white p-5 text-slate-900 shadow-[var(--shadow-overlay)]',
        modal.presentation.maxViewportHeightPercent === 50 ? 'max-h-[50vh]' : 'max-h-[80vh]',
        isSheet ? 'rounded-t-2xl' : 'max-w-lg rounded-2xl',
        modal.presentation.reducedMotion ? 'transition-none' : 'transition-transform duration-200'
      ]"
      @keydown="onKeydown"
    >
      <header class="flex items-start justify-between gap-4">
        <h2 :id="titleId" class="text-lg font-semibold leading-snug">{{ modal.title }}</h2>
        <button
          type="button"
          data-testid="marketing-modal-close"
          class="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          @click="dismiss"
        >
          Cerrar
        </button>
      </header>
      <p :id="bodyId" class="mt-3 text-sm leading-relaxed text-slate-700">{{ modal.body }}</p>
      <div class="mt-5">
        <a
          data-testid="marketing-modal-cta"
          :href="modal.ctaPath"
          class="inline-flex rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
          @click.prevent="convert"
        >
          {{ modal.ctaLabel }}
        </a>
      </div>
    </section>
  </div>
</template>
