<script setup lang="ts">
import { nextTick, reactive, ref } from 'vue'
import { buildNavigationUrl, type DriverStopView } from '../../shared/delivery-driver-app'
import { newCommandId, useDeliveryDriverApp } from '../composables/useDeliveryDriverApp'

const app = useDeliveryDriverApp()
const { manifest, loading, syncing, offline, error, notice, rejected, pending } = app

type Panel = { stopId: string; kind: 'deliver' | 'fail' | 'incident' } | null
const panel = ref<Panel>(null)
const formError = ref<string | null>(null)
const busy = ref(false)
const form = reactive({
  method: 'signature' as 'signature' | 'photo' | 'neighbour',
  receivedBy: '',
  failReason: 'customer_absent',
  failNote: '',
  incidentCategory: 'customer_absent',
  incidentNote: ''
})
const canvas = ref<HTMLCanvasElement | null>(null)
const hasSignature = ref(false)
const photoBase64 = ref<string | null>(null)
let drawing = false

const statusLabel: Record<DriverStopView['status'], string> = {
  pending: 'Pendiente',
  in_progress: 'En curso',
  delivered: 'Entregado',
  failed: 'No entregado'
}
const routeLabel: Record<string, string> = {
  planned: 'Planificada',
  in_progress: 'En reparto',
  completed: 'Completada',
  cancelled: 'Cancelada',
  draft: 'Borrador'
}
const failReasons = [
  ['customer_absent', 'Cliente ausente'],
  ['wrong_address', 'Dirección incorrecta'],
  ['access_blocked', 'Acceso bloqueado'],
  ['refused', 'Rechazado por el cliente'],
  ['damaged_parcel', 'Bulto dañado'],
  ['other', 'Otro motivo']
] as const
const incidentCategories = [...failReasons, ['vehicle_issue', 'Incidencia del vehículo']] as const

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

async function open(stopId: string, kind: 'deliver' | 'fail' | 'incident') {
  panel.value = { stopId, kind }
  formError.value = null
  hasSignature.value = false
  photoBase64.value = null
  form.receivedBy = ''
  form.failNote = ''
  form.incidentNote = ''
  await nextTick()
  clearSignature()
}
function close() {
  panel.value = null
  formError.value = null
}

function clearSignature() {
  hasSignature.value = false
  const el = canvas.value
  const ctx = el?.getContext?.('2d')
  if (el && ctx) ctx.clearRect(0, 0, el.width, el.height)
}
function point(event: PointerEvent) {
  const el = canvas.value!
  const rect = el.getBoundingClientRect()
  const scaleX = rect.width ? el.width / rect.width : 1
  const scaleY = rect.height ? el.height / rect.height : 1
  return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY }
}
function pointerDown(event: PointerEvent) {
  const ctx = canvas.value?.getContext?.('2d')
  if (!ctx) return
  drawing = true
  const p = point(event)
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(p.x, p.y)
}
function pointerMove(event: PointerEvent) {
  const ctx = canvas.value?.getContext?.('2d')
  if (!drawing || !ctx) return
  const p = point(event)
  ctx.lineTo(p.x, p.y)
  ctx.stroke()
  hasSignature.value = true
}
function pointerUp() {
  drawing = false
}

async function onPhoto(event: Event) {
  photoBase64.value = null
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height))
    const el = document.createElement('canvas')
    el.width = Math.max(1, Math.round(bitmap.width * scale))
    el.height = Math.max(1, Math.round(bitmap.height * scale))
    el.getContext('2d')!.drawImage(bitmap, 0, 0, el.width, el.height)
    const data = el.toDataURL('image/jpeg', 0.7).split(',')[1] ?? ''
    if (!data || data.length > 195_000) throw new Error('size')
    photoBase64.value = data
  } catch {
    formError.value = 'No se ha podido preparar la foto (formato no soportado o demasiado grande).'
  }
}

function signatureData(): string | null {
  try {
    return canvas.value?.toDataURL('image/png').split(',')[1] ?? null
  } catch {
    return null
  }
}

async function submitDeliver(stopId: string) {
  formError.value = null
  const receivedBy = form.receivedBy.trim()
  if (receivedBy.length < 2) {
    formError.value = 'Indica el nombre de quien recibe (mínimo 2 caracteres).'
    return
  }
  let evidence: { mime: 'image/png' | 'image/jpeg'; base64: string } | undefined
  if (form.method === 'signature') {
    const data = signatureData()
    if (!hasSignature.value || !data) {
      formError.value = 'Falta la firma del receptor.'
      return
    }
    evidence = { mime: 'image/png', base64: data }
  } else if (form.method === 'photo') {
    if (!photoBase64.value) {
      formError.value = 'Haz una foto del bulto entregado.'
      return
    }
    evidence = { mime: 'image/jpeg', base64: photoBase64.value }
  }
  busy.value = true
  const ok = await app.submit({
    kind: 'deliver',
    commandId: newCommandId(),
    stopId,
    occurredAt: now(),
    pod: { method: form.method, receivedBy, ...(evidence ? { evidence } : {}) }
  })
  busy.value = false
  if (ok) close()
}
async function submitFail(stopId: string) {
  busy.value = true
  const note = form.failNote.trim()
  const ok = await app.submit({
    kind: 'fail',
    commandId: newCommandId(),
    stopId,
    occurredAt: now(),
    reason: form.failReason as 'other',
    ...(note ? { note } : {})
  })
  busy.value = false
  if (ok) close()
}
async function submitIncident(stopId: string) {
  const note = form.incidentNote.trim()
  if (note.length < 1) {
    formError.value = 'Describe brevemente la incidencia.'
    return
  }
  busy.value = true
  const ok = await app.submit({
    kind: 'incident',
    commandId: newCommandId(),
    stopId,
    occurredAt: now(),
    category: form.incidentCategory as 'other',
    note
  })
  busy.value = false
  if (ok) close()
}
async function startRoute(routeId: string) {
  await app.submit({ kind: 'start_route', commandId: newCommandId(), routeId, occurredAt: now() })
}
async function startStop(stopId: string) {
  await app.submit({ kind: 'start', commandId: newCommandId(), stopId, occurredAt: now() })
}
</script>

<template>
  <section class="mx-auto max-w-2xl space-y-4 p-4" aria-labelledby="reparto-title">
    <header class="flex items-center justify-between gap-2">
      <h1 id="reparto-title" class="text-xl font-bold text-slate-900">Reparto de hoy</h1>
      <button
        type="button"
        data-test="sync-now"
        class="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 disabled:opacity-50"
        :disabled="syncing || pending === 0"
        @click="app.sync()"
      >
        {{ syncing ? 'Sincronizando…' : 'Sincronizar' }}
      </button>
    </header>

    <div
      v-if="offline"
      data-test="offline-banner"
      role="status"
      class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      Sin conexión: los cambios se guardan en este dispositivo y se enviarán al recuperar la señal.
    </div>
    <p v-if="pending > 0" data-test="pending-count" role="status" class="text-sm font-medium text-slate-700">
      {{ pending }} {{ pending === 1 ? 'evento pendiente' : 'eventos pendientes' }} de enviar
    </p>
    <div
      v-if="rejected.length"
      data-test="rejected-notice"
      role="alert"
      class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      El servidor no ha aceptado {{ rejected.length }} {{ rejected.length === 1 ? 'evento' : 'eventos' }}:
      {{ rejected.map((r) => r.code).join(', ') }}. Revisa el estado de las paradas.
    </div>
    <p v-if="notice" role="status" class="text-sm text-slate-700">{{ notice }}</p>

    <div v-if="loading" role="status" aria-live="polite" class="p-6 text-center text-sm text-slate-600">
      Cargando tu reparto…
    </div>
    <div v-else-if="error" role="alert" class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      {{ error }}
      <button type="button" class="ml-2 underline" @click="app.load()">Reintentar</button>
    </div>
    <p
      v-else-if="manifest && manifest.routes.length === 0"
      class="rounded-lg bg-slate-50 p-6 text-center text-slate-600"
    >
      No tienes rutas asignadas para hoy.
    </p>

    <template v-else-if="manifest">
      <article
        v-for="route in manifest.routes"
        :key="route.id"
        class="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
        :aria-label="`Ruta ${route.windowStart} a ${route.windowEnd}`"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="font-semibold text-slate-900">
              Ruta {{ route.windowStart }}–{{ route.windowEnd }} · {{ routeLabel[route.status] ?? route.status }}
            </h2>
            <p class="text-xs text-slate-500">
              {{ route.totalStops }} paradas · {{ route.totalParcels }} bultos
              <span v-if="route.vehicleName"> · {{ route.vehicleName }}</span>
            </p>
          </div>
          <button
            v-if="route.status === 'planned'"
            type="button"
            data-test="start-route"
            class="min-h-11 rounded-lg bg-neteco-600 px-4 text-sm font-semibold text-white"
            @click="startRoute(route.id)"
          >
            Iniciar ruta
          </button>
        </div>

        <ol class="space-y-3">
          <li
            v-for="stop in route.stops"
            :key="stop.id"
            :data-test="`stop-${stop.id}`"
            class="rounded-lg border border-slate-200 p-3"
          >
            <div class="flex items-start justify-between gap-2">
              <div>
                <p class="font-medium text-slate-900">{{ stop.sequenceIndex + 1 }}. {{ stop.recipientName }}</p>
                <p class="text-sm text-slate-600">{{ stop.streetAddress }}, {{ stop.postalCode }} {{ stop.city }}</p>
                <p class="text-xs text-slate-500">
                  {{ stop.parcelCount }} {{ stop.parcelCount === 1 ? 'bulto' : 'bultos' }}
                  <span v-if="stop.timeWindowStart"> · {{ stop.timeWindowStart }}–{{ stop.timeWindowEnd }}</span>
                  <span v-if="stop.incidentCount"> · {{ stop.incidentCount }} incidencia(s)</span>
                </p>
              </div>
              <span
                class="shrink-0 rounded px-2 py-0.5 text-xs font-medium"
                :class="
                  stop.status === 'delivered'
                    ? 'bg-emerald-100 text-emerald-800'
                    : stop.status === 'failed'
                      ? 'bg-red-100 text-red-800'
                      : 'bg-slate-100 text-slate-800'
                "
              >
                {{ statusLabel[stop.status] }}
              </span>
            </div>
            <p v-if="stop.pod" class="mt-1 text-xs text-slate-600">Recibido por {{ stop.pod.receivedBy }}</p>
            <p v-if="stop.failureReason" class="mt-1 text-xs text-red-700">Motivo: {{ stop.failureReason }}</p>

            <div class="mt-2 flex flex-wrap gap-2">
              <a
                :data-test="`nav-${stop.id}`"
                :href="buildNavigationUrl(stop)"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-3 text-sm font-medium"
              >
                Navegar
              </a>
              <template v-if="route.status === 'in_progress' && stop.status !== 'delivered'">
                <button
                  v-if="stop.status === 'pending'"
                  type="button"
                  :data-test="`start-${stop.id}`"
                  class="min-h-11 rounded-lg border border-slate-300 px-3 text-sm font-medium"
                  @click="startStop(stop.id)"
                >
                  Llegué
                </button>
                <button
                  type="button"
                  :data-test="`deliver-open-${stop.id}`"
                  class="min-h-11 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white"
                  @click="open(stop.id, 'deliver')"
                >
                  Entregar
                </button>
                <button
                  v-if="stop.status !== 'failed'"
                  type="button"
                  :data-test="`fail-open-${stop.id}`"
                  class="min-h-11 rounded-lg border border-red-300 px-3 text-sm font-medium text-red-800"
                  @click="open(stop.id, 'fail')"
                >
                  No entregado
                </button>
              </template>
              <button
                v-if="route.status !== 'cancelled'"
                type="button"
                :data-test="`incident-open-${stop.id}`"
                class="min-h-11 rounded-lg border border-slate-300 px-3 text-sm"
                @click="open(stop.id, 'incident')"
              >
                Incidencia
              </button>
            </div>

            <form
              v-if="panel && panel.stopId === stop.id"
              class="mt-3 space-y-3 rounded-lg bg-slate-50 p-3"
              @submit.prevent
            >
              <template v-if="panel.kind === 'deliver'">
                <label class="block text-sm font-medium text-slate-800">
                  Método de prueba
                  <select
                    v-model="form.method"
                    data-test="pod-method"
                    class="mt-1 block min-h-11 w-full rounded-md border border-slate-300 bg-white px-2"
                  >
                    <option value="signature">Firma</option>
                    <option value="photo">Foto</option>
                    <option value="neighbour">Entrega a vecino/conserje</option>
                  </select>
                </label>
                <label class="block text-sm font-medium text-slate-800">
                  Nombre de quien recibe
                  <input
                    v-model="form.receivedBy"
                    data-test="received-by"
                    type="text"
                    maxlength="100"
                    autocomplete="off"
                    class="mt-1 block min-h-11 w-full rounded-md border border-slate-300 px-2"
                  />
                </label>
                <div v-show="form.method === 'signature'">
                  <canvas
                    ref="canvas"
                    data-test="signature-canvas"
                    width="300"
                    height="150"
                    class="w-full touch-none rounded-md border border-slate-300 bg-white"
                    aria-label="Firma del receptor"
                    @pointerdown="pointerDown"
                    @pointermove="pointerMove"
                    @pointerup="pointerUp"
                    @pointerleave="pointerUp"
                  />
                  <button type="button" class="mt-1 text-sm underline" @click="clearSignature">Borrar firma</button>
                </div>
                <label v-if="form.method === 'photo'" class="block text-sm font-medium text-slate-800">
                  Foto del bulto entregado
                  <input
                    data-test="photo-input"
                    type="file"
                    accept="image/*"
                    capture="environment"
                    class="mt-1 block w-full text-sm"
                    @change="onPhoto"
                  />
                </label>
                <p v-if="formError" data-test="deliver-error" role="alert" class="text-sm text-red-700">
                  {{ formError }}
                </p>
                <div class="flex gap-2">
                  <button
                    type="button"
                    data-test="deliver-submit"
                    class="min-h-11 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-50"
                    :disabled="busy"
                    @click="submitDeliver(stop.id)"
                  >
                    Confirmar entrega
                  </button>
                  <button type="button" class="min-h-11 px-3 text-sm underline" @click="close">Cancelar</button>
                </div>
              </template>

              <template v-else-if="panel.kind === 'fail'">
                <label class="block text-sm font-medium text-slate-800">
                  Motivo
                  <select
                    v-model="form.failReason"
                    data-test="fail-reason"
                    class="mt-1 block min-h-11 w-full rounded-md border border-slate-300 bg-white px-2"
                  >
                    <option v-for="[value, label] in failReasons" :key="value" :value="value">{{ label }}</option>
                  </select>
                </label>
                <label class="block text-sm font-medium text-slate-800">
                  Nota (opcional)
                  <input
                    v-model="form.failNote"
                    type="text"
                    maxlength="300"
                    class="mt-1 block min-h-11 w-full rounded-md border border-slate-300 px-2"
                  />
                </label>
                <div class="flex gap-2">
                  <button
                    type="button"
                    data-test="fail-submit"
                    class="min-h-11 rounded-lg bg-red-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
                    :disabled="busy"
                    @click="submitFail(stop.id)"
                  >
                    Registrar no entrega
                  </button>
                  <button type="button" class="min-h-11 px-3 text-sm underline" @click="close">Cancelar</button>
                </div>
              </template>

              <template v-else>
                <label class="block text-sm font-medium text-slate-800">
                  Tipo de incidencia
                  <select
                    v-model="form.incidentCategory"
                    data-test="incident-category"
                    class="mt-1 block min-h-11 w-full rounded-md border border-slate-300 bg-white px-2"
                  >
                    <option v-for="[value, label] in incidentCategories" :key="value" :value="value">
                      {{ label }}
                    </option>
                  </select>
                </label>
                <label class="block text-sm font-medium text-slate-800">
                  Descripción
                  <textarea
                    v-model="form.incidentNote"
                    data-test="incident-note"
                    maxlength="500"
                    rows="3"
                    class="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1"
                  />
                </label>
                <p v-if="formError" role="alert" class="text-sm text-red-700">{{ formError }}</p>
                <div class="flex gap-2">
                  <button
                    type="button"
                    data-test="incident-submit"
                    class="min-h-11 rounded-lg bg-slate-800 px-4 text-sm font-semibold text-white disabled:opacity-50"
                    :disabled="busy"
                    @click="submitIncident(stop.id)"
                  >
                    Registrar incidencia
                  </button>
                  <button type="button" class="min-h-11 px-3 text-sm underline" @click="close">Cancelar</button>
                </div>
              </template>
            </form>
          </li>
        </ol>
      </article>
    </template>

    <footer class="border-t border-slate-200 pt-3 text-xs text-slate-500">
      <p>
        Los datos de reparto y los eventos pendientes se guardan en este dispositivo hasta 12 h / 72 h. Borra los datos
        si el dispositivo es compartido.
      </p>
      <button type="button" data-test="clear-local" class="mt-1 min-h-11 underline" @click="app.clearLocalData()">
        Borrar datos locales
      </button>
    </footer>
  </section>
</template>
