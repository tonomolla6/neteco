<script setup lang="ts">
import { replenishmentListSchema, type ReplenishmentList } from '~~/shared/replenishment-reminders'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'

const props = defineProps<{ enabled: boolean; variantId?: string }>()
const request = useRequestFetch()
const STATUS: Record<string, string> = { active: 'Activo', paused: 'En pausa', cancelled: 'Cancelado' }
const phase = ref<'loading' | 'ready' | 'error'>('loading'),
  list = shallowRef<ReplenishmentList | null>(null),
  message = ref(''),
  busy = ref(false),
  variantId = ref(props.variantId ?? ''),
  source = ref<'declared' | 'history'>('declared'),
  intervalDays = ref(30)
async function load() {
  if (!props.enabled) return
  phase.value = 'loading'
  try {
    list.value = replenishmentListSchema.parse(
      catalogPolicyOwnJson(
        await request<unknown>('/api/account/replenishment', { method: 'GET', retry: 0, cache: 'no-store' })
      )
    )
    phase.value = 'ready'
  } catch {
    list.value = null
    phase.value = 'error'
  }
}
async function post(body: Record<string, unknown>) {
  if (busy.value) return
  busy.value = true
  message.value = ''
  try {
    await request<unknown>('/api/account/replenishment/plans', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomId() },
      retry: 0
    })
    await load()
    message.value = 'Plan actualizado.'
  } catch (cause) {
    const code = (cause as { data?: { error?: { code?: string } } })?.data?.error?.code
    message.value =
      code === 'insufficient_history'
        ? 'Aún no hay suficientes compras de esta referencia para calcular tu consumo. Indica cada cuántos días la usas.'
        : code === 'conflict'
          ? 'El plan ha cambiado. Recarga para ver su estado actual.'
          : code === 'not_found'
            ? 'No encontramos esa referencia.'
            : 'No se ha podido actualizar el plan.'
  } finally {
    busy.value = false
  }
}
const create = () =>
  post({
    variantId: variantId.value.trim(),
    action: 'save',
    expectedVersion: 0,
    source: source.value,
    ...(source.value === 'declared' ? { intervalDays: Number(intervalDays.value) } : {})
  })
const act = (plan: ReplenishmentList['plans'][number], action: 'pause' | 'resume' | 'cancel') =>
  post({ variantId: plan.variantId, action, expectedVersion: plan.version })
watch(() => props.enabled, load, { immediate: true })
</script>

<template>
  <section class="min-w-0 space-y-4 break-words" aria-labelledby="rr-title">
    <h2 id="rr-title" class="text-lg font-bold">Recordatorios de reposición</h2>
    <p v-if="!enabled">Necesitas una sesión de cuenta vigente y el email verificado.</p>
    <p v-if="phase === 'loading' && enabled" role="status">Cargando tus planes…</p>
    <div v-if="phase === 'error'" role="alert">
      No se han podido leer tus planes.
      <button data-rr-retry type="button" class="underline" @click="load">Volver a consultar</button>
    </div>
    <p v-if="message" data-rr-message role="status">{{ message }}</p>
    <template v-if="list && enabled">
      <p v-if="!list.consent.replenishment" data-rr-no-consent role="note">
        Tienes los avisos de reposición desactivados: guardaremos tus planes, pero no te enviaremos ningún recordatorio
        hasta que los actives en «Avisos por email».
      </p>
      <p class="text-sm" data-rr-cap>
        Como máximo te enviamos {{ list.cap.maxQueued }} recordatorio cada {{ list.cap.windowDays }} días.
      </p>
      <p v-if="!list.plans.length" data-rr-empty>Todavía no has configurado ningún recordatorio.</p>
      <ul v-else class="divide-y">
        <li
          v-for="plan in list.plans"
          :key="plan.id"
          class="flex flex-wrap items-center justify-between gap-3 py-3"
          data-rr-plan
        >
          <div>
            <p class="font-medium">
              {{ plan.name }} <span class="text-sm">({{ plan.sku }})</span>
            </p>
            <p class="text-sm">
              {{ STATUS[plan.status] }} · cada {{ plan.intervalDays }} días ({{
                plan.source === 'history' ? 'según tu historial' : 'según tu consumo declarado'
              }}) · próximo aviso {{ plan.nextDueAt.slice(0, 10) }}
            </p>
          </div>
          <div class="flex gap-2">
            <button
              v-if="plan.status === 'active'"
              data-rr-pause
              type="button"
              class="underline"
              :disabled="busy"
              @click="act(plan, 'pause')"
            >
              Pausar
            </button>
            <button
              v-if="plan.status === 'paused'"
              data-rr-resume
              type="button"
              class="underline"
              :disabled="busy"
              @click="act(plan, 'resume')"
            >
              Reanudar
            </button>
            <button
              v-if="plan.status !== 'cancelled'"
              data-rr-cancel
              type="button"
              class="underline"
              :disabled="busy"
              @click="act(plan, 'cancel')"
            >
              Cancelar
            </button>
          </div>
        </li>
      </ul>
      <form class="space-y-3" @submit.prevent="create">
        <h3 class="font-medium">Añadir un recordatorio</h3>
        <label class="block"
          >Referencia del producto
          <input v-model="variantId" data-rr-variant class="block w-full border px-2 py-1" maxlength="80" required />
        </label>
        <label class="block"
          >Cómo calculamos cuándo avisarte
          <select v-model="source" data-rr-source class="block border px-2 py-1">
            <option value="declared">Indico cada cuántos días lo uso</option>
            <option value="history">Usar mi historial de compras</option>
          </select>
        </label>
        <label v-if="source === 'declared'" class="block"
          >Días entre cada reposición
          <input
            v-model.number="intervalDays"
            data-rr-interval
            type="number"
            min="7"
            max="365"
            class="block border px-2 py-1"
          />
        </label>
        <button data-rr-create type="submit" class="rounded border px-4 py-2" :disabled="busy || !variantId.trim()">
          Guardar recordatorio
        </button>
      </form>
    </template>
  </section>
</template>
