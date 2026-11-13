<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useUgcReviews } from '../composables/useUgcReviews'

const { adminReviews: rawAdminReviews, loading, submitting, error, fetchAdminReviews, moderateReview } = useUgcReviews()

const activeTab = ref<'pending' | 'pii' | 'incentive' | 'all'>('pending')
const notice = ref<string | null>(null)
const actionError = ref('')

// Estado de interfaz: pestañas, confirmación y etiquetas legibles.
type UgcTab = 'pending' | 'pii' | 'incentive' | 'all'
const TABS: Array<{ value: UgcTab; label: string }> = [
  { value: 'pending', label: 'Pendientes' },
  { value: 'pii', label: 'Con datos personales' },
  { value: 'incentive', label: 'Posibles regalos no declarados' },
  { value: 'all', label: 'Todas' }
]
const onTab = (value: string) => handleTabChange(value as UgcTab)
const MODERATION: Record<string, [string, 'neutral' | 'success' | 'warning' | 'danger']> = {
  pending: ['Pendiente', 'warning'],
  approved: ['Aprobada', 'success'],
  rejected: ['Rechazada', 'danger'],
  quarantined: ['Apartada para revisar', 'warning'],
  withdrawn: ['Retirada por el cliente', 'neutral']
}
const SCAN: Record<string, [string, 'neutral' | 'success' | 'warning' | 'danger']> = {
  clean: ['Archivo seguro', 'success'],
  infected: ['Archivo peligroso', 'danger'],
  quarantined: ['Archivo apartado', 'warning'],
  pending: ['Comprobando archivo', 'neutral']
}
const ACTION_DONE: Record<'approve' | 'reject' | 'quarantine', string> = {
  approve: 'Reseña aprobada.',
  reject: 'Reseña rechazada.',
  quarantine: 'Reseña apartada para revisarla más tarde.'
}
const reviewToReject = ref<{ id: string; version: number; title?: string } | null>(null)
const confirmReject = computed({
  get: () => reviewToReject.value !== null,
  set: (open: boolean) => {
    if (!open) reviewToReject.value = null
  }
})
async function confirmRejectReview() {
  const item = reviewToReject.value
  reviewToReject.value = null
  if (item) await handleModerate(item as ModerationItem, 'reject')
}
const moderationReason = ref('Verificación técnica completada por moderación')

const loadReviews = async () => {
  notice.value = null
  actionError.value = ''
  if (activeTab.value === 'pending') {
    await fetchAdminReviews({ status: 'pending' })
  } else if (activeTab.value === 'pii') {
    await fetchAdminReviews({ pii: true })
  } else if (activeTab.value === 'incentive') {
    await fetchAdminReviews({ incentive: true })
  } else {
    await fetchAdminReviews({})
  }
}

onMounted(() => {
  loadReviews()
})

const handleTabChange = (tab: typeof activeTab.value) => {
  activeTab.value = tab
  loadReviews()
}

interface ModerationPhoto {
  id: string
  photoUrl: string
  antivirusStatus: string
  moderationStatus: string
}

interface ModerationItem {
  id: string
  version: number
  rating?: number
  title?: string
  moderationStatus?: string
  displayName?: string
  productId?: string
  createdAt?: string
  isVerifiedBuyer?: boolean
  piiDetected?: boolean
  piiRedactedContent?: string | null
  hiddenIncentiveSuspected?: boolean
  content?: string
  photos?: ModerationPhoto[]
  [key: string]: unknown
}

function isModerationItem(r: Record<string, unknown>): r is ModerationItem {
  return typeof r.id === 'string' && typeof r.version === 'number'
}

const adminReviews = computed<ModerationItem[]>(() => rawAdminReviews.value.filter(isModerationItem))

const handleModerate = async (review: ModerationItem, action: 'approve' | 'reject' | 'quarantine') => {
  actionError.value = ''
  try {
    await moderateReview({
      reviewId: review.id,
      action,
      reason: moderationReason.value,
      expectedVersion: review.version,
      commandId: `cmd-admin-mod-${review.id}-${Date.now()}`
    })
    await loadReviews()
    notice.value = ACTION_DONE[action]
  } catch {
    actionError.value = 'No se ha podido guardar la decisión. Vuelve a intentarlo.'
  }
}

const handleRedactPii = async (review: ModerationItem) => {
  if (!review.piiRedactedContent) return
  actionError.value = ''
  try {
    const res = await fetch(`/api/admin/ugc-reviews/${review.id}/redact-pii`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redactedContent: review.piiRedactedContent,
        expectedVersion: review.version,
        commandId: `cmd-pii-${review.id}-${Date.now()}`
      })
    })
    if (!res.ok) throw new Error('Error al redactar PII')
    await loadReviews()
    notice.value = 'Se han quitado los datos personales de la reseña.'
  } catch {
    actionError.value = 'No se han podido quitar los datos personales. Vuelve a intentarlo.'
  }
}
</script>

<template>
  <div class="adm-stack">
    <AdminPageActions>
      <AdminButton icon="i-lucide-refresh-cw" :loading="loading" @click="loadReviews">Actualizar</AdminButton>
    </AdminPageActions>

    <AdminTabs :model-value="activeTab" :tabs="TABS" label="Filtrar reseñas" @update:model-value="onTab" />

    <UAlert v-if="notice" role="status" color="success" variant="subtle" icon="i-lucide-circle-check" :title="notice" />
    <UAlert
      v-if="actionError"
      role="alert"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="actionError"
    />

    <div v-if="loading" role="status" class="adm-card adm-table-skeleton" aria-busy="true">
      <span class="sr-only">Cargando reseñas…</span>
      <div v-for="row in 4" :key="row"><i /><i /><i /></div>
    </div>

    <AdminCard v-else-if="error && adminReviews.length === 0" flush>
      <AdminEmptyState
        role="alert"
        variant="error"
        title="No se han podido cargar las reseñas"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="loadReviews">Reintentar</AdminButton>
      </AdminEmptyState>
    </AdminCard>

    <AdminCard v-else-if="adminReviews.length === 0" flush>
      <AdminEmptyState
        icon="i-lucide-camera"
        :title="activeTab === 'all' ? 'Todavía no hay reseñas de clientes' : 'Nada pendiente en este apartado'"
        :description="
          activeTab === 'all'
            ? 'Cuando un cliente envíe una reseña o una foto, aparecerá aquí.'
            : 'No hay reseñas ni fotos que necesiten tu atención.'
        "
      />
    </AdminCard>

    <template v-else>
      <AdminCard v-for="rev in adminReviews" :key="rev.id" as="article">
        <template #title>
          <span class="flex flex-wrap items-center gap-2">
            <AdminBadge tone="neutral" plain>
              <UIcon name="i-lucide-star" class="size-3.5" />{{ rev.rating }}/5
            </AdminBadge>
            {{ rev.title }}
            <AdminBadge :tone="MODERATION[rev.moderationStatus ?? '']?.[1] ?? 'neutral'">
              {{ MODERATION[rev.moderationStatus ?? '']?.[0] ?? adminHumanize(rev.moderationStatus ?? 'pendiente') }}
            </AdminBadge>
            <AdminBadge v-if="rev.isVerifiedBuyer" tone="success" plain>Compra verificada</AdminBadge>
          </span>
        </template>
        <template #actions>
          <AdminButton size="sm" icon="i-lucide-check" :disabled="submitting" @click="handleModerate(rev, 'approve')">
            Aprobar
          </AdminButton>
          <AdminButton size="sm" :disabled="submitting" @click="handleModerate(rev, 'quarantine')">
            Apartar para revisar
          </AdminButton>
          <AdminButton variant="danger-soft" size="sm" :disabled="submitting" @click="reviewToReject = rev">
            Rechazar
          </AdminButton>
        </template>

        <div class="space-y-3">
          <p class="adm-help">
            {{ rev.displayName }} · <time :datetime="rev.createdAt">{{ adminDate(rev.createdAt, true) }}</time>
            <template v-if="rev.productId"> · producto #{{ rev.productId.slice(0, 8).toUpperCase() }}</template>
          </p>

          <p>{{ rev.content }}</p>

          <UAlert
            v-if="rev.piiDetected"
            color="warning"
            variant="subtle"
            icon="i-lucide-user-round-x"
            title="El texto incluye datos personales (teléfono, correo o DNI)"
            :description="`Texto propuesto sin esos datos: «${rev.piiRedactedContent ?? ''}»`"
            :actions="
              rev.piiRedactedContent
                ? [
                    {
                      label: 'Usar el texto sin datos personales',
                      color: 'neutral',
                      variant: 'outline',
                      onClick: () => handleRedactPii(rev)
                    }
                  ]
                : []
            "
          />

          <UAlert
            v-if="rev.hiddenIncentiveSuspected"
            color="warning"
            variant="subtle"
            icon="i-lucide-gift"
            title="Posible regalo o incentivo no declarado"
            description="El cliente indicó que no recibió nada a cambio, pero el texto menciona regalos, sorteos o muestras gratuitas. Revísala antes de publicarla."
          />

          <div v-if="rev.photos && rev.photos.length > 0" class="border-t border-[var(--border)] pt-3">
            <h4>Fotos adjuntas</h4>
            <div class="mt-2 flex flex-wrap gap-3">
              <figure
                v-for="photo in rev.photos"
                :key="photo.id"
                class="w-28 rounded-[var(--radius-control)] border border-[var(--border)] p-2"
              >
                <img
                  :src="photo.photoUrl"
                  alt="Foto enviada por el cliente"
                  class="h-24 w-24 rounded-[var(--radius-control)] object-cover"
                />
                <figcaption class="mt-1.5 flex flex-col items-start gap-1">
                  <AdminBadge :tone="SCAN[photo.antivirusStatus]?.[1] ?? 'neutral'">
                    {{ SCAN[photo.antivirusStatus]?.[0] ?? adminHumanize(photo.antivirusStatus) }}
                  </AdminBadge>
                  <span class="adm-help">
                    {{ MODERATION[photo.moderationStatus]?.[0] ?? adminHumanize(photo.moderationStatus) }}
                  </span>
                </figcaption>
              </figure>
            </div>
          </div>
        </div>
      </AdminCard>
    </template>

    <AdminConfirm
      v-model:open="confirmReject"
      title="Rechazar reseña"
      :description="`La reseña «${reviewToReject?.title ?? ''}» no se publicará en la tienda.`"
      confirm-label="Rechazar"
      danger
      @confirm="confirmRejectReview"
    />
  </div>
</template>
