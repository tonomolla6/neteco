<script setup lang="ts" generic="Token extends { id: string; version: number }">
defineProps<{
  savedCardsAvailable: boolean
  savedTokens: Token[]
  consentVersion: string
  consentLocked: boolean
  wallets: { apple_pay: boolean; google_pay: boolean }
  submitting: boolean
  actionsDisabled: boolean
  selectedTokenId: string | null
  selectedWallet: string | null
  bizumAvailable: boolean
  transferAvailable: boolean
  transferHint: string
}>()
defineEmits<{ oneClick: [token: Token]; wallet: [method: 'apple_pay' | 'google_pay'] }>()
const method = defineModel<'tarjeta' | 'bizum' | 'transferencia'>({ required: true })
const saveCard = defineModel<boolean>('saveCard', { required: true })

const optionClass = (value: string) =>
  method.value === value ? 'border-neteco-500 ring-1 ring-neteco-500' : 'border-slate-200 hover:border-neteco-300'
</script>

<template>
  <fieldset class="mt-5 space-y-2">
    <legend class="sr-only">Selecciona el método de pago</legend>
    <label
      class="flex cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 transition"
      :class="optionClass('tarjeta')"
    >
      <input v-model="method" type="radio" value="tarjeta" class="accent-neteco-500" />
      <UIcon name="i-lucide-credit-card" class="size-5 text-slate-500" />
      <span class="font-medium text-slate-800">Tarjeta de crédito / débito</span>
    </label>
    <div v-if="method === 'tarjeta'" class="ml-2 space-y-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
      <p>
        <UIcon name="i-lucide-shield-check" class="mr-1 inline size-4 text-emerald-600" />
        Introducirás la tarjeta y completarás la autenticación bancaria en la página segura de Redsys. NETECO no recibe
        ni almacena el número de tarjeta ni el CVC.
      </p>

      <!-- PAY-022: Tarjetas guardadas elegibles para pago en un clic y consentimiento explícito -->
      <div
        v-if="savedCardsAvailable"
        class="space-y-3 border-t border-slate-200 pt-3"
        data-testid="saved-cards-section"
      >
        <div v-if="savedTokens.length" class="space-y-2" data-testid="saved-cards-list">
          <p class="text-[13px] font-semibold text-slate-700">Tarjetas guardadas para pago rápido</p>
          <div
            v-for="token in savedTokens"
            :key="token.id"
            class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800"
          >
            <span>
              Referencia guardada <span class="font-mono">{{ token.id.slice(0, 8) }}</span> (v{{ token.version }})
            </span>
            <UButton
              type="button"
              size="xs"
              :data-testid="`one-click-pay-${token.id}`"
              :loading="submitting && selectedTokenId === token.id"
              :disabled="actionsDisabled"
              @click="$emit('oneClick', token)"
            >
              Pagar en 1 clic
            </UButton>
          </div>
        </div>

        <label class="flex items-start gap-2 text-xs text-slate-700">
          <input
            v-model="saveCard"
            type="checkbox"
            data-testid="save-card-consent"
            :disabled="consentLocked"
            class="mt-0.5 accent-neteco-600"
          />
          <span>
            Guardar esta tarjeta para próximos pedidos. El banco nos da una referencia para cobrar en un clic
            (condiciones versión <span class="tabular">{{ consentVersion }}</span
            >); nunca guardamos el número ni el código de seguridad.
          </span>
        </label>

        <p class="text-xs text-slate-600">
          Puedes consultar o revocar tus tarjetas guardadas en cualquier momento desde
          <a
            href="/cuenta/metodos-de-pago"
            data-testid="revoke-saved-card-link"
            class="font-medium text-neteco-700 underline hover:text-neteco-600"
            >Mis métodos de pago</a
          >.
        </p>
      </div>

      <!-- PAY-019: Apple Pay / Google Pay solo cuando capabilities lo habilitan -->
      <div
        v-if="wallets.apple_pay || wallets.google_pay"
        class="space-y-2 border-t border-slate-200 pt-3"
        data-testid="wallet-payment-options"
      >
        <p class="text-[13px] font-semibold text-slate-700">Pago rápido con wallet</p>
        <div class="flex flex-wrap gap-2">
          <UButton
            v-if="wallets.apple_pay"
            type="button"
            variant="outline"
            data-testid="wallet-pay-apple_pay"
            :loading="submitting && selectedWallet === 'apple_pay'"
            :disabled="actionsDisabled"
            @click="$emit('wallet', 'apple_pay')"
          >
            Pagar con Apple Pay
          </UButton>
          <UButton
            v-if="wallets.google_pay"
            type="button"
            variant="outline"
            data-testid="wallet-pay-google_pay"
            :loading="submitting && selectedWallet === 'google_pay'"
            :disabled="actionsDisabled"
            @click="$emit('wallet', 'google_pay')"
          >
            Pagar con Google Pay
          </UButton>
        </div>
      </div>
    </div>

    <label
      v-if="bizumAvailable"
      class="flex cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 transition"
      :class="optionClass('bizum')"
    >
      <input v-model="method" type="radio" value="bizum" class="accent-neteco-500" />
      <UIcon name="i-lucide-smartphone" class="size-5 text-slate-500" />
      <span class="font-medium text-slate-800">Bizum</span>
    </label>
    <div v-if="bizumAvailable && method === 'bizum'" class="ml-2 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
      Te enviaremos a Redsys para autorizar el pago con Bizum de forma segura.
    </div>

    <label
      v-if="transferAvailable"
      class="flex cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 transition"
      :class="optionClass('transferencia')"
    >
      <input v-model="method" type="radio" value="transferencia" class="accent-neteco-500" />
      <UIcon name="i-lucide-landmark" class="size-5 text-slate-500" />
      <span>
        <span class="block font-medium text-slate-800">Transferencia bancaria</span>
        <span class="block text-xs text-slate-500">{{ transferHint }}</span>
      </span>
    </label>
  </fieldset>
</template>
