<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import {
  CMS_PREVIEW_BREAKPOINTS,
  type CmsPreviewBreakpoint,
  type ContentDiffResult,
  type ContentDocumentSnapshot
} from '~~/shared/cms-preview-comparison'

const props = withDefaults(
  defineProps<{
    pageId?: string
    initialBaseVersion?: number
    initialCompareVersion?: number
  }>(),
  {
    pageId: '40000000-0000-4000-8000-000000000001',
    initialBaseVersion: 1,
    initialCompareVersion: 2
  }
)

const requestFetch = useRequestFetch()
const loading = ref(false)
const errorMessage = ref('')

const activeBreakpoint = ref<CmsPreviewBreakpoint>('desktop')
const activeMode = ref<'side_by_side' | 'overlay' | 'diff_only'>('side_by_side')

const baseVersion = ref(props.initialBaseVersion)
const compareVersion = ref(props.initialCompareVersion)
const diffResult = ref<ContentDiffResult | null>(null)
const baseDoc = ref<ContentDocumentSnapshot | null>(null)
const compareDoc = ref<ContentDocumentSnapshot | null>(null)

// Template regression testing
const activeTab = ref<'preview_diff' | 'template_regression'>('preview_diff')
const selectedTemplate = ref<
  'home' | 'catalog' | 'search' | 'product' | 'cart_empty' | 'login' | 'promotional_landing'
>('home')
const regressionLoading = ref(false)
const regressionResult = ref<{ passed: boolean; missingCriticalSelectors: string[] } | null>(null)

const currentViewportWidth = computed(() => {
  return `${CMS_PREVIEW_BREAKPOINTS[activeBreakpoint.value].width}px`
})

function extractErrorCode(err: unknown, fallback: string): string {
  const code = (err as { data?: { error?: { code?: string } } })?.data?.error?.code
  return code ? `Error: ${code}` : fallback
}

async function fetchDiff() {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch(
      `/api/admin/content/preview-comparison?pageId=${props.pageId}&baseVersion=${baseVersion.value}&compareVersion=${compareVersion.value}&breakpoint=${activeBreakpoint.value}`
    )) as {
      diff: ContentDiffResult
      baseDocument: ContentDocumentSnapshot
      compareDocument: ContentDocumentSnapshot
    }
    diffResult.value = res.diff
    baseDoc.value = res.baseDocument
    compareDoc.value = res.compareDocument
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al obtener la comparación de preview')
  } finally {
    loading.value = false
  }
}

async function runRegressionCheck() {
  regressionLoading.value = true
  try {
    const res = (await requestFetch('/api/admin/content/templates/critical-regression', {
      method: 'POST',
      body: {
        templateName: selectedTemplate.value,
        breakpoint: activeBreakpoint.value,
        renderedSelectors: ['header', 'nav.main', 'section.hero', 'section.featured-products', 'footer']
      }
    })) as { passed: boolean; missingCriticalSelectors: string[] }
    regressionResult.value = res
  } catch (err: unknown) {
    errorMessage.value = extractErrorCode(err, 'Error al ejecutar regresión visual')
  } finally {
    regressionLoading.value = false
  }
}

const setTab = (value: string) => {
  activeTab.value = value as 'preview_diff' | 'template_regression'
}
const setMode = (value: string) => {
  activeMode.value = value as 'side_by_side' | 'overlay' | 'diff_only'
}
const setBreakpoint = (value: string) => {
  activeBreakpoint.value = value as CmsPreviewBreakpoint
}
const TABS = [
  { value: 'preview_diff', label: 'Comparar versiones' },
  { value: 'template_regression', label: 'Comprobar páginas' }
]
const MODES = [
  { value: 'side_by_side', label: 'Con vista previa' },
  { value: 'diff_only', label: 'Solo cambios' }
]
const breakpointOptions = computed(() =>
  Object.entries(CMS_PREVIEW_BREAKPOINTS).map(([value, spec]) => ({ value, label: spec.label }))
)
const CHANGE: Record<string, [string, 'success' | 'warning' | 'danger' | 'neutral']> = {
  added: ['Añadido', 'success'],
  modified: ['Modificado', 'warning'],
  removed: ['Eliminado', 'danger'],
  unchanged: ['Sin cambios', 'neutral']
}
const BLOCKS: Record<string, string> = {
  heading: 'Título',
  paragraph: 'Texto',
  text: 'Texto',
  image: 'Imagen',
  hero: 'Cabecera destacada',
  cta: 'Botón de acción',
  button: 'Botón',
  list: 'Lista',
  quote: 'Cita',
  product_grid: 'Productos',
  banner: 'Banner',
  video: 'Vídeo',
  faq: 'Preguntas frecuentes'
}
const blockLabel = (type: unknown) => BLOCKS[String(type)] ?? adminHumanize(String(type ?? 'bloque'))
const TEMPLATES: Record<string, string> = {
  home: 'Portada',
  catalog: 'Catálogo de productos',
  search: 'Búsqueda',
  product: 'Ficha de producto',
  cart_empty: 'Carrito vacío',
  login: 'Acceso de clientes',
  promotional_landing: 'Página de promoción'
}

onMounted(() => {
  void fetchDiff()
})
</script>

<template>
  <div class="adm-stack" aria-label="Comparación visual de preview">
    <AdminTabs :model-value="activeTab" :tabs="TABS" label="Modos de vista" @update:model-value="setTab" />

    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="No se ha podido completar la operación"
      description="Comprueba los números de versión y vuelve a intentarlo."
    />

    <!-- Comparar versiones -->
    <section v-if="activeTab === 'preview_diff'" class="adm-stack">
      <div class="adm-card">
        <div class="adm-tablecard__bar">
          <div class="adm-toolbar">
            <label class="adm-label" for="preview-base-version">Versión publicada</label>
            <input
              id="preview-base-version"
              v-model.number="baseVersion"
              type="number"
              min="0"
              class="adm-input w-20"
              @change="fetchDiff"
            />
            <label class="adm-label" for="preview-compare-version">Borrador</label>
            <input
              id="preview-compare-version"
              v-model.number="compareVersion"
              type="number"
              min="1"
              class="adm-input w-20"
              @change="fetchDiff"
            />
            <AdminButton size="sm" icon="i-lucide-refresh-cw" :loading="loading" @click="fetchDiff">
              Actualizar
            </AdminButton>
            <div class="adm-toolbar__end">
              <AdminFilters
                :model-value="activeBreakpoint"
                :options="breakpointOptions"
                label="Selector de breakpoints"
                @update:model-value="setBreakpoint"
              />
              <AdminFilters
                :model-value="activeMode"
                :options="MODES"
                label="Modo de visualización"
                @update:model-value="setMode"
              />
            </div>
          </div>
        </div>
      </div>

      <div v-if="loading" role="status" class="adm-card adm-table-skeleton" aria-busy="true">
        <span class="sr-only">Comparando las dos versiones…</span>
        <div v-for="row in 4" :key="row"><i /><i /><i /></div>
      </div>

      <AdminCard v-else-if="!diffResult" flush>
        <AdminEmptyState
          :variant="errorMessage ? 'error' : 'empty'"
          icon="i-lucide-diff"
          :title="errorMessage ? 'No se ha podido comparar' : 'Elige dos versiones para compararlas'"
          :description="errorMessage ? 'Puede que alguna de las versiones no exista.' : undefined"
        >
          <AdminButton icon="i-lucide-rotate-cw" @click="fetchDiff">Reintentar</AdminButton>
        </AdminEmptyState>
      </AdminCard>

      <template v-else>
        <div class="adm-grid">
          <AdminStat label="Bloques añadidos" :value="`+${diffResult.summary.addedBlocksCount}`" />
          <AdminStat label="Bloques modificados" :value="diffResult.summary.modifiedBlocksCount" />
          <AdminStat label="Bloques eliminados" :value="`−${diffResult.summary.removedBlocksCount}`" />
          <AdminStat label="Sin cambios" :value="diffResult.summary.unchangedBlocksCount" />
        </div>

        <AdminCard
          v-if="diffResult.metadataDiff.titleChanged || diffResult.metadataDiff.seoChanged"
          title="Cambios en el título y en los datos para buscadores"
        >
          <p v-if="diffResult.metadataDiff.titleChanged">
            <span class="mr-2 text-[var(--text-muted)] line-through">{{ diffResult.metadataDiff.oldTitle }}</span>
            <span class="font-semibold text-[var(--text-strong)]">{{ diffResult.metadataDiff.newTitle }}</span>
          </p>
          <p v-if="diffResult.metadataDiff.seoChanged" class="adm-help mt-1">
            Ha cambiado el título, la descripción o la visibilidad en buscadores.
          </p>
        </AdminCard>

        <AdminCard title="Cambios bloque a bloque" flush>
          <AdminEmptyState
            v-if="!diffResult.blockDiffs.length"
            compact
            icon="i-lucide-equal"
            title="Las dos versiones son iguales"
          />
          <ul v-else class="adm-list" role="list">
            <li v-for="b in diffResult.blockDiffs" :key="b.id">
              <div class="min-w-0 flex-1">
                <p class="adm-list__title">
                  <AdminBadge :tone="CHANGE[b.changeType]?.[1] ?? 'neutral'">
                    {{ CHANGE[b.changeType]?.[0] ?? adminHumanize(b.changeType) }}
                  </AdminBadge>
                  <template v-if="b.newBlock">
                    {{ blockLabel(b.newBlock.type) }}
                  </template>
                  <template v-else-if="b.oldBlock">{{ blockLabel(b.oldBlock.type) }}</template>
                </p>
                <p v-if="b.newBlock" class="mt-1">
                  {{ b.newBlock.text || b.newBlock.label || b.newBlock.title || '' }}
                </p>
                <p v-else-if="b.oldBlock" class="mt-1 text-[var(--text-muted)] line-through">
                  {{ b.oldBlock.text || b.oldBlock.label || '' }}
                </p>
                <p v-if="b.fieldDifferences?.length" class="adm-help mt-1">
                  Ha cambiado: {{ b.fieldDifferences.map((field) => adminHumanize(String(field))).join(', ') }}
                </p>
              </div>
            </li>
          </ul>
        </AdminCard>

        <AdminCard
          v-if="activeMode === 'side_by_side'"
          :title="`Vista previa del borrador · ${CMS_PREVIEW_BREAKPOINTS[activeBreakpoint].label}`"
          :description="`Versión ${compareVersion} a ${currentViewportWidth} de ancho`"
        >
          <div
            class="flex justify-center overflow-x-auto rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-4"
          >
            <div
              class="space-y-3 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] p-4 transition-all duration-300"
              :style="{ width: currentViewportWidth }"
            >
              <div
                v-for="block in compareDoc?.blocks"
                :key="block.id"
                class="rounded-[var(--radius-control)] border border-[var(--border)] p-2"
              >
                <p class="adm-help">{{ blockLabel(block.type) }}</p>
                <p>{{ block.text || block.title || block.label }}</p>
              </div>
            </div>
          </div>
        </AdminCard>
      </template>
    </section>

    <!-- Comprobar plantillas -->
    <section v-if="activeTab === 'template_regression'" class="adm-stack">
      <AdminCard
        title="Comprobar que una página se ve completa"
        description="Revisa que no falte ninguna parte importante (cabecera, menú, productos, pie) en el tamaño de pantalla elegido."
      >
        <div class="flex flex-wrap items-end gap-3">
          <AdminFormField v-slot="{ id }" label="Página">
            <select :id="id" v-model="selectedTemplate">
              <option value="home">Portada</option>
              <option value="catalog">Catálogo de productos</option>
              <option value="search">Búsqueda</option>
              <option value="product">Ficha de producto</option>
              <option value="cart_empty">Carrito vacío</option>
              <option value="login">Acceso de clientes</option>
              <option value="promotional_landing">Página de promoción</option>
            </select>
          </AdminFormField>
          <div class="adm-field">
            <span class="adm-label">Tamaño de pantalla</span>
            <AdminFilters
              :model-value="activeBreakpoint"
              :options="breakpointOptions"
              label="Tamaño de pantalla"
              @update:model-value="setBreakpoint"
            />
          </div>
          <AdminButton variant="primary" :loading="regressionLoading" @click="runRegressionCheck">
            {{ regressionLoading ? 'Comprobando…' : 'Comprobar página' }}
          </AdminButton>
        </div>
      </AdminCard>

      <UAlert
        v-if="regressionResult"
        :color="regressionResult.passed ? 'success' : 'error'"
        variant="subtle"
        :icon="regressionResult.passed ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
        :title="regressionResult.passed ? 'La página se ve completa' : 'Faltan partes de la página'"
        :description="
          regressionResult.passed
            ? `Todas las partes importantes de «${TEMPLATES[selectedTemplate]}» están en su sitio en ${CMS_PREVIEW_BREAKPOINTS[activeBreakpoint].label.toLowerCase()}.`
            : `Faltan ${regressionResult.missingCriticalSelectors.length} partes en «${TEMPLATES[selectedTemplate]}»: ${regressionResult.missingCriticalSelectors.join(', ')}`
        "
      />
    </section>
  </div>
</template>
