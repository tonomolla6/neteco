<script setup lang="ts">
import type { AccountProfile, Address } from '~/composables/useAccount'
import { z } from 'zod'
import type { AddressInput } from '~~/server/domain/customer'
import { validateCloudflareCustomerAddress } from '~~/shared/customer-tax-validation'

definePageMeta({ middleware: 'auth', layout: 'cuenta' })
useSeoMeta({ title: 'Mis direcciones', robots: 'noindex, nofollow' })

/**
 * Agenda de direcciones.
 *
 * Antes el formulario de alta —catorce campos— estaba permanentemente desplegado
 * bajo la lista, incluso con la agenda vacía y aunque el cliente no quisiera añadir
 * ninguna. Ahora es un diálogo que se abre a demanda, y la lista es lo que se ve.
 *
 * Se expone además la edición, que ya existía en el servidor
 * (`PUT /api/account/addresses/[id]`) sin que ninguna pantalla la ofreciera: la
 * única acción disponible en cada dirección era borrarla.
 */
const cloudflare = useRuntimeConfig().public.serverRuntime === 'cloudflare'
const { user, session, loggedIn } = useUserSession()
const scope = computed(() =>
  JSON.stringify([
    loggedIn.value,
    user.value?.id,
    user.value?.emailVerified,
    session.value?.sessionId,
    session.value?.sessionVersion
  ])
)
const originalScope = scope.value
const revoked = ref(false)
let active = true
let generation = 0
let controller: AbortController | null = null
const text = z.string().max(4096)
const addressReadSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['shipping', 'billing', 'both']),
    label: text,
    recipientName: text,
    companyName: text.nullable(),
    taxId: text.nullable(),
    line1: text,
    line2: text.nullable(),
    postalCode: text,
    city: text,
    region: text,
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    phone: text.nullable(),
    instructions: text.nullable(),
    isDefault: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict()
const agendaSchema = z
  .object({ addresses: z.array(addressReadSchema).max(50) })
  .strict()
  .refine(({ addresses }) => new Set(addresses.map((address) => address.id)).size === addresses.length)
const seedSchema = z.object({
  profile: z.object({
    name: text.nullable(),
    company: text.nullable(),
    taxId: text.nullable(),
    phone: text.nullable()
  })
})
const { data: accountData } = await useFetch<{ profile: AccountProfile } | null>('/api/account')
const { data, refresh, status } = await useFetch<{ addresses: Address[] }>('/api/account/addresses')
const { notice, errorMessage, busy, run, showNotice } = useAccountFeedback()

const retryingRead = ref(false)
const failedRead = ref(false)
const uncertain = ref(false)
const reviewed = ref(false)
type Intent = {
  method: 'POST' | 'PUT' | 'DELETE'
  id: string | null
  body?: Readonly<AddressInput>
  acknowledged: boolean
}
let intent: Intent | null = null
function authorized() {
  return (
    active &&
    !revoked.value &&
    scope.value === originalScope &&
    loggedIn.value === true &&
    user.value?.emailVerified === true &&
    z.string().uuid().safeParse(user.value?.id).success &&
    z.string().uuid().safeParse(session.value?.sessionId).success &&
    Number.isSafeInteger(session.value?.sessionVersion) &&
    (session.value?.sessionVersion ?? 0) > 0
  )
}
const readState = computed(() => {
  if (cloudflare && (!authorized() || failedRead.value)) return 'error'
  if (retryingRead.value || status.value === 'pending' || status.value === 'idle') return 'loading'
  if (cloudflare) return status.value === 'success' && agendaSchema.safeParse(data.value).success ? 'success' : 'error'
  const payload = data.value
  return status.value === 'success' &&
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Object.hasOwn(payload, 'addresses') &&
    Array.isArray(payload.addresses)
    ? 'success'
    : 'error'
})
// A failed read must not turn cached addresses into a successful or empty agenda.
const addresses = computed(() => (readState.value === 'success' ? data.value!.addresses : []))
const canAct = computed(
  () => !busy.value && (!cloudflare || (authorized() && readState.value === 'success' && !uncertain.value))
)

async function retryRead() {
  if (cloudflare) {
    if (!authorized() || busy.value || uncertain.value || readState.value !== 'error') return
    await readCurrent()
    return
  }
  if (readState.value !== 'error') return
  retryingRead.value = true
  try {
    await refresh()
  } catch {
    // The read error stays generic; no server details or personal data are rendered.
  } finally {
    retryingRead.value = false
  }
}

const open = ref(false)
const editing = ref<Address | null>(null)
const confirming = ref<Address | null>(null)
const dialogOpen = computed({
  get: () => open.value,
  set: (value: boolean) => {
    if (!cloudflare || (!busy.value && !uncertain.value)) open.value = value
  }
})

const KINDS = [
  { label: 'Envío y facturación', value: 'both' },
  { label: 'Solo envío', value: 'shipping' },
  { label: 'Solo facturación', value: 'billing' }
]

/** Lista corta y honesta: NETECO reparte en España. No un desplegable de 195 países. */
const COUNTRIES = [
  { label: 'España', value: 'ES' },
  { label: 'Portugal', value: 'PT' },
  { label: 'Francia', value: 'FR' },
  { label: 'Andorra', value: 'AD' }
]

function blankForm() {
  const seed = cloudflare ? seedSchema.safeParse(accountData.value) : null
  const profile = cloudflare ? (seed?.success && authorized() ? seed.data.profile : null) : accountData.value?.profile
  return {
    kind: 'both' as Address['kind'],
    label: '',
    recipientName: profile?.name ?? '',
    companyName: profile?.company ?? '',
    taxId: profile?.taxId ?? '',
    line1: '',
    line2: '',
    postalCode: '',
    city: '',
    region: '',
    countryCode: 'ES',
    phone: profile?.phone ?? '',
    instructions: '',
    isDefault: false
  }
}

const form = reactive(blankForm())
function purge() {
  generation++
  controller?.abort()
  controller = null
  data.value = null as unknown as { addresses: Address[] }
  accountData.value = null
  intent = null
  uncertain.value = false
  reviewed.value = false
  busy.value = false
  retryingRead.value = false
  open.value = false
  editing.value = null
  confirming.value = null
  notice.value = ''
  errorMessage.value = ''
  Object.assign(form, blankForm())
}
if (cloudflare) {
  watch(
    scope,
    () => {
      if (scope.value !== originalScope || !authorized()) {
        revoked.value = true
        purge()
      }
    },
    { flush: 'sync', immediate: true }
  )
  watch(
    [data, accountData],
    () => {
      if (!authorized()) {
        data.value = null as unknown as { addresses: Address[] }
        accountData.value = null
      }
    },
    { flush: 'sync' }
  )
}
onBeforeUnmount(() => {
  active = false
  if (cloudflare) purge()
})

async function readCurrent() {
  if (!authorized() || retryingRead.value) return false
  const request = generation
  retryingRead.value = true
  reviewed.value = false
  failedRead.value = false
  try {
    await refresh()
    if (!authorized() || request !== generation) return false
    if (status.value !== 'success' || !agendaSchema.safeParse(data.value).success) throw new Error('invalid_agenda')
    return true
  } catch {
    if (authorized() && request === generation) failedRead.value = true
    return false
  } finally {
    if (authorized() && request === generation) retryingRead.value = false
  }
}
function matchesCurrent(command: Intent) {
  if (!command.acknowledged || readState.value !== 'success') return false
  const current = addresses.value.find((address) => address.id === command.id)
  if (command.method === 'DELETE') return !current
  return (
    !!current &&
    !!command.body &&
    Object.entries(command.body).every(([key, value]) => {
      const observed = current[key as keyof Address]
      return (observed ?? '') === (key === 'postalCode' ? String(value).toUpperCase() : value)
    })
  )
}
function complete(command: Intent) {
  intent = null
  uncertain.value = false
  reviewed.value = false
  open.value = false
  editing.value = null
  confirming.value = null
  Object.assign(form, blankForm())
  showNotice(
    command.method === 'DELETE'
      ? 'Dirección eliminada.'
      : command.method === 'PUT'
        ? 'Dirección actualizada.'
        : 'Dirección guardada.'
  )
}
async function execute(command: Intent) {
  if (!canAct.value) return
  intent = command
  busy.value = true
  notice.value = ''
  errorMessage.value = ''
  const request = generation
  controller = new AbortController()
  const current = () => authorized() && request === generation && intent === command
  try {
    const response = await $fetch<unknown>(
      command.method === 'POST' ? '/api/account/addresses' : `/api/account/addresses/${command.id}`,
      {
        method: command.method,
        ...(command.body ? { body: command.body } : {}),
        retry: 0,
        signal: controller.signal
      }
    )
    if (!current()) return
    if (command.method === 'POST') command.id = z.object({ id: z.string().uuid() }).strict().parse(response).id
    else
      z.object({ ok: z.literal(true) })
        .strict()
        .parse(response)
    command.acknowledged = true
    if (!(await readCurrent()) || !current() || !matchesCurrent(command)) throw new Error('unconfirmed_agenda')
    complete(command)
  } catch {
    if (!current()) return
    uncertain.value = true
    reviewed.value = false
    open.value = false
    confirming.value = null
    errorMessage.value =
      'No podemos confirmar el resultado. Revisa la agenda antes de continuar; no se reenviará la operación.'
  } finally {
    if (authorized() && request === generation) {
      busy.value = false
      controller = null
    }
  }
}
async function reviewAgenda() {
  if (!authorized() || busy.value || !uncertain.value || !intent) return
  const command = intent
  if (!(await readCurrent()) || !authorized() || intent !== command) return
  if (matchesCurrent(command)) complete(command)
  else reviewed.value = true
}
function acknowledgeReview() {
  if (!authorized() || !uncertain.value || !reviewed.value || busy.value || readState.value !== 'success') return
  intent = null
  uncertain.value = false
  reviewed.value = false
  open.value = false
  editing.value = null
  confirming.value = null
  Object.assign(form, blankForm(), { recipientName: '', companyName: '', taxId: '', phone: '' })
  notice.value = ''
  errorMessage.value = ''
}

function startCreate() {
  if (cloudflare && !canAct.value) return
  editing.value = null
  Object.assign(form, blankForm())
  open.value = true
}

function startEdit(address: Address) {
  if (cloudflare && (!canAct.value || !addresses.value.some((current) => current.id === address.id))) return
  editing.value = address
  Object.assign(form, {
    kind: address.kind,
    label: address.label,
    recipientName: address.recipientName,
    companyName: address.companyName ?? '',
    taxId: address.taxId ?? '',
    line1: address.line1,
    line2: address.line2 ?? '',
    postalCode: address.postalCode,
    city: address.city,
    region: address.region,
    countryCode: address.countryCode,
    phone: address.phone ?? '',
    instructions: address.instructions ?? '',
    isDefault: address.isDefault
  })
  open.value = true
}

async function save() {
  if (cloudflare) {
    if (!canAct.value) return
    let body: AddressInput
    try {
      body = validateCloudflareCustomerAddress({ ...form })
    } catch (error) {
      errorMessage.value =
        error instanceof z.ZodError && error.issues.some((issue) => issue.path[0] === 'taxId')
          ? 'Revisa el identificador fiscal de la dirección (NIF / CIF / VAT).'
          : 'Revisa los campos de la dirección y sus formatos.'
      return
    }
    const id = editing.value?.id ?? null
    if (id && !addresses.value.some((address) => address.id === id)) return
    await execute({ method: id ? 'PUT' : 'POST', id, body: Object.freeze(body), acknowledged: false })
    return
  }
  await run(async () => {
    if (editing.value) {
      await $fetch(`/api/account/addresses/${editing.value.id}`, { method: 'PUT', body: form })
    } else {
      await $fetch('/api/account/addresses', { method: 'POST', body: form })
    }
    await refresh()
    open.value = false
    showNotice(editing.value ? 'Dirección actualizada.' : 'Dirección guardada.')
    editing.value = null
  }, 'No se ha podido guardar la dirección.')
}

function startRemove(address: Address) {
  if (cloudflare && (!canAct.value || !addresses.value.some((current) => current.id === address.id))) return
  confirming.value = address
}

async function remove() {
  const target = confirming.value
  if (!target) return
  if (cloudflare) {
    if (!canAct.value || !addresses.value.some((address) => address.id === target.id)) return
    await execute({ method: 'DELETE', id: target.id, acknowledged: false })
    return
  }
  await run(async () => {
    await $fetch(`/api/account/addresses/${target.id}`, { method: 'DELETE' })
    await refresh()
    confirming.value = null
    showNotice('Dirección eliminada.')
  }, 'No se ha podido eliminar la dirección.')
}

const KIND_LABEL: Record<Address['kind'], string> = {
  both: 'Envío y facturación',
  shipping: 'Solo envío',
  billing: 'Solo facturación'
}
</script>

<template>
  <div class="min-w-0 break-words" :aria-busy="readState === 'loading'">
    <UiPageHeader
      title="Direcciones"
      :count="readState === 'success' ? addresses.length : undefined"
      count-label="guardadas"
      description="Las direcciones de envío y facturación que puedes elegir al pagar."
    >
      <template #actions>
        <UButton icon="i-lucide-plus" :disabled="!canAct" @click="startCreate">Añadir dirección</UButton>
      </template>
    </UiPageHeader>

    <AccountFeedback :notice="notice" :error="errorMessage" />
    <UiSurface v-if="cloudflare && uncertain" class="mt-4">
      <p role="alert">
        No podemos confirmar el resultado de la operación. Revisa los cambios y posibles duplicados antes de continuar.
        Continuar no confirma éxito ni ausencia de cambios.
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <UButton :disabled="!authorized() || busy || retryingRead" @click="reviewAgenda">Revisar agenda</UButton>
        <UButton
          :disabled="!reviewed || readState !== 'success' || !authorized() || busy || retryingRead"
          @click="acknowledgeReview"
          >He revisado la agenda; continuar</UButton
        >
      </div>
    </UiSurface>

    <div v-if="readState === 'loading'" class="mt-4 grid gap-4 grid-cols-1 md:grid-cols-2">
      <p role="status" class="sr-only">Cargando tus direcciones.</p>
      <div
        v-for="row in 2"
        :key="row"
        class="h-40 animate-pulse rounded-[var(--radius-panel)] bg-[var(--surface-sunken)]"
      />
    </div>

    <UiSurface v-else-if="readState === 'error'" class="mt-4">
      <p role="alert">No hemos podido cargar tus direcciones. Vuelve a intentarlo.</p>
      <UButton
        class="mt-3"
        color="neutral"
        icon="i-lucide-rotate-cw"
        :disabled="cloudflare && (!authorized() || uncertain || busy)"
        @click="retryRead"
        >Reintentar</UButton
      >
    </UiSurface>

    <UiSurface v-else-if="!addresses.length" class="mt-4" padding="none">
      <UiEmptyState
        icon="i-lucide-map-pin"
        title="Todavía no has guardado ninguna dirección"
        description="Guarda tus direcciones frecuentes y elígelas al pagar sin volver a escribirlas."
      >
        <UButton icon="i-lucide-plus" :disabled="!canAct" @click="startCreate">Añadir la primera dirección</UButton>
      </UiEmptyState>
    </UiSurface>

    <div v-else class="mt-4 grid gap-4 grid-cols-1 md:grid-cols-2">
      <UiSurface v-for="address in addresses" :key="address.id" as="article" padding="sm">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="truncate font-semibold text-[var(--text-strong)]">{{ address.label }}</h2>
              <UBadge v-if="address.isDefault" variant="subtle">Predeterminada</UBadge>
            </div>
            <p class="mt-0.5 text-xs uppercase tracking-wide text-[var(--text-muted)]">
              {{ KIND_LABEL[address.kind] }}
            </p>
          </div>
        </div>

        <address class="mt-3 text-sm not-italic text-[var(--text)]">
          <p class="font-medium">{{ address.recipientName }}</p>
          <p v-if="address.companyName">{{ address.companyName }}</p>
          <p>
            {{ address.line1 }}<template v-if="address.line2">, {{ address.line2 }}</template>
          </p>
          <p>{{ address.postalCode }} {{ address.city }} ({{ address.region }})</p>
          <p v-if="address.phone" class="mt-1 text-[var(--text-muted)]">{{ address.phone }}</p>
        </address>

        <p v-if="address.instructions" class="mt-2 text-sm text-[var(--text-muted)]">
          {{ address.instructions }}
        </p>

        <div class="mt-4 flex gap-2 border-t border-[var(--border)] pt-3">
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-pencil"
            :disabled="!canAct"
            @click="startEdit(address)"
          >
            Editar
          </UButton>
          <UButton
            size="sm"
            color="error"
            variant="ghost"
            icon="i-lucide-trash-2"
            :disabled="!canAct"
            @click="startRemove(address)"
          >
            Eliminar
          </UButton>
        </div>
      </UiSurface>
    </div>

    <UModal
      v-model:open="dialogOpen"
      :dismissible="!cloudflare || (!busy && !uncertain)"
      :title="editing ? 'Editar dirección' : 'Añadir dirección'"
    >
      <template #body>
        <form id="address-form" class="grid gap-4 grid-cols-1 sm:grid-cols-2" @submit.prevent="save">
          <fieldset class="contents" :disabled="cloudflare && (busy || uncertain || !authorized())">
            <UFormField label="Etiqueta" required hint="Cómo la reconoces tú">
              <UInput v-model="form.label" class="w-full" placeholder="Almacén, oficina, obra…" />
            </UFormField>
            <UFormField label="Uso" required>
              <USelect v-model="form.kind" :items="KINDS" class="w-full" />
            </UFormField>

            <UFormField label="Destinatario" required>
              <UInput v-model="form.recipientName" class="w-full" autocomplete="name" />
            </UFormField>
            <UFormField label="Teléfono de contacto">
              <UInput v-model="form.phone" type="tel" class="w-full" autocomplete="tel" />
            </UFormField>

            <UFormField label="Empresa">
              <UInput v-model="form.companyName" class="w-full" autocomplete="organization" />
            </UFormField>
            <UFormField label="NIF / CIF / VAT">
              <UInput v-model="form.taxId" class="w-full" />
            </UFormField>

            <UFormField class="sm:col-span-2" label="Dirección" required>
              <UInput v-model="form.line1" class="w-full" autocomplete="address-line1" placeholder="Calle y número" />
            </UFormField>
            <UFormField class="sm:col-span-2" label="Piso, puerta, nave, polígono">
              <UInput v-model="form.line2" class="w-full" autocomplete="address-line2" />
            </UFormField>

            <UFormField label="Código postal" required>
              <UInput v-model="form.postalCode" class="w-full" autocomplete="postal-code" inputmode="numeric" />
            </UFormField>
            <UFormField label="Población" required>
              <UInput v-model="form.city" class="w-full" autocomplete="address-level2" />
            </UFormField>
            <UFormField label="Provincia" required>
              <UInput v-model="form.region" class="w-full" autocomplete="address-level1" />
            </UFormField>
            <UFormField label="País" required>
              <USelect v-model="form.countryCode" :items="COUNTRIES" class="w-full" />
            </UFormField>

            <UFormField
              class="sm:col-span-2"
              label="Instrucciones de entrega"
              hint="Horario de recepción, muelle, persona de contacto"
            >
              <UTextarea v-model="form.instructions" class="w-full" :rows="2" />
            </UFormField>

            <div class="sm:col-span-2">
              <UCheckbox v-model="form.isDefault" label="Usar como dirección predeterminada" />
            </div>
          </fieldset>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="cloudflare && (busy || uncertain)"
            @click="dialogOpen = false"
            >Cancelar</UButton
          >
          <UButton type="submit" form="address-form" :loading="busy" :disabled="!canAct">
            {{ editing ? 'Guardar cambios' : 'Guardar dirección' }}
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal
      :open="Boolean(confirming)"
      :dismissible="!cloudflare || (!busy && !uncertain)"
      title="Eliminar dirección"
      @update:open="(value) => !value && (!cloudflare || (!busy && !uncertain)) && (confirming = null)"
    >
      <template #body>
        <p class="text-[var(--text)]">
          Se eliminará <strong>{{ confirming?.label }}</strong> de tu agenda. Los pedidos ya realizados conservan su
          propia copia de la dirección, así que no se ven afectados.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="cloudflare && (busy || uncertain)"
            @click="confirming = null"
            >Cancelar</UButton
          >
          <UButton color="error" :loading="busy" :disabled="!canAct" @click="remove">Eliminar dirección</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
