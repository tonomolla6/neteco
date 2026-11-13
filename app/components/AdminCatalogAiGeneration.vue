<script setup lang="ts">
import { computed, ref } from 'vue'

const requestFetch = useRequestFetch()

interface VerifiableClaim {
  claimText: string
  sourceRef: string
  verified: boolean
  hazardClpCompliant: boolean
  category: string
}

interface DuplicateCheck {
  maxSimilarityScore: number
  duplicateRisk: string
  matchedProducts: Array<{ productId: string; name: string; similarityScore: number }>
}

interface GenerationResponse {
  id: string
  productId: string | null
  targetScope: string
  prompt: string
  generatedTitle: string | null
  generatedShortDescription: string | null
  generatedDescription: string | null
  generatedUsage: string | null
  generatedAttributes: Record<string, unknown> | null
  verifiableClaims: VerifiableClaim[]
  duplicateCheck: DuplicateCheck
  isAiGenerated: boolean
  aiModelName: string
  approvalStatus: string
  version: number
  humanReviewedAt?: string
}

const productName = ref('')
const targetScope = ref<'description' | 'attributes' | 'full_editorial'>('full_editorial')
const sourceTitle = ref('Ficha Técnica FDS-Oficial')
const sourceSnippet = ref('Limpiador concentrado biodegradable conforme norma OECD 301 con pH neutro 7.0.')
const sourceClaims = ref('Biodegradable OECD 301, pH 7.0, Secado rápido')
const prompt = ref('Generar descripción y atributos para producto químico')
const targetProductId = ref('prod-desengrasante-1')

const loading = ref(false)
const reviewing = ref(false)
const applying = ref(false)
const errorMessage = ref('')
const statusMessage = ref('')
const generation = ref<GenerationResponse | null>(null)

async function generateContent() {
  if (!productName.value.trim()) return
  loading.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const claimsArray = sourceClaims.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const res = (await requestFetch('/api/admin/catalog/ai-generate/propose', {
      method: 'POST',
      body: {
        productName: productName.value.trim(),
        targetScope: targetScope.value,
        prompt: prompt.value.trim(),
        sources: [
          {
            id: 'src-1',
            title: sourceTitle.value.trim(),
            type: 'fds',
            verifiedClaims: claimsArray.length ? claimsArray : ['Formula estandar'],
            textSnippet: sourceSnippet.value.trim()
          }
        ]
      }
    })) as { generation: GenerationResponse }

    generation.value = res.generation
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido generar el contenido'
  } finally {
    loading.value = false
  }
}

async function reviewContent(decision: 'approve' | 'reject') {
  if (!generation.value) return
  reviewing.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch(`/api/admin/catalog/ai-generate/generations/${generation.value.id}/review`, {
      method: 'POST',
      body: {
        expectedVersion: generation.value.version,
        decision,
        reviewNotes: 'Revisión técnica de claims y seguridad completada'
      }
    })) as { generation: GenerationResponse }

    generation.value = res.generation
    if (res.generation.approvalStatus === 'approved') {
      statusMessage.value = 'Revisión aprobada. Ya puedes aplicar el contenido al producto.'
    } else {
      statusMessage.value = 'Contenido rechazado'
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido guardar la revisión'
  } finally {
    reviewing.value = false
  }
}

async function applyContent() {
  if (!generation.value) return
  applying.value = true
  errorMessage.value = ''
  try {
    await requestFetch(`/api/admin/catalog/ai-generate/generations/${generation.value.id}/apply`, {
      method: 'POST',
      body: {
        expectedVersion: generation.value.version,
        targetProductId: targetProductId.value || 'prod-desengrasante-1'
      }
    })
    statusMessage.value = 'Contenido aplicado al catálogo. Queda marcado como generado con IA.'
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido aplicar el contenido al catálogo'
  } finally {
    applying.value = false
  }
}

// ── Presentación ───────────────────────────────────────────────────────────
const APPROVAL: Record<string, [string, 'warning' | 'success' | 'danger' | 'neutral']> = {
  pending_review: ['Pendiente de revisión', 'warning'],
  approved: ['Aprobado', 'success'],
  rejected: ['Rechazado', 'danger'],
  applied: ['Aplicado al catálogo', 'success']
}
const RISK: Record<string, [string, 'success' | 'warning' | 'danger']> = {
  none: ['Sin parecidos', 'success'],
  low: ['Parecido bajo', 'success'],
  medium: ['Parecido medio', 'warning'],
  high: ['Muy parecido a otro producto', 'danger']
}
/** Los fallos de red llegan con textos técnicos: se enseña una frase legible. */
const readableError = computed(() =>
  /[áéíóúñ]| (el|la|no|se|al) /i.test(errorMessage.value)
    ? errorMessage.value
    : 'El servicio no ha respondido. Vuelve a intentarlo en unos minutos.'
)
</script>

<template>
  <div class="adm-stack">
    <UAlert
      v-if="errorMessage"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="readableError"
    />
    <UAlert
      v-if="statusMessage"
      role="status"
      :color="generation?.approvalStatus === 'rejected' ? 'neutral' : 'success'"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="statusMessage"
    />

    <AdminCard
      title="Generar textos de un producto"
      description="La IA redacta a partir de la ficha técnica o de seguridad. Nada se publica sin que lo revises."
    >
      <div class="adm-stack">
        <div class="adm-form-grid">
          <div class="adm-field">
            <label for="cat-name" class="adm-label">Nombre del producto</label>
            <input
              id="cat-name"
              v-model="productName"
              data-test="product-name-input"
              type="text"
              class="adm-input"
              placeholder="Por ejemplo: desengrasante alcalino extra fuerte"
            />
          </div>
          <div class="adm-field">
            <label for="cat-scope" class="adm-label">Qué quieres generar</label>
            <select id="cat-scope" v-model="targetScope" class="adm-input">
              <option value="full_editorial">Todo (descripción, modo de empleo y características)</option>
              <option value="description">Solo descripciones</option>
              <option value="attributes">Solo características técnicas</option>
            </select>
          </div>
        </div>
        <div class="adm-field">
          <label for="cat-claims" class="adm-label">Datos comprobados de la ficha técnica</label>
          <input
            id="cat-claims"
            v-model="sourceClaims"
            type="text"
            class="adm-input"
            placeholder="Por ejemplo: biodegradable, pH 7.0, sin fosfatos"
            aria-describedby="cat-claims-help"
          />
          <p id="cat-claims-help" class="adm-help">
            Sepáralos con comas. La IA solo podrá afirmar lo que aparezca aquí.
          </p>
        </div>
        <div>
          <button
            type="button"
            data-test="generate-content-btn"
            :disabled="loading || !productName.trim()"
            class="adm-btn adm-btn--primary"
            @click="generateContent"
          >
            <span v-if="loading">Comprobando datos y buscando duplicados…</span>
            <span v-else>Generar textos</span>
          </button>
        </div>
      </div>
    </AdminCard>

    <AdminCard v-if="generation">
      <template #title>Contenido generado por IA</template>
      <template #actions>
        <AdminBadge :tone="APPROVAL[generation.approvalStatus]?.[1] ?? 'neutral'">
          {{ APPROVAL[generation.approvalStatus]?.[0] ?? adminStatusLabel(generation.approvalStatus) }}
        </AdminBadge>
      </template>
      <div class="adm-stack">
        <div v-if="generation.verifiableClaims && generation.verifiableClaims.length">
          <h4>Datos técnicos comprobados</h4>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <AdminBadge v-for="claim in generation.verifiableClaims" :key="claim.claimText" tone="success" plain>
              {{ claim.claimText }}
            </AdminBadge>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <h4>Parecido con otros productos del catálogo</h4>
          <AdminBadge :tone="RISK[generation.duplicateCheck.duplicateRisk]?.[1] ?? 'neutral'">
            {{
              RISK[generation.duplicateCheck.duplicateRisk]?.[0] ??
              adminHumanize(generation.duplicateCheck.duplicateRisk)
            }}
            · {{ Math.round(generation.duplicateCheck.maxSimilarityScore * 100) }} %
          </AdminBadge>
        </div>
        <ul v-if="generation.duplicateCheck.matchedProducts?.length" class="adm-help list-disc pl-5">
          <li v-for="match in generation.duplicateCheck.matchedProducts" :key="match.productId">
            {{ match.name }} ({{ Math.round(match.similarityScore * 100) }} %)
          </li>
        </ul>

        <dl class="space-y-3">
          <div v-if="generation.generatedTitle">
            <dt class="adm-label">Título sugerido</dt>
            <dd>{{ generation.generatedTitle }}</dd>
          </div>
          <div v-if="generation.generatedDescription">
            <dt class="adm-label">Descripción</dt>
            <dd>{{ generation.generatedDescription }}</dd>
          </div>
          <div v-if="generation.generatedUsage">
            <dt class="adm-label">Modo de empleo</dt>
            <dd>{{ generation.generatedUsage }}</dd>
          </div>
        </dl>

        <div v-if="generation.approvalStatus.includes('approved')" class="adm-field">
          <label for="cat-target-product" class="adm-label">Producto al que se aplica</label>
          <input
            id="cat-target-product"
            v-model="targetProductId"
            type="text"
            class="adm-input"
            placeholder="Referencia del producto"
          />
        </div>
      </div>
      <template
        v-if="generation.approvalStatus === 'pending_review' || generation.approvalStatus.includes('approved')"
        #footer
      >
        <template v-if="generation.approvalStatus === 'pending_review'">
          <button
            type="button"
            :disabled="reviewing"
            class="adm-btn adm-btn--danger-soft"
            @click="reviewContent('reject')"
          >
            Rechazar
          </button>
          <button
            type="button"
            data-test="approve-content-btn"
            :disabled="reviewing"
            class="adm-btn adm-btn--secondary"
            @click="reviewContent('approve')"
          >
            Dar por revisado
          </button>
        </template>
        <button
          v-if="generation.approvalStatus.includes('approved')"
          type="button"
          data-test="apply-content-btn"
          :disabled="applying"
          class="adm-btn adm-btn--secondary"
          @click="applyContent"
        >
          Aplicar al producto
        </button>
      </template>
    </AdminCard>
  </div>
</template>
