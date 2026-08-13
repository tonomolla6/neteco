import { describe, expect, it } from 'vitest'
import { validatedEmailBaseUrl } from '../../server/utils/email-base-url'

describe('email public base URL', () => {
  it('accepts clean HTTP origins locally and requires HTTPS in production', () => {
    expect(validatedEmailBaseUrl('http://localhost:3000', 'local')).toBe('http://localhost:3000')
    expect(validatedEmailBaseUrl('https://shop.neteco.es/', 'production')).toBe('https://shop.neteco.es')
    expect(() => validatedEmailBaseUrl('http://shop.neteco.es', 'production')).toThrow('must use HTTPS')
  })

  it.each([
    'javascript:alert(1)',
    'https://user:secret@shop.neteco.es',
    'https://shop.neteco.es/untrusted-path',
    'https://shop.neteco.es?redirect=evil',
    'https://shop.neteco.es#fragment',
    'not-a-url'
  ])('rejects unsafe base URL %s', (value) => {
    expect(() => validatedEmailBaseUrl(value, 'production')).toThrow()
  })
})
