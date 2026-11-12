<script setup lang="ts">
import { PICTOGRAM_NAMES, type ProductSafety } from '~~/shared/product-safety'

/**
 * Seguridad y fichas de un producto químico. Solo se monta si `safety.chemical`: el menaje y
 * la celulosa no llevan ningún bloque de peligros. Las frases se muestran tal como están
 * publicadas; si falta la ficha de datos de seguridad, se ofrece bajo petición en vez de
 * pedir al cliente que consulte un documento que no tiene.
 */
const props = defineProps<{
  safety: ProductSafety
  productSlug: string
  /** Versión compacta para la columna de compra: pictogramas, palabra y enlace a la FDS. */
  summary?: boolean
}>()
const emit = defineEmits<{ details: [] }>()
const runtime = useRuntimeConfig()

const ICONS: Record<string, string> = {
  GHS01: 'i-lucide-bomb',
  GHS02: 'i-lucide-flame',
  GHS03: 'i-lucide-flame-kindling',
  GHS04: 'i-lucide-cylinder',
  GHS05: 'i-lucide-test-tube-diagonal',
  GHS06: 'i-lucide-skull',
  GHS08: 'i-lucide-person-standing',
  GHS09: 'i-lucide-fish'
}
const contactTo = computed(() =>
  runtime.public.serverRuntime === 'cloudflare'
    ? { path: '/contacto', query: { producto: props.productSlug, asunto: 'ficha-seguridad' } }
    : '/contacto'
)
const DOCUMENT_LABELS = {
  sds: 'Ficha de datos de seguridad',
  datasheet: 'Ficha técnica',
  label: 'Etiqueta',
  certificate: 'Certificado'
} as const
</script>

<template>
  <div data-product-safety :class="summary ? 'space-y-2' : 'space-y-5'">
    <div v-if="safety.pictograms.length || safety.signalWord" class="flex flex-wrap items-center gap-3">
      <ul v-if="safety.pictograms.length" class="flex flex-wrap gap-2" aria-label="Pictogramas de peligro">
        <li
          v-for="code in safety.pictograms"
          :key="code"
          data-hazard-pictogram
          class="flex items-center gap-2"
          :title="PICTOGRAM_NAMES[code]"
        >
          <!-- Rombo CLP: borde rojo, fondo blanco, símbolo negro -->
          <span
            class="relative inline-flex items-center justify-center"
            :class="summary ? 'size-9' : 'size-11'"
            aria-hidden="true"
          >
            <span class="absolute inset-[15%] rotate-45 rounded-[2px] border-[3px] border-red-600 bg-white" />
            <UIcon
              v-if="ICONS[code]"
              :name="ICONS[code]!"
              class="relative text-slate-950"
              :class="summary ? 'size-4' : 'size-5'"
            />
            <span v-else class="relative font-display text-lg font-black leading-none text-slate-950">!</span>
          </span>
          <span v-if="!summary" class="text-[13px] text-[var(--text)]">{{ PICTOGRAM_NAMES[code] }}</span>
          <span v-else class="sr-only">{{ PICTOGRAM_NAMES[code] }}</span>
        </li>
      </ul>
      <p v-if="safety.signalWord" class="text-[15px] font-bold uppercase tracking-wide text-red-700">
        {{ safety.signalWord }}
      </p>
    </div>

    <template v-if="summary">
      <p class="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
        <a
          v-if="safety.sds"
          :href="safety.sds.url"
          target="_blank"
          rel="noopener"
          data-sds-link
          class="inline-flex min-h-6 items-center gap-1 font-semibold text-[var(--link)] underline underline-offset-2"
        >
          <UIcon name="i-lucide-file-down" class="size-4" aria-hidden="true" /> Ficha de seguridad (PDF)
        </a>
        <NuxtLink
          v-else
          :to="contactTo"
          data-sds-on-request
          class="min-h-6 font-semibold text-[var(--link)] underline underline-offset-2"
        >
          Ficha de seguridad disponible bajo petición
        </NuxtLink>
        <button
          v-if="safety.hazardStatements.length || safety.precautionaryStatements.length"
          type="button"
          class="min-h-6 text-[var(--text-muted)] underline underline-offset-2"
          @click="emit('details')"
        >
          Ver indicaciones de peligro
        </button>
      </p>
    </template>

    <template v-else>
      <div v-if="safety.hazardStatements.length" class="max-w-3xl">
        <h3 class="text-[15px] font-semibold text-[var(--text-strong)]">Indicaciones de peligro</h3>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-[15px] leading-relaxed text-[var(--text)]">
          <li v-for="statement in safety.hazardStatements" :key="statement">{{ statement }}</li>
        </ul>
      </div>
      <div v-if="safety.precautionaryStatements.length" class="max-w-3xl">
        <h3 class="text-[15px] font-semibold text-[var(--text-strong)]">Consejos de prudencia</h3>
        <ul class="mt-2 list-disc space-y-1 pl-5 text-[15px] leading-relaxed text-[var(--text)]">
          <li v-for="statement in safety.precautionaryStatements" :key="statement">{{ statement }}</li>
        </ul>
      </div>
      <p v-if="safety.safetyInstructions" class="max-w-3xl text-[15px] leading-relaxed text-[var(--text)]">
        {{ safety.safetyInstructions }}
      </p>
      <dl v-if="safety.ufi || safety.registrationNumber" class="grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <template v-if="safety.ufi">
          <dt class="text-[13px] text-[var(--text-muted)]">UFI</dt>
          <dd class="tabular text-[15px] font-medium text-[var(--text-strong)]">{{ safety.ufi }}</dd>
        </template>
        <template v-if="safety.registrationNumber">
          <dt class="text-[13px] text-[var(--text-muted)]">Registro</dt>
          <dd class="tabular text-[15px] font-medium text-[var(--text-strong)]">{{ safety.registrationNumber }}</dd>
        </template>
      </dl>

      <div>
        <h3 class="text-[15px] font-semibold text-[var(--text-strong)]">Documentos</h3>
        <ul class="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <li v-for="document in [...(safety.sds ? [safety.sds] : []), ...safety.otherDocuments]" :key="document.url">
            <a
              :href="document.url"
              target="_blank"
              rel="noopener"
              :data-sds-link="document.role === 'sds' ? '' : undefined"
              class="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-strong)] px-3 text-[15px] font-medium text-[var(--text-strong)] hover:border-[var(--action)] hover:text-[var(--action)]"
            >
              <UIcon name="i-lucide-file-down" class="size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
              {{ DOCUMENT_LABELS[document.role] }}
              <span class="text-[13px] font-normal text-[var(--text-muted)]">
                PDF · v{{ document.version }}<template v-if="document.language"> · {{ document.language }}</template>
              </span>
            </a>
          </li>
        </ul>
        <p v-if="!safety.sds" data-sds-on-request class="mt-3 text-[15px] text-[var(--text)]">
          Ficha de seguridad disponible bajo petición.
          <NuxtLink :to="contactTo" class="font-semibold text-[var(--link)] underline underline-offset-2">
            Pídenosla
          </NuxtLink>
          y te la enviamos.
        </p>
      </div>
    </template>
  </div>
</template>
