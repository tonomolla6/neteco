import type { CarrierProvider } from './carrier-provider'
import { ManualCarrierProvider, MockCarrierProvider, OwnDeliveryCarrierProvider } from './mock-carrier'

export function carrierProviderFromEnvironment(environment: NodeJS.ProcessEnv = process.env): CarrierProvider {
  const provider = environment.CARRIER_PROVIDER ?? 'mock'
  if (provider === 'mock' && environment.APP_ENV !== 'production') return new MockCarrierProvider()
  if (provider === 'own-delivery') return new OwnDeliveryCarrierProvider()
  if (provider === 'manual') return new ManualCarrierProvider()
  throw new Error('A contracted production carrier adapter is required')
}
