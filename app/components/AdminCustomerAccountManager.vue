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
    error.value = 'No se ha podido cargar la información CRM del cliente.'
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
    error.value = 'Error al actualizar la asignación del gestor de cuenta.'
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
    error.value = 'Error al crear la nota comercial interna.'
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
    error.value = 'Error al registrar la oportunidad comercial.'
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
    error.value = 'Error al agendar la interacción en el calendario.'
  }
}

onMounted(() => {
  void loadData()
})
</script>

<template>
  <div class="space-y-6">
    <div class="border-b border-slate-200 pb-4">
      <h1 class="text-2xl font-bold text-slate-900">Gestor de Cuenta y CRM (SUP-016)</h1>
      <p class="text-sm text-slate-500">
        Asignación de gestor, SLA, notas internas, pipeline de oportunidades y calendario con permiso.
      </p>
    </div>

    <div v-if="error" class="rounded-lg bg-rose-50 p-4 text-sm text-rose-800" role="alert">
      {{ error }}
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- Account manager assignment card -->
      <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <h2 class="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">Asignación de Gestor y SLA</h2>

        <div v-if="manager" class="rounded-lg bg-indigo-50 p-4 border border-indigo-100 text-sm">
          <div class="font-bold text-indigo-950">{{ manager.managerName }}</div>
          <div class="text-indigo-800">{{ manager.managerEmail }} · {{ manager.managerPhone || 'Sin extensión' }}</div>
          <div class="mt-2 text-xs font-semibold text-indigo-900">
            Nivel SLA: {{ manager.slaTier.toUpperCase() }} (Garantía de respuesta: {{ manager.slaResponseHours }}h)
          </div>
          <div v-if="manager.slaDescription" class="mt-1 text-xs text-indigo-700">
            {{ manager.slaDescription }}
          </div>
        </div>

        <form class="space-y-3 text-xs" @submit.prevent="saveAssignment">
          <div>
            <label class="block font-medium text-slate-700">Nombre del gestor</label>
            <input
              v-model="managerName"
              type="text"
              class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-slate-900"
            />
          </div>
          <div>
            <label class="block font-medium text-slate-700">Email corporativo</label>
            <input
              v-model="managerEmail"
              type="email"
              class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-slate-900"
            />
          </div>
          <div>
            <label class="block font-medium text-slate-700">Teléfono / Extensión</label>
            <input
              v-model="managerPhone"
              type="text"
              class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-slate-900"
            />
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block font-medium text-slate-700">Nivel de SLA</label>
              <select
                v-model="slaTier"
                class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-slate-900"
              >
                <option value="standard">Standard (24h)</option>
                <option value="priority">Priority (4h)</option>
                <option value="vip">VIP (2h)</option>
                <option value="custom">Personalizado</option>
              </select>
            </div>
            <div>
              <label class="block font-medium text-slate-700">Horas respuesta</label>
              <input
                v-model.number="slaResponseHours"
                type="number"
                min="1"
                max="168"
                class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-slate-900"
              />
            </div>
          </div>
          <div>
            <label class="block font-medium text-slate-700">Motivo de asignación / cambio</label>
            <input
              v-model="assignReason"
              type="text"
              class="mt-1 block w-full rounded border border-slate-300 px-2 py-1 text-slate-900"
            />
          </div>
          <button
            type="submit"
            class="w-full rounded bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-700"
          >
            Guardar asignación de gestor
          </button>
        </form>
      </div>

      <!-- Opportunities pipeline card -->
      <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <h2 class="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">Oportunidades Comerciales</h2>

        <div v-if="opportunities.length === 0" class="text-xs text-slate-500 py-3 text-center">
          No hay oportunidades registradas para este cliente.
        </div>
        <ul v-else class="divide-y divide-slate-100 max-h-48 overflow-y-auto text-xs space-y-2">
          <li v-for="opp in opportunities" :key="opp.id" class="pt-2 first:pt-0 flex items-center justify-between">
            <div>
              <div class="font-bold text-slate-900">{{ opp.title }}</div>
              <div class="text-slate-500">
                {{ (opp.estimatedValueCents / 100).toFixed(2) }} € · {{ opp.probabilityPercent }}% prob.
              </div>
            </div>
            <span
              class="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-700"
            >
              {{ opp.stage }}
            </span>
          </li>
        </ul>

        <form class="space-y-2 text-xs pt-2 border-t border-slate-100" @submit.prevent="addOpportunity">
          <input
            v-model="oppTitle"
            type="text"
            placeholder="Título de la oportunidad"
            class="w-full rounded border border-slate-300 px-2 py-1 text-slate-900"
          />
          <div class="grid grid-cols-3 gap-2">
            <input
              v-model.number="oppValueEuros"
              type="number"
              placeholder="Valor (€)"
              class="rounded border border-slate-300 px-2 py-1 text-slate-900"
            />
            <select v-model="oppStage" class="rounded border border-slate-300 px-2 py-1 text-slate-900">
              <option value="lead">Lead</option>
              <option value="qualified">Cualificado</option>
              <option value="proposal">Propuesta</option>
              <option value="negotiation">Negociación</option>
              <option value="won">Ganada</option>
              <option value="lost">Perdida</option>
            </select>
            <input
              v-model.number="oppProbability"
              type="number"
              placeholder="Prob %"
              class="rounded border border-slate-300 px-2 py-1 text-slate-900"
            />
          </div>
          <button
            type="submit"
            class="w-full rounded bg-slate-800 px-3 py-1.5 font-semibold text-white hover:bg-slate-900"
          >
            Añadir oportunidad
          </button>
        </form>
      </div>

      <!-- Commercial internal notes card -->
      <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <h2 class="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">
          Notas comerciales internas (confidencial)
        </h2>

        <div v-if="notes.length === 0" class="text-xs text-slate-500 py-3 text-center">No hay notas registradas.</div>
        <ul v-else class="divide-y divide-slate-100 max-h-48 overflow-y-auto text-xs space-y-2">
          <li v-for="n in notes" :key="n.id" class="pt-2 first:pt-0">
            <div class="flex items-center justify-between font-bold text-slate-900">
              <span>{{ n.title }}</span>
              <span class="rounded bg-amber-50 text-amber-800 px-1.5 py-0.5 text-[10px] uppercase font-semibold">
                {{ n.category }}
              </span>
            </div>
            <p class="text-slate-600 mt-1 whitespace-pre-wrap">{{ n.content }}</p>
          </li>
        </ul>

        <form class="space-y-2 text-xs pt-2 border-t border-slate-100" @submit.prevent="addNote">
          <input
            v-model="noteTitle"
            type="text"
            placeholder="Título de la nota"
            class="w-full rounded border border-slate-300 px-2 py-1 text-slate-900"
          />
          <textarea
            v-model="noteContent"
            rows="2"
            placeholder="Contenido confidencial interno..."
            class="w-full rounded border border-slate-300 px-2 py-1 text-slate-900"
          ></textarea>
          <button
            type="submit"
            class="w-full rounded bg-slate-800 px-3 py-1.5 font-semibold text-white hover:bg-slate-900"
          >
            Guardar nota interna
          </button>
        </form>
      </div>

      <!-- Calendar interactions with consent -->
      <div class="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <h2 class="text-base font-bold text-slate-900 border-b border-slate-100 pb-2">
          Calendario de Citas (Con Permiso)
        </h2>

        <div v-if="calendarEvents.length === 0" class="text-xs text-slate-500 py-3 text-center">
          No hay reuniones programadas.
        </div>
        <ul v-else class="divide-y divide-slate-100 max-h-48 overflow-y-auto text-xs space-y-2">
          <li v-for="ev in calendarEvents" :key="ev.id" class="pt-2 first:pt-0 flex items-center justify-between">
            <div>
              <div class="font-bold text-slate-900">{{ ev.subject }}</div>
              <div class="text-slate-500">
                {{ new Date(ev.scheduledAt).toLocaleString('es-ES') }} ({{ ev.durationMinutes }} min - {{ ev.channel }})
              </div>
            </div>
            <span class="rounded bg-emerald-50 text-emerald-800 px-1.5 py-0.5 text-[10px] uppercase font-semibold">
              {{ ev.status }}
            </span>
          </li>
        </ul>

        <form class="space-y-2 text-xs pt-2 border-t border-slate-100" @submit.prevent="scheduleEvent">
          <input
            v-model="eventSubject"
            type="text"
            placeholder="Asunto de la reunión"
            class="w-full rounded border border-slate-300 px-2 py-1 text-slate-900"
          />
          <div class="grid grid-cols-2 gap-2">
            <select v-model="eventChannel" class="rounded border border-slate-300 px-2 py-1 text-slate-900">
              <option value="phone">Llamada telefónica</option>
              <option value="video">Videollamada</option>
              <option value="in_person">Visita presencial</option>
            </select>
            <input
              v-model.number="eventDuration"
              type="number"
              placeholder="Minutos"
              class="rounded border border-slate-300 px-2 py-1 text-slate-900"
            />
          </div>
          <div class="flex items-center gap-2">
            <input
              id="ev-consent"
              v-model="eventConsentVerified"
              type="checkbox"
              class="h-4 w-4 rounded border-slate-300"
            />
            <label for="ev-consent" class="text-[11px] text-slate-700"
              >Consentimiento de cita verificado con el cliente</label
            >
          </div>
          <button
            type="submit"
            :disabled="!eventConsentVerified"
            class="w-full rounded bg-slate-800 px-3 py-1.5 font-semibold text-white hover:bg-slate-900 disabled:bg-slate-300"
          >
            Agendar reunión con permiso
          </button>
        </form>
      </div>
    </div>
  </div>
</template>
