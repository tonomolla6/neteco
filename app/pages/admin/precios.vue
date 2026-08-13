<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Precios · Admin' })

interface VolumeTier {
  minimumQuantity: number
  unitGrossCents: number
}

interface PriceVersion {
  id: string
  grossCents: number
  compareAtGrossCents: number | null
  referenceGrossCents30d: number | null
  volumeTiers: VolumeTier[]
  validFrom: string
  validUntil: string | null
  status: 'approved' | 'cancelled'
  reason: string
}

interface PriceItem {
  variantId: string
  id: number
  sku: string
  format: string
  product: string
  grossCents: number
  compareAtGrossCents: number | null
  referenceGrossCents30d: number | null
  volumeTiers: VolumeTier[]
  pricingVersion: string
  validFrom: string
  history: PriceVersion[]
}

const search = ref('')
const query = ref('')
const { data, refresh } = await useFetch<{ items: PriceItem[] }>('/api/admin/prices', {
  query: computed(() => ({ q: query.value || undefined }))
})
const items = computed(() => data.value?.items ?? [])
const selected = ref<PriceItem | null>(null)
const toast = useToast()
const saving = ref(false)
const form = reactive({
  gross: null as number | null,
  compareAt: null as number | null,
  validFrom: '',
  reason: '',
  tiers: [] as Array<{ minimumQuantity: number | null; unitGross: number | null }>
})

function localDateInput(hours = 1) {
  const date = new Date(Date.now() + hours * 60 * 60_000)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function choose(item: PriceItem) {
  selected.value = item
  Object.assign(form, {
    gross: item.grossCents / 100,
    compareAt: item.compareAtGrossCents === null ? null : item.compareAtGrossCents / 100,
    validFrom: localDateInput(),
    reason: '',
    tiers: item.volumeTiers.map((tier) => ({
      minimumQuantity: tier.minimumQuantity,
      unitGross: tier.unitGrossCents / 100
    }))
  })
}

function addTier() {
  form.tiers.push({ minimumQuantity: null, unitGross: null })
}

function submitSearch() {
  query.value = search.value.trim()
}

async function schedule() {
  if (!selected.value) return
  saving.value = true
  try {
    await $fetch('/api/admin/prices', {
      method: 'POST',
      body: {
        variantId: selected.value.variantId,
        grossCents: Math.round(Number(form.gross) * 100),
        compareAtGrossCents: form.compareAt == null ? null : Math.round(Number(form.compareAt) * 100),
        volumeTiers: form.tiers.map((tier) => ({
          minimumQuantity: Number(tier.minimumQuantity),
          unitGrossCents: Math.round(Number(tier.unitGross) * 100)
        })),
        validFrom: new Date(form.validFrom).toISOString(),
        reason: form.reason
      }
    })
    await refresh()
    selected.value = null
    toast.add({ title: 'Precio programado', color: 'success' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido programar el precio'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function cancel(version: PriceVersion) {
  const reason = prompt('Motivo de cancelación de la programación')?.trim()
  if (!reason) return
  try {
    await $fetch(`/api/admin/prices/${version.id}/cancel`, { method: 'POST', body: { reason } })
    await refresh()
    toast.add({ title: 'Programación cancelada', color: 'success' })
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido cancelar la programación'), color: 'error' })
  }
}

function isUpcoming(version: PriceVersion) {
  return version.status === 'approved' && new Date(version.validFrom) > new Date()
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-slate-900">Precios e histórico</h1>
    <p class="mt-1 text-sm text-slate-500">
      Programa vigencias sin despliegue, conserva la referencia de 30 días y define tramos de volumen.
    </p>

    <form class="mt-5 flex gap-2" @submit.prevent="submitSearch">
      <UInput v-model="search" class="max-w-lg flex-1" placeholder="Producto o referencia" />
      <UButton type="submit" icon="i-lucide-search">Buscar</UButton>
    </form>

    <form v-if="selected" class="mt-5 rounded-2xl border border-neteco-200 bg-neteco-50 p-5" @submit.prevent="schedule">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="font-semibold text-slate-900">{{ selected.product }} · {{ selected.format }}</h2>
          <p class="font-mono text-xs text-slate-500">{{ selected.sku }}</p>
        </div>
        <UButton type="button" variant="ghost" icon="i-lucide-x" @click="selected = null">Cerrar</UButton>
      </div>
      <div class="mt-4 grid gap-3 md:grid-cols-4">
        <UFormField label="Nuevo precio € IVA inc.">
          <UInput v-model.number="form.gross" type="number" min="0.01" step="0.01" required />
        </UFormField>
        <UFormField label="Precio anterior € (opcional)">
          <UInput v-model.number="form.compareAt" type="number" min="0.01" step="0.01" />
        </UFormField>
        <UFormField label="Vigente desde">
          <UInput v-model="form.validFrom" type="datetime-local" required />
        </UFormField>
        <UFormField label="Motivo">
          <UInput v-model="form.reason" required placeholder="Campaña, tarifa proveedor…" />
        </UFormField>
      </div>
      <div class="mt-4">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold text-slate-800">Tramos por volumen</h3>
          <UButton type="button" size="sm" variant="soft" icon="i-lucide-plus" @click="addTier">Añadir tramo</UButton>
        </div>
        <div v-for="(tier, index) in form.tiers" :key="index" class="mt-2 flex items-end gap-2">
          <UFormField label="Desde unidades">
            <UInput v-model.number="tier.minimumQuantity" type="number" min="1" required />
          </UFormField>
          <UFormField label="Precio unitario €">
            <UInput v-model.number="tier.unitGross" type="number" min="0.01" step="0.01" required />
          </UFormField>
          <UButton
            type="button"
            color="error"
            variant="ghost"
            icon="i-lucide-trash-2"
            @click="form.tiers.splice(index, 1)"
          />
        </div>
      </div>
      <div class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-4 text-sm">
        <p>
          Vista previa: <strong>{{ formatPrice(Math.round(Number(form.gross || 0) * 100)) }}</strong> desde
          {{ form.validFrom ? new Date(form.validFrom).toLocaleString('es-ES') : '—' }}
          <span v-if="form.tiers.length"> · {{ form.tiers.length }} tramo(s)</span>
        </p>
        <UButton type="submit" :loading="saving" icon="i-lucide-calendar-check">Programar precio</UButton>
      </div>
    </form>

    <div class="mt-5 space-y-3">
      <article v-for="item in items" :key="item.variantId" class="rounded-2xl border border-slate-200 bg-white p-5">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 class="font-semibold text-slate-900">{{ item.product }}</h2>
            <p class="text-sm text-slate-600">
              {{ item.format }} · <span class="font-mono">{{ item.sku }}</span>
            </p>
          </div>
          <div class="text-right">
            <p class="text-xl font-bold text-slate-900">{{ formatPrice(item.grossCents) }}</p>
            <p v-if="item.referenceGrossCents30d" class="text-xs text-slate-500">
              Referencia 30 días: {{ formatPrice(item.referenceGrossCents30d) }}
            </p>
          </div>
          <UButton size="sm" icon="i-lucide-calendar-plus" @click="choose(item)">Nueva vigencia</UButton>
        </div>
        <div v-if="item.volumeTiers.length" class="mt-3 flex flex-wrap gap-2 text-xs">
          <span
            v-for="tier in item.volumeTiers"
            :key="tier.minimumQuantity"
            class="rounded-full bg-emerald-50 px-3 py-1 text-emerald-800"
          >
            ≥ {{ tier.minimumQuantity }}: {{ formatPrice(tier.unitGrossCents) }}/ud
          </span>
        </div>
        <details class="mt-3 text-sm">
          <summary class="cursor-pointer font-medium text-slate-700">Histórico ({{ item.history.length }})</summary>
          <ul class="mt-2 divide-y divide-slate-100">
            <li v-for="version in item.history" :key="version.id" class="flex flex-wrap items-center gap-3 py-2">
              <span class="font-semibold">{{ formatPrice(version.grossCents) }}</span>
              <span>{{ new Date(version.validFrom).toLocaleString('es-ES') }}</span>
              <span v-if="version.validUntil">→ {{ new Date(version.validUntil).toLocaleString('es-ES') }}</span>
              <span v-else>→ sin fin</span>
              <UBadge :color="version.status === 'cancelled' ? 'neutral' : isUpcoming(version) ? 'warning' : 'success'">
                {{
                  version.status === 'cancelled'
                    ? 'cancelado'
                    : isUpcoming(version)
                      ? 'programado'
                      : 'vigente/histórico'
                }}
              </UBadge>
              <span class="text-slate-500">{{ version.reason }}</span>
              <UButton v-if="isUpcoming(version)" size="xs" color="error" variant="ghost" @click="cancel(version)">
                Cancelar
              </UButton>
            </li>
          </ul>
        </details>
      </article>
    </div>
  </div>
</template>
