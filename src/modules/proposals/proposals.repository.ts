import type { Prisma, PrismaClient } from '@/generated/prisma/client'
import { nextReference } from '@/lib/reference'
import {
  countLeadConfirmationsSince,
  findContactWhatsapp,
  findEmailSettings,
} from '@/modules/inquiries/inquiries.repository'
import type { LeadEmailPatch } from '@/modules/inquiries/lead-emails'
import type { LeadStatus } from '@/modules/inquiries/lead-schemas'

export const proposalInclude = {
  attachment: { select: { id: true, key: true, mime: true, size: true, originalName: true } },
} satisfies Prisma.CorporateProposalInclude

export const proposalDetailInclude = {
  ...proposalInclude,
  events: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 },
} satisfies Prisma.CorporateProposalInclude

export type ProposalRow = Prisma.CorporateProposalGetPayload<{ include: typeof proposalInclude }>
export type ProposalDetailRow = Prisma.CorporateProposalGetPayload<{ include: typeof proposalDetailInclude }>

export type ProposalCreateData = Pick<
  Prisma.CorporateProposalUncheckedCreateInput,
  | 'company'
  | 'contactPerson'
  | 'email'
  | 'phone'
  | 'groupSize'
  | 'dates'
  | 'eventType'
  | 'logistics'
  | 'message'
  | 'sourcePage'
  | 'locale'
  | 'clientRequestId'
  | 'visitorEmailSkipped'
>

const NEWEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }] satisfies Prisma.CorporateProposalOrderByWithRelationInput[]

export function createProposalsRepository(prisma: PrismaClient) {
  return {
    /** Reference allocation and insert share one transaction, so a reference is never skipped or reused. */
    create: (data: ProposalCreateData) =>
      prisma.$transaction(async (tx) => {
        const reference = await nextReference(tx, 'proposal')
        return tx.corporateProposal.create({
          data: { ...data, reference },
          select: { id: true, reference: true, createdAt: true },
        })
      }),

    /** Store the uploaded brief as a (private) Media row and link it to the proposal. */
    attachFile: (
      proposalId: string,
      file: { key: string; url: string; mime: string; size: number; originalName: string },
    ) =>
      prisma.$transaction(async (tx) => {
        const media = await tx.media.create({ data: file, select: { id: true } })
        await tx.corporateProposal.update({ where: { id: proposalId }, data: { attachmentId: media.id } })
        return media.id
      }),

    findById: (id: string) => prisma.corporateProposal.findUnique({ where: { id }, include: proposalDetailInclude }),

    findByClientRequestId: (clientRequestId: string) =>
      prisma.corporateProposal.findUnique({ where: { clientRequestId }, select: { id: true, reference: true } }),

    countConfirmationsSince: (since: Date, email?: string) => countLeadConfirmationsSince(prisma, since, email),

    exists: (id: string) => prisma.corporateProposal.findUnique({ where: { id }, select: { id: true } }),

    list: (
      where: Prisma.CorporateProposalWhereInput,
      skip: number,
      take: number,
      orderBy: Prisma.CorporateProposalOrderByWithRelationInput[] = NEWEST_FIRST,
    ) =>
      prisma.$transaction([
        prisma.corporateProposal.findMany({ where, include: proposalInclude, orderBy, skip, take }),
        prisma.corporateProposal.count({ where }),
      ]),

    countByStatus: (where: Prisma.CorporateProposalWhereInput) =>
      prisma.corporateProposal.groupBy({ by: ['status'], where, _count: { _all: true } }),

    listForExport: (
      where: Prisma.CorporateProposalWhereInput,
      take = 10_000,
      orderBy: Prisma.CorporateProposalOrderByWithRelationInput[] = NEWEST_FIRST,
    ) => prisma.corporateProposal.findMany({ where, include: proposalInclude, orderBy, take }),

    update: (id: string, data: { status?: LeadStatus; internalNotes?: string | null }) =>
      prisma.corporateProposal.update({ where: { id }, data, include: proposalDetailInclude }),

    applyLifecycleUpdate: (
      id: string,
      data: Prisma.CorporateProposalUncheckedUpdateInput,
      events: Prisma.LeadEventCreateManyInput[],
    ) =>
      prisma.$transaction(async (tx) => {
        if (Object.keys(data).length > 0) {
          await tx.corporateProposal.update({ where: { id }, data })
        }
        if (events.length > 0) {
          await tx.leadEvent.createMany({ data: events })
        }
        return tx.corporateProposal.findUniqueOrThrow({ where: { id }, include: proposalDetailInclude })
      }),

    updateEmailState: (id: string, patch: LeadEmailPatch) =>
      prisma.corporateProposal.update({ where: { id }, data: patch }),

    /** Deletes the proposal and its attachment's Media row; returns the storage key to remove. */
    delete: (id: string) =>
      prisma.$transaction(async (tx) => {
        const row = await tx.corporateProposal.delete({
          where: { id },
          select: { attachment: { select: { id: true, key: true } } },
        })
        if (row.attachment) await tx.media.delete({ where: { id: row.attachment.id } })
        return row.attachment?.key ?? null
      }),

    findEmailRetryIds: (opts: { createdAfter: Date; createdBefore: Date; maxAttempts: number; take: number }) =>
      prisma.corporateProposal.findMany({
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

export type ProposalsRepository = ReturnType<typeof createProposalsRepository>
