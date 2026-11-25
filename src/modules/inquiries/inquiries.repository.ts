import type { Prisma, PrismaClient } from '@/generated/prisma/client'
import { nextReference } from '@/lib/reference'
import type { LeadEmailPatch } from './lead-emails'
import type { LeadStatus } from './lead-schemas'

export const inquiryInclude = {
  tour: { select: { id: true, slug: true, title: true } },
  destination: { select: { id: true, slug: true, name: true } },
} satisfies Prisma.InquiryInclude

export const inquiryDetailInclude = {
  ...inquiryInclude,
  calendarBlock: { select: { id: true, startDate: true, endDate: true } },
  events: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 },
} satisfies Prisma.InquiryInclude

export type InquiryRow = Prisma.InquiryGetPayload<{ include: typeof inquiryInclude }>
export type InquiryDetailRow = Prisma.InquiryGetPayload<{ include: typeof inquiryDetailInclude }>

export type InquiryCreateData = Omit<
  Prisma.InquiryUncheckedCreateInput,
  'id' | 'reference' | 'status' | 'internalNotes' | 'emailStatus' | 'createdAt' | 'updatedAt'
>

const NEWEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }] satisfies Prisma.InquiryOrderByWithRelationInput[]

export interface InquiryLifecycleUpdate {
  data: Prisma.InquiryUncheckedUpdateInput
  events: Prisma.LeadEventCreateManyInput[]
  calendar?: { action: 'upsert'; startDate: Date; endDate: Date; note: string } | { action: 'delete' }
}

export type AdminInquiryCreateData = Omit<
  Prisma.InquiryUncheckedCreateInput,
  'id' | 'reference' | 'createdAt' | 'updatedAt'
>

export interface AdminInquiryCreateOptions {
  data: AdminInquiryCreateData
  events: Omit<Prisma.LeadEventCreateManyInput, 'inquiryId'>[]
  calendar?: { startDate: Date; endDate: Date; guestName: string }
}

const DEFAULT_GUIDE_NAME = 'Dinesh Jayasuriya'
const DEFAULT_GUIDE_TITLE = 'Licensed National Tourist Guide Lecturer · Serendiva'

export interface EmailSettings {
  whatsapp: string | null
  guideName: string
  guideTitle: { en: string; zh?: string; de?: string }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function parseGuideTitle(raw: unknown): EmailSettings['guideTitle'] {
  if (typeof raw === 'string' && raw.trim() !== '') return { en: raw.trim() }
  const obj = asRecord(raw)
  if (!obj) return { en: DEFAULT_GUIDE_TITLE }
  const en = typeof obj.en === 'string' && obj.en.trim() !== '' ? obj.en.trim() : DEFAULT_GUIDE_TITLE
  const zh = typeof obj.zh === 'string' && obj.zh.trim() !== '' ? obj.zh.trim() : undefined
  const de = typeof obj.de === 'string' && obj.de.trim() !== '' ? obj.de.trim() : undefined
  return { en, ...(zh ? { zh } : {}), ...(de ? { de } : {}) }
}

/** Contact + guide profile fields used in outgoing emails, with safe fallbacks. */
export async function findEmailSettings(prisma: PrismaClient): Promise<EmailSettings> {
  const rows = await prisma.siteSetting.findMany({
    where: { key: { in: ['contact', 'guide'] } },
    select: { key: true, value: true },
  })
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const contact = asRecord(byKey.get('contact'))
  const guide = asRecord(byKey.get('guide'))
  const rawWa = contact?.whatsapp
  const rawName = guide?.name
  return {
    whatsapp: typeof rawWa === 'string' && rawWa.trim() !== '' ? rawWa.trim() : null,
    guideName: typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : DEFAULT_GUIDE_NAME,
    guideTitle: parseGuideTitle(guide?.title),
  }
}

/** WhatsApp number from the `contact` site setting (shown in visitor confirmations), if configured. */
export async function findContactWhatsapp(prisma: PrismaClient): Promise<string | null> {
  return (await findEmailSettings(prisma)).whatsapp
}

/** Visitor confirmations owed across inquiries & corporate proposals since `since` (all, or for one address). */
export async function countLeadConfirmationsSince(
  prisma: PrismaClient,
  since: Date,
  email?: string,
): Promise<number> {
  const where = {
    createdAt: { gte: since },
    visitorEmailSkipped: false,
    ...(email ? { email: { equals: email, mode: 'insensitive' as const } } : {}),
  }
  const [inquiries, proposals] = await Promise.all([
    prisma.inquiry.count({ where }),
    prisma.corporateProposal.count({ where }),
  ])
  return inquiries + proposals
}

export function createInquiriesRepository(prisma: PrismaClient) {
  return {
    findTourIdBySlug: (slug: string) => prisma.tour.findUnique({ where: { slug }, select: { id: true } }),

    findDestinationIdBySlug: (slug: string) =>
      prisma.destination.findUnique({ where: { slug }, select: { id: true } }),

    findTourById: (id: string) => prisma.tour.findUnique({ where: { id }, select: { id: true } }),

    findDestinationById: (id: string) => prisma.destination.findUnique({ where: { id }, select: { id: true } }),

    /** Reference allocation and insert share one transaction, so a reference is never skipped or reused. */
    create: (data: InquiryCreateData) =>
      prisma.$transaction(async (tx) => {
        const reference = await nextReference(tx, 'inquiry')
        return tx.inquiry.create({ data: { ...data, reference }, select: { id: true, reference: true } })
      }),

    createAdmin: (opts: AdminInquiryCreateOptions) =>
      prisma.$transaction(async (tx) => {
        const reference = await nextReference(tx, 'inquiry')
        const created = await tx.inquiry.create({ data: { ...opts.data, reference }, select: { id: true } })
        if (opts.events.length > 0) {
          await tx.leadEvent.createMany({ data: opts.events.map((e) => ({ ...e, inquiryId: created.id })) })
        }
        if (opts.calendar) {
          await tx.availabilityRange.create({
            data: {
              inquiryId: created.id,
              startDate: opts.calendar.startDate,
              endDate: opts.calendar.endDate,
              type: 'busy',
              note: `${reference} · ${opts.calendar.guestName}`,
            },
          })
        }
        return tx.inquiry.findUniqueOrThrow({ where: { id: created.id }, include: inquiryDetailInclude })
      }),

    /** Visitor confirmations owed since `since` (all, or for one address — case-insensitive). */
    countConfirmationsSince: (since: Date, email?: string) => countLeadConfirmationsSince(prisma, since, email),

    findByClientRequestId: (clientRequestId: string) =>
      prisma.inquiry.findUnique({ where: { clientRequestId }, select: { id: true, reference: true } }),

    findById: (id: string) => prisma.inquiry.findUnique({ where: { id }, include: inquiryDetailInclude }),

    exists: (id: string) => prisma.inquiry.findUnique({ where: { id }, select: { id: true } }),

    list: (
      where: Prisma.InquiryWhereInput,
      skip: number,
      take: number,
      orderBy: Prisma.InquiryOrderByWithRelationInput[] = NEWEST_FIRST,
    ) =>
      prisma.$transaction([
        prisma.inquiry.findMany({ where, include: inquiryInclude, orderBy, skip, take }),
        prisma.inquiry.count({ where }),
      ]),

    countByStatus: (where: Prisma.InquiryWhereInput) =>
      prisma.inquiry.groupBy({ by: ['status'], where, _count: { _all: true } }),

    /** CSV export (capped so a runaway export cannot exhaust memory). */
    listForExport: (
      where: Prisma.InquiryWhereInput,
      take = 10_000,
      orderBy: Prisma.InquiryOrderByWithRelationInput[] = NEWEST_FIRST,
    ) => prisma.inquiry.findMany({ where, include: inquiryInclude, orderBy, take }),

    latest: (take: number) => prisma.inquiry.findMany({ include: inquiryInclude, orderBy: NEWEST_FIRST, take }),

    update: (id: string, data: { status?: LeadStatus; internalNotes?: string | null }) =>
      prisma.inquiry.update({ where: { id }, data, include: inquiryDetailInclude }),

    applyLifecycleUpdate: (id: string, opts: InquiryLifecycleUpdate) =>
      prisma.$transaction(async (tx) => {
        if (Object.keys(opts.data).length > 0) {
          await tx.inquiry.update({ where: { id }, data: opts.data })
        }
        if (opts.events.length > 0) {
          await tx.leadEvent.createMany({ data: opts.events })
        }
        if (opts.calendar?.action === 'upsert') {
          await tx.availabilityRange.upsert({
            where: { inquiryId: id },
            create: {
              inquiryId: id,
              startDate: opts.calendar.startDate,
              endDate: opts.calendar.endDate,
              type: 'busy',
              note: opts.calendar.note,
            },
            update: {
              startDate: opts.calendar.startDate,
              endDate: opts.calendar.endDate,
              type: 'busy',
              note: opts.calendar.note,
            },
          })
        } else if (opts.calendar?.action === 'delete') {
          await tx.availabilityRange.deleteMany({ where: { inquiryId: id } })
        }
        return tx.inquiry.findUniqueOrThrow({ where: { id }, include: inquiryDetailInclude })
      }),

    updateEmailState: (id: string, patch: LeadEmailPatch) => prisma.inquiry.update({ where: { id }, data: patch }),

    delete: (id: string) =>
      prisma.$transaction(async (tx) => {
        const blocks = await tx.availabilityRange.deleteMany({ where: { inquiryId: id } })
        await tx.inquiry.delete({ where: { id }, select: { id: true } })
        return blocks.count > 0
      }),

    /** Leads whose emails still need (re)sending, oldest first. */
    findEmailRetryIds: (opts: { createdAfter: Date; createdBefore: Date; maxAttempts: number; take: number }) =>
      prisma.inquiry.findMany({
        where: {
          emailStatus: { in: ['pending', 'failed', 'partial'] },
          emailAttempts: { lt: opts.maxAttempts },
          createdAt: { gte: opts.createdAfter, lte: opts.createdBefore },
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: opts.take,
      }),

    contactWhatsapp: () => findContactWhatsapp(prisma),

    emailSettings: () => findEmailSettings(prisma),
  }
}

export type InquiriesRepository = ReturnType<typeof createInquiriesRepository>
