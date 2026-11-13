<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AlphaBetaPromotionRecord } from '~~/shared/alpha-beta-promotion'
import type { ProgressiveRolloutRecord } from '~~/shared/progressive-rollout'
import type { CloudflarePolicyAuditRecord } from '~~/shared/cloudflare-policy'
import type { CampaignContentPipelineRecord } from '~~/shared/campaign-pipeline'

export type ActiveTab = 'promotions' | 'rollouts' | 'policies' | 'campaigns'

const requestFetch = useRequestFetch()

const activeTab = ref<ActiveTab>('promotions')
const loading = ref(true)
const loadError = ref<string | null>(null)
const actionMessage = ref<string | null>(null)
const actionType = ref<'success' | 'error'>('success')

// Data containers
const promotions = ref<AlphaBetaPromotionRecord[]>([])
const rollouts = ref<ProgressiveRolloutRecord[]>([])
const policies = ref<CloudflarePolicyAuditRecord[]>([])
const campaigns = ref<CampaignContentPipelineRecord[]>([])

async function loadData() {
  loading.value = true
  loadError.value = null
  actionMessage.value = null
  try {
    const [promoRes, rolloutRes, policyRes, campaignRes] = await Promise.all([
      requestFetch('/api/admin/release/alpha-beta-promotions'),
      requestFetch('/api/admin/release/progressive-rollouts'),
      requestFetch('/api/admin/release/cloudflare-policies'),
      requestFetch('/api/admin/cms/campaign-pipeline')
    ])

    promotions.value = Array.isArray(promoRes) ? promoRes : []
    rollouts.value = Array.isArray(rolloutRes) ? rolloutRes : []
    policies.value = Array.isArray(policyRes) ? policyRes : []
    campaigns.value = Array.isArray(campaignRes) ? campaignRes : []
  } catch (err: unknown) {
    loadError.value = err instanceof Error ? err.message : 'No se han podido cargar los controles de versión'
  } finally {
    loading.value = false
  }
}

const tabs = computed<Array<{ value: ActiveTab; label: string; count: number }>>(() => [
  { value: 'promotions', label: 'Paso a pruebas con clientes', count: promotions.value.length },
  { value: 'rollouts', label: 'Activaciones graduales', count: rollouts.value.length },
  { value: 'policies', label: 'Revisiones de configuración', count: policies.value.length },
  { value: 'campaigns', label: 'Campañas', count: campaigns.value.length }
])
const STATUS_LABELS: Record<string, string> = {
  promoted: 'Abierta a clientes',
  tripped: 'Detenida automáticamente',
  rolled_back: 'Retirada',
  ramping: 'Ampliándose',
  completed: 'Completada'
}
const STATUS_TONES: Record<string, 'success' | 'danger'> = {
  promoted: 'success',
  tripped: 'danger',
  rolled_back: 'danger'
}
const statusLabel = (status: string) => STATUS_LABELS[status] ?? adminStatusLabel(status)
const statusTone = (status: string) => STATUS_TONES[status] ?? adminStatusTone(status)
const environmentLabels: Record<string, string> = {
  production: 'Tienda real',
  staging: 'Entorno previo',
  preview: 'Vista previa'
}
function promotionChecks(promo: AlphaBetaPromotionRecord) {
  const summary = promo.checklistSummary
  return [
    { label: 'Objetivo de servicio', ok: Boolean(summary?.sloVerified), done: 'cumplido' },
    { label: 'Avisos automáticos', ok: Boolean(summary?.alertsConfigured), done: 'activos' },
    { label: 'Procedimientos', ok: Boolean(summary?.runbooksPublished), done: 'publicados' },
    { label: 'Recuperación de copias', ok: Boolean(summary?.restoreRehearsed), done: 'ensayada' },
    { label: 'Revisión de seguridad', ok: Boolean(summary?.pentestCleared), done: 'superada' },
    { label: 'Pruebas de usuarios', ok: Boolean(summary?.uatPassed), done: 'aprobadas' }
  ]
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="adm-stack" role="region" aria-label="Controles de versión y publicación">
    <AdminTabs v-model="activeTab" :tabs="tabs" label="Secciones de control de publicación" />

    <div v-if="loading" class="adm-table-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span class="sr-only">Cargando los controles de versión…</span>
      <div v-for="row in 4" :key="row"><i /><i /><i /><i /></div>
    </div>

    <div v-else-if="loadError" role="alert">
      <AdminEmptyState
        variant="error"
        title="No se han podido cargar los controles de versión"
        description="Comprueba la conexión y vuelve a intentarlo."
      >
        <AdminButton icon="i-lucide-rotate-cw" @click="loadData">Reintentar</AdminButton>
      </AdminEmptyState>
    </div>

    <template v-else>
      <UAlert
        v-if="actionMessage"
        role="status"
        :color="actionType === 'error' ? 'error' : 'success'"
        variant="subtle"
        :title="actionMessage"
      />

      <section
        v-if="activeTab === 'promotions'"
        id="panel-promo"
        role="tabpanel"
        aria-label="Paso de pruebas internas a pruebas con clientes"
        class="adm-stack"
      >
        <AdminEmptyState
          v-if="promotions.length === 0"
          title="Ninguna versión ha pasado a pruebas con clientes"
          description="Aquí verás qué requisitos cumple cada versión antes de abrirla a más gente."
          icon="i-lucide-flask-conical"
        />
        <AdminCard v-for="promo in promotions" v-else :key="promo.id" as="article">
          <template #title>Versión {{ promo.releaseVersion }}</template>
          <template #actions>
            <AdminBadge :tone="statusTone(promo.status)">{{ statusLabel(promo.status) }}</AdminBadge>
          </template>
          <div class="flex flex-wrap gap-2">
            <AdminBadge :tone="promo.p0DefectsCount > 0 ? 'danger' : 'neutral'">
              Fallos graves: {{ promo.p0DefectsCount }}
            </AdminBadge>
            <AdminBadge :tone="promo.p1DefectsCount > 0 ? 'danger' : 'neutral'">
              Fallos importantes: {{ promo.p1DefectsCount }}
            </AdminBadge>
          </div>
          <ul class="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <li v-for="check in promotionChecks(promo)" :key="check.label" class="flex items-center gap-2">
              <UIcon
                :name="check.ok ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'"
                class="size-4 shrink-0"
                :class="check.ok ? 'text-neteco-700' : 'text-[var(--text-muted)]'"
              />
              <span>{{ check.label }}: {{ check.ok ? check.done : 'pendiente' }}</span>
            </li>
          </ul>
          <template v-if="promo.evidenceHash" #footer>
            <span class="adm-help mr-auto">Justificante #{{ promo.evidenceHash.slice(0, 8).toUpperCase() }}</span>
          </template>
        </AdminCard>
      </section>

      <section
        v-if="activeTab === 'rollouts'"
        id="panel-rollout"
        role="tabpanel"
        aria-label="Activaciones graduales"
        class="adm-stack"
      >
        <AdminEmptyState
          v-if="rollouts.length === 0"
          title="No hay ninguna activación gradual"
          description="Cuando una novedad se abra poco a poco a los clientes, su avance aparecerá aquí."
          icon="i-lucide-sliders-horizontal"
        />
        <AdminCard v-for="ro in rollouts" v-else :key="ro.id" as="article" :title="ro.name">
          <template #actions>
            <AdminBadge :tone="statusTone(ro.status)">{{ statusLabel(ro.status) }}</AdminBadge>
          </template>
          <div class="adm-stack text-sm">
            <p>
              Visitas que ya la ven: <strong>{{ ro.trafficPercentage }} %</strong>
            </p>
            <p v-if="ro.cohorts && ro.cohorts.length > 0" class="flex flex-wrap items-center gap-1.5">
              Grupos de clientes:
              <AdminBadge v-for="c in ro.cohorts" :key="c" plain>{{ adminHumanize(c) }}</AdminBadge>
            </p>
            <p v-if="ro.zones && ro.zones.length > 0" class="flex flex-wrap items-center gap-1.5">
              Zonas:
              <AdminBadge v-for="z in ro.zones" :key="z" plain>{{ adminHumanize(z) }}</AdminBadge>
            </p>
            <p v-if="ro.betaScopeNotice">
              <strong>Aviso a los clientes:</strong> {{ ro.betaScopeNotice.title }} — {{ ro.betaScopeNotice.summary }}
            </p>
            <UAlert
              v-if="ro.tripReason"
              role="alert"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="Se detuvo automáticamente"
              :description="ro.tripReason"
            />
          </div>
        </AdminCard>
      </section>

      <section
        v-if="activeTab === 'policies'"
        id="panel-policy"
        role="tabpanel"
        aria-label="Revisiones de configuración"
        class="adm-stack"
      >
        <AdminEmptyState
          v-if="policies.length === 0"
          title="Todavía no se ha revisado la configuración"
          description="Cada revisión comprueba que la configuración del servidor cumple las normas antes de publicar."
          icon="i-lucide-shield-check"
        />
        <AdminCard v-for="pol in policies" v-else :key="pol.id" as="article">
          <template #title>
            {{ environmentLabels[pol.targetEnvironment] ?? adminHumanize(pol.targetEnvironment) }} · normas
            {{ pol.policyVersion }}
          </template>
          <template #actions>
            <AdminBadge :tone="pol.passed ? 'success' : 'danger'">{{
              pol.passed ? 'Superada' : 'Bloqueada'
            }}</AdminBadge>
          </template>
          <div class="adm-stack text-sm">
            <p>
              Problemas que bloquean: <strong>{{ pol.blockersCount }}</strong> · avisos: {{ pol.warningsCount }}
            </p>
            <UAlert
              v-if="pol.hasCriticalDrift"
              role="alert"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="La configuración real no coincide con la aprobada"
            />
            <ul v-if="pol.violations && pol.violations.length > 0" class="list-disc space-y-1 pl-5">
              <li v-for="(v, i) in pol.violations" :key="i">
                {{ v.message }} <span class="adm-help">({{ v.resource }})</span>
              </li>
            </ul>
          </div>
        </AdminCard>
      </section>

      <section
        v-if="activeTab === 'campaigns'"
        id="panel-campaign"
        role="tabpanel"
        aria-label="Campañas"
        class="adm-stack"
      >
        <AdminEmptyState
          v-if="campaigns.length === 0"
          title="No hay campañas en preparación"
          description="Las campañas de contenido pendientes de publicar aparecerán aquí."
          icon="i-lucide-megaphone"
        />
        <AdminCard v-for="cmp in campaigns" v-else :key="cmp.id" as="article" :title="cmp.title">
          <template #actions>
            <AdminBadge :tone="statusTone(cmp.status)">{{ statusLabel(cmp.status) }}</AdminBadge>
          </template>
          <div class="space-y-1 text-sm">
            <p>
              Versión en borrador: {{ cmp.currentVersion }} · versión publicada:
              {{ cmp.publishedVersion ?? 'ninguna' }}
            </p>
            <p v-if="cmp.publishAt">Programada para el {{ adminDate(cmp.publishAt, true) }}</p>
          </div>
        </AdminCard>
      </section>
    </template>
  </div>
</template>
