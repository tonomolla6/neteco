<script setup lang="ts">
// SHP-029: la información de peligro químico es siempre visible en la ficha. Nunca se oculta por
// estar bloqueado un envío ni se sugiere que un producto sin clasificar es seguro.
interface HazardInfo {
  variantId: string
  classified: boolean
  unNumber?: string | null
  properShippingName?: string | null
  adrClass?: string | null
  packingGroup?: string | null
  pictograms: string[]
  signalWord?: string | null
  hazardStatements: string[]
  precautionaryStatements: string[]
  ufiCode?: string | null
  sdsVersion?: string | null
}

const props = defineProps<{ variantId: string }>()
const hazard = ref<HazardInfo | null>(null)
const state = ref<'loading' | 'ready' | 'error'>('loading')
let request = 0

async function load(variantId: string) {
  const current = ++request
  state.value = 'loading'
  try {
    const data = await $fetch<HazardInfo>('/api/storefront/adr/hazard-info', { query: { variantId } })
    if (current !== request) return
    hazard.value = data
    state.value = 'ready'
  } catch {
    if (current !== request) return
    hazard.value = null
    state.value = 'error'
  }
}

watch(
  () => props.variantId,
  (id) => void load(id),
  { immediate: true }
)
const dangerousSignal = computed(() => hazard.value?.signalWord && hazard.value.signalWord !== 'NONE')
</script>

<template>
  <section
    data-hazard-notice
    class="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
    :aria-busy="state === 'loading' ? 'true' : undefined"
    aria-labelledby="hazard-notice-title"
  >
    <h3 id="hazard-notice-title" class="font-bold">Peligros químicos y transporte</h3>
    <p v-if="state === 'loading'" class="mt-1">Cargando la información de peligro…</p>
    <p v-else-if="state === 'error'" role="alert" class="mt-1">
      No se pudo cargar la información de peligro. Consulta la ficha de datos de seguridad antes de manipular el
      producto.
    </p>
    <p v-else-if="hazard && !hazard.classified" class="mt-1">
      Clasificación de peligro pendiente de verificación. Consulta la ficha de datos de seguridad antes de manipular el
      producto.
    </p>
    <div v-else-if="hazard" class="mt-1 space-y-2">
      <p v-if="dangerousSignal">
        Palabra de advertencia: <strong>{{ hazard.signalWord }}</strong>
      </p>
      <p v-if="hazard.unNumber && hazard.unNumber !== 'NONE'">
        <strong>{{ hazard.unNumber }}</strong>
        <template v-if="hazard.properShippingName"> · {{ hazard.properShippingName }}</template>
        <template v-if="hazard.adrClass && hazard.adrClass !== 'NONE'"> · Clase {{ hazard.adrClass }}</template>
        <template v-if="hazard.packingGroup && hazard.packingGroup !== 'NONE'">
          · Grupo de embalaje {{ hazard.packingGroup }}
        </template>
      </p>
      <ul v-if="hazard.pictograms.length" class="flex flex-wrap gap-1.5" aria-label="Pictogramas de peligro">
        <li
          v-for="code in hazard.pictograms"
          :key="code"
          class="rounded border border-amber-400 bg-white px-1.5 py-0.5 font-mono text-xs"
        >
          {{ code }}
        </li>
      </ul>
      <ul v-if="hazard.hazardStatements.length" class="list-disc pl-5">
        <li v-for="statement in hazard.hazardStatements" :key="statement">{{ statement }}</li>
      </ul>
      <ul v-if="hazard.precautionaryStatements.length" class="list-disc pl-5">
        <li v-for="statement in hazard.precautionaryStatements" :key="statement">{{ statement }}</li>
      </ul>
      <p v-if="hazard.sdsVersion" class="text-xs">Ficha de datos de seguridad, versión {{ hazard.sdsVersion }}</p>
    </div>
  </section>
</template>
