<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  assetId?: string
}>()

const requestFetch = useRequestFetch()

interface CropItem {
  ratio: string
  purpose: string
  x: number
  y: number
  width: number
  height: number
}

interface BackgroundRemoval {
  maskDescription: string
  alphaCutoutStorageKey: string
  backgroundType: string
  edgeAccuracyScore: number
  noPackagingInvented: boolean
}

interface ProposedMetadata {
  suggestedAltText: string
  dominantColors: string[]
  focalPoint: { x: number; y: number }
  noFictionalClaimsOrBadges: boolean
}

interface EnrichmentResponse {
  id: string
  assetId: string
  enrichmentType: string
  backgroundRemoval: BackgroundRemoval | null
  proposedCrops: CropItem[] | null
  proposedMetadata: ProposedMetadata | null
  prohibitedInventionCheck: {
    passed: boolean
    noInventedPackaging: boolean
    noInventedClaims: boolean
    noInventedUses: boolean
  }
  requiresHumanApproval: boolean
  approvalStatus: string
  version: number
  humanDecidedAt?: string
}

const targetAssetId = ref(props.assetId || 'asset-00000000-0000-4000-8000-000000000001')
const enrichmentType = ref<'remove_background' | 'propose_crops' | 'propose_metadata' | 'full_visual_enrichment'>(
  'full_visual_enrichment'
)
const productName = ref('Desengrasante Alcalino Extra Fuerte')
const instruction = ref('')

const loading = ref(false)
const deciding = ref(false)
const applying = ref(false)
const errorMessage = ref('')
const statusMessage = ref('')
const enrichment = ref<EnrichmentResponse | null>(null)

async function proposeEnrichment() {
  if (!targetAssetId.value.trim()) return
  loading.value = true
  errorMessage.value = ''
  statusMessage.value = ''
  try {
    const res = (await requestFetch<unknown, string>('/api/admin/media/ai-enrich/propose', {
      method: 'POST',
      body: {
        assetId: targetAssetId.value.trim(),
        enrichmentType: enrichmentType.value,
        options: {
          contextProductName: productName.value.trim() || undefined,
          instruction: instruction.value.trim() || undefined
        }
      }
    })) as { enrichment: EnrichmentResponse }

    enrichment.value = res.enrichment
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido generar la propuesta'
  } finally {
    loading.value = false
  }
}

async function recordDecision(decision: 'approve' | 'reject') {
  if (!enrichment.value) return
  deciding.value = true
  errorMessage.value = ''
  try {
    const res = (await requestFetch<unknown, string>(
      `/api/admin/media/ai-enrich/enrichments/${enrichment.value.id}/decision`,
      {
        method: 'POST',
        body: {
          expectedVersion: enrichment.value.version,
          decision,
          humanNotes: 'Verificación humana de no invención de elementos visuales completada'
        }
      }
    )) as { enrichment: EnrichmentResponse }

    enrichment.value = res.enrichment
    if (res.enrichment.approvalStatus === 'approved') {
      statusMessage.value = 'Propuesta aprobada. Ya puedes aplicarla a la imagen.'
    } else {
      statusMessage.value = 'Propuesta rechazada'
    }
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se ha podido guardar tu decisión'
  } finally {
    deciding.value = false
  }
}

async function applyEnrichment() {
  if (!enrichment.value) return
  applying.value = true
  errorMessage.value = ''
  try {
    await requestFetch<unknown, string>(`/api/admin/media/ai-enrich/enrichments/${enrichment.value.id}/apply`, {
      method: 'POST',
      body: {
        expectedVersion: enrichment.value.version,
        targetAssetId: enrichment.value.assetId
      }
    })
    statusMessage.value = 'Cambios aplicados a la imagen en la biblioteca de medios'
  } catch (err: unknown) {
    errorMessage.value = err instanceof Error ? err.message : 'No se han podido aplicar los cambios a la imagen'
  } finally {
    applying.value = false
  }
}

// ── Presentación ───────────────────────────────────────────────────────────
const APPROVAL: Record<string, [string, 'warning' | 'success' | 'danger' | 'neutral']> = {
  pending_approval: ['Pendiente de tu decisión', 'warning'],
  approved: ['Aprobada', 'success'],
  rejected: ['Rechazada', 'danger'],
  applied: ['Aplicada', 'success']
}
const PURPOSES: Record<string, string> = {
  thumbnail: 'Miniatura',
  listing: 'Listado',
  card: 'Tarjeta de producto',
  detail: 'Ficha de producto',
  hero: 'Cabecera',
  banner: 'Cabecera',
  social: 'Redes sociales',
  zoom: 'Ampliación'
}
const purposeLabel = (code: string) => PURPOSES[code.toLowerCase()] ?? adminHumanize(code)
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
      :color="enrichment?.approvalStatus === 'rejected' ? 'neutral' : 'success'"
      variant="subtle"
      icon="i-lucide-circle-check"
      :title="statusMessage"
    />

    <AdminCard
      title="Mejorar una imagen"
      description="La IA quita el fondo, propone recortes y redacta el texto alternativo. No añade envases, sellos ni usos que no existan, y nada se aplica sin tu aprobación."
    >
      <div class="adm-stack">
        <div class="adm-form-grid">
          <div class="adm-field">
            <label for="med-asset-id" class="adm-label">Imagen</label>
            <input
              id="med-asset-id"
              v-model="targetAssetId"
              type="text"
              class="adm-input"
              placeholder="Referencia de la imagen"
              aria-describedby="med-asset-help"
            />
            <p id="med-asset-help" class="adm-help">Cópiala desde la biblioteca de medios.</p>
          </div>
          <div class="adm-field">
            <label for="med-type" class="adm-label">Qué quieres hacer</label>
            <select id="med-type" v-model="enrichmentType" class="adm-input">
              <option value="full_visual_enrichment">Todo (fondo, recortes y texto alternativo)</option>
              <option value="remove_background">Quitar el fondo</option>
              <option value="propose_crops">Proponer recortes</option>
              <option value="propose_metadata">Proponer texto alternativo</option>
            </select>
          </div>
        </div>
        <div>
          <button
            type="button"
            data-test="propose-enrichment-btn"
            :disabled="loading || !targetAssetId.trim()"
            class="adm-btn adm-btn--primary"
            @click="proposeEnrichment"
          >
            <span v-if="loading">Generando propuesta…</span>
            <span v-else>Generar propuesta</span>
          </button>
        </div>
      </div>
    </AdminCard>

    <AdminCard v-if="enrichment">
      <template #title>Propuesta para la imagen</template>
      <template #actions>
        <AdminBadge :tone="APPROVAL[enrichment.approvalStatus]?.[1] ?? 'neutral'">
          {{ APPROVAL[enrichment.approvalStatus]?.[0] ?? adminStatusLabel(enrichment.approvalStatus) }}
        </AdminBadge>
      </template>
      <div class="adm-stack">
        <UAlert
          v-if="enrichment.prohibitedInventionCheck?.passed !== false"
          color="success"
          variant="subtle"
          icon="i-lucide-shield-check"
          title="Sin elementos inventados"
          description="La propuesta solo ajusta fondo, recorte y accesibilidad: no añade envases, sellos ni mensajes comerciales."
        />
        <UAlert
          v-else
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Revisa la propuesta con cuidado"
          description="Puede contener elementos que no están en la imagen original."
        />

        <div v-if="enrichment.backgroundRemoval">
          <h4>Fondo eliminado</h4>
          <p class="mt-1">{{ enrichment.backgroundRemoval.maskDescription }}</p>
          <p class="adm-help">
            Precisión del contorno: {{ Math.round(enrichment.backgroundRemoval.edgeAccuracyScore * 100) }} %
          </p>
        </div>

        <div v-if="enrichment.proposedCrops && enrichment.proposedCrops.length">
          <h4>Recortes propuestos</h4>
          <ul class="mt-2 grid gap-2 sm:grid-cols-3">
            <li
              v-for="crop in enrichment.proposedCrops"
              :key="crop.ratio + crop.purpose"
              class="rounded-[var(--radius-control)] border border-[var(--border)] p-3"
            >
              <p class="font-semibold text-[var(--text-strong)]">{{ purposeLabel(crop.purpose) }}</p>
              <p class="adm-help">Proporción {{ crop.ratio }} · {{ crop.width }} × {{ crop.height }} px</p>
            </li>
          </ul>
        </div>

        <div v-if="enrichment.proposedMetadata">
          <h4>Texto alternativo propuesto</h4>
          <p class="mt-1">{{ enrichment.proposedMetadata.suggestedAltText }}</p>
          <p class="adm-help">Es lo que leen los lectores de pantalla y los buscadores.</p>
        </div>
      </div>
      <template
        v-if="enrichment.approvalStatus === 'pending_approval' || enrichment.approvalStatus.includes('approved')"
        #footer
      >
        <template v-if="enrichment.approvalStatus === 'pending_approval'">
          <button
            type="button"
            :disabled="deciding"
            class="adm-btn adm-btn--danger-soft"
            @click="recordDecision('reject')"
          >
            Rechazar
          </button>
          <button
            type="button"
            data-test="approve-enrichment-btn"
            :disabled="deciding"
            class="adm-btn adm-btn--secondary"
            @click="recordDecision('approve')"
          >
            Aprobar propuesta
          </button>
        </template>
        <button
          v-if="enrichment.approvalStatus.includes('approved')"
          type="button"
          data-test="apply-enrichment-btn"
          :disabled="applying"
          class="adm-btn adm-btn--secondary"
          @click="applyEnrichment"
        >
          Aplicar a la imagen
        </button>
      </template>
    </AdminCard>
  </div>
</template>
