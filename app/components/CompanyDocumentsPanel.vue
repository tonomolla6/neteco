<script setup lang="ts">
import {
  COMPANY_DOCUMENT_KINDS,
  COMPANY_DOCUMENT_MAX_BYTES,
  companyDocumentListSchema,
  type CompanyDocumentList
} from '~~/shared/company-documents'
import { catalogPolicyOwnJson } from '~~/shared/catalog-publication-policy'
import { randomId } from '../utils/uuid'

const props = defineProps<{ enabled: boolean }>()
const request = useRequestFetch()
const KIND: Record<string, string> = {
  tax_certificate: 'Certificado de situación censal / NIF',
  commercial_register: 'Registro mercantil',
  authorization_letter: 'Carta de autorización',
  bank_certificate: 'Certificado bancario',
  other: 'Otro'
}
const STATUS: Record<string, string> = {
  pending: 'En revisión',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  suspended: 'Suspendida'
}
const phase = ref<'loading' | 'ready' | 'error' | 'no-company'>('loading'),
  list = shallowRef<CompanyDocumentList | null>(null),
  message = ref(''),
  busy = ref(false),
  kind = ref<(typeof COMPANY_DOCUMENT_KINDS)[number]>('tax_certificate'),
  file = shallowRef<File | null>(null)
const code = (cause: unknown) =>
  (cause as { data?: { error?: { code?: string } }; statusCode?: number })?.data?.error?.code
async function load() {
  if (!props.enabled) return
  phase.value = 'loading'
  try {
    list.value = companyDocumentListSchema.parse(
      catalogPolicyOwnJson(
        await request<unknown>('/api/account/company/documents', { method: 'GET', retry: 0, cache: 'no-store' })
      )
    )
    phase.value = 'ready'
  } catch (cause) {
    list.value = null
    phase.value = code(cause) === 'not_found' ? 'no-company' : 'error'
  }
}
async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function pick(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
}
async function add() {
  const chosen = file.value
  if (!chosen || busy.value) return
  if (chosen.size > COMPANY_DOCUMENT_MAX_BYTES) {
    message.value = 'El archivo supera los 10 MB.'
    return
  }
  busy.value = true
  message.value = ''
  try {
    await request<unknown>('/api/account/company/documents', {
      method: 'POST',
      body: {
        kind: kind.value,
        fileName: chosen.name,
        contentType: chosen.type,
        sizeBytes: chosen.size,
        sha256: await sha256(chosen)
      },
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomId() },
      retry: 0
    })
    file.value = null
    await load()
    message.value = 'Documento registrado.'
  } catch (cause) {
    const c = code(cause)
    message.value =
      c === 'limit_reached'
        ? 'Has alcanzado el máximo de 5 documentos. Elimina uno para añadir otro.'
        : c === 'locked'
          ? 'Tu cuenta profesional ya está aprobada: no se pueden añadir documentos.'
          : c === 'conflict'
            ? 'Ese archivo ya está registrado.'
            : c === 'invalid_input'
              ? 'Sólo se admiten PDF, JPG o PNG de hasta 10 MB.'
              : 'No se ha podido registrar el documento.'
  } finally {
    busy.value = false
  }
}
async function remove(id: string) {
  if (busy.value) return
  busy.value = true
  message.value = ''
  try {
    await request<unknown>(`/api/account/company/documents/${id}`, { method: 'DELETE', retry: 0 })
    await load()
    message.value = 'Documento retirado.'
  } catch {
    message.value = 'No se ha podido retirar el documento.'
  } finally {
    busy.value = false
  }
}
watch(() => props.enabled, load, { immediate: true })
</script>

<template>
  <section class="min-w-0 space-y-4 break-words" aria-labelledby="cd-title">
    <h2 id="cd-title" class="text-lg font-bold">Documentos de tu cuenta profesional</h2>
    <p>Son opcionales: puedes solicitar la cuenta sin adjuntar nada. Ayudan a agilizar la revisión.</p>
    <p v-if="!enabled">Necesitas una sesión de cuenta vigente y el email verificado.</p>
    <p v-if="phase === 'loading' && enabled" role="status">Cargando documentos…</p>
    <p v-if="phase === 'no-company'" data-cd-no-company>Aún no has solicitado una cuenta profesional.</p>
    <div v-if="phase === 'error'" role="alert">
      No se han podido leer tus documentos.
      <button data-cd-retry type="button" class="underline" @click="load">Volver a consultar</button>
    </div>
    <p v-if="message" data-cd-message role="status">{{ message }}</p>
    <template v-if="list && enabled">
      <p data-cd-status>Estado de la solicitud: {{ STATUS[list.companyStatus] }}</p>
      <p v-if="!list.documents.length" data-cd-empty>No has adjuntado documentos.</p>
      <ul v-else class="divide-y">
        <li
          v-for="doc in list.documents"
          :key="doc.id"
          class="flex items-center justify-between gap-3 py-2"
          data-cd-doc
        >
          <span>{{ KIND[doc.kind] }} · {{ doc.fileName }} ({{ Math.ceil(doc.sizeBytes / 1024) }} KB)</span>
          <button data-cd-remove type="button" class="underline" :disabled="busy" @click="remove(doc.id)">
            Retirar
          </button>
        </li>
      </ul>
      <form v-if="list.companyStatus !== 'approved'" class="space-y-3" @submit.prevent="add">
        <label class="block"
          >Tipo de documento
          <select v-model="kind" data-cd-kind class="block border px-2 py-1">
            <option v-for="k in COMPANY_DOCUMENT_KINDS" :key="k" :value="k">{{ KIND[k] }}</option>
          </select>
        </label>
        <label class="block"
          >Archivo (PDF, JPG o PNG, máximo 10 MB)
          <input data-cd-file type="file" accept="application/pdf,image/jpeg,image/png" @change="pick" />
        </label>
        <p class="text-sm">
          Por ahora sólo se registran el nombre, el tipo, el tamaño y la huella SHA-256 del documento; el archivo no se
          sube desde esta página.
        </p>
        <button
          data-cd-add
          type="submit"
          class="rounded border px-4 py-2"
          :disabled="busy || !file || list.documents.length >= list.limit"
        >
          Registrar documento
        </button>
      </form>
    </template>
  </section>
</template>
