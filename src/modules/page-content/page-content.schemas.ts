import { z } from 'zod'
import { LocaleSchema } from '@/lib/i18n'

/**
 * Website message namespaces whose copy the admin may override. Keep in sync with the page registry in
 * serendiva-web/src/lib/page-content/registry.ts (the web decides which paths are shown in the editor).
 */
export const PAGE_CONTENT_NAMESPACES = [
  'common',
  'home',
  'about',
  'blog',
  'contact',
  'corporate',
  'destinations',
  'destinationDetail',
  'gallery',
  'legal',
  'responsible',
  'reviews',
  'tours',
  'tourDetail',
  'travelGuide',
  'quiz',
] as const
export type PageContentNamespace = (typeof PAGE_CONTENT_NAMESPACES)[number]

export const MAX_PAGE_CONTENT_ENTRIES = 1000
export const MAX_PAGE_CONTENT_TEXT = 10_000
export const MAX_HIDDEN_SECTIONS = 100

/** Dotted message path, e.g. `testimonial.quote` or `privacy.sections.3.blocks.0.text`. */
const MessagePath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/, 'Must be a dotted message path (letters, digits, _, - and .)')

export const PageContentNamespaceSchema = z.enum(PAGE_CONTENT_NAMESPACES)
export const PageContentParams = z.object({ namespace: PageContentNamespaceSchema })

export const PageContentValuesSchema = z
  .record(MessagePath, z.string().max(MAX_PAGE_CONTENT_TEXT))
  .refine((v) => Object.keys(v).length <= MAX_PAGE_CONTENT_ENTRIES, {
    message: `At most ${MAX_PAGE_CONTENT_ENTRIES} changed texts per page`,
  })

export const MAX_LISTS = 50
export const MAX_LIST_ITEMS = 30
export const MAX_ITEM_FIELDS = 30

/** List item key: starts with a letter, never numeric (object key order must stay the insertion order). */
export const LIST_ITEM_KEY = /^[a-z][A-Za-z0-9_-]{0,39}$/

const ListItemSchema = z
  .object({
    key: z.string().regex(LIST_ITEM_KEY, 'Item keys start with a lowercase letter (letters, digits, _ and -)'),
    /** Item texts by field path inside the item (`title`, `points.one`); `icon` = Material Symbols name. */
    values: z
      .record(MessagePath, z.string().max(MAX_PAGE_CONTENT_TEXT))
      .refine((v) => Object.keys(v).length <= MAX_ITEM_FIELDS, { message: `At most ${MAX_ITEM_FIELDS} fields per item` }),
  })
  .meta({ id: 'PageContentListItem' })

/**
 * Lists the admin re-ordered, shortened or extended: the message object at the path is rebuilt from these
 * items (in this order). Unchanged lists are not sent.
 */
export const PageContentListsSchema = z
  .record(
    MessagePath,
    z
      .array(ListItemSchema)
      .max(MAX_LIST_ITEMS)
      .refine((items) => new Set(items.map((i) => i.key)).size === items.length, { message: 'Item keys must be unique' }),
  )
  .refine((v) => Object.keys(v).length <= MAX_LISTS, { message: `At most ${MAX_LISTS} edited lists per page` })

/** PUT body: the complete set of overrides for one namespace (replaces what was stored). */
export const PageContentBodySchema = z
  .object({
    values: PageContentValuesSchema,
    hidden: z.array(MessagePath).max(MAX_HIDDEN_SECTIONS).default([]),
    lists: PageContentListsSchema.default({}),
  })
  .meta({ id: 'PageContentBody' })
export type PageContentBodyT = z.infer<typeof PageContentBodySchema>
export type PageContentListsT = z.infer<typeof PageContentListsSchema>

export const PageContentEntrySchema = z
  .object({
    namespace: PageContentNamespaceSchema,
    locale: LocaleSchema,
    values: z.record(z.string(), z.string()),
    hidden: z.array(z.string()),
    lists: z.record(z.string(), z.array(z.object({ key: z.string(), values: z.record(z.string(), z.string()) }))),
    updatedAt: z.string().nullable(),
  })
  .meta({ id: 'PageContentEntry' })
export type PageContentEntryT = z.infer<typeof PageContentEntrySchema>

/** Public: overrides for English plus the requested locale (the website merges en → locale). */
export const PublicPageContentSchema = z
  .object({ items: z.array(PageContentEntrySchema.omit({ updatedAt: true })) })
  .meta({ id: 'PublicPageContent' })

export const AdminPageContentSchema = z
  .object({ items: z.array(PageContentEntrySchema) })
  .meta({ id: 'AdminPageContent' })
