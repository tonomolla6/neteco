import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { isD1CheckConstraintFailure } from '../../workers/runtime/d1-errors'

describe('D1 CHECK constraint evidence', () => {
  it.each([
    'CHECK constraint failed: cart_guard',
    "CHECK constraint failed: status IN ('active', 'converted', 'expired')",
    'CHECK constraint failed: quantity > 0\n AND quantity < 1000',
    'D1_ERROR: CHECK constraint failed: cart_guard: SQLITE_CONSTRAINT',
    "D1_ERROR: CHECK constraint failed: status IN ('active', 'expired', 'converted'): SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
    'D1_ERROR: CHECK constraint failed: quantity > 0\n AND quantity < 1000: SQLITE_CONSTRAINT'
  ])('recognizes the anchored database format %j', (message) => {
    expect(isD1CheckConstraintFailure(new Error(message))).toBe(true)
  })

  it('recognizes an actual SQLite CHECK failure and its D1 wrapper', () => {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec('CREATE TABLE evidence(value INTEGER CONSTRAINT positive CHECK(value > 0))')
      try {
        database.exec('INSERT INTO evidence(value) VALUES (0)')
        throw new Error('Expected SQLite to reject the value')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect(isD1CheckConstraintFailure(error)).toBe(true)
        if (!(error instanceof Error)) throw error
        expect(isD1CheckConstraintFailure(new Error(`D1_ERROR: ${error.message}: SQLITE_CONSTRAINT`))).toBe(true)
      }
    } finally {
      database.close()
    }
  })

  it.each([
    'D1_ERROR: provider unavailable; CHECK constraint failed private_table',
    'D1_ERROR: provider unavailable; CHECK constraint failed: private_table: SQLITE_CONSTRAINT',
    'provider unavailable CHECK constraint failed: private_table',
    'Error: CHECK constraint failed: cart_guard',
    ' CHECK constraint failed: cart_guard',
    '\nCHECK constraint failed: cart_guard',
    'CHECK constraint failed',
    'CHECK constraint failed: ',
    'CHECK constraint failed: \n\t',
    'CHECK constraint failed: cart_guard\u0000',
    'D1_ERROR: CHECK constraint failed: cart_guard',
    'D1_ERROR: CHECK constraint failed: : SQLITE_CONSTRAINT',
    'D1_ERROR: CHECK constraint failed: cart_guard: SQLITE_CONSTRAINT\n',
    'D1_ERROR: CHECK constraint failed: cart_guard: SQLITE_CONSTRAINT; provider unavailable',
    'D1_ERROR: CHECK constraint failed: cart_guard: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
    'D1_ERROR: CHECK constraint failed: cart_guard: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)\n',
    'D1_ERROR: provider unavailable; CHECK constraint failed: cart_guard: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)',
    'D1_ERROR: UNIQUE constraint failed: cart_commands.command_id: SQLITE_CONSTRAINT',
    'D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT'
  ])('does not turn unrelated or malformed evidence into a CHECK failure %j', (message) => {
    expect(isD1CheckConstraintFailure(new Error(message))).toBe(false)
  })

  it.each([
    undefined,
    null,
    false,
    1,
    'CHECK constraint failed: cart_guard',
    { message: 'CHECK constraint failed: cart_guard' }
  ])('rejects non-Error evidence %j', (error) => {
    expect(isD1CheckConstraintFailure(error)).toBe(false)
  })

  it('does not invoke an accessor or coerce an invalid Error message', () => {
    const getter = vi.fn(() => 'CHECK constraint failed: cart_guard')
    const accessor = Object.defineProperty(new Error(), 'message', { get: getter })
    expect(isD1CheckConstraintFailure(accessor)).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    const value = Object.defineProperty(new Error(), 'message', { value: 1 })
    expect(isD1CheckConstraintFailure(value)).toBe(false)
  })

  it('fails closed on a hostile Error proxy without propagating its trap', () => {
    const error = new Proxy(new Error('CHECK constraint failed: cart_guard'), {
      getOwnPropertyDescriptor() {
        throw new Error('synthetic unavailable descriptor')
      }
    })
    expect(isD1CheckConstraintFailure(error)).toBe(false)
  })
})
