<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AlphaBetaPromotionRecord } from '../../shared/alpha-beta-promotion'
import type { ProgressiveRolloutRecord } from '../../shared/progressive-rollout'
import type { CloudflarePolicyAuditRecord } from '../../shared/cloudflare-policy'
import type { CampaignContentPipelineRecord } from '../../shared/campaign-pipeline'

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
    loadError.value = err instanceof Error ? err.message : 'Error al cargar los paneles de release'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="release-gates-panel" role="region" aria-label="Panel de Release Gates y Despliegues">
    <header class="panel-header">
      <h1 class="panel-title">Controles de Release y Despliegue Progresivo</h1>
      <p class="panel-subtitle">
        CIC-028 Alpha→Beta · CIC-029 Rollout &amp; Guardrails · CIC-030 Cloudflare Policy-as-Code · CIC-031 Pipeline
        Campañas
      </p>
    </header>

    <!-- Navegación de pestañas accesible -->
    <nav class="tabs-nav" role="tablist" aria-label="Secciones de control de lanzamiento">
      <button
        id="tab-promo"
        role="tab"
        :aria-selected="activeTab === 'promotions'"
        aria-controls="panel-promo"
        :class="['tab-button', { active: activeTab === 'promotions' }]"
        @click="activeTab = 'promotions'"
      >
        Alpha→Beta ({{ promotions.length }})
      </button>
      <button
        id="tab-rollout"
        role="tab"
        :aria-selected="activeTab === 'rollouts'"
        aria-controls="panel-rollout"
        :class="['tab-button', { active: activeTab === 'rollouts' }]"
        @click="activeTab = 'rollouts'"
      >
        Rollouts ({{ rollouts.length }})
      </button>
      <button
        id="tab-policy"
        role="tab"
        :aria-selected="activeTab === 'policies'"
        aria-controls="panel-policy"
        :class="['tab-button', { active: activeTab === 'policies' }]"
        @click="activeTab = 'policies'"
      >
        Cloudflare Policies ({{ policies.length }})
      </button>
      <button
        id="tab-campaign"
        role="tab"
        :aria-selected="activeTab === 'campaigns'"
        aria-controls="panel-campaign"
        :class="['tab-button', { active: activeTab === 'campaigns' }]"
        @click="activeTab = 'campaigns'"
      >
        Campañas ({{ campaigns.length }})
      </button>
    </nav>

    <!-- Estado de Carga -->
    <div v-if="loading" class="state-loading" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <span>Cargando controles de release y despliegue...</span>
    </div>

    <!-- Estado de Error -->
    <div v-else-if="loadError" class="state-error" role="alert">
      <p class="error-text">{{ loadError }}</p>
      <button class="btn-retry" @click="loadData">Reintentar carga</button>
    </div>

    <!-- Contenido de Paneles -->
    <div v-else class="panels-container">
      <!-- Mensaje de acción -->
      <div v-if="actionMessage" :class="['action-message', actionType]" role="status">
        {{ actionMessage }}
      </div>

      <!-- Tab 1: Promociones Alpha->Beta -->
      <section
        v-if="activeTab === 'promotions'"
        id="panel-promo"
        role="tabpanel"
        aria-labelledby="tab-promo"
        class="tab-content"
      >
        <div v-if="promotions.length === 0" class="empty-state">
          <p>No hay promociones Alpha→Beta registradas en el sistema.</p>
        </div>
        <div v-else class="items-list">
          <article v-for="promo in promotions" :key="promo.id" class="card promo-card">
            <header class="card-header">
              <h2>Versión {{ promo.releaseVersion }}</h2>
              <span :class="['badge', `status-${promo.status}`]">{{ promo.status }}</span>
            </header>
            <div class="card-body">
              <div class="defects-row">
                <span :class="['defect-chip', { danger: promo.p0DefectsCount > 0 }]">
                  P0: {{ promo.p0DefectsCount }}
                </span>
                <span :class="['defect-chip', { danger: promo.p1DefectsCount > 0 }]">
                  P1: {{ promo.p1DefectsCount }}
                </span>
              </div>
              <div class="checklist-grid">
                <span :class="['check-item', { ok: promo.checklistSummary?.sloVerified }]">
                  SLO: {{ promo.checklistSummary?.sloVerified ? 'Conforme' : 'Pendiente' }}
                </span>
                <span :class="['check-item', { ok: promo.checklistSummary?.alertsConfigured }]">
                  Alertas: {{ promo.checklistSummary?.alertsConfigured ? 'Activas' : 'Pendiente' }}
                </span>
                <span :class="['check-item', { ok: promo.checklistSummary?.runbooksPublished }]">
                  Runbooks: {{ promo.checklistSummary?.runbooksPublished ? 'Publicados' : 'Pendiente' }}
                </span>
                <span :class="['check-item', { ok: promo.checklistSummary?.restoreRehearsed }]">
                  Restore DR: {{ promo.checklistSummary?.restoreRehearsed ? 'Ensayado' : 'Pendiente' }}
                </span>
                <span :class="['check-item', { ok: promo.checklistSummary?.pentestCleared }]">
                  Pentest: {{ promo.checklistSummary?.pentestCleared ? 'Superado' : 'Pendiente' }}
                </span>
                <span :class="['check-item', { ok: promo.checklistSummary?.uatPassed }]">
                  UAT: {{ promo.checklistSummary?.uatPassed ? 'Aprobado' : 'Pendiente' }}
                </span>
              </div>
              <footer class="card-footer">
                <small class="evidence-hash">Evidencia SHA256: {{ promo.evidenceHash?.slice(0, 16) }}...</small>
              </footer>
            </div>
          </article>
        </div>
      </section>

      <!-- Tab 2: Rollouts Progresivos -->
      <section
        v-if="activeTab === 'rollouts'"
        id="panel-rollout"
        role="tabpanel"
        aria-labelledby="tab-rollout"
        class="tab-content"
      >
        <div v-if="rollouts.length === 0" class="empty-state">
          <p>No hay despliegues progresivos activos ni configurados.</p>
        </div>
        <div v-else class="items-list">
          <article v-for="ro in rollouts" :key="ro.id" class="card rollout-card">
            <header class="card-header">
              <h2>
                {{ ro.name }} (<code>{{ ro.featureKey }}</code
                >)
              </h2>
              <span :class="['badge', `status-${ro.status}`]">{{ ro.status }}</span>
            </header>
            <div class="card-body">
              <p>
                Tráfico asignado: <strong>{{ ro.trafficPercentage }}%</strong>
              </p>
              <div v-if="ro.cohorts && ro.cohorts.length > 0">
                Cohortes: <span v-for="c in ro.cohorts" :key="c" class="tag">{{ c }}</span>
              </div>
              <div v-if="ro.zones && ro.zones.length > 0">
                Zonas: <span v-for="z in ro.zones" :key="z" class="tag">{{ z }}</span>
              </div>
              <div v-if="ro.betaScopeNotice" class="beta-notice-preview">
                <strong>Aviso Beta:</strong> {{ ro.betaScopeNotice.title }} - {{ ro.betaScopeNotice.summary }}
              </div>
              <div v-if="ro.tripReason" class="trip-alert" role="alert">Disparo Guardrail: {{ ro.tripReason }}</div>
            </div>
          </article>
        </div>
      </section>

      <!-- Tab 3: Cloudflare Policies -->
      <section
        v-if="activeTab === 'policies'"
        id="panel-policy"
        role="tabpanel"
        aria-labelledby="tab-policy"
        class="tab-content"
      >
        <div v-if="policies.length === 0" class="empty-state">
          <p>No se han ejecutado auditorías de política de Cloudflare aún.</p>
        </div>
        <div v-else class="items-list">
          <article v-for="pol in policies" :key="pol.id" class="card policy-card">
            <header class="card-header">
              <h2>Entorno: {{ pol.targetEnvironment }} · Política {{ pol.policyVersion }}</h2>
              <span :class="['badge', pol.passed ? 'status-promoted' : 'status-rejected']">
                {{ pol.passed ? 'PASSED' : 'BLOCKED' }}
              </span>
            </header>
            <div class="card-body">
              <p>
                Bloqueadores: <strong>{{ pol.blockersCount }}</strong> | Advertencias: {{ pol.warningsCount }}
              </p>
              <p v-if="pol.hasCriticalDrift" class="drift-alert" role="alert">
                ¡Drift crítico detectado en la infraestructura live!
              </p>
              <ul v-if="pol.violations && pol.violations.length > 0" class="violations-list">
                <li v-for="(v, i) in pol.violations" :key="i" :class="v.severity">
                  [{{ v.ruleId }}] {{ v.message }} ({{ v.resource }})
                </li>
              </ul>
            </div>
          </article>
        </div>
      </section>

      <!-- Tab 4: Campañas y Contenido -->
      <section
        v-if="activeTab === 'campaigns'"
        id="panel-campaign"
        role="tabpanel"
        aria-labelledby="tab-campaign"
        class="tab-content"
      >
        <div v-if="campaigns.length === 0" class="empty-state">
          <p>No hay campañas en el pipeline editorial independiente.</p>
        </div>
        <div v-else class="items-list">
          <article v-for="cmp in campaigns" :key="cmp.id" class="card campaign-card">
            <header class="card-header">
              <h2>
                {{ cmp.title }} (<code>{{ cmp.campaignSlug }}</code
                >)
              </h2>
              <span :class="['badge', `status-${cmp.status}`]">{{ cmp.status }}</span>
            </header>
            <div class="card-body">
              <p>
                Versión en borrador: {{ cmp.currentVersion }} | Versión en producción:
                {{ cmp.publishedVersion ?? 'Ninguna' }}
              </p>
              <p v-if="cmp.publishAt">Programada para: {{ cmp.publishAt }}</p>
            </div>
          </article>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.release-gates-panel {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  padding: 1rem;
}
.panel-header {
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 0.75rem;
}
.panel-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: #0f172a;
}
.panel-subtitle {
  font-size: 0.875rem;
  color: #64748b;
}
.tabs-nav {
  display: flex;
  gap: 0.5rem;
  border-bottom: 2px solid #e2e8f0;
}
.tab-button {
  padding: 0.5rem 1rem;
  border: none;
  background: none;
  cursor: pointer;
  font-weight: 600;
  color: #64748b;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
}
.tab-button.active {
  color: #0284c7;
  border-bottom-color: #0284c7;
}
.state-loading,
.state-error,
.empty-state {
  padding: 2rem;
  text-align: center;
  background: #f8fafc;
  border-radius: 0.5rem;
  border: 1px dashed #cbd5e1;
}
.btn-retry {
  margin-top: 1rem;
  padding: 0.5rem 1rem;
  background: #0284c7;
  color: white;
  border: none;
  border-radius: 0.375rem;
  cursor: pointer;
}
.card {
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 1rem;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}
.badge {
  padding: 0.25rem 0.5rem;
  border-radius: 0.25rem;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}
.status-draft {
  background: #f1f5f9;
  color: #475569;
}
.status-in_review {
  background: #fef3c7;
  color: #b45309;
}
.status-approved,
.status-promoted,
.status-active {
  background: #dcfce7;
  color: #15803d;
}
.status-tripped,
.status-rejected,
.status-rolled_back {
  background: #fee2e2;
  color: #b91c1c;
}
.defects-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.defect-chip {
  padding: 0.2rem 0.5rem;
  background: #f1f5f9;
  border-radius: 0.25rem;
  font-size: 0.8rem;
}
.defect-chip.danger {
  background: #fee2e2;
  color: #b91c1c;
  font-weight: bold;
}
.checklist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.5rem;
  margin: 0.75rem 0;
}
.check-item {
  font-size: 0.75rem;
  padding: 0.25rem;
  background: #f8fafc;
  border-radius: 0.25rem;
}
.check-item.ok {
  color: #166534;
  font-weight: 600;
}
.tag {
  display: inline-block;
  background: #e0f2fe;
  color: #0369a1;
  padding: 0.1rem 0.4rem;
  border-radius: 0.25rem;
  margin-right: 0.25rem;
  font-size: 0.75rem;
}
.drift-alert,
.trip-alert {
  background: #fee2e2;
  color: #991b1b;
  padding: 0.5rem;
  border-radius: 0.25rem;
  margin-top: 0.5rem;
  font-weight: 600;
}
</style>
