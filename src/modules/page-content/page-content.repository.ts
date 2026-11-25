import type { PrismaClient } from '@/generated/prisma/client'
import { jsonValue } from '@/lib/json'

export function createPageContentRepository(prisma: PrismaClient) {
  return {
    list: (locales: string[]) =>
      prisma.pageContent.findMany({ where: { locale: { in: locales } }, orderBy: [{ namespace: 'asc' }, { locale: 'asc' }] }),

    all: () => prisma.pageContent.findMany({ orderBy: [{ namespace: 'asc' }, { locale: 'asc' }] }),

    upsert: (
      namespace: string,
      locale: string,
      data: { values: Record<string, string>; hidden: string[]; lists: Record<string, unknown> },
    ) =>
      prisma.pageContent.upsert({
        where: { namespace_locale: { namespace, locale } },
        create: { namespace, locale, values: jsonValue(data.values), hidden: data.hidden, lists: jsonValue(data.lists) },
        update: { values: jsonValue(data.values), hidden: data.hidden, lists: jsonValue(data.lists) },
      }),

    remove: (namespace: string, locale: string) =>
      prisma.pageContent.deleteMany({ where: { namespace, locale } }),
  }
}
