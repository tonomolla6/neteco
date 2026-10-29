import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import {
  assignCustomerAccountManager,
  readCustomerAccountManager,
  readCustomerVisibleAccountManager,
  createCustomerCommercialNote,
  listCustomerCommercialNotes,
  createCustomerOpportunity,
  updateCustomerOpportunityStage,
  listCustomerOpportunities,
  scheduleCustomerCalendarEvent,
  updateCustomerCalendarEventStatus,
  listCustomerCalendarEvents
} from '../../workers/crm/account-manager'

describe('SUP-016 Dedicated account manager and commercial CRM per customer', () => {
  let f: Awaited<ReturnType<typeof returnsFixture>>
  const NOW = utc(0)

  beforeEach(async () => {
    f = await returnsFixture()
    const migration = await readFile(
      new URL('../../db/d1/migrations/0102_support_live_chat_and_account_managers.sql', import.meta.url),
      'utf8'
    )
    f.sqlite.exec(migration)
    f.sqlite.exec(
      "INSERT INTO permissions VALUES('support.manage','support','manage','Synthetic test permission');" +
        "INSERT INTO role_permissions VALUES('operator','support.manage');"
    )
  })

  afterEach(() => f.sqlite.close())

  it('assigns dedicated account manager to customer with SLA tier and response hours', async () => {
    const assignment = await assignCustomerAccountManager(
      f.database,
      CLAIMS,
      CUSTOMER,
      {
        managerIdentityId: CLAIMS.identityId,
        managerName: 'Laura Martínez',
        managerEmail: 'laura.martinez@neteco.es',
        managerPhone: '+34 962 111 222 ext 104',
        availabilitySchedule: 'L-V 08:30 - 17:30',
        slaTier: 'priority',
        slaResponseHours: 4,
        slaDescription: 'Compromiso de respuesta técnica y comercial en menos de 4 horas laborables.',
        reason: 'Cliente empresa de volumen industrial asignado a cuenta prioritaria.'
      },
      { now: NOW }
    )

    expect(assignment.id).toBeDefined()
    expect(assignment.customerId).toBe(CUSTOMER)
    expect(assignment.managerName).toBe('Laura Martínez')
    expect(assignment.slaTier).toBe('priority')
    expect(assignment.slaResponseHours).toBe(4)
    expect(assignment.version).toBe(1)

    // Admin read
    const read = await readCustomerAccountManager(f.database, CLAIMS, CUSTOMER)
    expect(read).not.toBeNull()
    expect(read!.managerEmail).toBe('laura.martinez@neteco.es')
  })

  it('exposes visible contact info to assigned customer, but fallback to unassigned customer', async () => {
    // Unassigned customer: returns hasAssignedManager=false and general support channels
    const unassignedView = await readCustomerVisibleAccountManager(f.database, CUSTOMER)
    expect(unassignedView.hasAssignedManager).toBe(false)
    expect(unassignedView.manager).toBeUndefined()
    expect(unassignedView.generalSupport).toBeDefined()
    expect(unassignedView.generalSupport.email).toBe('soporte@neteco.es')

    // Now assign manager
    await assignCustomerAccountManager(
      f.database,
      CLAIMS,
      CUSTOMER,
      {
        managerIdentityId: CLAIMS.identityId,
        managerName: 'Laura Martínez',
        managerEmail: 'laura.martinez@neteco.es',
        managerPhone: '+34 962 111 222 ext 104',
        availabilitySchedule: 'L-V 08:30 - 17:30',
        slaTier: 'vip',
        slaResponseHours: 2,
        reason: 'Paso a cuenta VIP'
      },
      { now: NOW }
    )

    // Assigned customer view now has visible contact!
    const assignedView = await readCustomerVisibleAccountManager(f.database, CUSTOMER)
    expect(assignedView.hasAssignedManager).toBe(true)
    expect(assignedView.manager).toBeDefined()
    expect(assignedView.manager!.name).toBe('Laura Martínez')
    expect(assignedView.manager!.email).toBe('laura.martinez@neteco.es')
    expect(assignedView.manager!.phone).toBe('+34 962 111 222 ext 104')
    expect(assignedView.manager!.slaTier).toBe('vip')
    expect(assignedView.manager!.slaResponseHours).toBe(2)
  })

  it('manages internal commercial notes with categories and strict confidentiality', async () => {
    const note = await createCustomerCommercialNote(
      f.database,
      CLAIMS,
      CUSTOMER,
      {
        category: 'commercial',
        confidentiality: 'internal_sales',
        title: 'Interés en suministro mensual a granel',
        content: 'El cliente solicita estudio de precios para garrafas de 25L con consumo mensual recurrente.'
      },
      { now: NOW }
    )

    expect(note.id).toBeDefined()
    expect(note.category).toBe('commercial')

    const notes = await listCustomerCommercialNotes(f.database, CLAIMS, CUSTOMER)
    expect(notes.length).toBe(1)
    expect(notes[0]?.title).toBe('Interés en suministro mensual a granel')
  })

  it('tracks commercial opportunities with estimated value, stages and CAS', async () => {
    // 1. Create opportunity
    const opp = await createCustomerOpportunity(
      f.database,
      CLAIMS,
      CUSTOMER,
      {
        title: 'Licitación productos desinfección hotelera',
        estimatedValueCents: 450000, // 4,500.00 EUR
        stage: 'proposal',
        probabilityPercent: 60,
        expectedCloseDate: '2026-11-30',
        notes: 'Enviada propuesta inicial.'
      },
      { now: NOW }
    )

    expect(opp.id).toBeDefined()
    expect(opp.estimatedValueCents).toBe(450000)
    expect(opp.stage).toBe('proposal')
    expect(opp.version).toBe(1)

    // 2. Advance stage with CAS
    const won = await updateCustomerOpportunityStage(
      f.database,
      CLAIMS,
      opp.id,
      {
        expectedVersion: 1,
        stage: 'won',
        probabilityPercent: 100,
        notes: 'Cliente firmó contrato marco.',
        reason: 'Aceptación formal de la propuesta comercial.'
      },
      { now: NOW }
    )

    expect(won.stage).toBe('won')
    expect(won.version).toBe(2)

    // 3. Stale update fails CAS
    await expect(
      updateCustomerOpportunityStage(
        f.database,
        CLAIMS,
        opp.id,
        {
          expectedVersion: 1,
          stage: 'lost',
          reason: 'Stale attempt'
        },
        { now: NOW }
      )
    ).rejects.toThrow('version_conflict')

    const list = await listCustomerOpportunities(f.database, CLAIMS, CUSTOMER)
    expect(list.length).toBe(1)
    expect(list[0]?.stage).toBe('won')
  })

  it('schedules calendar interactions strictly requiring customer consent', async () => {
    // Fails without consent
    await expect(
      scheduleCustomerCalendarEvent(
        f.database,
        CLAIMS,
        CUSTOMER,
        {
          managerIdentityId: CLAIMS.identityId,
          subject: 'Revisión técnica de dosificadores',
          scheduledAt: '2026-11-05T11:00:00Z',
          durationMinutes: 45,
          channel: 'video',
          customerConsentVerified: false as unknown as true,
          consentReference: 'Ref-Consent-123'
        },
        { now: NOW }
      )
    ).rejects.toThrow('consent_required')

    // Succeeds with verified consent
    const event = await scheduleCustomerCalendarEvent(
      f.database,
      CLAIMS,
      CUSTOMER,
      {
        managerIdentityId: CLAIMS.identityId,
        subject: 'Revisión técnica de dosificadores',
        scheduledAt: '2026-11-05T11:00:00Z',
        durationMinutes: 45,
        channel: 'video',
        customerConsentVerified: true,
        consentReference: 'Llamada telefónica grabada 2026-10-28 ref #492',
        notes: 'Presentación de catálogo dosificadores automáticos.'
      },
      { now: NOW }
    )

    expect(event.id).toBeDefined()
    expect(event.status).toBe('scheduled')
    expect(event.customerConsentVerified).toBe(1)

    // Update status to confirmed
    const confirmed = await updateCustomerCalendarEventStatus(
      f.database,
      CLAIMS,
      event.id,
      {
        status: 'confirmed',
        notes: 'Enlace de videollamada enviado y confirmado por el cliente.'
      },
      { now: NOW }
    )
    expect(confirmed.status).toBe('confirmed')

    const events = await listCustomerCalendarEvents(f.database, CLAIMS, CUSTOMER)
    expect(events.length).toBe(1)
    expect(events[0]?.subject).toBe('Revisión técnica de dosificadores')
  })
})
