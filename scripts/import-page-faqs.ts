/**
 * One-off: adds the FAQs that used to be static copy on the reviews and travel guide pages (scopes `reviews`
 * and `travelGuide`) to an existing database, without running the full seed (which resets content).
 * A scope that already has FAQs is left untouched, so running it twice is safe.
 *
 *   npx tsx --env-file-if-exists=.env scripts/import-page-faqs.ts
 */
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'
import { reviewsFaqs, travelGuideFaqs } from '../prisma/seed-data/faqs'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is not set')
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })

try {
  for (const [scope, faqs] of [
    ['reviews', reviewsFaqs],
    ['travelGuide', travelGuideFaqs],
  ] as const) {
    const existing = await prisma.faq.count({ where: { scope } })
    if (existing > 0) {
      console.info(`${scope}: ${existing} FAQ(s) already exist — skipped`)
      continue
    }
    await prisma.faq.createMany({
      data: faqs.map((f, order) => ({
        scope,
        question: { en: f.question },
        answer: { en: f.answer },
        order,
        status: 'published' as const,
      })),
    })
    console.info(`${scope}: ${faqs.length} FAQ(s) added`)
  }
} finally {
  await prisma.$disconnect()
}
