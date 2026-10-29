import { describe, expect, it } from 'vitest'
import {
  catalogImageSource,
  publishedDocumentUrl,
  publishedImageSources,
  publishedImageUrl
} from '../../app/utils/publishedMedia'

const path = '/media/12345678-1234-4321-aaaa-123456789abc/image'

describe('governed responsive catalog images', () => {
  it('selects bounded AVIF, WebP and JPEG derivatives of the same publication only', () => {
    const sources = publishedImageSources(`${path}?w=800&format=jpeg`)!
    expect(sources.jpeg).toBe(`${path}?w=800&format=jpeg`)
    for (const format of ['avif', 'webp', 'jpeg'] as const) {
      expect(sources[`${format}Srcset`].split(', ')).toEqual(
        [256, 400, 640, 800, 1200, 1600].map((width) => `${path}?w=${width}&format=${format} ${width}w`)
      )
    }
    expect(publishedImageUrl(path, 1200)).toBe(`${path}?w=1200&format=jpeg`)
    expect(publishedImageUrl(`${path}?w=64&format=avif`, 1600, 'webp')).toBe(`${path}?w=1600&format=webp`)
  })

  it.each([
    undefined,
    null,
    '',
    '/img/products/demo.jpg',
    'https://other.example' + path,
    '//other.example' + path,
    '/media/quarantine/original/image',
    '/media/not-a-uuid/image',
    path.replace('/media/', '/%6dedia/'),
    path.replace('/image', '/document'),
    path + '?w=1800',
    path + '?w=0800',
    path + '?format=png',
    path + '?format=webp&format=jpeg',
    path + '?w=800&w=1600',
    path + '?url=https://other.example',
    path + '?w=800?format=avif',
    path + '#fragment',
    path + '\\extra'
  ])('never converts an ungoverned or host-controlled source %s', (source) => {
    expect(publishedImageSources(source)).toBeNull()
    expect(publishedImageUrl(source, 800)).toBeNull()
  })
})

describe('catalog image source runtime boundary', () => {
  it.each([path, `${path}?w=64`, `${path}?format=avif`, `${path}?w=800&format=jpeg`, `${path}?format=webp&w=1600`])(
    'preserves the exact permitted governed source %s',
    (source) => {
      expect(catalogImageSource(source, true)).toBe(source)
    }
  )

  it('accepts only the bounded generated width and format combinations without replacing the original source', () => {
    for (const width of [64, 128, 256, 400, 640, 800, 1200, 1600]) {
      for (const format of ['avif', 'webp', 'jpeg']) {
        const source = `${path}?w=${width}&format=${format}`
        expect(catalogImageSource(source, true)).toBe(source)
      }
    }
  })

  it('matches the public endpoint UUID version and variant contract', () => {
    for (const version of [1, 2, 3, 4, 5]) {
      for (const variant of ['8', '9', 'a', 'b']) {
        const source = path.replace('-4321-', `-${version}321-`).replace('-aaaa-', `-${variant}aaa-`)
        expect(catalogImageSource(source, true)).toBe(source)
      }
    }
  })

  it.each([
    '/img/products/demo.jpg',
    '/media/catalog/product-original.png',
    '/uploads/product.png',
    '/quarantine/12345678-1234-4321-aaaa-123456789abc/original.png',
    'quarantine/12345678-1234-4321-aaaa-123456789abc/original.png',
    `https://neteco.invalid${path}?w=800&format=jpeg`,
    `https://other.example${path}`,
    `//other.example${path}`,
    `https://private-bucket.r2.dev${path}`,
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    path.replace('/image', '/document'),
    path.replace('/media/', '/%6dedia/'),
    path.replace('/media/', '/%256dedia/'),
    path.replace('/media/', '/media%2f'),
    path.replace('12345678', '%31' + '2345678'),
    path.replace('/image', '/%69mage'),
    path.replace('/image', '/image/'),
    path.replace('/media/', '/media//'),
    path.replace('/media/', '/media/../media/'),
    path.replace('12345678-1234-4321-aaaa-123456789abc', 'not-a-uuid'),
    path.replace('/media/', '/MEDIA/'),
    path.replace('/image', '/IMAGE'),
    path.replace('12345678-1234-4321-aaaa-123456789abc', '12345678-1234-4321-AAAA-123456789ABC'),
    path.replace('-4321-', '-0321-'),
    path.replace('-4321-', '-6321-'),
    path.replace('-4321-', '-7321-'),
    path.replace('-aaaa-', '-7aaa-'),
    path.replace('-aaaa-', '-caaa-'),
    path.replace('12345678-1234-4321-aaaa-123456789abc', '00000000-0000-0000-0000-000000000000'),
    `${path}?w=1800`,
    `${path}?w=0`,
    `${path}?w=-800`,
    `${path}?w=0800`,
    `${path}?w=800.0`,
    `${path}?w=8e2`,
    `${path}?w=+800`,
    `${path}?w=800&w=1600`,
    `${path}?format=png`,
    `${path}?format=jpg`,
    `${path}?format=WEBP`,
    `${path}?format=avif&format=webp`,
    `${path}?w=800&format=jpeg&url=https://other.example/original`,
    `${path}?w=800&format=jpeg&quality=100`,
    `${path}?w=800&format=jpeg&download=1`,
    `${path}?width=800&format=jpeg`,
    `${path}?W=800&format=jpeg`,
    `${path}?format=`,
    `${path}?w=`,
    `${path}?w=800?format=avif`,
    `${path}?%77=800&format=jpeg`,
    `${path}?w=800&%66ormat=jpeg`,
    `${path}?w=%38%30%30&format=jpeg`,
    `${path}?w=800&format=%61vif`,
    `${path}?w=800&%2577=800&format=jpeg`,
    `${path}?w=800&format=jpeg&%75rl=https://other.example`,
    `${path}?w=800&%77=1600&format=jpeg`,
    `${path}#fragment`,
    `${path}?w=800&format=jpeg#fragment`,
    `${path}\\original`,
    path.replace('/media/', '\\media\\'),
    ` ${path}`,
    `${path} `,
    `${path}\n`,
    `${path}\r\n`,
    `${path}\t`,
    `${path}\u2028`,
    `${path}\u0000`
  ])('rejects a legacy, external or noncanonical source in the governed profile: %s', (source) => {
    expect(catalogImageSource(source, true)).toBeNull()
  })

  it.each([
    '/img/products/demo.jpg',
    '/media/catalog/product-original.png',
    '/uploads/product.jpg?v=2',
    'https://supplier.example/product.png',
    'https://supplier.example/product.jpg?width=800#preview',
    '//cdn.example/catalog/product.webp'
  ])('preserves an ordinary existing image URL in the Node profile: %s', (source) => {
    expect(catalogImageSource(source, false)).toBe(source)
  })

  it.each([undefined, null, ''])('keeps missing image source %s empty in both runtimes', (source) => {
    expect(catalogImageSource(source, true)).toBeNull()
    expect(catalogImageSource(source, false)).toBeNull()
  })
})

describe('governed public technical document URLs', () => {
  const document = path.replace('/image', '/document')

  it('preserves only the same-origin publication document route without adding download parameters', () => {
    expect(publishedDocumentUrl(document)).toBe(document)
  })

  it('matches the public document endpoint UUID version and variant contract', () => {
    for (const version of [1, 2, 3, 4, 5]) {
      for (const variant of ['8', '9', 'a', 'b']) {
        const source = document.replace('-4321-', `-${version}321-`).replace('-aaaa-', `-${variant}aaa-`)
        expect(publishedDocumentUrl(source)).toBe(source)
      }
    }
  })

  it.each([
    undefined,
    null,
    '',
    path,
    '/files/datasheet.pdf',
    '/img/products/safety-sheet.pdf',
    '/api/account/orders/1/invoice',
    '/api/admin/orders/1/invoice',
    '/api/invoices/12345678-1234-4321-aaaa-123456789abc/pdf',
    '/media/12345678-1234-4321-aaaa-123456789abc/invoice',
    '/media/quarantine/original/document',
    '/quarantine/12345678-1234-4321-aaaa-123456789abc/original.pdf',
    'quarantine/12345678-1234-4321-aaaa-123456789abc/original.pdf',
    `https://private-bucket.r2.dev${document}`,
    `https://neteco.invalid${document}`,
    `https://supplier.example${document}`,
    `//supplier.example${document}`,
    'data:application/pdf;base64,AAAA',
    'javascript:alert(1)',
    document.replace('/media/', '/%6dedia/'),
    document.replace('/media/', '/%256dedia/'),
    document.replace('/media/', '/media%2f'),
    document.replace('12345678', '%31' + '2345678'),
    document.replace('/document', '/%64ocument'),
    document.replace('/document', '/document.pdf'),
    document.replace('/document', '/document/'),
    document.replace('/media/', '/media//'),
    document.replace('/media/', '/media/../media/'),
    document.replace('12345678-1234-4321-aaaa-123456789abc', 'not-a-uuid'),
    document.replace('/media/', '/MEDIA/'),
    document.replace('/document', '/DOCUMENT'),
    document.replace('12345678-1234-4321-aaaa-123456789abc', '12345678-1234-4321-AAAA-123456789ABC'),
    document.replace('-4321-', '-0321-'),
    document.replace('-4321-', '-6321-'),
    document.replace('-4321-', '-7321-'),
    document.replace('-aaaa-', '-7aaa-'),
    document.replace('-aaaa-', '-caaa-'),
    document.replace('12345678-1234-4321-aaaa-123456789abc', '00000000-0000-0000-0000-000000000000'),
    `${document}?`,
    `${document}?download=1`,
    `${document}?w=800&format=jpeg`,
    `${document}?url=https://other.example/original.pdf`,
    `${document}?token=private`,
    `${document}?filename=invoice.pdf`,
    `${document}?download=1&download=2`,
    `${document}#fragment`,
    `${document}\\original`,
    document.replace('/media/', '\\media\\'),
    ` ${document}`,
    `${document} `,
    `${document}\n`,
    `${document}\r\n`,
    `${document}\t`,
    `${document}\u2028`,
    `${document}\u0000`
  ])(
    'rejects invoices, raw objects, foreign origins and aliases rather than constructing a public PDF route: %s',
    (source) => {
      expect(publishedDocumentUrl(source)).toBeNull()
    }
  )
})
