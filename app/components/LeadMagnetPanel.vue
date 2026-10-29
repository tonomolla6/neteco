<script setup lang="ts">
import { dilutionPlan, LEAD_MAGNET_CONSENT_TEXT, type DilutionPlan, type LeadMagnet } from '~~/shared/lead-magnets'

/**
 * MKT-029. The resource is fully usable without any form. The only form asks for an
 * e-mail to receive a copy; the marketing checkbox is optional, unchecked and never
 * required for the copy.
 */
const props = defineProps<{ slug: string }>()

const magnet = ref<LeadMagnet | null>(null)
const loading = ref(true)
const loadError = ref(false)
const checked = ref<string[]>([])

const calc = reactive({ mode: 'percent' as 'percent' | 'ratio', value: '', liters: '', price: '' })
const plan = ref<DilutionPlan | null>(null)
const calcError = ref('')

const form = reactive({ email: '', marketingConsent: false, website: '' })
const sending = ref(false)
const sent = ref(false)
const formError = ref('')

async function load() {
  loading.value = true
  loadError.value = false
  try {
    magnet.value = (await $fetch(`/api/lead-magnets/${encodeURIComponent(props.slug)}`)) as LeadMagnet
  } catch {
    magnet.value = null
    loadError.value = true
  } finally {
    loading.value = false
  }
}
await load()

const progress = computed(() => (magnet.value?.kind === 'checklist' ? checked.value.length : 0))

function calculate() {
  calcError.value = ''
  plan.value = null
  const value = Number(calc.value.replace(',', '.'))
  const liters = Number(calc.liters.replace(',', '.'))
  const price = calc.price.trim() === '' ? undefined : Math.round(Number(calc.price.replace(',', '.')) * 100)
  try {
    plan.value = dilutionPlan(
      calc.mode === 'percent'
        ? { mode: 'percent', percent: value, finalVolumeMl: liters * 1000, productPricePerLiterCents: price }
        : { mode: 'ratio', waterParts: value, finalVolumeMl: liters * 1000, productPricePerLiterCents: price }
    )
  } catch {
    calcError.value = 'Revisa los valores: usa números positivos dentro de los rangos habituales.'
  }
}

async function requestCopy() {
  formError.value = ''
  sending.value = true
  try {
    await $fetch(`/api/lead-magnets/${encodeURIComponent(props.slug)}/request-copy`, {
      method: 'POST',
      body: {
        email: form.email,
        marketingConsent: form.marketingConsent,
        ...(form.website ? { website: form.website } : {})
      }
    })
    sent.value = true
  } catch (error) {
    const status =
      (error as { statusCode?: number; status?: number }).statusCode ?? (error as { status?: number }).status
    formError.value =
      status === 429
        ? 'Has hecho demasiadas solicitudes. Inténtalo de nuevo más tarde.'
        : 'No hemos podido enviar la copia. Revisa el e-mail e inténtalo de nuevo.'
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <section class="mx-auto max-w-3xl space-y-8 px-4 py-8" aria-labelledby="lead-magnet-title">
    <p v-if="loading" role="status">Cargando recurso…</p>
    <div v-else-if="loadError || !magnet" role="alert" class="space-y-3">
      <p>No hemos podido cargar este recurso.</p>
      <button type="button" class="rounded border px-3 py-2" @click="load">Reintentar</button>
    </div>
    <template v-else>
      <header class="space-y-2">
        <h1 id="lead-magnet-title" class="text-3xl font-bold">{{ magnet.title }}</h1>
        <p>{{ magnet.description }}</p>
      </header>

      <div v-if="magnet.kind === 'checklist'" class="space-y-3">
        <p aria-live="polite" data-testid="progress">
          {{ progress }} de {{ magnet.items.length }} comprobaciones hechas
        </p>
        <ul class="space-y-3">
          <li v-for="item in magnet.items" :key="item.id" class="rounded border p-3">
            <label class="flex items-start gap-3">
              <input v-model="checked" type="checkbox" :value="item.id" class="mt-1" />
              <span>
                <span class="block font-medium">{{ item.action }}</span>
                <span class="block text-sm opacity-80">{{ item.why }}</span>
              </span>
            </label>
          </li>
        </ul>
      </div>

      <form v-else-if="magnet.kind === 'calculator'" class="space-y-4" novalidate @submit.prevent="calculate">
        <div>
          <label for="calc-mode" class="block font-medium">Cómo indica la etiqueta la dilución</label>
          <select id="calc-mode" v-model="calc.mode" class="w-full rounded border p-2">
            <option value="percent">Porcentaje de producto (%)</option>
            <option value="ratio">1 parte de producto por N partes de agua</option>
          </select>
        </div>
        <div>
          <label for="calc-value" class="block font-medium">
            {{ calc.mode === 'percent' ? 'Porcentaje (0,1 a 100)' : 'Partes de agua (1 a 1000)' }}
          </label>
          <input id="calc-value" v-model="calc.value" inputmode="decimal" class="w-full rounded border p-2" />
        </div>
        <div>
          <label for="calc-liters" class="block font-medium">Volumen final (litros)</label>
          <input id="calc-liters" v-model="calc.liters" inputmode="decimal" class="w-full rounded border p-2" />
        </div>
        <div>
          <label for="calc-price" class="block font-medium">Precio del producto por litro, en euros (opcional)</label>
          <input id="calc-price" v-model="calc.price" inputmode="decimal" class="w-full rounded border p-2" />
        </div>
        <button type="submit" class="rounded border px-3 py-2">Calcular</button>
        <p v-if="calcError" role="alert">{{ calcError }}</p>
        <div v-if="plan" aria-live="polite" data-testid="calc-result" class="rounded border p-3">
          <p>Producto: {{ plan.productMl }} ml</p>
          <p>Agua: {{ plan.waterMl }} ml</p>
          <p v-if="plan.productCostCents !== null">
            Coste de producto: {{ (plan.productCostCents / 100).toFixed(2) }} € ({{
              ((plan.costPerLiterCents ?? 0) / 100).toFixed(2)
            }}
            € por litro preparado)
          </p>
          <p class="text-sm opacity-80">{{ plan.notice }}</p>
        </div>
      </form>

      <div v-else class="space-y-4">
        <article v-for="section in magnet.sections" :key="section.id">
          <h2 class="text-xl font-semibold">{{ section.heading }}</h2>
          <p>{{ section.body }}</p>
        </article>
      </div>

      <form class="space-y-4 rounded border p-4" aria-labelledby="copy-title" @submit.prevent="requestCopy">
        <h2 id="copy-title" class="text-xl font-semibold">Recibir una copia por e-mail</h2>
        <p class="text-sm">Opcional. Solo necesitamos tu e-mail para enviarte este recurso.</p>
        <p v-if="sent" role="status">Si la dirección es válida, recibirás la copia en unos minutos.</p>
        <template v-else>
          <div>
            <label for="copy-email" class="block font-medium">E-mail</label>
            <input
              id="copy-email"
              v-model="form.email"
              type="email"
              required
              autocomplete="email"
              maxlength="254"
              class="w-full rounded border p-2"
            />
          </div>
          <div class="hidden" aria-hidden="true">
            <label for="copy-website">No rellenar</label>
            <input id="copy-website" v-model="form.website" tabindex="-1" autocomplete="off" />
          </div>
          <label class="flex items-start gap-3">
            <input v-model="form.marketingConsent" type="checkbox" class="mt-1" />
            <span class="text-sm">{{ LEAD_MAGNET_CONSENT_TEXT }}</span>
          </label>
          <p v-if="formError" role="alert">{{ formError }}</p>
          <button type="submit" class="rounded border px-3 py-2" :disabled="sending">
            {{ sending ? 'Enviando…' : 'Enviarme la copia' }}
          </button>
        </template>
      </form>
    </template>
  </section>
</template>
