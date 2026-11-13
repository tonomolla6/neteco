<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Medios · Admin' })

/**
 * Biblioteca de medios.
 *
 * Antes: un formulario de subida de seis campos permanentemente desplegado por encima de
 * la tabla, aunque no fueras a subir nada, y una tabla de 1.050 px de ancho mínimo cuyos
 * estados se mostraban crudos («AV: clean», «Derechos: pending»). Aprobar o bloquear un
 * asset pedía el motivo con `window.prompt()`, siendo una decisión de derechos de imagen
 * que queda registrada.
 *
 * Análisis y revisión de derechos son independientes: publicar exige ambos
 * vigentes, además de una asociación explícita al producto.
 */
interface MediaAsset {
  id: string
  originalName: string
  mimeType: string
  bytes: number
  width: number | null
  height: number | null
  ownerName: string | null
  license: string | null
  authorizedAt: string | null
  rightsStatus: string
  quarantineStatus: string
  altText: string | null
  sourceUrl: string | null
  createdAt: string
  canApprove?: boolean
  rightsVersion?: number
  canPublish?: boolean
  publications?: Array<{
    id: string
    title: string
    role: string
    version: string
    status: 'active' | 'withdrawn'
    publicationVersion: number
  }>
}

const {
  data,
  refresh,
  status: fetchStatus
} = await useFetch<{
  items: MediaAsset[]
  capabilities?: { canUpload?: boolean; canApprove?: boolean; canPublish?: boolean }
}>('/api/admin/media')
const toast = useToast()
const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
const publicationAsset = ref<MediaAsset | null>(null)
const canDecide = computed(() => !cloudflare || data.value?.capabilities?.canApprove === true)
const canWithdraw = computed(() => cloudflare && data.value?.capabilities?.canPublish === true)

const QUARANTINE: Record<string, { label: string; color: 'success' | 'warning' | 'error' | 'neutral' }> = {
  clean: { label: 'Analizado', color: 'success' },
  pending: { label: 'Pendiente de análisis', color: 'warning' },
  scanning: { label: 'Analizando', color: 'warning' },
  infected: { label: 'Infectado', color: 'error' },
  failed: { label: 'Análisis fallido', color: 'error' }
}
const RIGHTS: Record<string, { label: string; color: 'success' | 'warning' | 'error' | 'neutral' }> = {
  pending: { label: 'Derechos por revisar', color: 'warning' },
  approved: { label: 'Derechos aprobados', color: 'success' },
  blocked: { label: 'Bloqueado', color: 'error' },
  rejected: { label: 'Bloqueado', color: 'error' }
}

const TONES = { success: 'success', warning: 'warning', error: 'danger', neutral: 'neutral' } as const
const USES: Record<string, string> = {
  main: 'Imagen principal',
  image: 'Imagen adicional',
  datasheet: 'Ficha técnica',
  sds: 'Ficha de seguridad',
  certificate: 'Certificado',
  label: 'Etiqueta'
}

const query = ref('')
const rows = computed(() => {
  const term = query.value.toLowerCase()
  return (data.value?.items ?? []).filter(
    (item) =>
      !term ||
      item.originalName.toLowerCase().includes(term) ||
      (item.ownerName ?? '').toLowerCase().includes(term) ||
      (item.altText ?? '').toLowerCase().includes(term)
  )
})
const rightsFilter = ref('all')
const rightsOptions = [
  { value: 'all', label: 'Todos' },
  { value: 'pending', label: 'Por revisar' },
  { value: 'approved', label: 'Aprobados' },
  { value: 'blocked', label: 'Bloqueados' }
]
const visibleRows = computed(() =>
  rows.value.filter(
    (item) =>
      rightsFilter.value === 'all' ||
      (rightsFilter.value === 'blocked'
        ? item.rightsStatus === 'blocked' || item.rightsStatus === 'rejected'
        : item.rightsStatus === rightsFilter.value)
  )
)
const page = ref(1)
watch([query, rightsFilter], () => (page.value = 1))
const awaitingReview = computed(
  () => (data.value?.items ?? []).filter((item) => item.rightsStatus === 'pending' && item.canApprove !== false).length
)

const columns = [
  { key: 'originalName', label: 'Archivo' },
  { key: 'ownerName', label: 'Propietario y licencia' },
  { key: 'quarantineStatus', label: 'Estado' },
  { key: 'sourceUrl', label: cloudflare ? 'Usado en' : 'Enlace público', hideOnMobile: !cloudflare }
]

/* --- Subida --- */
const uploading = ref(false)
const uploadOpen = ref(false)
const form = reactive({ ownerName: '', license: '', authorizedAt: '', altText: '', source: '' })
const file = ref<File | null>(null)

function choose(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

async function upload() {
  if (!file.value || uploading.value || (cloudflare && data.value?.capabilities?.canUpload !== true)) return
  const body = new FormData()
  body.append('file', file.value)
  body.append('ownerName', form.ownerName)
  body.append('license', form.license)
  body.append('authorizedAt', form.authorizedAt)
  body.append('altText', form.altText)
  if (form.source.trim()) body.append('source', form.source.trim())
  uploading.value = true
  try {
    const result = await $fetch<{ quarantineStatus: string }>('/api/admin/media', { method: 'POST', body })
    toast.add({
      title:
        result.quarantineStatus === 'clean'
          ? 'Subido y analizado. Queda aprobar los derechos para poder publicarlo.'
          : 'Subido a cuarentena. No se puede publicar hasta que pase el análisis.',
      color: result.quarantineStatus === 'clean' ? 'success' : 'warning'
    })
    file.value = null
    Object.assign(form, { ownerName: '', license: '', authorizedAt: '', altText: '', source: '' })
    uploadOpen.value = false
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido subir'), color: 'error' })
  } finally {
    uploading.value = false
  }
}

/* --- Decisión de derechos --- */
const deciding = ref<{ item: MediaAsset; decision: 'approve' | 'reject' } | null>(null)
const reason = ref('')
const saving = ref(false)
const decisionCommand = ref<{ payload: string; key: string } | null>(null)

async function confirmDecision() {
  const target = deciding.value
  if (
    !target ||
    saving.value ||
    !canDecide.value ||
    reason.value.trim().length < 3 ||
    (cloudflare && target.decision === 'approve' && target.item.canApprove !== true)
  )
    return
  const payload = JSON.stringify([target.item.id, target.decision, reason.value.trim(), target.item.rightsVersion])
  if (decisionCommand.value?.payload !== payload) decisionCommand.value = { payload, key: crypto.randomUUID() }
  saving.value = true
  try {
    await $fetch(`/api/admin/media/${target.item.id}`, {
      method: 'PUT',
      body: { decision: target.decision, reason: reason.value.trim() },
      headers: {
        'Idempotency-Key': decisionCommand.value.key,
        ...(target.item.rightsVersion !== undefined ? { 'If-Match': String(target.item.rightsVersion) } : {})
      }
    })
    toast.add({
      title:
        target.decision === 'approve' ? 'Derechos aprobados; la publicación es independiente' : 'Archivo bloqueado',
      color: 'success',
      icon: 'i-lucide-check'
    })
    deciding.value = null
    reason.value = ''
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido aplicar la decisión'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function copy(value: string) {
  await navigator.clipboard.writeText(value)
  toast.add({ title: 'Ruta copiada', color: 'success', icon: 'i-lucide-clipboard-check' })
}

const withdrawal = ref<{ asset: MediaAsset; publication: NonNullable<MediaAsset['publications']>[number] } | null>(null)
const withdrawalReason = ref('')
const withdrawing = ref(false)
const withdrawalCommand = ref<{ payload: string; key: string } | null>(null)

async function withdraw() {
  const target = withdrawal.value
  if (!target || !canWithdraw.value || withdrawing.value || withdrawalReason.value.trim().length < 3) return
  const reason = withdrawalReason.value.trim()
  const payload = JSON.stringify([target.publication.id, reason, target.publication.publicationVersion])
  if (withdrawalCommand.value?.payload !== payload) withdrawalCommand.value = { payload, key: crypto.randomUUID() }
  withdrawing.value = true
  try {
    // This explicit publication route is implemented by the Cloudflare ingress.
    const endpoint: string = `/api/admin/media/publications/${target.publication.id}`
    await $fetch(endpoint, {
      method: 'DELETE',
      body: { reason },
      headers: {
        'Idempotency-Key': withdrawalCommand.value.key,
        'If-Match': String(target.publication.publicationVersion)
      }
    })
    withdrawal.value = null
    withdrawalReason.value = ''
    toast.add({ title: 'Asociación retirada; se conserva su historial', color: 'success' })
    await refresh()
  } catch (error) {
    toast.add({ title: apiErrorMessage(error, 'No se ha podido retirar la asociación'), color: 'error' })
  } finally {
    withdrawing.value = false
  }
}

async function publicationCreated() {
  toast.add({
    title: 'Asociación creada; la entrega sigue sujeta a las comprobaciones de publicación',
    color: 'success'
  })
  await refresh()
}

function kib(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`
}
</script>

<template>
  <AdminPage :count="rows.length" :count-label="rows.length === 1 ? 'archivo' : 'archivos'">
    <template #actions>
      <AdminButton
        variant="primary"
        icon="i-lucide-upload"
        :disabled="cloudflare && data?.capabilities?.canUpload !== true"
        @click="uploadOpen = true"
      >
        Subir archivo
      </AdminButton>
    </template>
    <div class="adm-stack">
      <UAlert
        v-if="awaitingReview"
        color="warning"
        variant="subtle"
        icon="i-lucide-shield-question"
        :title="`${awaitingReview} ${awaitingReview === 1 ? 'archivo espera' : 'archivos esperan'} la aprobación de derechos`"
        description="Revisa la autorización de cada uno. Aprobar los derechos no publica el archivo por sí solo."
      />

      <AdminTable
        v-model:page="page"
        :rows="visibleRows"
        :columns="columns"
        :row-key="(row) => row.id"
        :status="fetchStatus === 'pending' ? 'pending' : fetchStatus === 'error' ? 'error' : 'idle'"
        :filtered="Boolean(query) || rightsFilter !== 'all'"
        empty-title="La biblioteca está vacía"
        empty-description="Sube las fotos de producto y las fichas de seguridad. Cada archivo necesita propietario, licencia y fecha de autorización antes de poder publicarse."
        empty-icon="i-lucide-image"
        error-message="No hemos podido cargar la biblioteca."
        caption="Archivos de la biblioteca"
        @retry="refresh()"
        @clear-filters="((query = ''), (rightsFilter = 'all'))"
      >
        <template #toolbar>
          <AdminToolbar
            v-model:search="query"
            placeholder="Buscar por nombre, propietario o descripción"
            search-label="Buscar en la biblioteca"
          >
            <AdminFilters v-model="rightsFilter" :options="rightsOptions" label="Filtrar por derechos" />
          </AdminToolbar>
        </template>

        <template #empty-action>
          <AdminButton
            variant="primary"
            icon="i-lucide-upload"
            :disabled="cloudflare && data?.capabilities?.canUpload !== true"
            @click="uploadOpen = true"
          >
            Subir el primer archivo
          </AdminButton>
        </template>

        <template #cell-originalName="{ row }">
          <p class="max-w-xs truncate font-medium text-[var(--text-strong)]">{{ row.originalName }}</p>
          <p class="text-xs text-[var(--text-muted)]">
            {{ row.mimeType.replace('image/', '').replace('application/', '').toUpperCase() }} · {{ kib(row.bytes) }}
            <template v-if="row.width"> · {{ row.width }}×{{ row.height }}</template>
          </p>
          <p class="max-w-xs truncate text-xs text-[var(--text-muted)]">
            {{ row.altText || 'Sin texto alternativo' }}
          </p>
        </template>

        <template #cell-ownerName="{ row }">
          <p>{{ row.ownerName || '—' }}</p>
          <p class="text-xs text-[var(--text-muted)]">
            {{ row.license || 'Sin licencia' }} ·
            {{ row.authorizedAt ? adminDate(row.authorizedAt) : 'sin fecha' }}
          </p>
        </template>

        <template #cell-quarantineStatus="{ row }">
          <div class="flex flex-col items-start gap-1">
            <AdminBadge :tone="TONES[(QUARANTINE[row.quarantineStatus] ?? { color: 'neutral' as const }).color]">
              {{ QUARANTINE[row.quarantineStatus]?.label ?? adminStatusLabel(row.quarantineStatus) }}
            </AdminBadge>
            <AdminBadge :tone="TONES[(RIGHTS[row.rightsStatus] ?? { color: 'neutral' as const }).color]">
              {{ RIGHTS[row.rightsStatus]?.label ?? adminStatusLabel(row.rightsStatus) }}
            </AdminBadge>
          </div>
        </template>

        <template #cell-sourceUrl="{ row }">
          <ul v-if="cloudflare && row.publications?.length" class="space-y-2 text-xs">
            <li v-for="publication in row.publications" :key="publication.id">
              <p class="max-w-xs break-words">
                {{ publication.title }} · {{ USES[publication.role] ?? adminHumanize(publication.role) }} · versión
                {{ publication.version }}
              </p>
              <div class="mt-0.5 flex flex-wrap items-center gap-2">
                <AdminBadge :tone="publication.status === 'withdrawn' ? 'neutral' : 'success'">{{
                  publication.status === 'withdrawn' ? 'Retirada' : 'En uso'
                }}</AdminBadge>
                <AdminButton
                  v-if="publication.status === 'active' && canWithdraw"
                  variant="danger-soft"
                  size="sm"
                  @click="((withdrawal = { asset: row, publication }), (withdrawalReason = ''))"
                >
                  Retirar
                </AdminButton>
              </div>
            </li>
          </ul>
          <AdminButton
            v-else-if="!cloudflare && row.sourceUrl"
            variant="ghost"
            size="sm"
            icon="i-lucide-copy"
            @click="copy(row.sourceUrl)"
          >
            Copiar enlace
          </AdminButton>
          <span v-else class="text-xs text-[var(--text-muted)]">Sin usar en ningún producto</span>
        </template>

        <template #actions="{ row }">
          <div class="flex flex-wrap justify-end gap-1">
            <AdminButton
              v-if="cloudflare"
              size="sm"
              :disabled="!canWithdraw || row.canPublish !== true"
              @click="canWithdraw && row.canPublish === true && (publicationAsset = row)"
            >
              Asociar
            </AdminButton>
            <AdminButton
              v-if="row.rightsStatus !== 'approved' && canDecide"
              size="sm"
              :disabled="
                cloudflare
                  ? row.canApprove !== true
                  : row.canApprove === undefined
                    ? row.quarantineStatus !== 'clean'
                    : !row.canApprove
              "
              :title="
                row.canApprove === undefined && row.quarantineStatus !== 'clean'
                  ? 'Primero tiene que pasar el análisis de seguridad'
                  : undefined
              "
              @click="((deciding = { item: row, decision: 'approve' }), (reason = ''))"
            >
              Aprobar
            </AdminButton>
            <AdminButton
              v-if="canDecide && row.rightsStatus !== 'blocked' && row.rightsStatus !== 'rejected'"
              variant="danger-soft"
              size="sm"
              @click="((deciding = { item: row, decision: 'reject' }), (reason = ''))"
            >
              Bloquear
            </AdminButton>
          </div>
        </template>
      </AdminTable>

      <MediaPublicationDialog
        v-if="publicationAsset && canWithdraw"
        :asset="publicationAsset"
        @close="publicationAsset = null"
        @published="publicationCreated"
      />

      <!-- Retirar asociación -->
      <AdminConfirm
        :open="Boolean(withdrawal)"
        title="Retirar asociación"
        confirm-label="Retirar asociación"
        danger
        :loading="withdrawing"
        @update:open="(open) => !open && !withdrawing && (withdrawal = null)"
        @confirm="withdraw"
      >
        <div class="adm-stack">
          <p>
            Retira «{{ withdrawal?.publication.title }}» sin borrar el archivo ni el historial. El resto de asociaciones
            no cambia.
          </p>
          <AdminFormField
            v-slot="{ id }"
            label="Motivo de retirada"
            required
            help="Al menos 3 caracteres. Queda anotado en el historial."
          >
            <textarea :id="id" v-model="withdrawalReason" maxlength="500" rows="3" class="adm-input" />
          </AdminFormField>
        </div>
      </AdminConfirm>

      <!-- Subida -->
      <AdminDrawer v-model:open="uploadOpen" title="Subir archivo">
        <form id="media-form" class="adm-stack" @submit.prevent="upload">
          <AdminFormField v-slot="{ id }" label="Archivo" required help="JPEG, PNG o PDF">
            <input
              :id="id"
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              required
              class="block w-full text-sm file:mr-3 file:rounded-[var(--radius-control)] file:border-0 file:bg-[var(--surface-sunken)] file:px-3 file:py-1.5 file:text-sm"
              @change="choose"
            />
          </AdminFormField>
          <div class="adm-form-grid">
            <AdminFormField
              v-slot="{ id }"
              label="Propietario o licenciante"
              required
              help="De quién es la imagen"
              data-field="Propietario o licenciante"
            >
              <input :id="id" v-model="form.ownerName" type="text" required />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Licencia o autorización"
              required
              data-field="Licencia o autorización"
            >
              <input
                :id="id"
                v-model="form.license"
                type="text"
                required
                placeholder="Cesión del proveedor, banco, propia…"
              />
            </AdminFormField>
            <AdminFormField v-slot="{ id }" label="Fecha de autorización" required data-field="Fecha de autorización">
              <input :id="id" v-model="form.authorizedAt" type="date" required />
            </AdminFormField>
            <AdminFormField
              v-slot="{ id }"
              label="Texto alternativo"
              help="Describe la imagen. Obligatorio en imágenes."
              data-field="Texto alternativo"
            >
              <input :id="id" v-model="form.altText" type="text" />
            </AdminFormField>
          </div>
          <AdminFormField
            v-slot="{ id }"
            label="Referencia de autorización"
            :required="cloudflare"
            help="Documento, enlace o número de contrato que acredita la licencia."
            data-field="Referencia de autorización"
          >
            <input :id="id" v-model="form.source" type="text" :required="cloudflare" maxlength="1000" />
          </AdminFormField>
          <p class="adm-help">
            El archivo se analiza al subirlo. Para que se vea en la tienda hacen falta el análisis de seguridad
            superado, los derechos aprobados y asociarlo a un producto. Subirlo no lo publica.
          </p>
        </form>
        <template #footer>
          <AdminButton @click="uploadOpen = false">Cancelar</AdminButton>
          <AdminButton variant="primary" type="submit" form="media-form" :loading="uploading" icon="i-lucide-upload">
            Subir
          </AdminButton>
        </template>
      </AdminDrawer>

      <!-- Decisión de derechos -->
      <AdminConfirm
        :open="Boolean(deciding)"
        :title="deciding?.decision === 'approve' ? 'Aprobar los derechos' : 'Bloquear el archivo'"
        :confirm-label="deciding?.decision === 'approve' ? 'Aprobar' : 'Bloquear'"
        :danger="deciding?.decision === 'reject'"
        :loading="saving"
        @update:open="(value) => !value && (deciding = null)"
        @confirm="confirmDecision"
      >
        <div v-if="deciding" class="adm-stack">
          <p>
            <strong>{{ deciding.item.originalName }}</strong>
            <template v-if="deciding.item.ownerName"> · {{ deciding.item.ownerName }}</template>
          </p>
          <p class="adm-help">
            <template v-if="deciding.decision === 'approve'">
              Aprobar los derechos no publica el archivo: siguen haciendo falta el análisis de seguridad superado y
              asociarlo a un producto. Confirma que has revisado la autorización.
            </template>
            <template v-else>Quedará bloqueado y no podrá usarse en ninguna parte.</template>
          </p>
          <AdminFormField
            v-slot="{ id }"
            label="Motivo"
            required
            help="Al menos 3 caracteres. Queda anotado en el historial."
            :error="reason.trim().length && reason.trim().length < 3 ? 'Al menos 3 caracteres.' : undefined"
          >
            <textarea
              :id="id"
              v-model="reason"
              rows="2"
              class="adm-input"
              :placeholder="
                deciding.decision === 'approve'
                  ? 'Contrato de cesión verificado con el proveedor'
                  : 'Sin autorización del titular'
              "
            />
          </AdminFormField>
        </div>
      </AdminConfirm>
    </div>
  </AdminPage>
</template>
