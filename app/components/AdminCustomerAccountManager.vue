<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type {
  CustomerAccountManagerRecord,
  CommercialNoteRecord,
  OpportunityRecord,
  CalendarEventRecord
} from '../../workers/crm/account-manager'

const props = defineProps<{
  customerId: string
}>()

const requestFetch = useRequestFetch()

const loading = ref(true)
const error = ref<string | null>(null)

// Current assignment
const manager = ref<CustomerAccountManagerRecord | null>(null)
const notes = ref<CommercialNoteRecord[]>([])
const opportunities = ref<OpportunityRecord[]>([])
const calendarEvents = ref<CalendarEventRecord[]>([])

// Assignment form
const managerIdentityId = ref('00000000-0000-4000-8000-000000000001')
const managerName = ref('Laura Martínez')
const managerEmail = ref('laura.martinez@neteco.es')
const managerPhone = ref('+34 962 111 222 ext 104')
const availabilitySchedule = ref('L-V 08:30 - 17:30')
const slaTier = ref<'standard' | 'priority' | 'vip' | 'custom'>('priority')
const slaResponseHours = ref(4)
const slaDescription = ref('SLA prioritario para cuenta de volumen industrial.')
const assignReason = ref('Asignación inicial de gestor de cuenta comercial.')

// Note form
const noteCategory = ref<'commercial' | 'credit' | 'logistics' | 'operations' | 'general'>('commercial')
const noteConfidentiality = ref<'internal_sales' | 'admin_only'>('internal_sales')
const noteTitle = ref('')
const noteContent = ref('')

// Opportunity form
const oppTitle = ref('')
const oppValueEuros = ref(1500)
const oppStage = ref<'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'>('qualified')
const oppProbability = ref(50)
const oppCloseDate = ref('2026-11-30')

// Calendar event form
const eventSubject = ref('')
const eventScheduledAt = ref('2026-11-10T10:00:00Z')
const eventDuration = ref(45)
const eventChannel = ref<'phone' | 'video' | 'in_person'>('video')
const eventConsentVerified = ref(true)
const eventConsentRef = ref('Acordado verbalmente en llamada')

async function loadData() {
  loading.value = true
  error.value = null

  try {
    const [mgrRes, notesRes, oppsRes, calRes] = await Promise.all([
      requestFetch<{ manager: CustomerAccountManagerRecord | null }>(
        `/api/admin/crm/customers/${props.customerId}/account-manager`
      ),
      requestFetch<{ notes: CommercialNoteRecord[] }>(`/api/admin/crm/customers/${props.customerId}/notes`),
      requestFetch<{ opportunities: OpportunityRecord[] }>(
        `/api/admin/crm/customers/${props.customerId}/opportunities`
      ),
      requestFetch<{ events: CalendarEventRecord[] }>(`/api/admin/crm/customers/${props.customerId}/calendar-events`)
    ])

    manager.value = mgrRes.manager
    notes.value = notesRes.notes
    opportunities.value = oppsRes.opportunities
    calendarEvents.value = calRes.events
  } catch {
    error.value = 'No se ha podido cargar la información comercial del cliente.'
  } finally {
    loading.value = false
  }
}

async function saveAssignment() {
  try {
    const res = await $fetch<{ assignment: CustomerAccountManagerRecord }>(
      `/api/admin/crm/customers/${props.customerId}/account-manager`,
      {
        method: 'POST',
        body: {
          managerIdentityId: managerIdentityId.value,
          managerName: managerName.value.trim(),
          managerEmail: managerEmail.value.trim(),
          managerPhone: managerPhone.value.trim() || undefined,
          availabilitySchedule: availabilitySchedule.value.trim(),
          slaTier: slaTier.value,
          slaResponseHours: slaResponseHours.value,
          slaDescription: slaDescription.value.trim() || undefined,
          reason: assignReason.value.trim()
        }
      }
    )
    manager.value = res.assignment
  } catch {
    error.value = 'No se ha podido guardar el gestor de cuenta.'
  }
}

async function addNote() {
  if (!noteTitle.value.trim() || !noteContent.value.trim()) return
  try {
    const res = await $fetch<{ note: CommercialNoteRecord }>(`/api/admin/crm/customers/${props.customerId}/notes`, {
      method: 'POST',
      body: {
        category: noteCategory.value,
        confidentiality: noteConfidentiality.value,
        title: noteTitle.value.trim(),
        content: noteContent.value.trim()
      }
    })
    notes.value.unshift(res.note)
    noteTitle.value = ''
    noteContent.value = ''
  } catch {
    error.value = 'No se ha podido guardar la nota.'
  }
}

async function addOpportunity() {
  if (!oppTitle.value.trim()) return
  try {
    const res = await $fetch<{ opportunity: OpportunityRecord }>(
      `/api/admin/crm/customers/${props.customerId}/opportunities`,
      {
        method: 'POST',
        body: {
          title: oppTitle.value.trim(),
          estimatedValueCents: Math.round(oppValueEuros.value * 100),
          stage: oppStage.value,
          probabilityPercent: oppProbability.value,
          expectedCloseDate: oppCloseDate.value || undefined
        }
      }
    )
    opportunities.value.unshift(res.opportunity)
    oppTitle.value = ''
  } catch {
    error.value = 'No se ha podido guardar la oportunidad.'
  }
}

async function scheduleEvent() {
  if (!eventSubject.value.trim() || !eventConsentVerified.value) return
  try {
    const res = await $fetch<{ event: CalendarEventRecord }>(
      `/api/admin/crm/customers/${props.customerId}/calendar-events`,
      {
        method: 'POST',
        body: {
          managerIdentityId: managerIdentityId.value,
          subject: eventSubject.value.trim(),
          scheduledAt: eventScheduledAt.value,
          durationMinutes: eventDuration.value,
          channel: eventChannel.value,
          customerConsentVerified: true,
          consentReference: eventConsentRef.value.trim() || undefined
        }
      }
    )
    calendarEvents.value.push(res.event)
    eventSubject.value = ''
  } catch {
    error.value = 'No se ha podido programar la cita.'
  }
}

onMounted(() => {
  void loadData()
})

/* --- Presentación --- */
const prefix = useId()
const panel = ref<'manager' | 'opportunity' | 'note' | 'event' | null>(null)
function openPanel(name: 'manager' | 'opportunity' | 'note' | 'event') {
  error.value = null
  panel.value = name
}
function closePanel(value: boolean) {
  if (!value) panel.value = null
}
async function submitAssignment() {
  const before = manager.value
  await saveAssignment()
  if (manager.value !== before) panel.value = null
}
async function submitOpportunity() {
  const before = opportunities.value.length
  await addOpportunity()
  if (opportunities.value.length > before) panel.value = null
}
async function submitNote() {
  const before = notes.value.length
  await addNote()
  if (notes.value.length > before) panel.value = null
}
async function submitEvent() {
  const before = calendarEvents.value.length
  await scheduleEvent()
  if (calendarEvents.value.length > before) panel.value = null
}
const TIER_LABELS: Record<string, string> = {
  standard: 'Atención estándar',
  priority: 'Atención prioritaria',
  vip: 'Atención preferente',
  custom: 'Atención personalizada'
}
const STAGE_LABELS: Record<string, string> = {
  lead: 'Contacto nuevo',
  qualified: 'Interesado',
  proposal: 'Propuesta enviada',
  negotiation: 'En negociación',
  won: 'Ganada',
  lost: 'Perdida'
}
const STAGE_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  lead: 'neutral',
  qualified: 'info',
  proposal: 'info',
  negotiation: 'warning',
  won: 'success',
  lost: 'danger'
}
const NOTE_CATEGORY_LABELS: Record<string, string> = {
  commercial: 'Comercial',
  credit: 'Crédito',
  logistics: 'Logística',
  operations: 'Operaciones',
  general: 'General'
}
const CHANNEL_LABELS: Record<string, string> = {
  phone: 'Llamada',
  video: 'Videollamada',
  in_person: 'Visita presencial'
}
const EVENT_STATUS_LABELS: Record<string, string> = {
  scheduled: 'Programada',
  confirmed: 'Confirmada',
  completed: 'Realizada',
  cancelled: 'Cancelada',
  rescheduled: 'Reprogramada'
}
const EVENT_STATUS_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  scheduled: 'info',
  confirmed: 'success',
  completed: 'neutral',
  cancelled: 'neutral',
  rescheduled: 'warning'
}
</script>

<template>
  <div class="adm-stack">
    <UAlert v-if="error" role="alert" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error">
      <template #actions>
        <AdminButton size="sm" icon="i-lucide-rotate-cw" :loading="loading" @click="loadData">Reintentar</AdminButton>
      </template>
    </UAlert>

    <div class="grid items-start gap-5 lg:grid-cols-2">
      <AdminCard title="Gestor asignado">
        <template #actions>
          <AdminButton size="sm" icon="i-lucide-user-pen" @click="openPanel('manager')">
            {{ manager ? 'Cambiar gestor' : 'Asignar gestor' }}
          </AdminButton>
        </template>
        <div v-if="loading && !manager" class="adm-help" role="status">Cargando…</div>
        <div v-else-if="manager">
          <p class="font-semibold text-[var(--text-strong)]">{{ manager.managerName }}</p>
          <p class="adm-help break-words">{{ manager.managerEmail }} · {{ manager.managerPhone || 'Sin teléfono' }}</p>
          <p class="mt-3 flex flex-wrap items-center gap-2">
            <AdminBadge tone="info">{{ TIER_LABELS[manager.slaTier] ?? adminHumanize(manager.slaTier) }}</AdminBadge>
            <span class="adm-help">Respuesta en {{ manager.slaResponseHours }} h como máximo</span>
          </p>
          <p v-if="manager.slaDescription" class="adm-help mt-2">{{ manager.slaDescription }}</p>
        </div>
        <AdminEmptyState
          v-else
          compact
          icon="i-lucide-user-round"
          title="Sin gestor asignado"
          description="Asigna a una persona del equipo para que atienda a este cliente."
        />
      </AdminCard>

      <AdminCard title="Oportunidades" flush>
        <template #actions>
          <AdminButton size="sm" icon="i-lucide-plus" @click="openPanel('opportunity')">Añadir</AdminButton>
        </template>
        <AdminEmptyState
          v-if="opportunities.length === 0"
          compact
          icon="i-lucide-handshake"
          title="No hay oportunidades con este cliente"
        />
        <ul v-else class="adm-list">
          <li v-for="opp in opportunities" :key="opp.id">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">{{ opp.title }}</p>
              <p class="adm-help">
                {{ adminMoney(opp.estimatedValueCents) }} · {{ opp.probabilityPercent }} % de probabilidad
              </p>
            </div>
            <AdminBadge :tone="STAGE_TONES[opp.stage] ?? 'neutral'">
              {{ STAGE_LABELS[opp.stage] ?? adminHumanize(opp.stage) }}
            </AdminBadge>
          </li>
        </ul>
      </AdminCard>

      <AdminCard title="Notas internas" description="Solo las ve el equipo, nunca el cliente." flush>
        <template #actions>
          <AdminButton size="sm" icon="i-lucide-plus" @click="openPanel('note')">Añadir</AdminButton>
        </template>
        <AdminEmptyState v-if="notes.length === 0" compact icon="i-lucide-notebook-pen" title="No hay notas" />
        <ul v-else class="adm-list">
          <li v-for="n in notes" :key="n.id">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">
                {{ n.title }}
                <AdminBadge plain>{{ NOTE_CATEGORY_LABELS[n.category] ?? adminHumanize(n.category) }}</AdminBadge>
              </p>
              <p class="mt-1 whitespace-pre-wrap break-words">{{ n.content }}</p>
            </div>
          </li>
        </ul>
      </AdminCard>

      <AdminCard title="Citas" description="Llamadas y visitas acordadas con el cliente." flush>
        <template #actions>
          <AdminButton size="sm" icon="i-lucide-plus" @click="openPanel('event')">Programar</AdminButton>
        </template>
        <AdminEmptyState
          v-if="calendarEvents.length === 0"
          compact
          icon="i-lucide-calendar"
          title="No hay citas programadas"
        />
        <ul v-else class="adm-list">
          <li v-for="ev in calendarEvents" :key="ev.id">
            <div class="min-w-0 flex-1">
              <p class="adm-list__title">{{ ev.subject }}</p>
              <p class="adm-help">
                {{ adminDate(ev.scheduledAt, true) }} · {{ ev.durationMinutes }} min ·
                {{ CHANNEL_LABELS[ev.channel] ?? adminHumanize(ev.channel) }}
              </p>
            </div>
            <AdminBadge :tone="EVENT_STATUS_TONES[ev.status] ?? 'neutral'">
              {{ EVENT_STATUS_LABELS[ev.status] ?? adminHumanize(ev.status) }}
            </AdminBadge>
          </li>
        </ul>
      </AdminCard>
    </div>

    <AdminDrawer :open="panel === 'manager'" title="Gestor de cuenta" @update:open="closePanel">
      <form :id="`${prefix}-manager`" class="adm-stack" @submit.prevent="submitAssignment">
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
        <AdminFormField v-slot="{ id }" label="Nombre del gestor">
          <input :id="id" v-model="managerName" type="text" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Correo de trabajo">
          <input :id="id" v-model="managerEmail" type="email" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Teléfono o extensión">
          <input :id="id" v-model="managerPhone" type="text" />
        </AdminFormField>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Nivel de atención">
            <select :id="id" v-model="slaTier">
              <option value="standard">Estándar (24 h)</option>
              <option value="priority">Prioritaria (4 h)</option>
              <option value="vip">Preferente (2 h)</option>
              <option value="custom">Personalizada</option>
            </select>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Plazo de respuesta (horas)">
            <input :id="id" v-model.number="slaResponseHours" type="number" min="1" max="168" />
          </AdminFormField>
        </div>
        <AdminFormField v-slot="{ id }" label="Motivo del cambio" help="Queda guardado en el historial.">
          <input :id="id" v-model="assignReason" type="text" />
        </AdminFormField>
      </form>
      <template #footer>
        <AdminButton @click="panel = null">Cancelar</AdminButton>
        <AdminButton variant="primary" type="submit" :form="`${prefix}-manager`">Guardar gestor</AdminButton>
      </template>
    </AdminDrawer>

    <AdminDrawer :open="panel === 'opportunity'" title="Nueva oportunidad" @update:open="closePanel">
      <form :id="`${prefix}-opportunity`" class="adm-stack" @submit.prevent="submitOpportunity">
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
        <AdminFormField v-slot="{ id }" label="Título" required>
          <input :id="id" v-model="oppTitle" type="text" placeholder="Por ejemplo: suministro anual de limpieza" />
        </AdminFormField>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Importe estimado (€)">
            <input :id="id" v-model.number="oppValueEuros" type="number" />
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Probabilidad (%)">
            <input :id="id" v-model.number="oppProbability" type="number" />
          </AdminFormField>
        </div>
        <AdminFormField v-slot="{ id }" label="Fase">
          <select :id="id" v-model="oppStage">
            <option value="lead">Contacto nuevo</option>
            <option value="qualified">Interesado</option>
            <option value="proposal">Propuesta enviada</option>
            <option value="negotiation">En negociación</option>
            <option value="won">Ganada</option>
            <option value="lost">Perdida</option>
          </select>
        </AdminFormField>
      </form>
      <template #footer>
        <AdminButton @click="panel = null">Cancelar</AdminButton>
        <AdminButton variant="primary" type="submit" :form="`${prefix}-opportunity`" :disabled="!oppTitle.trim()">
          Guardar oportunidad
        </AdminButton>
      </template>
    </AdminDrawer>

    <AdminDrawer :open="panel === 'note'" title="Nueva nota interna" @update:open="closePanel">
      <form :id="`${prefix}-note`" class="adm-stack" @submit.prevent="submitNote">
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
        <AdminFormField v-slot="{ id }" label="Título" required>
          <input :id="id" v-model="noteTitle" type="text" />
        </AdminFormField>
        <AdminFormField v-slot="{ id }" label="Nota" help="Solo la ve el equipo." required>
          <textarea :id="id" v-model="noteContent" rows="4"></textarea>
        </AdminFormField>
      </form>
      <template #footer>
        <AdminButton @click="panel = null">Cancelar</AdminButton>
        <AdminButton
          variant="primary"
          type="submit"
          :form="`${prefix}-note`"
          :disabled="!noteTitle.trim() || !noteContent.trim()"
        >
          Guardar nota
        </AdminButton>
      </template>
    </AdminDrawer>

    <AdminDrawer :open="panel === 'event'" title="Programar cita" @update:open="closePanel">
      <form :id="`${prefix}-event`" class="adm-stack" @submit.prevent="submitEvent">
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
        <AdminFormField v-slot="{ id }" label="Asunto" required>
          <input :id="id" v-model="eventSubject" type="text" />
        </AdminFormField>
        <div class="adm-form-grid">
          <AdminFormField v-slot="{ id }" label="Tipo de cita">
            <select :id="id" v-model="eventChannel">
              <option value="phone">Llamada telefónica</option>
              <option value="video">Videollamada</option>
              <option value="in_person">Visita presencial</option>
            </select>
          </AdminFormField>
          <AdminFormField v-slot="{ id }" label="Duración (minutos)">
            <input :id="id" v-model.number="eventDuration" type="number" />
          </AdminFormField>
        </div>
        <label class="adm-check" for="ev-consent">
          <input id="ev-consent" v-model="eventConsentVerified" type="checkbox" />
          El cliente ha aceptado la cita
        </label>
      </form>
      <template #footer>
        <AdminButton @click="panel = null">Cancelar</AdminButton>
        <AdminButton
          variant="primary"
          type="submit"
          :form="`${prefix}-event`"
          :disabled="!eventSubject.trim() || !eventConsentVerified"
        >
          Programar cita
        </AdminButton>
      </template>
    </AdminDrawer>
  </div>
</template>
