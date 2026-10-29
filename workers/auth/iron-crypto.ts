import type { unseal } from 'iron-webcrypto'

// iron-webcrypto v1 predates TypeScript's ArrayBuffer/SharedArrayBuffer split.
// Copy its input views to owned buffers accepted by current Web Crypto types.
// Keep native method receivers; never cast incompatible crypto signatures.
export const ironCrypto: Parameters<typeof unseal>[0] = {
  getRandomValues: (array) => crypto.getRandomValues(array),
  subtle: {
    decrypt: (algorithm, key, data) => crypto.subtle.decrypt(algorithm, key, new Uint8Array(data)),
    encrypt: (algorithm, key, data) => crypto.subtle.encrypt(algorithm, key, new Uint8Array(data)),
    sign: (algorithm, key, data) => crypto.subtle.sign(algorithm, key, new Uint8Array(data)),
    deriveBits: (algorithm, key, length) => crypto.subtle.deriveBits(algorithm, key, length),
    importKey: (format, data, algorithm, extractable, usages) =>
      crypto.subtle.importKey(
        format,
        data instanceof Uint8Array ? new Uint8Array(data) : data,
        algorithm,
        extractable,
        usages
      )
  }
}
