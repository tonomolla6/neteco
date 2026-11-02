<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { EventItemView, EventQuestionView } from '~~/shared/events'

const props = defineProps<{
  event: EventItemView
}>()

const requestFetch = useRequestFetch()

const attendeeName = ref('')
const attendeeEmail = ref('')
const attendeePhone = ref('')
const consentEmail = ref(true)
const consentSms = ref(false)
const consentFollowup = ref(true)

const registering = ref(false)
const registered = ref(false)
const regError = ref<string | null>(null)

// Q&A state
const questions = ref<EventQuestionView[]>([])
const loadingQuestions = ref(false)
const newQuestionText = ref('')
const questionAuthor = ref('')
const submittingQuestion = ref(false)
const questionSubmitted = ref(false)

const typeLabels: Record<string, string> = {
  webinar: 'Webinar Técnico',
  demo: 'Demostración Práctica',
  local_event: 'Evento Presencial'
}

const sectorLabels: Record<string, string> = {
  hosteleria: 'Hostelería',
  automocion: 'Automoción',
  sanitario: 'Sanitario',
  industrial: 'Industrial',
  oficinas: 'Oficinas',
  colectividades: 'Colectividades',
  general: 'General'
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString('es-ES', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return iso
  }
}

async function loadQuestions() {
  loadingQuestions.value = true
  try {
    const res = (await requestFetch(`/api/events/${props.event.slug}/questions`)) as { questions: EventQuestionView[] }
    questions.value = res.questions
  } catch {
    // optional questions
  } finally {
    loadingQuestions.value = false
  }
}

async function handleRegister() {
  registering.value = true
  regError.value = null
  try {
    await requestFetch(`/api/events/${props.event.slug}/register`, {
      method: 'POST',
      body: {
        attendeeName: attendeeName.value,
        attendeeEmail: attendeeEmail.value,
        attendeePhone: attendeePhone.value || undefined,
        consentEmailReminder: consentEmail.value,
        consentSmsReminder: consentSms.value,
        consentFollowup: consentFollowup.value,
        consentTermsVersion: 'event-terms-2026-v1'
      }
    })
    registered.value = true
  } catch {
    regError.value = 'No se pudo completar el registro. Comprueba los datos o el aforo.'
  } finally {
    registering.value = false
  }
}

async function handleSendQuestion() {
  if (!newQuestionText.value.trim() || !questionAuthor.value.trim()) return
  submittingQuestion.value = true
  try {
    await requestFetch(`/api/events/${props.event.slug}/questions`, {
      method: 'POST',
      body: {
        authorName: questionAuthor.value,
        questionText: newQuestionText.value
      }
    })
    questionSubmitted.value = true
    newQuestionText.value = ''
    await loadQuestions()
  } catch {
    // error handling
  } finally {
    submittingQuestion.value = false
  }
}

onMounted(() => {
  loadQuestions()
})
</script>

<template>
  <div class="event-card border rounded-lg p-6 bg-white shadow-sm space-y-6">
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-2 border-b pb-4">
      <div class="flex items-center gap-2">
        <span class="bg-indigo-100 text-indigo-800 text-xs px-2.5 py-0.5 rounded-full font-semibold">
          {{ typeLabels[event.type] || event.type }}
        </span>
        <span class="bg-gray-100 text-gray-700 text-xs px-2.5 py-0.5 rounded-full font-medium">
          {{ sectorLabels[event.sector] || event.sector }}
        </span>
      </div>

      <div class="text-xs font-semibold text-gray-600">
        {{ event.currentAttendeesCount }} / {{ event.maxAttendees }} plazas
      </div>
    </div>

    <!-- Title and details -->
    <div>
      <h2 class="text-xl font-bold text-gray-900 mb-2">{{ event.title }}</h2>
      <p class="text-gray-600 text-sm mb-4">{{ event.description }}</p>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-gray-600 bg-gray-50 p-3 rounded">
        <div><strong class="text-gray-800">Fecha y hora:</strong> {{ formatDate(event.scheduledAt) }}</div>
        <div><strong class="text-gray-800">Duración:</strong> {{ event.durationMinutes }} minutos</div>
        <div class="sm:col-span-2">
          <strong class="text-gray-800">Ubicación / Enlace:</strong>
          <span v-if="event.locationType === 'online'" class="text-blue-600 underline ml-1">{{
            event.locationDetails
          }}</span>
          <span v-else class="ml-1">{{ event.locationDetails }}</span>
        </div>
      </div>
    </div>

    <!-- Completed Event: Recording & Subtitles Player -->
    <div v-if="event.status === 'completed' && event.recordingUrl" class="border rounded p-4 bg-gray-50 space-y-3">
      <h3 class="text-sm font-bold text-gray-900 flex items-center gap-2">
        <span class="w-2.5 h-2.5 rounded-full bg-green-500 inline-block"></span>
        Grabación disponible
      </h3>

      <div class="aspect-video bg-black rounded overflow-hidden">
        <video controls class="w-full h-full" :src="event.recordingUrl">
          <track
            v-if="event.subtitlesUrl"
            label="Español"
            kind="subtitles"
            srclang="es"
            :src="event.subtitlesUrl"
            default
          />
          Tu navegador no soporta el reproductor de vídeo.
        </video>
      </div>

      <div v-if="event.subtitlesUrl" class="text-xs text-gray-600 flex justify-between items-center">
        <span>Subtítulos en español sincronizados (normativa accesibilidad).</span>
        <a
          :href="event.subtitlesUrl"
          data-testid="subtitles-link"
          target="_blank"
          download
          class="text-blue-600 hover:underline font-medium"
        >
          Descargar subtítulos (.vtt)
        </a>
      </div>
    </div>

    <!-- Registration Form (Scheduled Events) -->
    <div v-else-if="event.status === 'scheduled' || event.status === 'live'" class="border-t pt-4 space-y-4">
      <h3 class="text-sm font-bold text-gray-900">Inscripción al Evento</h3>

      <div v-if="registered" class="bg-green-50 text-green-800 p-3 rounded text-sm font-medium">
        ¡Inscripción confirmada! Te enviaremos los accesos y recordatorios según tus preferencias.
      </div>

      <form v-else class="space-y-3" @submit.prevent="handleRegister">
        <div v-if="regError" class="bg-red-50 text-red-700 p-2 text-xs rounded">
          {{ regError }}
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div>
            <label class="block text-xs font-medium text-gray-700 mb-1">Nombre completo / Cargo</label>
            <input
              v-model="attendeeName"
              type="text"
              required
              class="w-full border rounded px-3 py-1.5 text-sm"
              placeholder="Ej. Carmen Ortiz (Jefe de Cocina)"
            />
          </div>

          <div>
            <label class="block text-xs font-medium text-gray-700 mb-1">Correo electrónico</label>
            <input
              v-model="attendeeEmail"
              type="email"
              required
              class="w-full border rounded px-3 py-1.5 text-sm"
              placeholder="ejemplo@empresa.es"
            />
          </div>

          <div class="sm:col-span-2">
            <label class="block text-xs font-medium text-gray-700 mb-1"
              >Teléfono móvil (opcional para recordatorios SMS)</label
            >
            <input
              v-model="attendeePhone"
              type="tel"
              class="w-full border rounded px-3 py-1.5 text-sm"
              placeholder="+34 600 000 000"
            />
          </div>
        </div>

        <!-- Channel-specific Consents -->
        <div class="bg-gray-50 p-3 rounded space-y-2 text-xs text-gray-700">
          <p class="font-semibold text-gray-800 mb-1">Consentimientos por canal de comunicación:</p>
          <div class="flex items-center gap-2">
            <input
              id="consent-email"
              v-model="consentEmail"
              data-testid="consent-email"
              type="checkbox"
              class="rounded text-blue-600 focus:ring-blue-500 h-4 w-4"
            />
            <label for="consent-email">Recordatorio por email (24 horas y 1 hora antes de la sesión)</label>
          </div>

          <div class="flex items-center gap-2">
            <input
              id="consent-sms"
              v-model="consentSms"
              data-testid="consent-sms"
              type="checkbox"
              class="rounded text-blue-600 focus:ring-blue-500 h-4 w-4"
            />
            <label for="consent-sms">Recordatorio por SMS de última hora</label>
          </div>

          <div class="flex items-center gap-2">
            <input
              id="consent-followup"
              v-model="consentFollowup"
              data-testid="consent-followup"
              type="checkbox"
              class="rounded text-blue-600 focus:ring-blue-500 h-4 w-4"
            />
            <label for="consent-followup"
              >Material y seguimiento post-evento (grabación, ficha técnica de productos y dosificaciones)</label
            >
          </div>
        </div>

        <button
          type="submit"
          class="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-6 rounded text-sm transition disabled:opacity-50"
          :disabled="registering || event.currentAttendeesCount >= event.maxAttendees"
        >
          {{ registering ? 'Registrando...' : 'Reservar mi plaza' }}
        </button>
      </form>
    </div>

    <!-- Questions & Answers Section -->
    <div class="border-t pt-4 space-y-4">
      <h3 class="text-sm font-bold text-gray-900">Preguntas y Respuestas Técnicas</h3>

      <div v-if="questions.length > 0" class="space-y-3">
        <div v-for="q in questions" :key="q.id" class="bg-gray-50 border rounded p-3 text-xs space-y-1.5">
          <div class="flex justify-between text-gray-500 font-medium">
            <span>{{ q.authorName }}</span>
            <span>{{ formatDate(q.createdAt) }}</span>
          </div>
          <p class="text-gray-800 font-semibold text-sm">{{ q.questionText }}</p>

          <div v-if="q.answerText" class="mt-2 pl-3 border-l-2 border-blue-500 text-blue-950 bg-blue-50/50 p-2 rounded">
            <p class="font-bold text-xs text-blue-800">Respuesta técnica Neteco:</p>
            <p class="text-xs mt-0.5">{{ q.answerText }}</p>
          </div>
        </div>
      </div>

      <div v-else class="text-xs text-gray-500 italic">Aún no hay preguntas formuladas para esta sesión.</div>

      <!-- Question input form -->
      <form class="space-y-2 pt-2 border-t" @submit.prevent="handleSendQuestion">
        <div v-if="questionSubmitted" class="bg-green-50 text-green-700 p-2 text-xs rounded">
          Pregunta enviada. El ponente o moderador responderá a la mayor brevedad.
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            v-model="questionAuthor"
            type="text"
            required
            placeholder="Tu nombre / empresa"
            class="border rounded px-2.5 py-1 text-xs"
          />
          <input
            v-model="newQuestionText"
            type="text"
            required
            placeholder="Escribe tu consulta técnica sobre el temario..."
            class="sm:col-span-2 border rounded px-2.5 py-1 text-xs"
          />
        </div>
        <button
          type="submit"
          class="text-xs bg-gray-100 hover:bg-gray-200 text-gray-800 font-semibold px-3 py-1.5 rounded transition disabled:opacity-50"
          :disabled="submittingQuestion"
        >
          Enviar consulta
        </button>
      </form>
    </div>
  </div>
</template>
