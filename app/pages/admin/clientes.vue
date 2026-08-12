<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Clientes profesionales · Admin', robots: 'noindex, nofollow' })

interface Company {
  id: string
  legalName: string
  tradeName: string | null
  taxId: string | null
  countryCode: string
  status: 'pending' | 'approved' | 'rejected' | 'suspended'
  rejectionReason: string | null
  createdAt: string
  reviewedAt: string | null
  reviewedBy: string | null
  locations: number
  members: number
  contactEmail: string | null
}

const { data, refresh } = await useFetch<{ companies: Company[] }>('/api/admin/companies')
const toast = useToast()

async function transition(company: Company, status: Company['status']) {
  const reason = window.prompt(`Motivo obligatorio para pasar ${company.legalName} a ${status}:`)?.trim()
  if (!reason || reason.length < 3) return
  try {
    await $fetch(`/api/admin/companies/${company.id}`, { method: 'PUT', body: { status, reason } })
    await refresh()
    toast.add({ title: `${company.legalName}: ${status}`, color: 'success', icon: 'i-lucide-check' })
  } catch (error) {
    const candidate = error as { data?: { statusMessage?: string } }
    toast.add({
      title: candidate.data?.statusMessage ?? 'No se ha podido actualizar la empresa',
      color: 'error',
      icon: 'i-lucide-triangle-alert'
    })
  }
}
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold text-slate-900">Clientes profesionales</h1>
    <p class="mt-1 text-sm text-slate-500">Revisa altas, identidad fiscal y estado operativo con motivo auditado.</p>
    <div class="mt-5 overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table class="w-full min-w-[980px] text-sm">
        <thead>
          <tr class="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th class="px-4 py-3">Empresa</th>
            <th class="px-4 py-3">Fiscal</th>
            <th class="px-4 py-3">Estructura</th>
            <th class="px-4 py-3">Estado</th>
            <th class="px-4 py-3">Revisión</th>
            <th class="px-4 py-3 text-right">Acciones</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="company in data?.companies"
            :key="company.id"
            class="border-b border-slate-100 align-top last:border-0"
          >
            <td class="px-4 py-3">
              <p class="font-semibold text-slate-800">{{ company.legalName }}</p>
              <p class="text-xs text-slate-500">{{ company.contactEmail }}</p>
            </td>
            <td class="px-4 py-3">
              <p>{{ company.countryCode }} · {{ company.taxId || 'Pendiente' }}</p>
              <p v-if="company.tradeName" class="text-xs text-slate-500">{{ company.tradeName }}</p>
            </td>
            <td class="px-4 py-3">{{ company.locations }} sedes · {{ company.members }} miembros</td>
            <td class="px-4 py-3">
              <UBadge variant="subtle">{{ company.status }}</UBadge>
              <p v-if="company.rejectionReason" class="mt-1 max-w-xs text-xs text-red-700">
                {{ company.rejectionReason }}
              </p>
            </td>
            <td class="px-4 py-3 text-xs text-slate-500">
              <template v-if="company.reviewedAt"
                >{{ formatDate(company.reviewedAt) }}<br />{{ company.reviewedBy }}</template
              ><span v-else>Sin revisar</span>
            </td>
            <td class="px-4 py-3">
              <div class="flex justify-end gap-1">
                <UButton
                  v-if="company.status === 'pending' || company.status === 'suspended'"
                  size="xs"
                  color="success"
                  variant="soft"
                  @click="transition(company, 'approved')"
                  >Aprobar</UButton
                ><UButton
                  v-if="company.status === 'pending'"
                  size="xs"
                  color="error"
                  variant="soft"
                  @click="transition(company, 'rejected')"
                  >Rechazar</UButton
                ><UButton
                  v-if="company.status === 'approved'"
                  size="xs"
                  color="warning"
                  variant="soft"
                  @click="transition(company, 'suspended')"
                  >Suspender</UButton
                ><UButton
                  v-if="company.status === 'rejected' || company.status === 'suspended'"
                  size="xs"
                  variant="soft"
                  @click="transition(company, 'pending')"
                  >Revisar</UButton
                >
              </div>
            </td>
          </tr>
          <tr v-if="!data?.companies.length">
            <td colspan="6" class="px-4 py-10 text-center text-slate-500">No hay solicitudes profesionales.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
