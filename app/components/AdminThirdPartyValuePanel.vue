<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Script {
  id: string
  vendor: string
  name: string
  kind: string
  monthlyCostCents: number
  loadMsP75: number
  status: 'active' | 'removed'
  version: number
  latestVerdict: 'keep' | 'remove' | 'inconclusive' | null
}

const requestFetch = useRequestFetch()
const loading = ref(true)
const busy = ref(false)
const errorMessage = ref('')
const notice = ref('')
const scripts = ref<Script[]>([])
const reasons = ref<Record<string, string>>({})
const form = ref({ vendor: '', name: '', kind: 'pixel', monthlyCostEur: 0, loadMsP75: 0 })

const verdictLabel: Record<string, string> = {
  keep: 'Mantener',
  remove: 'Eliminar: sin retorno',
  inconclusive: 'Sin concluir'
}

function errorText(error: unknown, fallback: string): string {
  const code = (error as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `${fallback} (${code})` : fallback
}

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    scripts.value =
      ((await requestFetch('/api/admin/performance/third-parties')) as { scripts: Script[] })?.scripts ?? []
  } catch (error) {
    errorMessage.value = errorText(error, 'No se pudo cargar el registro de terceros')
  } finally {
    loading.value = false
  }
}

async function post(path: string, body: Record<string, unknown>, success: string) {
  busy.value = true
  errorMessage.value = ''
  notice.value = ''
  try {
    await requestFetch(`/api/admin/performance/third-parties/${path}`, {
      method: 'POST',
      body: { commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), ...body }
    })
    notice.value = success
    await load()
  } catch (error) {
    errorMessage.value = errorText(error, 'La operación no se pudo completar')
  } finally {
    busy.value = false
  }
}

const register = () =>
  post(
    'scripts',
    {
      vendor: form.value.vendor.trim(),
      name: form.value.name.trim(),
      kind: form.value.kind,
      monthlyCostCents: Math.round(Number(form.value.monthlyCostEur) * 100),
      loadMsP75: Math.round(Number(form.value.loadMsP75))
    },
    'Script registrado.'
  )
const remove = (script: Script) =>
  post(
    'remove',
    { scriptId: script.id, expectedVersion: script.version, reason: (reasons.value[script.id] ?? '').trim() },
    'Script eliminado del manifiesto.'
  )

onMounted(load)
</script>

<template>
  <section class="space-y-4" aria-labelledby="third-party-title" data-third-party-panel>
    <div>
      <h2 id="third-party-title" class="text-lg font-semibold text-neutral-900">Terceros: valor frente a coste</h2>
      <p class="text-xs text-neutral-600">
        Cada píxel o widget se mide con un A/B (cargado frente a no cargado). Si no devuelve valor, se elimina.
      </p>
    </div>
    <div v-if="errorMessage" role="alert" class="rounded bg-red-100 p-3 text-sm text-red-700" data-error>
      {{ errorMessage }} <button type="button" class="ml-2 underline" data-retry @click="load">Reintentar</button>
    </div>
    <div v-if="notice" role="status" class="rounded bg-emerald-100 p-3 text-sm text-emerald-700">{{ notice }}</div>

    <form class="grid gap-3 rounded border border-neutral-200 bg-white p-4 sm:grid-cols-5" @submit.prevent="register">
      <label class="text-xs font-medium">
        Proveedor
        <input
          v-model="form.vendor"
          required
          minlength="2"
          maxlength="80"
          class="mt-1 w-full rounded border px-2 py-1 text-sm"
        />
      </label>
      <label class="text-xs font-medium">
        Nombre
        <input
          v-model="form.name"
          required
          minlength="2"
          maxlength="80"
          class="mt-1 w-full rounded border px-2 py-1 text-sm"
        />
      </label>
      <label class="text-xs font-medium">
        Tipo
        <select v-model="form.kind" class="mt-1 w-full rounded border px-2 py-1 text-sm">
          <option value="pixel">Píxel</option>
          <option value="widget">Widget</option>
          <option value="analytics">Analítica</option>
          <option value="chat">Chat</option>
          <option value="ab_testing">A/B</option>
          <option value="other">Otro</option>
        </select>
      </label>
      <label class="text-xs font-medium">
        Coste mensual (EUR)
        <input
          v-model.number="form.monthlyCostEur"
          type="number"
          min="0"
          step="0.01"
          class="mt-1 w-full rounded border px-2 py-1 text-sm"
        />
      </label>
      <div class="flex items-end">
        <button
          type="submit"
          class="rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          :disabled="busy"
        >
          Registrar
        </button>
      </div>
    </form>

    <p v-if="loading" class="py-4 text-center text-sm text-neutral-500" data-loading>Cargando terceros...</p>
    <p v-else-if="!scripts.length && !errorMessage" class="py-4 text-center text-sm text-neutral-500" data-empty>
      No hay scripts de terceros registrados.
    </p>
    <ul v-else class="space-y-2">
      <li v-for="s in scripts" :key="s.id" class="rounded border border-neutral-200 bg-white p-3 text-sm" data-script>
        <div class="flex flex-wrap items-center gap-2">
          <strong>{{ s.vendor }} · {{ s.name }}</strong>
          <span class="text-xs text-neutral-500"
            >{{ s.kind }} · {{ (s.monthlyCostCents / 100).toFixed(2) }} EUR/mes · {{ s.loadMsP75 }} ms p75</span
          >
          <span v-if="s.status === 'removed'" class="rounded bg-neutral-200 px-2 text-xs" data-removed>Eliminado</span>
          <span
            v-else-if="s.latestVerdict"
            class="rounded px-2 text-xs"
            :class="s.latestVerdict === 'remove' ? 'bg-red-100 text-red-800' : 'bg-emerald-100 text-emerald-800'"
            data-verdict
          >
            {{ verdictLabel[s.latestVerdict] }}
          </span>
          <span v-else class="text-xs text-neutral-500">Sin A/B registrado</span>
        </div>
        <div v-if="s.status === 'active'" class="mt-2 flex flex-wrap items-center gap-2">
          <input
            v-model="reasons[s.id]"
            :aria-label="`Motivo para eliminar ${s.name}`"
            placeholder="Motivo (mín. 10 caracteres)"
            maxlength="500"
            class="min-w-0 flex-1 rounded border px-2 py-1 text-xs"
          />
          <button
            type="button"
            class="rounded border border-red-300 px-2 py-1 text-xs text-red-800 disabled:opacity-50"
            :disabled="busy || (reasons[s.id] ?? '').trim().length < 10"
            data-remove
            @click="remove(s)"
          >
            Eliminar
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
