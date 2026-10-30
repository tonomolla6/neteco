import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createBaTestWorld,
  ADMIN_IDENTITY,
  CONTENT_MGR_IDENTITY,
  ORDER_MGR_IDENTITY,
  MKT_MGR_IDENTITY,
  UNPRIVILEGED_IDENTITY,
  SESSION_PASSWORD,
  TEST_ORIGIN,
  FIXTURE_NOW,
  type BaTestWorld
} from './d1-ba-preview-diff-fixtures'
import { handleCmsPreviewComparisonHttp } from '../../workers/cms/preview-comparison-http'
import { handleRoleDashboardHttp } from '../../workers/admin/role-dashboard-http'
import { handleCommercialCampaignsHttp } from '../../workers/marketing/commercial-campaigns-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

describe('BA HTTP Endpoints: CMS Preview Comparison, Role Dashboard, Commercial Campaigns', () => {
  let world: BaTestWorld
  let adminCookie: string
  let contentCookie: string
  let orderCookie: string
  let mktCookie: string
  let unprivilegedCookie: string

  const PAGE_ID = '40000000-0000-4000-8000-000000000001'
  const V1_ID = '50000000-0000-4000-8000-000000000001'
  const V2_ID = '50000000-0000-4000-8000-000000000002'

  beforeEach(async () => {
    world = await createBaTestWorld()

    // Issue cookies
    adminCookie = (await issueD1SessionCookie(
      world.db,
      { sessionId: '20000000-0000-4000-8000-000000000001', identityId: ADMIN_IDENTITY, sessionVersion: 1 },
      { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!

    contentCookie = (await issueD1SessionCookie(
      world.db,
      { sessionId: '20000000-0000-4000-8000-000000000002', identityId: CONTENT_MGR_IDENTITY, sessionVersion: 1 },
      { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!

    orderCookie = (await issueD1SessionCookie(
      world.db,
      { sessionId: '20000000-0000-4000-8000-000000000003', identityId: ORDER_MGR_IDENTITY, sessionVersion: 1 },
      { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!

    mktCookie = (await issueD1SessionCookie(
      world.db,
      { sessionId: '20000000-0000-4000-8000-000000000005', identityId: MKT_MGR_IDENTITY, sessionVersion: 1 },
      { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!

    unprivilegedCookie = (await issueD1SessionCookie(
      world.db,
      { sessionId: '20000000-0000-4000-8000-000000000009', identityId: UNPRIVILEGED_IDENTITY, sessionVersion: 1 },
      { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!

    // Seed test page
    world.sqlite.exec(`
      INSERT INTO content_pages (id, slug, title, status, page_version, draft_version, draft_version_id, created_by, created_at, updated_at)
      VALUES ('${PAGE_ID}', 'desengrasante-eco', 'Desengrasante Eco', 'draft', 1, 0, NULL, '${CONTENT_MGR_IDENTITY}', '${FIXTURE_NOW}', '${FIXTURE_NOW}');

      INSERT INTO content_versions (id, page_id, version, document, based_on_id, created_by, created_at)
      VALUES
        ('${V1_ID}', '${PAGE_ID}', 1, json('{"title":"Desengrasante Eco","slug":"desengrasante-eco","seo":{"title":"SEO1","description":"Desc1","noindex":false},"blocks":[]}'), NULL, '${CONTENT_MGR_IDENTITY}', '${FIXTURE_NOW}'),
        ('${V2_ID}', '${PAGE_ID}', 2, json('{"title":"Desengrasante Eco ULTRA","slug":"desengrasante-eco","seo":{"title":"SEO2","description":"Desc2","noindex":false},"blocks":[]}'), '${V1_ID}', '${CONTENT_MGR_IDENTITY}', '${FIXTURE_NOW}');

      UPDATE content_pages SET page_version = 2, draft_version = 2, draft_version_id = '${V2_ID}', title = 'Desengrasante Eco ULTRA' WHERE id = '${PAGE_ID}';
    `)
  })

  afterEach(() => world.close())

  const previewDeps = () => ({
    database: world.db,
    origin: TEST_ORIGIN,
    sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
  })

  const dashboardDeps = () => ({
    database: world.db,
    origin: TEST_ORIGIN,
    sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
  })

  const campaignDeps = () => ({
    database: world.db,
    origin: TEST_ORIGIN,
    sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
  })

  describe('handleCmsPreviewComparisonHttp (ADM-024)', () => {
    it('returns preview comparison diff via GET /api/admin/content/preview-comparison', async () => {
      const req = new Request(
        `${TEST_ORIGIN}/api/admin/content/preview-comparison?pageId=${PAGE_ID}&baseVersion=1&compareVersion=2`,
        { headers: { cookie: contentCookie } }
      )
      const res = await handleCmsPreviewComparisonHttp(req, previewDeps())
      expect(res).not.toBeNull()
      expect(res?.status).toBe(200)

      const body = await res?.json()
      expect(body.pageId).toBe(PAGE_ID)
      expect(body.diff.hasChanges).toBe(true)
      expect(body.breakpoints.mobile.width).toBe(375)
    })

    it('rejects unauthenticated request with 401', async () => {
      const req = new Request(
        `${TEST_ORIGIN}/api/admin/content/preview-comparison?pageId=${PAGE_ID}&baseVersion=1&compareVersion=2`
      )
      const res = await handleCmsPreviewComparisonHttp(req, previewDeps())
      expect(res?.status).toBe(401)
    })

    it('executes critical template regression check via POST /api/admin/content/templates/critical-regression', async () => {
      const req = new Request(`${TEST_ORIGIN}/api/admin/content/templates/critical-regression`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          templateName: 'home',
          breakpoint: 'desktop',
          renderedSelectors: ['header', 'nav', 'main', 'footer']
        })
      })
      const res = await handleCmsPreviewComparisonHttp(req, previewDeps())
      expect(res?.status).toBe(200)
      const body = await res?.json()
      expect(body.passed).toBe(true)
    })

    it('rejects unprivileged user with 403 on preview comparison', async () => {
      const req = new Request(
        `${TEST_ORIGIN}/api/admin/content/preview-comparison?pageId=${PAGE_ID}&baseVersion=1&compareVersion=2`,
        { headers: { cookie: unprivilegedCookie } }
      )
      const res = await handleCmsPreviewComparisonHttp(req, previewDeps())
      expect(res?.status).toBe(403)
      const body = await res?.json()
      expect(body.error.code).toBe('forbidden')
    })

    it('rejects cross-site request on POST /api/admin/content/templates/critical-regression with 403', async () => {
      const req = new Request(`${TEST_ORIGIN}/api/admin/content/templates/critical-regression`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site'
        },
        body: JSON.stringify({
          templateName: 'home',
          breakpoint: 'desktop',
          renderedSelectors: ['header']
        })
      })
      const res = await handleCmsPreviewComparisonHttp(req, previewDeps())
      expect(res?.status).toBe(403)
      const body = await res?.json()
      expect(body.error.code).toBe('csrf_rejected')
    })
  })

  describe('handleRoleDashboardHttp (ADM-025)', () => {
    it('handles GET and PUT /api/admin/dashboard/config and /api/admin/dashboard/role-config', async () => {
      // 1. GET default config
      const getReq = new Request(`${TEST_ORIGIN}/api/admin/dashboard/config?role=order_manager`, {
        headers: { cookie: orderCookie }
      })
      const getRes = await handleRoleDashboardHttp(getReq, dashboardDeps())
      expect(getRes?.status).toBe(200)
      const config = await getRes?.json()
      expect(config.roleCode).toBe('order_manager')
      expect(config.widgets.some((w: { widgetId: string }) => w.widgetId === 'mandatory_alerts')).toBe(true)

      // 2. PUT updated config
      const putReq = new Request(`${TEST_ORIGIN}/api/admin/dashboard/role-config`, {
        method: 'PUT',
        headers: { cookie: orderCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: 'cmd-http-config-01',
          roleCode: 'order_manager',
          expectedVersion: 0,
          widgets: [
            { widgetId: 'mandatory_alerts', visible: true, order: 1, colSpan: 12, isMandatory: true },
            { widgetId: 'orders_summary', visible: true, order: 2, colSpan: 6 }
          ],
          columnPreferences: { ordersTable: ['createdAt', 'total'] }
        })
      })
      const putRes = await handleRoleDashboardHttp(putReq, dashboardDeps())
      expect(putRes?.status).toBe(200)
      const updated = await putRes?.json()
      expect(updated.version).toBe(1)
    })

    it('rejects PUT that tries to hide mandatory alerts with 400', async () => {
      const putReq = new Request(`${TEST_ORIGIN}/api/admin/dashboard/role-config`, {
        method: 'PUT',
        headers: { cookie: orderCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: 'cmd-http-config-malicious',
          roleCode: 'order_manager',
          expectedVersion: 0,
          widgets: [{ widgetId: 'mandatory_alerts', visible: false, order: 1, colSpan: 12, isMandatory: true }],
          columnPreferences: {}
        })
      })
      const putRes = await handleRoleDashboardHttp(putReq, dashboardDeps())
      expect(putRes?.status).toBe(400)
      const err = await putRes?.json()
      expect(err.error.code).toBe('mandatory_alerts_cannot_be_hidden')
    })

    it('handles saved views lifecycle (POST, GET, DELETE)', async () => {
      // POST view
      const postReq = new Request(`${TEST_ORIGIN}/api/admin/dashboard/views`, {
        method: 'POST',
        headers: { cookie: orderCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: 'cmd-http-view-01',
          roleCode: 'order_manager',
          viewType: 'orders',
          name: 'Vista Pedidos Urgentes',
          scope: 'role_shared',
          isDefault: true,
          definition: { bucket: 'por_preparar' }
        })
      })
      const postRes = await handleRoleDashboardHttp(postReq, dashboardDeps())
      expect(postRes?.status).toBe(201)
      const savedView = await postRes?.json()
      expect(savedView.id).toBeDefined()

      // GET views
      const listReq = new Request(`${TEST_ORIGIN}/api/admin/dashboard/views?viewType=orders&role=order_manager`, {
        headers: { cookie: orderCookie }
      })
      const listRes = await handleRoleDashboardHttp(listReq, dashboardDeps())
      expect(listRes?.status).toBe(200)
      const viewsList = await listRes?.json()
      expect(viewsList.views.length).toBe(1)

      // DELETE view
      const delReq = new Request(
        `${TEST_ORIGIN}/api/admin/dashboard/views/${savedView.id}?expectedVersion=1&commandId=cmd-http-del-01`,
        { method: 'DELETE', headers: { cookie: orderCookie } }
      )
      const delRes = await handleRoleDashboardHttp(delReq, dashboardDeps())
      expect(delRes?.status).toBe(200)
    })

    it('rejects unprivileged user with 403 on dashboard config and views', async () => {
      const getCfgReq = new Request(`${TEST_ORIGIN}/api/admin/dashboard/config?role=admin`, {
        headers: { cookie: unprivilegedCookie }
      })
      const getCfgRes = await handleRoleDashboardHttp(getCfgReq, dashboardDeps())
      expect(getCfgRes?.status).toBe(403)

      const getViewsReq = new Request(`${TEST_ORIGIN}/api/admin/dashboard/views?viewType=orders&role=admin`, {
        headers: { cookie: unprivilegedCookie }
      })
      const getViewsRes = await handleRoleDashboardHttp(getViewsReq, dashboardDeps())
      expect(getViewsRes?.status).toBe(403)
    })

    it('rejects cross-site request on PUT /api/admin/dashboard/role-config with 403', async () => {
      const putReq = new Request(`${TEST_ORIGIN}/api/admin/dashboard/role-config`, {
        method: 'PUT',
        headers: {
          cookie: orderCookie,
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site'
        },
        body: JSON.stringify({
          commandId: 'cmd-csrf-01',
          roleCode: 'order_manager',
          expectedVersion: 0,
          widgets: [{ widgetId: 'mandatory_alerts', visible: true, order: 1, colSpan: 12, isMandatory: true }],
          columnPreferences: {}
        })
      })
      const putRes = await handleRoleDashboardHttp(putReq, dashboardDeps())
      expect(putRes?.status).toBe(403)
      const body = await putRes?.json()
      expect(body.error.code).toBe('csrf_rejected')
    })
  })

  describe('handleCommercialCampaignsHttp (ADM-026)', () => {
    it('handles campaign creation, asset linking, calendar feed and conflict detection', async () => {
      // 1. POST campaign
      const createReq = new Request(`${TEST_ORIGIN}/api/admin/campaigns`, {
        method: 'POST',
        headers: { cookie: mktCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: 'cmd-camp-http-01',
          code: 'camp-primavera-2026',
          name: 'Campaña Primavera 2026',
          description: 'Descuentos y bundles de limpieza ecológica',
          channelType: 'omnichannel',
          targetAudience: 'all',
          priority: 80,
          startAt: '2026-11-01T00:00:00Z',
          endAt: '2026-11-20T23:59:59Z'
        })
      })
      const createRes = await handleCommercialCampaignsHttp(createReq, campaignDeps())
      expect(createRes?.status).toBe(201)
      const campaign = await createRes?.json()
      expect(campaign.id).toBeDefined()

      // 2. Link Banner asset
      const linkReq = new Request(`${TEST_ORIGIN}/api/admin/campaigns/${campaign.id}/assets`, {
        method: 'POST',
        headers: { cookie: mktCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: 'cmd-link-asset-http-01',
          assetType: 'banner',
          assetId: 'banner-primavera-top',
          assetName: 'Banner Superior Primavera',
          placementOrSlot: 'home_hero',
          startAt: '2026-11-01T00:00:00Z',
          endAt: '2026-11-20T23:59:59Z',
          config: { image: '/img/primavera.webp' }
        })
      })
      const linkRes = await handleCommercialCampaignsHttp(linkReq, campaignDeps())
      expect(linkRes?.status).toBe(201)
      const asset = await linkRes?.json()
      expect(asset.assetType).toBe('banner')

      // 3. GET campaign detail
      const detailReq = new Request(`${TEST_ORIGIN}/api/admin/campaigns/${campaign.id}`, {
        headers: { cookie: mktCookie }
      })
      const detailRes = await handleCommercialCampaignsHttp(detailReq, campaignDeps())
      expect(detailRes?.status).toBe(200)
      const detail = await detailRes?.json()
      expect(detail.linkedAssets.length).toBe(1)

      // 4. GET calendar
      const calReq = new Request(`${TEST_ORIGIN}/api/admin/campaigns/calendar?month=2026-11`, {
        headers: { cookie: mktCookie }
      })
      const calRes = await handleCommercialCampaignsHttp(calReq, campaignDeps())
      expect(calRes?.status).toBe(200)
      const cal = await calRes?.json()
      expect(cal.month).toBe('2026-11')
      expect(cal.days.length).toBe(30)

      // 5. GET conflicts
      const confReq = new Request(
        `${TEST_ORIGIN}/api/admin/campaigns/conflicts?startAt=2026-11-01T00:00:00Z&endAt=2026-11-30T23:59:59Z`,
        {
          headers: { cookie: mktCookie }
        }
      )
      const confRes = await handleCommercialCampaignsHttp(confReq, campaignDeps())
      expect(confRes?.status).toBe(200)
      const conf = await confRes?.json()
      expect(Array.isArray(conf.conflicts)).toBe(true)
    })

    it('rejects unauthorized users from campaign listing, calendar, and conflicts with 403', async () => {
      // 1. Unprivileged user on listing
      const listReq = new Request(`${TEST_ORIGIN}/api/admin/campaigns`, {
        headers: { cookie: unprivilegedCookie }
      })
      const listRes = await handleCommercialCampaignsHttp(listReq, campaignDeps())
      expect(listRes?.status).toBe(403)

      // 2. Order manager (lacks campaigns.manage) on calendar
      const calReq = new Request(`${TEST_ORIGIN}/api/admin/campaigns/calendar?month=2026-11`, {
        headers: { cookie: orderCookie }
      })
      const calRes = await handleCommercialCampaignsHttp(calReq, campaignDeps())
      expect(calRes?.status).toBe(403)

      // 3. Unprivileged on conflicts
      const confReq = new Request(`${TEST_ORIGIN}/api/admin/campaigns/conflicts`, {
        headers: { cookie: unprivilegedCookie }
      })
      const confRes = await handleCommercialCampaignsHttp(confReq, campaignDeps())
      expect(confRes?.status).toBe(403)
    })

    it('validates PUT /api/admin/campaigns/:id body with Zod schema and rejects invalid input with 400', async () => {
      // First create a campaign to update
      const createReq = new Request(`${TEST_ORIGIN}/api/admin/campaigns`, {
        method: 'POST',
        headers: { cookie: mktCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: 'cmd-camp-put-test-01',
          code: 'camp-for-put-test',
          name: 'Campaña Original',
          channelType: 'web',
          targetAudience: 'all',
          priority: 50,
          startAt: '2026-11-01T00:00:00Z',
          endAt: '2026-11-20T23:59:59Z'
        })
      })
      const createRes = await handleCommercialCampaignsHttp(createReq, campaignDeps())
      expect(createRes?.status).toBe(201)
      const campaign = await createRes?.json()

      // Invalid PUT with endAt < startAt
      const putInvalidReq = new Request(`${TEST_ORIGIN}/api/admin/campaigns/${campaign.id}`, {
        method: 'PUT',
        headers: { cookie: mktCookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: 'cmd-put-invalid-01',
          expectedVersion: 1,
          startAt: '2026-11-20T00:00:00Z',
          endAt: '2026-11-10T00:00:00Z'
        })
      })
      const putInvalidRes = await handleCommercialCampaignsHttp(putInvalidReq, campaignDeps())
      expect(putInvalidRes?.status).toBe(400)
      const err = await putInvalidRes?.json()
      expect(err.error.code).toBe('invalid_body')
    })

    it('rejects cross-site request on POST /api/admin/campaigns with 403', async () => {
      const createReq = new Request(`${TEST_ORIGIN}/api/admin/campaigns`, {
        method: 'POST',
        headers: {
          cookie: mktCookie,
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site'
        },
        body: JSON.stringify({
          commandId: 'cmd-csrf-camp-01',
          code: 'camp-csrf',
          name: 'Campaña CSRF',
          channelType: 'web',
          startAt: '2026-11-01T00:00:00Z',
          endAt: '2026-11-20T23:59:59Z'
        })
      })
      const res = await handleCommercialCampaignsHttp(createReq, campaignDeps())
      expect(res?.status).toBe(403)
      const body = await res?.json()
      expect(body.error.code).toBe('csrf_rejected')
    })
  })
})
