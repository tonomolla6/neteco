<script setup lang="ts">
/** SEO-030: public linkable assets (guides, checklists, comparisons, studies, calculators) with methodology and date. */
import { ref, computed, onMounted } from 'vue'
import { computeDilution } from '~~/shared/content-governance'

interface Summary {
  slug: string
  kind: string
  title: string
  summary: string
  dataAsOf: string
  publishedAt: string
}
interface Detail extends Summary {
  methodology: string
  payload: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}
const props = defineProps<{ slug?: string }>()
const request = useRequestFetch()
const items = ref<Summary[]>([])
const detail = ref<Detail | null>(null)
const loading = ref(true)
const failed = ref(false)
const total = ref('1000')
const preset = ref(0)
const KINDS: Record<string, string> = {
  calculator: 'Calculadora',
  comparison: 'Comparativa',
  guide: 'Guía',
  checklist: 'Checklist',
  study: 'Estudio'
}
const result = computed(() => {
  const chosen = detail.value?.payload.presets?.[preset.value]
  const amount = Number(total.value)
  if (!chosen || total.value.trim() === '') return null
  return computeDilution({ totalMl: amount, concentrateParts: chosen.concentrateParts, waterParts: chosen.waterParts })
})
async function load() {
  loading.value = true
  failed.value = false
  try {
    if (props.slug) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(props.slug)) throw new Error('slug')
      detail.value = await request<Detail>(`/api/content-assets/${props.slug}`, { method: 'GET' })
    } else items.value = (await request<{ items: Summary[] }>('/api/content-assets', { method: 'GET' })).items
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)
</script>

<template>
  <section class="mx-auto max-w-3xl space-y-4 p-4" data-testid="content-assets">
    <h1 v-if="!props.slug" class="text-2xl font-bold">Datos y herramientas</h1>
    <p v-if="loading" role="status">Cargando…</p>
    <p v-else-if="failed" role="alert">El recurso no está disponible en este momento.</p>
    <template v-else-if="detail">
      <h1 class="text-2xl font-bold">{{ detail.title }}</h1>
      <p>{{ detail.summary }}</p>
      <p class="text-sm">{{ KINDS[detail.kind] }} · Datos a fecha de {{ detail.dataAsOf }}</p>
      <section aria-labelledby="method-title">
        <h2 id="method-title" class="font-semibold">Metodología</h2>
        <p>{{ detail.methodology }}</p>
      </section>
      <ul v-if="detail.kind === 'checklist'" class="list-disc pl-5">
        <li v-for="entry in detail.payload.items" :key="entry">{{ entry }}</li>
      </ul>
      <div v-else-if="detail.kind === 'guide'">
        <section v-for="s in detail.payload.sections" :key="s.heading">
          <h2 class="font-semibold">{{ s.heading }}</h2>
          <p>{{ s.body }}</p>
        </section>
      </div>
      <table v-else-if="detail.kind === 'comparison'" class="w-full text-left text-sm">
        <thead>
          <tr>
            <th scope="col" />
            <th v-for="c in detail.payload.columns" :key="c" scope="col">{{ c }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in detail.payload.rows" :key="row.label">
            <th scope="row">{{ row.label }}</th>
            <td v-for="(v, i) in row.values" :key="i">{{ v }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else-if="detail.kind === 'study'">
        <p>Muestra: {{ detail.payload.sampleSize }}</p>
        <table class="w-full text-left text-sm">
          <caption class="sr-only">
            Datos del estudio
          </caption>
          <tbody>
            <tr v-for="d in detail.payload.dataset" :key="d.label">
              <th scope="row">{{ d.label }}</th>
              <td>{{ d.value }} {{ d.unit }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <form v-else-if="detail.kind === 'calculator'" class="space-y-2" @submit.prevent>
        <label class="block text-sm"
          >Uso
          <select v-model.number="preset" class="block w-full rounded border p-2">
            <option v-for="(p, i) in detail.payload.presets" :key="p.use" :value="i">
              {{ p.use }} ({{ p.concentrateParts }}:{{ p.waterParts }})
            </option>
          </select>
        </label>
        <label class="block text-sm"
          >Volumen total (ml)
          <input v-model="total" inputmode="decimal" class="block w-full rounded border p-2" data-testid="calc-total" />
        </label>
        <p v-if="result" role="status" data-testid="calc-result">
          Producto: {{ result.concentrateMl }} ml · Agua: {{ result.waterMl }} ml
        </p>
        <p v-else class="text-sm">Introduce un volumen entre 1 y 1.000.000 ml.</p>
      </form>
    </template>
    <template v-else>
      <p v-if="!items.length" data-testid="assets-empty">Aún no hay recursos publicados.</p>
      <ul v-else class="space-y-3">
        <li v-for="item in items" :key="item.slug">
          <a :href="`/datos-y-herramientas/${item.slug}`" class="font-semibold">{{ item.title }}</a>
          <p class="text-sm">{{ KINDS[item.kind] }} · Datos a fecha de {{ item.dataAsOf }}</p>
          <p class="text-sm">{{ item.summary }}</p>
        </li>
      </ul>
    </template>
  </section>
</template>
