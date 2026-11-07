<script setup lang="ts">
import type { ProductCompareResponse } from '~~/workers/catalog/product-compare'

const props = defineProps<{
  comparison: ProductCompareResponse
}>()

defineEmits<{
  (e: 'remove', slug: string): void
}>()

const technicalRows = computed(() => props.comparison.rows.filter((row) => row.group === 'technical'))

const regulatoryRows = computed(() => props.comparison.rows.filter((row) => row.group === 'regulatory'))
</script>

<template>
  <div class="w-full overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
    <table class="w-full border-collapse text-left" aria-label="Tabla comparativa de productos">
      <caption class="sr-only">
        Comparativa de especificaciones técnicas, precios, disponibilidad y datos de seguridad de productos
      </caption>

      <thead>
        <tr class="border-b border-slate-200 bg-slate-50">
          <th
            scope="col"
            class="sticky left-0 z-20 min-w-[200px] border-r border-slate-200 bg-slate-50 p-4 align-top sm:min-w-[240px]"
          >
            <div class="flex flex-col gap-1">
              <span class="text-xs font-semibold uppercase tracking-wider text-slate-500">Comparador</span>
              <span class="text-sm font-bold text-slate-900">
                {{ comparison.products.length }} {{ comparison.products.length === 1 ? 'producto' : 'productos' }}
              </span>
            </div>
          </th>

          <th
            v-for="product in comparison.products"
            :key="product.slug"
            scope="col"
            class="min-w-[220px] border-r border-slate-200 bg-slate-50 p-4 align-top sm:min-w-[260px]"
          >
            <div class="flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <span v-if="product.brand" class="text-[11px] font-semibold uppercase tracking-wider text-neteco-600">
                  {{ product.brand }}
                </span>
                <button
                  type="button"
                  :aria-label="`Quitar ${product.name} de la comparativa`"
                  class="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-slate-500 hover:bg-slate-200 hover:text-red-700"
                  @click="$emit('remove', product.slug)"
                >
                  <UIcon name="i-lucide-x" class="size-3.5" />
                  <span>Quitar</span>
                </button>
              </div>

              <div class="flex h-24 w-full items-center justify-center">
                <img
                  v-if="product.image"
                  :src="product.image"
                  :alt="product.imageAlt || product.name"
                  width="96"
                  height="96"
                  loading="lazy"
                  class="max-h-full max-w-full object-contain"
                />
                <div v-else class="text-xs text-slate-400">Sin imagen</div>
              </div>

              <NuxtLink
                :to="`/producto/${product.slug}`"
                class="line-clamp-2 text-sm font-bold text-slate-900 hover:text-neteco-600"
              >
                {{ product.name }}
              </NuxtLink>

              <div class="mt-1">
                <div class="tabular font-display text-base font-bold text-slate-900">
                  <span class="font-sans text-xs font-normal text-slate-500">desde </span>
                  {{ formatPrice(product.minPrice) }}
                </div>
                <p class="text-[11px] text-slate-500">{{ formatPrice(product.minNetPrice) }} sin IVA</p>
              </div>

              <div class="text-xs text-slate-600">
                <span class="font-medium">{{ product.primaryFormat }}</span>
                <span v-if="product.formats.length > 1" class="text-slate-400">
                  · {{ product.formats.length }} formatos
                </span>
              </div>

              <div class="mt-1">
                <span
                  v-if="product.availability === 'in_stock'"
                  class="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700"
                >
                  <UIcon name="i-lucide-check-circle" class="size-3.5" />
                  <span>En stock</span>
                </span>
                <span
                  v-else-if="product.availability === 'backorder'"
                  class="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700"
                >
                  <UIcon name="i-lucide-clock" class="size-3.5" />
                  <span>Bajo pedido</span>
                </span>
                <span
                  v-else
                  class="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-700"
                >
                  <UIcon name="i-lucide-x-circle" class="size-3.5" />
                  <span>Agotado</span>
                </span>
              </div>
            </div>
          </th>
        </tr>
      </thead>

      <tbody>
        <!-- Sección atributos técnicos -->
        <tr v-if="technicalRows.length > 0" class="border-b border-slate-200 bg-slate-100/80">
          <td
            :colspan="comparison.products.length + 1"
            class="px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-700"
          >
            Especificaciones técnicas
          </td>
        </tr>

        <tr
          v-for="row in technicalRows"
          :key="row.code"
          class="border-b border-slate-100 transition hover:bg-slate-50/50"
        >
          <th
            scope="row"
            class="sticky left-0 z-10 border-r border-slate-200 bg-white p-3 px-4 align-top text-xs font-semibold text-slate-800"
          >
            <div class="flex items-center justify-between gap-2">
              <span>{{ row.label }}</span>
              <span
                v-if="row.hasDifference"
                class="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900"
                title="Valores diferentes entre productos"
              >
                <UIcon name="i-lucide-sparkles" class="size-3" />
                <span>Diferencia</span>
              </span>
            </div>
          </th>

          <td
            v-for="val in row.values"
            :key="val.productSlug"
            :class="[
              'border-r border-slate-200 p-3 px-4 align-middle text-xs',
              val.isDifferent
                ? 'border-l-2 border-l-amber-500 bg-amber-50/70 font-semibold text-slate-900'
                : 'text-slate-700',
              !val.present ? 'italic text-slate-400' : ''
            ]"
          >
            <div class="flex items-center gap-1.5">
              <span v-if="val.isDifferent" class="sr-only">Diferencia respecto a otros productos:</span>
              <span v-if="val.isDifferent" class="text-amber-600" aria-hidden="true" title="Diferencia">●</span>
              <span v-if="!val.present" aria-label="No indicado">{{ val.displayValue }}</span>
              <span v-else>{{ val.displayValue }}</span>
            </div>
          </td>
        </tr>

        <!-- Sección regulatoria y de seguridad -->
        <tr v-if="regulatoryRows.length > 0" class="border-b border-slate-200 bg-slate-100/80">
          <td
            :colspan="comparison.products.length + 1"
            class="px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-700"
          >
            Seguridad y normativa (información oficial del fabricante, sin ponderación comercial)
          </td>
        </tr>

        <tr
          v-for="row in regulatoryRows"
          :key="row.code"
          class="border-b border-slate-100 transition hover:bg-slate-50/50"
        >
          <th
            scope="row"
            class="sticky left-0 z-10 border-r border-slate-200 bg-white p-3 px-4 align-top text-xs font-semibold text-slate-800"
          >
            {{ row.label }}
          </th>

          <td
            v-for="val in row.values"
            :key="val.productSlug"
            :class="[
              'border-r border-slate-200 p-3 px-4 align-top text-xs text-slate-700',
              !val.present ? 'italic text-slate-400' : ''
            ]"
          >
            <span v-if="!val.present" aria-label="No indicado">{{ val.displayValue }}</span>
            <template v-else-if="row.code === 'clp_pictograms' && Array.isArray(val.rawValue)">
              <div class="flex flex-wrap gap-1">
                <span
                  v-for="pic in val.rawValue"
                  :key="pic"
                  class="inline-flex items-center rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 font-mono text-[11px] font-bold text-rose-800"
                >
                  {{ pic }}
                </span>
              </div>
            </template>
            <template v-else-if="row.code === 'hazard_statements' && Array.isArray(val.rawValue)">
              <ul class="list-disc space-y-1 pl-4 text-[11px]">
                <li v-for="stmt in val.rawValue" :key="stmt">{{ stmt }}</li>
              </ul>
            </template>
            <span v-else>{{ val.displayValue }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
