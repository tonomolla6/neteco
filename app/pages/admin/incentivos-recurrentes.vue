<script setup lang="ts">
import { ref } from 'vue'
import AdminRecurringIncentivesPanel from '~/components/AdminRecurringIncentivesPanel.vue'

definePageMeta({ layout: 'admin', middleware: 'admin' })
useSeoMeta({ title: 'Incentivos por recurrencia B2B · Admin', robots: 'noindex, nofollow, noarchive' })

const companyId = ref('comp-turia')
const appliedCompanyId = ref('comp-turia')

function updateCompany() {
  if (companyId.value.trim()) {
    appliedCompanyId.value = companyId.value.trim()
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
      <div class="flex flex-wrap items-center gap-3">
        <label for="company-picker" class="text-xs font-semibold text-slate-700">Identificador de Empresa B2B:</label>
        <input
          id="company-picker"
          v-model="companyId"
          data-test="company-input"
          type="text"
          class="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-mono"
          placeholder="ej. comp-turia"
          @keyup.enter="updateCompany"
        />
        <button
          type="button"
          class="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          @click="updateCompany"
        >
          Cargar empresa
        </button>
      </div>
    </div>

    <AdminRecurringIncentivesPanel :key="appliedCompanyId" :company-id="appliedCompanyId" />
  </div>
</template>
