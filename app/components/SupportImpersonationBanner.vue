<script setup lang="ts">
import { impersonationSessionSchema, type ImpersonationSession } from '~~/shared/support-impersonation'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'

const request = useRequestFetch()
const session = shallowRef<ImpersonationSession | null>(null),
  remaining = ref(0),
  error = ref(false),
  ending = ref(false)
let timer: ReturnType<typeof setInterval> | null = null,
  alive = true
function stopTimer() {
  if (timer) clearInterval(timer)
  timer = null
}
async function refresh() {
  try {
    const raw = catalogPolicyOwnJson(
      await request<unknown>('/api/admin/support-impersonation/current', { method: 'GET', retry: 0, cache: 'no-store' })
    ) as { session: unknown }
    if (!alive) return
    session.value = raw.session ? impersonationSessionSchema.parse(raw.session) : null
    remaining.value = session.value?.remainingSeconds ?? 0
    error.value = false
    stopTimer()
    if (session.value) timer = setInterval(tick, 1000)
  } catch {
    // Not an agent session (or API unavailable): show nothing rather than a false banner.
    if (alive) {
      session.value = null
      error.value = true
    }
  }
}
function tick() {
  remaining.value = Math.max(0, remaining.value - 1)
  if (remaining.value === 0) {
    stopTimer()
    void refresh()
  }
}
async function end() {
  if (!session.value || ending.value) return
  ending.value = true
  try {
    await request<unknown>(`/api/admin/support-impersonation/${session.value.id}/end`, {
      method: 'POST',
      body: {},
      headers: { 'Content-Type': 'application/json' },
      retry: 0
    })
  } finally {
    ending.value = false
    await refresh()
  }
}
const clock = computed(
  () => `${String(Math.floor(remaining.value / 60)).padStart(2, '0')}:${String(remaining.value % 60).padStart(2, '0')}`
)
onMounted(refresh)
onBeforeUnmount(() => {
  alive = false
  stopTimer()
})
</script>

<template>
  <div
    v-if="session"
    data-impersonation-banner
    role="status"
    class="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950"
  >
    <p data-impersonation-text>{{ session.banner }}</p>
    <p>
      <span class="sr-only">Tiempo restante: </span><span data-impersonation-clock aria-hidden="true">{{ clock }}</span>
    </p>
    <button
      data-impersonation-end
      type="button"
      class="rounded border border-slate-950 px-3 py-1"
      :disabled="ending"
      @click="end"
    >
      Terminar suplantación
    </button>
  </div>
</template>
