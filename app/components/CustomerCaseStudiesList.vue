<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useCustomerCaseStudies } from '../composables/useCustomerCaseStudies'
import type { PublicCaseStudy } from '../../shared/customer-case-studies'

const { cases, loading, error, fetchPublicCases } = useCustomerCaseStudies()

const selectedSector = ref<string | null>(null)
const selectedCase = ref<PublicCaseStudy | null>(null)

onMounted(() => {
  fetchPublicCases()
})

const sectors = computed(() => {
  const set = new Set<string>()
  for (const c of cases.value) {
    if (c.sector) set.add(c.sector)
  }
  return Array.from(set)
})

const filteredCases = computed(() => {
  if (!selectedSector.value) return cases.value
  return cases.value.filter((c) => c.sector === selectedSector.value)
})

const handleSectorFilter = (sector: string | null) => {
  selectedSector.value = sector
  selectedCase.value = null
}
</script>

<template>
  <div class="space-y-8" aria-labelledby="case-studies-heading">
    <!-- Header -->
    <header class="border-b border-gray-200 pb-6 dark:border-gray-800">
      <div class="max-w-3xl">
        <span
          class="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          ✓ Evidencia empírica verificada
        </span>
        <h1
          id="case-studies-heading"
          class="mt-3 text-3xl font-extrabold tracking-tight text-gray-900 sm:text-4xl dark:text-gray-100"
        >
          Casos de Éxito de Clientes Neteco
        </h1>
        <p class="mt-3 text-base leading-relaxed text-gray-600 dark:text-gray-400">
          Auditorías técnicas reales y resultados verificados en plantas industriales, lavanderías y hostelería. Todas
          las publicaciones cuentan con autorización formal y revisión periódica de vigencia.
        </p>
      </div>

      <!-- Filtro por sector -->
      <div v-if="sectors.length > 0" class="mt-6 flex flex-wrap items-center gap-2">
        <span class="text-xs font-semibold text-gray-500">Filtrar por sector:</span>
        <button
          type="button"
          class="rounded-full px-3 py-1 text-xs font-medium transition"
          :class="
            selectedSector === null
              ? 'bg-emerald-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300'
          "
          @click="handleSectorFilter(null)"
        >
          Todos los sectores
        </button>
        <button
          v-for="sec in sectors"
          :key="sec"
          type="button"
          class="rounded-full px-3 py-1 text-xs font-medium transition"
          :class="
            selectedSector === sec
              ? 'bg-emerald-600 text-white'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300'
          "
          @click="handleSectorFilter(sec)"
        >
          {{ sec }}
        </button>
      </div>
    </header>

    <!-- Error state -->
    <div
      v-if="error"
      role="alert"
      class="rounded-lg bg-rose-50 p-4 text-sm font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
    >
      {{ error }}
    </div>

    <!-- Loading state -->
    <div v-if="loading" role="status" class="py-16 text-center text-sm text-gray-500">
      Cargando casos de cliente con evidencia…
    </div>

    <!-- Empty state -->
    <div v-else-if="filteredCases.length === 0" class="py-16 text-center">
      <div class="text-5xl text-gray-400">📋</div>
      <h3 class="mt-3 text-lg font-bold text-gray-800 dark:text-gray-200">No hay casos publicados para este filtro</h3>
      <p class="text-sm text-gray-500">
        Los casos de éxito requieren permiso firmado y resultados certificados antes de su difusión pública.
      </p>
    </div>

    <!-- Grid de Casos de Éxito -->
    <div v-else class="grid gap-8 md:grid-cols-2">
      <article
        v-for="cs in filteredCases"
        :key="cs.id"
        class="flex flex-col justify-between overflow-hidden rounded-2xl border border-gray-200 bg-white p-6 shadow-sm transition hover:shadow-md dark:border-gray-800 dark:bg-gray-900"
      >
        <div>
          <!-- Tag sector y vigencia -->
          <div class="flex items-center justify-between text-xs text-gray-500">
            <span
              class="rounded bg-gray-100 px-2 py-0.5 font-semibold text-gray-700 dark:bg-gray-800 dark:text-gray-300"
            >
              {{ cs.sector }}
            </span>
            <span class="text-emerald-700 font-medium dark:text-emerald-400"> ✓ Revisión vigente </span>
          </div>

          <h2 class="mt-3 text-xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
            {{ cs.title }}
          </h2>
          <p v-if="cs.subtitle" class="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {{ cs.subtitle }}
          </p>

          <!-- Métricas verificadas destacadas -->
          <div v-if="cs.outcomeMetrics && cs.outcomeMetrics.length > 0" class="mt-5 grid grid-cols-2 gap-3">
            <div
              v-for="metric in cs.outcomeMetrics"
              :key="metric.metric"
              class="rounded-xl border border-emerald-100 bg-emerald-50/50 p-3 text-center dark:border-emerald-950 dark:bg-emerald-950/20"
            >
              <div class="text-2xl font-black text-emerald-700 dark:text-emerald-400">
                {{ metric.improvementPercent !== undefined ? `-${metric.improvementPercent}%` : metric.after }}
              </div>
              <div class="mt-0.5 text-xs font-semibold text-gray-800 dark:text-gray-200">
                {{ metric.metric }}
              </div>
              <div v-if="metric.before !== undefined" class="text-[11px] text-gray-500">
                De {{ metric.before }} a {{ metric.after }} {{ metric.unit }}
              </div>
            </div>
          </div>

          <!-- Contexto y Solución resumida -->
          <div class="mt-5 space-y-3 text-xs leading-relaxed text-gray-600 dark:text-gray-400">
            <div>
              <span class="font-bold text-gray-800 dark:text-gray-200">Contexto inicial:</span>
              <p class="mt-0.5 line-clamp-2">{{ cs.initialSituation }}</p>
            </div>
            <div>
              <span class="font-bold text-gray-800 dark:text-gray-200">Solución implementada:</span>
              <p class="mt-0.5 line-clamp-2">{{ cs.solutionSummary }}</p>
            </div>
          </div>
        </div>

        <!-- Pie de verificación y autorización (MED-020 & MKT-031) -->
        <div class="mt-6 border-t border-gray-100 pt-4 dark:border-gray-800">
          <div class="rounded-lg bg-gray-50 p-3 text-[11px] text-gray-600 dark:bg-gray-800/40 dark:text-gray-400">
            <div class="font-semibold text-gray-800 dark:text-gray-200">Auditoría: {{ cs.verifierIdentity }}</div>
            <div class="mt-0.5 text-gray-500">Método: {{ cs.verificationMethod }}</div>
            <div class="mt-2 text-emerald-700 font-medium dark:text-emerald-400">
              {{ cs.customerAuthorizationStatement }}
            </div>
          </div>

          <div class="mt-4 flex items-center justify-between">
            <button
              type="button"
              class="text-xs font-semibold text-emerald-600 hover:text-emerald-700 dark:text-emerald-400"
              @click="selectedCase = cs"
            >
              Ver estudio técnico completo &rarr;
            </button>
            <span class="text-[10px] text-gray-400">Documento inmutable</span>
          </div>
        </div>
      </article>
    </div>

    <!-- Modal Detalle Técnico del Caso -->
    <div
      v-if="selectedCase"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      @click="selectedCase = null"
    >
      <div
        class="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-900"
        @click.stop
      >
        <div class="flex items-start justify-between border-b border-gray-100 pb-4 dark:border-gray-800">
          <div>
            <span class="rounded bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
              {{ selectedCase.sector }}
            </span>
            <h2 class="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
              {{ selectedCase.title }}
            </h2>
          </div>
          <button
            type="button"
            class="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
            @click="selectedCase = null"
          >
            ✕
          </button>
        </div>

        <div class="mt-6 space-y-6 text-sm text-gray-700 dark:text-gray-300">
          <section>
            <h3 class="font-bold text-gray-900 dark:text-gray-100">1. Contexto e Instalaciones</h3>
            <p class="mt-1 text-xs text-gray-500">{{ selectedCase.facilityDescription }}</p>
            <p class="mt-2 leading-relaxed">{{ selectedCase.initialSituation }}</p>
          </section>

          <section>
            <h3 class="font-bold text-gray-900 dark:text-gray-100">2. Solución y Protocolo de Dosificación</h3>
            <p class="mt-1 leading-relaxed">{{ selectedCase.solutionSummary }}</p>
            <div class="mt-2 rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-800">
              <span class="font-semibold">Protocolo:</span> {{ selectedCase.dosageProtocol }}
              <div class="mt-1">
                <span class="font-semibold">Duración de despliegue:</span>
                {{ selectedCase.implementationDurationWeeks }} semanas.
              </div>
            </div>
          </section>

          <section>
            <h3 class="font-bold text-gray-900 dark:text-gray-100">3. Resultados Verificables Contrastados</h3>
            <div class="mt-3 overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="border-b bg-gray-50 text-gray-600 dark:bg-gray-800">
                  <tr>
                    <th class="p-2 font-semibold">Indicador clave</th>
                    <th class="p-2 font-semibold">Antes</th>
                    <th class="p-2 font-semibold">Después</th>
                    <th class="p-2 font-semibold">Mejora %</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  <tr v-for="m in selectedCase.outcomeMetrics" :key="m.metric">
                    <td class="p-2 font-medium">{{ m.metric }}</td>
                    <td class="p-2">{{ m.before }} {{ m.unit }}</td>
                    <td class="p-2 font-bold text-emerald-600">{{ m.after }} {{ m.unit }}</td>
                    <td class="p-2 font-bold">{{ m.improvementPercent ? `${m.improvementPercent}%` : '-' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section
            class="rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs dark:border-gray-800 dark:bg-gray-800/40"
          >
            <h4 class="font-bold text-gray-900 dark:text-gray-100">Gobernanza y Autorización (MED-020 & MKT-031)</h4>
            <ul class="mt-2 space-y-1 text-gray-600 dark:text-gray-400">
              <li>✓ {{ selectedCase.customerAuthorizationStatement }}</li>
              <li>
                ✓ Certificado por: {{ selectedCase.verifierIdentity }} (Método: {{ selectedCase.verificationMethod }}).
              </li>
              <li>✓ Revisión periódica en vigor hasta: {{ selectedCase.reviewValidUntil.split('T')[0] }}.</li>
            </ul>
          </section>
        </div>

        <div class="mt-6 flex justify-end">
          <button
            type="button"
            class="rounded-lg bg-gray-200 px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200"
            @click="selectedCase = null"
          >
            Cerrar estudio
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
