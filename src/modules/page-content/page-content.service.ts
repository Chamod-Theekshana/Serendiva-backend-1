import type { AppDeps } from '@/types'
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@/lib/i18n'
import { Tags } from '@/lib/revalidate'
import { createPageContentRepository } from './page-content.repository'
import {
  LIST_ITEM_KEY,
  PAGE_CONTENT_NAMESPACES,
  type PageContentBodyT,
  type PageContentEntryT,
  type PageContentListsT,
  type PageContentNamespace,
} from './page-content.schemas'

type Row = Awaited<ReturnType<ReturnType<typeof createPageContentRepository>['all']>>[number]
type ListItem = PageContentListsT[string][number]

const isNamespace = (v: string): v is PageContentNamespace => (PAGE_CONTENT_NAMESPACES as readonly string[]).includes(v)
const isLocale = (v: string): v is Locale => (LOCALES as readonly string[]).includes(v)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Stored JSON read defensively: only non-empty string values survive. */
function readValues(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v.trim() !== '') out[k] = v
  return out
}

/** Stored lists read defensively (an empty list is meaningful: the admin removed every item). */
function readLists(raw: unknown): Record<string, ListItem[]> {
  if (!isRecord(raw)) return {}
  const out: Record<string, ListItem[]> = {}
  for (const [path, items] of Object.entries(raw)) {
    if (!Array.isArray(items)) continue
    const seen = new Set<string>()
    out[path] = items.flatMap((item): ListItem[] => {
      if (!isRecord(item) || typeof item.key !== 'string' || !LIST_ITEM_KEY.test(item.key) || seen.has(item.key)) return []
      seen.add(item.key)
      return [{ key: item.key, values: readValues(item.values) }]
    })
  }
  return out
}

function toEntry(r: Row): PageContentEntryT | null {
  if (!isNamespace(r.namespace) || !isLocale(r.locale)) return null
  return {
    namespace: r.namespace,
    locale: r.locale,
    values: readValues(r.values),
    hidden: r.hidden,
    lists: readLists(r.lists),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export function createPageContentService(deps: AppDeps) {
  const repo = createPageContentRepository(deps.prisma)

  async function adminList() {
    const rows = await repo.all()
    return { items: rows.map(toEntry).filter((e): e is PageContentEntryT => e !== null) }
  }

  return {
    async publicList(locale: Locale) {
      const locales = [...new Set([DEFAULT_LOCALE, locale])]
      const rows = await repo.list(locales)
      return {
        items: rows
          .map(toEntry)
          .filter((e): e is PageContentEntryT => e !== null)
          .map(({ updatedAt: _updatedAt, ...rest }) => rest),
      }
    },

    adminList,

    /** Replaces the overrides of one namespace (English); an empty body removes the row. */
    async update(namespace: PageContentNamespace, body: PageContentBodyT) {
      const values = readValues(body.values)
      const hidden = [...new Set(body.hidden)].sort()
      const lists = readLists(body.lists)

      if (Object.keys(values).length === 0 && hidden.length === 0 && Object.keys(lists).length === 0) {
        await repo.remove(namespace, DEFAULT_LOCALE)
      } else {
        await repo.upsert(namespace, DEFAULT_LOCALE, { values, hidden, lists })
      }

      deps.revalidator.revalidate([Tags.pageContent])
      return adminList()
    },
  }
}
