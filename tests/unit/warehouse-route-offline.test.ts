import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openMigratedDatabase } from '../support/d1-sqlite'
import {
  setupWarehouseRouteFixture,
  type WarehouseRouteWorld,
  executeWarehouseScan,
  executePrintJob,
  executeOfflineReconnectionSync,
  handleDuplicateScan,
  handleLostDeviceRevocation,
  reconcileFulfillmentAndInventory
} from '../../workers/fulfillment/warehouse-route-offline'

describe('TST-043: Warehouse, route and offline operations test suite', () => {
  let sqlite: DatabaseSync
  let world: WarehouseRouteWorld

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    world = await setupWarehouseRouteFixture(sqlite)
  })

  afterEach(() => {
    if (sqlite?.isOpen) {
      sqlite.close()
    }
  })

  it('1. Escaneo: Valid barcode scan updates quantity, invalid barcode raises mismatch exception', async () => {
    // 1a: Valid barcode scan for reception
    const scanResult = await executeWarehouseScan(world.database, world.operatorClaims, {
      queueType: 'reception',
      targetId: world.receptionId,
      barcode: '8437000000012',
      quantity: 5
    })
    expect(scanResult.success).toBe(true)
    expect(scanResult.scannedQty).toBe(5)
    expect(scanResult.remainingQty).toBe(5) // expected 10, scanned 5
    expect(scanResult.queueItemStatus).toBe('in_progress')

    // 1b: Second valid scan completes the reception
    const scanComplete = await executeWarehouseScan(world.database, world.operatorClaims, {
      queueType: 'reception',
      targetId: world.receptionId,
      barcode: '8437000000012',
      quantity: 5
    })
    expect(scanComplete.scannedQty).toBe(10)
    expect(scanComplete.remainingQty).toBe(0)
    expect(scanComplete.queueItemStatus).toBe('completed')

    // 1c: Unknown barcode throws and reports exception
    await expect(
      executeWarehouseScan(world.database, world.operatorClaims, {
        queueType: 'reception',
        targetId: world.receptionId,
        barcode: 'UNKNOWN-BARCODE-999',
        quantity: 1
      })
    ).rejects.toMatchObject({ code: 'barcode_not_found' })
  })

  it('2. Impresión: Label print job succeeds on active printer and fails gracefully on offline printer', async () => {
    // 2a: Print on active online printer
    const printResult = await executePrintJob(world.database, world.operatorClaims, {
      printerId: 'printer-zpl-01',
      labelType: 'parcel_4x6',
      documentId: 'DOC-SHIP-001',
      copies: 1
    })
    expect(printResult.status).toBe('completed')
    expect(printResult.copies).toBe(1)

    // 2b: Print on offline printer
    await expect(
      executePrintJob(world.database, world.operatorClaims, {
        printerId: 'printer-offline-02',
        labelType: 'parcel_4x6',
        documentId: 'DOC-SHIP-002',
        copies: 1
      })
    ).rejects.toMatchObject({ code: 'printer_offline' })

    // 2c: Idempotent reprint returns existing completed job
    const reprintResult = await executePrintJob(world.database, world.operatorClaims, {
      printerId: 'printer-zpl-01',
      labelType: 'parcel_4x6',
      documentId: 'DOC-SHIP-001',
      copies: 1
    })
    expect(reprintResult.status).toBe('completed')
    expect(reprintResult.isReprint).toBe(true)
  })

  it('3. Reconexión: Offline delivery event batch syncs in order upon network restoration', async () => {
    const offlineBatch = {
      events: [
        {
          commandId: 'cmd-offline-01',
          kind: 'start_route' as const,
          routeId: world.routeId,
          occurredAt: '2026-10-31T07:30:00Z'
        },
        {
          commandId: 'cmd-offline-02',
          kind: 'start' as const,
          stopId: world.stopId,
          occurredAt: '2026-10-31T07:45:00Z'
        },
        {
          commandId: 'cmd-offline-03',
          kind: 'deliver' as const,
          stopId: world.stopId,
          occurredAt: '2026-10-31T08:00:00Z',
          pod: {
            method: 'signature' as const,
            receivedBy: 'Encargado Almacén',
            evidence: {
              mime: 'image/png' as const,
              base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
            }
          }
        }
      ]
    }

    const syncResult = await executeOfflineReconnectionSync(world.database, world.driverClaims, offlineBatch)
    expect(syncResult.appliedCount).toBe(3)
    expect(syncResult.routeStatus).toBe('completed')
    expect(syncResult.stopStatus).toBe('delivered')
    expect(syncResult.results.every((r) => r.outcome === 'applied')).toBe(true)
  })

  it('4. Duplicado: Handles duplicate scan and idempotent replay of sync events', async () => {
    // 4a: Scan beyond expected item quantity
    const duplicateScan = await handleDuplicateScan(world.database, world.operatorClaims, {
      queueType: 'reception',
      targetId: world.receptionId,
      barcode: '8437000000012',
      excessQuantity: 5
    })
    expect(duplicateScan.flaggedDuplicate).toBe(true)
    expect(duplicateScan.reason).toBe('item_already_completed')

    // 4b: Replay of identical sync event returns 'replayed' without state mutation
    const replayEvent = {
      events: [
        {
          commandId: 'cmd-replay-test-01',
          kind: 'start_route' as const,
          routeId: world.routeId,
          occurredAt: '2026-10-31T08:00:00Z'
        }
      ]
    }
    const firstAttempt = await executeOfflineReconnectionSync(world.database, world.driverClaims, replayEvent)
    expect(firstAttempt.results[0]!.outcome).toBe('applied')

    const secondAttempt = await executeOfflineReconnectionSync(world.database, world.driverClaims, replayEvent)
    expect(secondAttempt.results[0]!.outcome).toBe('replayed')
  })

  it('5. Dispositivo perdido: Revokes compromised device and blocks subsequent syncs', async () => {
    // 5a: Device is reported lost and session is revoked
    const revokeResult = await handleLostDeviceRevocation(world.database, world.adminClaims, {
      lostIdentityId: world.driverClaims.identityId,
      reason: 'Tablet extraviada en ruta comercial 3'
    })
    expect(revokeResult.revoked).toBe(true)
    expect(revokeResult.activeSessionsTerminated).toBeGreaterThanOrEqual(1)

    // 5b: Sync attempt from lost device is rejected
    const blockedSync = executeOfflineReconnectionSync(world.database, world.driverClaims, {
      events: [
        {
          commandId: 'cmd-lost-device-01',
          kind: 'start_route' as const,
          routeId: world.routeId,
          occurredAt: '2026-10-31T09:00:00Z'
        }
      ]
    })
    await expect(blockedSync).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('6. Conciliación: Inventory and fulfillment reconcile with zero discrepancy and detect real ledger tampering', async () => {
    const report = await reconcileFulfillmentAndInventory(world.database, world.adminClaims, {
      orderId: world.orderId
    })
    expect(report.isReconciled).toBe(true)
    expect(report.orderedQuantity).toBe(report.fulfilledQuantity)
    expect(report.inventoryDecremented).toBe(report.fulfilledQuantity)
    expect(report.discrepancies).toHaveLength(0)
    expect(report.ledgerConsistent).toBe(true)

    // Tamper with reservation quantity in D1 to verify real reconciliation detection
    world.sqlite.exec('UPDATE inventory_reservation_lines SET quantity = quantity + 3')
    const tamperedReport = await reconcileFulfillmentAndInventory(world.database, world.adminClaims, {
      orderId: world.orderId
    })
    expect(tamperedReport.isReconciled).toBe(false)
    expect(tamperedReport.discrepancies.length).toBeGreaterThan(0)
  })
})
