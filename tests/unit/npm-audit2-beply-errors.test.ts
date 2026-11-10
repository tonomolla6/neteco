import { expect, it } from 'vitest'
import { invoiceProviderFromEnvironment } from '../../server/integrations/invoice-factory'

it('retains the existing invalid URL diagnostic for incomplete Beply configuration', () => {
  expect(() => invoiceProviderFromEnvironment({ APP_ENV: 'test', INVOICE_PROVIDER: 'beply' })).toThrow('Invalid url')
})
