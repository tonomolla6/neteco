<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  evaluateEditorialQuality,
  type CatalogEditorialArticle,
  type EditorialTargetType
} from '~~/shared/catalog-editorial-content'

const props = withDefaults(
  defineProps<{
    targetType?: EditorialTargetType
    targetId?: string
  }>(),
  {
    targetType: 'product',
    targetId: 'prod-001'
  }
)

const requestFetch = useRequestFetch()

const loading = ref(true)
const saving = ref(false)
const loadError = ref<string | null>(null)
const feedbackMessage = ref<string | null>(null)
const feedbackType = ref<'success' | 'error'>('success')

// Form state
const currentArticle = ref<CatalogEditorialArticle | null>(null)
const title = ref('')
const summary = ref('')
const bodyMarkdown = ref('')
const applicationScope = ref('')
const compatibleSurfaces = ref('Acero inoxidable 316, Gres porcelánico, Resina epoxi')
const incompatibleSurfaces = ref('Aluminio no anodizado')
const dilutionDosageGuide = ref('150 ml por cada 10 litros de agua (1.5% v/v) a temperatura ambiente')
const requiredPpe = ref('Guantes de nitrilo UNE-EN 374, Gafas de protección química UNE-EN 166')
const hazardWarnings = ref('Provoca irritación ocular grave. No mezclar con ácidos fuertes.')
const technicalStandards = ref('UNE-EN 13697, Protocolo APPCC')
const supplierReferenceText = ref('Detergente multiusos líquido para todo tipo de suelos y superficies lavables.')

// Quality assessment computed in real-time
const qualityAssessment = computed(() => {
  return evaluateEditorialQuality({
    bodyMarkdown: bodyMarkdown.value,
    applicationScope: applicationScope.value,
    surfaceCompatibility: {
      compatible: compatibleSurfaces.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      incompatible: incompatibleSurfaces.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    },
    dilutionDosageGuide: dilutionDosageGuide.value,
    safetyAndPpe: {
      requiredPpe: requiredPpe.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      hazardWarnings: hazardWarnings.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    },
    supplierReferenceText: supplierReferenceText.value
  })
})

const TARGET_NAMES: Record<string, string> = { product: 'Producto', category: 'Categoría', family: 'Familia' }

const similarityPercent = computed(() => {
  return (qualityAssessment.value.similarityScore * 100).toFixed(1)
})

async function loadArticle() {
  loading.value = true
  loadError.value = null
  try {
    const res = await requestFetch<CatalogEditorialArticle | null>(
      `/api/admin/catalog-editorial/article?targetType=${props.targetType}&targetId=${encodeURIComponent(props.targetId)}`
    )
    if (res && res.title) {
      currentArticle.value = res
      title.value = res.title
      summary.value = res.summary
      bodyMarkdown.value = res.bodyMarkdown
      applicationScope.value = res.applicationScope
      compatibleSurfaces.value = res.surfaceCompatibility?.compatible?.join(', ') || ''
      incompatibleSurfaces.value = res.surfaceCompatibility?.incompatible?.join(', ') || ''
      dilutionDosageGuide.value = res.dilutionDosageGuide
      requiredPpe.value = res.safetyAndPpe?.requiredPpe?.join(', ') || ''
      hazardWarnings.value = res.safetyAndPpe?.hazardWarnings?.join(', ') || ''
      technicalStandards.value = res.technicalStandards?.join(', ') || ''
      supplierReferenceText.value = res.supplierReferenceText || ''
    }
  } catch {
    // 404 is normal for new article
  } finally {
    loading.value = false
  }
}

async function handleSave() {
  if (!qualityAssessment.value.isValid) {
    feedbackType.value = 'error'
    feedbackMessage.value = qualityAssessment.value.reasons.join(' ')
    return
  }

  saving.value = true
  feedbackMessage.value = null
  try {
    const payload = {
      targetType: props.targetType,
      targetId: props.targetId,
      title: title.value,
      summary: summary.value,
      bodyMarkdown: bodyMarkdown.value,
      applicationScope: applicationScope.value,
      surfaceCompatibility: {
        compatible: compatibleSurfaces.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        incompatible: incompatibleSurfaces.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      },
      dilutionDosageGuide: dilutionDosageGuide.value,
      safetyAndPpe: {
        requiredPpe: requiredPpe.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        hazardWarnings: hazardWarnings.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      },
      technicalStandards: technicalStandards.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      supplierReferenceText: supplierReferenceText.value || null,
      expectedVersion: currentArticle.value?.version
    }

    const saved = await requestFetch<CatalogEditorialArticle>('/api/admin/catalog-editorial/upsert', {
      method: 'POST',
      body: payload
    })
    currentArticle.value = saved
    feedbackType.value = 'success'
    feedbackMessage.value = 'Contenido guardado correctamente.'
  } catch (err: unknown) {
    feedbackType.value = 'error'
    feedbackMessage.value = err instanceof Error ? err.message : 'Error al guardar el contenido editorial'
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadArticle()
})
</script>

<template>
  <div class="editorial-editor-panel adm-stack">
    <AdminPageActions>
      <AdminButton variant="primary" :loading="saving" :disabled="loading" @click="handleSave">
        Guardar contenido
      </AdminButton>
    </AdminPageActions>

    <UAlert
      v-if="feedbackMessage"
      role="alert"
      :color="feedbackType === 'success' ? 'success' : 'error'"
      variant="subtle"
      :icon="feedbackType === 'success' ? 'i-lucide-circle-check' : 'i-lucide-triangle-alert'"
      :title="feedbackMessage"
    />

    <AdminCard
      title="Control de calidad del texto"
      description="El texto debe ser propio: no puede copiar el del proveedor y tiene que aportar más información."
    >
      <template #actions>
        <AdminBadge :tone="qualityAssessment.isValid ? 'success' : 'warning'">
          {{ qualityAssessment.isValid ? 'Cumple los requisitos' : 'Requiere ajustes' }}
        </AdminBadge>
      </template>
      <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-3">
        <div>
          <dt class="adm-help">Coincidencia con proveedor</dt>
          <dd class="font-semibold text-[var(--text-strong)]">{{ similarityPercent }} % (máximo 35 %)</dd>
        </div>
        <div>
          <dt class="adm-help">Aporta más que el texto del proveedor</dt>
          <dd class="font-semibold text-[var(--text-strong)]">
            {{ qualityAssessment.surpassesSupplier ? 'Sí' : 'No' }}
          </dd>
        </div>
        <div>
          <dt class="adm-help">Se aplica a</dt>
          <dd class="font-semibold text-[var(--text-strong)]">
            {{ TARGET_NAMES[targetType] ?? adminHumanize(targetType) }}
            <template v-if="currentArticle">
              · <AdminBadge :status="currentArticle.status" plain /> · versión {{ currentArticle.version }}
            </template>
          </dd>
        </div>
      </dl>
      <p v-if="!qualityAssessment.isValid" class="mt-3 text-sm font-semibold text-red-700">
        {{ qualityAssessment.reasons[0] }}
      </p>
    </AdminCard>

    <AdminCard title="Presentación">
      <div class="adm-stack">
        <AdminFormField label="Título" for="editorial-title">
          <input
            id="editorial-title"
            v-model="title"
            type="text"
            placeholder="Ej.: protocolo de limpieza y desengrase en cocinas colectivas"
          />
        </AdminFormField>
        <AdminFormField label="Resumen" for="editorial-summary" help="Una o dos frases para compradores y técnicos.">
          <input id="editorial-summary" v-model="summary" type="text" />
        </AdminFormField>
      </div>
    </AdminCard>

    <AdminCard title="Uso y dosificación">
      <div class="adm-form-grid">
        <AdminFormField label="Dónde se utiliza" for="editorial-scope">
          <input
            id="editorial-scope"
            v-model="applicationScope"
            type="text"
            placeholder="Hostelería, industrias cárnicas, hospitales"
          />
        </AdminFormField>
        <AdminFormField label="Dosificación o dilución" for="editorial-dilution">
          <input
            id="editorial-dilution"
            v-model="dilutionDosageGuide"
            type="text"
            placeholder="50 ml por cada 10 litros (0,5 %), con fregadora automática"
          />
        </AdminFormField>
        <AdminFormField label="Superficies compatibles" for="compatible-surfaces" help="Separadas por comas.">
          <input id="compatible-surfaces" v-model="compatibleSurfaces" type="text" />
        </AdminFormField>
        <AdminFormField
          label="Superficies no compatibles o prohibidas"
          for="incompatible-surfaces"
          help="Separadas por comas."
        >
          <input id="incompatible-surfaces" v-model="incompatibleSurfaces" type="text" />
        </AdminFormField>
      </div>
    </AdminCard>

    <AdminCard title="Seguridad">
      <div class="adm-form-grid">
        <AdminFormField label="Equipos de protección obligatorios" for="required-ppe" help="Separados por comas.">
          <input id="required-ppe" v-model="requiredPpe" type="text" />
        </AdminFormField>
        <AdminFormField label="Advertencias de peligro" for="hazard-warnings" help="Separadas por comas.">
          <input id="hazard-warnings" v-model="hazardWarnings" type="text" />
        </AdminFormField>
        <AdminFormField label="Normas y protocolos aplicables" for="technical-standards" help="Separados por comas.">
          <input id="technical-standards" v-model="technicalStandards" type="text" />
        </AdminFormField>
      </div>
    </AdminCard>

    <AdminCard title="Texto">
      <div class="adm-stack">
        <AdminFormField
          label="Texto propio"
          for="editorial-body"
          help="Guía de uso, forma de aplicación, advertencias y ventajas. Admite formato Markdown."
        >
          <textarea
            id="editorial-body"
            v-model="bodyMarkdown"
            rows="8"
            placeholder="Redacta la guía técnica: cómo se aplica, advertencias y ventajas…"
          ></textarea>
        </AdminFormField>
        <AdminFormField
          label="Texto original del proveedor"
          for="supplier-ref-text"
          help="Solo se usa para comprobar que tu texto no lo copia; no se publica."
        >
          <textarea id="supplier-ref-text" v-model="supplierReferenceText" rows="3"></textarea>
        </AdminFormField>
      </div>
    </AdminCard>
  </div>
</template>
