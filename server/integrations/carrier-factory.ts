import type { CarrierProvider } from './carrier-provider'
import { ManualCarrierProvider, MockCarrierProvider, OwnDeliveryCarrierProvider } from './mock-carrier'
import { shippingCalendarPolicy } from '../utils/shipping-policy'

export function carrierProviderFromEnvironment(environment: NodeJS.ProcessEnv = process.env): CarrierProvider {
  const provider = environment.CARRIER_PROVIDER ?? 'mock'
  const calendar = shippingCalendarPolicy(environment)
  if (provider === 'mock' && environment.APP_ENV !== 'production')
    return new MockCarrierProvider('mock-carrier', calendar)
  if (provider === 'own-delivery' && environment.APP_ENV !== 'production')
    return new OwnDeliveryCarrierProvider(calendar)
  if (provider === 'manual' && environment.APP_ENV !== 'production') return new ManualCarrierProvider(calendar)
  throw new Error('A contracted production carrier adapter is required')
}
