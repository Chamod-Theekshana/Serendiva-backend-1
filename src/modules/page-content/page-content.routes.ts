import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { LocaleQuery } from '@/lib/i18n'
import { publicCache } from '@/plugins/http-cache'
import { adminErrorResponses, errorResponses } from '@/lib/schemas'
import { AdminPageContentSchema, PageContentBodySchema, PageContentParams, PublicPageContentSchema } from './page-content.schemas'
import { createPageContentService } from './page-content.service'

/** GET /api/v1/page-content/public */
export const pageContentPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createPageContentService(app.deps)

  app.get(
    '/page-content/public',
    {
      config: publicCache,
      schema: {
        tags: ['Content'],
        summary: 'Admin overrides of the static page copy (English + the requested locale)',
        querystring: LocaleQuery,
        response: { 200: PublicPageContentSchema, ...errorResponses },
      },
    },
    async (req) => service.publicList(req.query.locale),
  )
}

/** /api/v1/admin/page-content */
export const pageContentAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = createPageContentService(app.deps)
  app.addHook('onRequest', app.authenticate)
  const tags = ['Admin · Page content']
  const security = [{ cookieAuth: [] }]

  app.get(
    '/page-content',
    { schema: { tags, security, summary: 'Every stored page-copy override', response: { 200: AdminPageContentSchema, ...adminErrorResponses } } },
    async () => service.adminList(),
  )

  app.put(
    '/page-content/:namespace',
    {
      schema: {
        tags,
        security,
        summary: 'Replace the copy overrides (and hidden sections) of one page namespace',
        params: PageContentParams,
        body: PageContentBodySchema,
        response: { 200: AdminPageContentSchema, ...adminErrorResponses },
      },
    },
    async (req) => service.update(req.params.namespace, req.body),
  )
}
