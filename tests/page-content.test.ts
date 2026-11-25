import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAdmin } from './factories'
import { buildTestApp, login, type ErrorBody, type Session, type TestContext } from './helpers'

let ctx: TestContext
let session: Session

interface Entry {
  namespace: string
  locale: string
  values: Record<string, string>
  hidden: string[]
}

beforeAll(async () => {
  ctx = await buildTestApp()
  await createAdmin(ctx.app.deps.prisma)
  session = await login(ctx.app)
})
afterAll(async () => {
  await ctx.close()
})
beforeEach(async () => {
  await ctx.app.deps.prisma.pageContent.deleteMany()
  ctx.revalidate.reset()
})

const put = (namespace: string, payload: unknown, cookies = session.cookies) =>
  ctx.app.inject({ method: 'PUT', url: `/api/v1/admin/page-content/${namespace}`, cookies, payload: payload as object })

const publicList = (locale = 'en') =>
  ctx.app.inject({ method: 'GET', url: `/api/v1/page-content/public?locale=${locale}` })

describe('page content overrides', () => {
  it('is empty by default (the website then shows its JSON defaults)', async () => {
    const res = await publicList()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [] })
  })

  it('requires a session for admin routes', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/v1/admin/page-content' })
    expect(anon.statusCode).toBe(401)
    const write = await put('corporate', { values: {} }, {})
    expect(write.statusCode).toBe(401)
  })

  it('stores overrides, drops empty strings, and serves them publicly', async () => {
    const res = await put('corporate', {
      values: { 'testimonial.quote': 'A real quote', 'hero.title': '   ' },
      hidden: ['testimonial', 'testimonial'],
    })
    expect(res.statusCode).toBe(200)
    const items = res.json<{ items: (Entry & { updatedAt: string })[] }>().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      namespace: 'corporate',
      locale: 'en',
      values: { 'testimonial.quote': 'A real quote' },
      hidden: ['testimonial'],
    })
    expect(ctx.revalidate.calls).toEqual([['page-content']])

    const pub = await publicList('de')
    expect(pub.json<{ items: Entry[] }>().items).toEqual([
      { namespace: 'corporate', locale: 'en', values: { 'testimonial.quote': 'A real quote' }, hidden: ['testimonial'], lists: {} },
    ])
  })

  it('replaces the whole namespace on save; an empty body removes it', async () => {
    await put('home', { values: { 'hero.intro': 'one', 'craft.quote': 'two' } })
    await put('home', { values: { 'hero.intro': 'three' } })
    const after = await publicList()
    expect(after.json<{ items: Entry[] }>().items[0]?.values).toEqual({ 'hero.intro': 'three' })

    const cleared = await put('home', { values: {}, hidden: [] })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json<{ items: Entry[] }>().items).toEqual([])
  })

  it('stores re-ordered / extended lists (an empty list is kept) and drops empty item texts', async () => {
    const res = await put('corporate', {
      values: {},
      lists: {
        'process.steps': [
          { key: 'execution', values: {} },
          { key: 'aftercare', values: { title: 'Aftercare', body: 'I stay in touch.', phase: '', icon: 'favorite' } },
        ],
        'hero.stats': [],
      },
    })
    expect(res.statusCode).toBe(200)
    const pub = await publicList()
    expect(pub.json<{ items: (Entry & { lists: unknown })[] }>().items[0]?.lists).toEqual({
      'process.steps': [
        { key: 'execution', values: {} },
        { key: 'aftercare', values: { title: 'Aftercare', body: 'I stay in touch.', icon: 'favorite' } },
      ],
      'hero.stats': [],
    })
  })

  it('rejects invalid or duplicate list item keys', async () => {
    const numeric = await put('corporate', { values: {}, lists: { 'process.steps': [{ key: '1', values: {} }] } })
    expect(numeric.statusCode).toBe(400)
    const dup = await put('corporate', {
      values: {},
      lists: { 'process.steps': [{ key: 'a', values: {} }, { key: 'a', values: {} }] },
    })
    expect(dup.statusCode).toBe(400)
  })

  it('rejects unknown namespaces and invalid paths', async () => {
    const ns = await put('admin', { values: {} })
    expect(ns.statusCode).toBe(400)

    const path = await put('corporate', { values: { '../etc': 'x' } })
    expect(path.statusCode).toBe(400)
    expect(path.json<ErrorBody>().error.code).toBe('VALIDATION_ERROR')

    const tooLong = await put('corporate', { values: { 'hero.title': 'x'.repeat(10_001) } })
    expect(tooLong.statusCode).toBe(400)
  })
})
