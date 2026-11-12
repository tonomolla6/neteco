import {
  commercialPromises,
  contactAction,
  contactPhones,
  primaryContactPhone,
  deferredPaymentPromise,
  ownDeliveryPromise,
  parcelPromise,
  parseCommercialTerms,
  supportPromise
} from '~~/shared/commercial-terms'

/**
 * Las condiciones comerciales configuradas, ya saneadas, y las frases que la tienda puede
 * decir con ellas. Ningún componente escribe a mano un plazo, un coste o un umbral.
 */
export function useCommercialTerms() {
  const runtime = useRuntimeConfig()
  const terms = computed(() =>
    parseCommercialTerms({
      ...(runtime.public.commercial as Record<string, unknown> | undefined),
      // Misma fuente que `shippingCommercialPolicy()` en el servidor.
      parcelFreeFromCents: runtime.public.freeShippingThresholdCents
    })
  )
  const bankTransfer = computed(() => runtime.public.bankTransferEnabled === true)
  return {
    terms,
    promises: computed(() => commercialPromises(terms.value, { bankTransfer: bankTransfer.value })),
    ownDelivery: computed(() => ownDeliveryPromise(terms.value)),
    parcel: computed(() => parcelPromise(terms.value)),
    deferredPayment: computed(() => deferredPaymentPromise(terms.value)),
    support: computed(() => supportPromise(terms.value)),
    /** Único correo de contacto. */
    email: computed(() => terms.value.contactEmail),
    /** Teléfonos configurados (puede estar vacío: entonces no se pinta ninguno). */
    phones: computed(() => contactPhones(terms.value)),
    /** El teléfono que se ofrece en una frase («llámanos al …»), o `null`. */
    phone: computed(() => primaryContactPhone(terms.value)),
    /** «llámanos al …» o «escríbenos a …», para cerrar un mensaje de error o de ayuda. */
    contact: computed(() => contactAction(terms.value))
  }
}
