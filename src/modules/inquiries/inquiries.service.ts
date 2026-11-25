import type { FastifyBaseLogger } from 'fastify'
import type { AppDeps } from '@/types'
import { Prisma } from '@/generated/prisma/client'
import type { EmailMessage } from '@/lib/email'
import { guideInquiryEmail, visitorConfirmationEmail } from '@/lib/email/templates'
import { tr } from '@/lib/i18n'
import { iso, isoDate, parseDate } from '@/lib/dates'
import { notFound } from '@/lib/errors'
import { pageMeta, toSkipTake } from '@/lib/pagination'
import { Tags } from '@/lib/revalidate'
import { toCsv } from '@/lib/csv'
import { verifyTurnstile } from '@/lib/turnstile'
import { createInquiriesRepository, type InquiryDetailRow, type InquiryRow } from './inquiries.repository'
import {
  type AdminInquiriesQueryT,
  type AdminInquiry,
  type AdminInquiryCreateBodyT,
  type AdminInquiryListItemT,
  type InquiryBodyT,
  type InquiryFilters,
  type InquiryResultT,
  type InquiryUpdateBodyT,
} from './inquiries.schemas'
import { deliverMissingEmails, guideNotNotifiedWhere, runAfterResponse, withLeadLock, type LeadEmailStatus } from './lead-emails'
import { countsFrom, createdAtRange, fakeReference, siteUrl, textPreview } from './lead-helpers'
import {
  dueWhere,
  eventRows,
  isReplyOverdue,
  leadOrder,
  planLeadContact,
  planLeadUpdate,
  toLeadEvent,
} from './lead-lifecycle'
import { thankYouMessage, type LeadContactBodyT } from './lead-schemas'

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

export interface RequestContext {
  ip: string
  log: FastifyBaseLogger
}

const tourRef = (t: InquiryRow['tour']) => (t ? { id: t.id, slug: t.slug, title: tr<string>(t.title, 'en', t.slug) } : null)
const destinationRef = (d: InquiryRow['destination']) =>
  d ? { id: d.id, slug: d.slug, name: tr<string>(d.name, 'en', d.slug) } : null

export function toAdminInquiryListItem(r: InquiryRow, responseHours = 24, now = new Date()): AdminInquiryListItemT {
  return {
    id: r.id,
    reference: r.reference,
    name: r.name,
    email: r.email,
    whatsapp: r.whatsapp,
    country: r.country,
    partyType: r.partyType,
    adults: r.adults,
    children: r.children,
    travelStart: isoDate(r.travelStart),
    travelEnd: isoDate(r.travelEnd),
    travelWindow: r.travelWindow,
    tour: tourRef(r.tour),
    destination: destinationRef(r.destination),
    messagePreview: textPreview(r.message),
    sourcePage: r.sourcePage,
    locale: r.locale,
    status: r.status,
    repliedAt: iso(r.repliedAt),
    lastContactAt: r.lastContactAt.toISOString(),
    followUpAt: isoDate(r.followUpAt),
    replyOverdue: isReplyOverdue(r, responseHours, now),
    bookedStart: isoDate(r.bookedStart),
    bookedEnd: isoDate(r.bookedEnd),
    emailStatus: r.emailStatus,
    hasNotes: Boolean(r.internalNotes?.trim()),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

function toAdminInquiry(r: InquiryDetailRow, responseHours = 24, now = new Date()): AdminInquiry {
  return {
    id: r.id,
    reference: r.reference,
    name: r.name,
    email: r.email,
    whatsapp: r.whatsapp,
    country: r.country,
    partyType: r.partyType,
    adults: r.adults,
    children: r.children,
    travelStart: isoDate(r.travelStart),
    travelEnd: isoDate(r.travelEnd),
    travelWindow: r.travelWindow,
    flexibleDates: r.flexibleDates,
    flexibility: r.flexibility,
    durationPreference: r.durationPreference,
    pace: r.pace,
    stayStyle: r.stayStyle,
    interests: r.interests,
    tourId: r.tourId,
    tour: tourRef(r.tour),
    destinationId: r.destinationId,
    destination: destinationRef(r.destination),
    message: r.message,
    sourcePage: r.sourcePage,
    locale: r.locale,
    status: r.status,
    internalNotes: r.internalNotes,
    repliedAt: iso(r.repliedAt),
    confirmedAt: iso(r.confirmedAt),
    closedAt: iso(r.closedAt),
    lastContactAt: r.lastContactAt.toISOString(),
    followUpAt: isoDate(r.followUpAt),
    lostReason: r.lostReason,
    replyOverdue: isReplyOverdue(r, responseHours, now),
    bookedStart: isoDate(r.bookedStart),
    bookedEnd: isoDate(r.bookedEnd),
    calendarBlock: r.calendarBlock
      ? {
          id: r.calendarBlock.id,
          startDate: r.calendarBlock.startDate.toISOString().slice(0, 10),
          endDate: r.calendarBlock.endDate.toISOString().slice(0, 10),
        }
      : null,
    events: r.events.map(toLeadEvent),
    emailStatus: r.emailStatus,
    guideEmailSentAt: iso(r.guideEmailSentAt),
    visitorEmailSentAt: iso(r.visitorEmailSentAt),
    emailAttempts: r.emailAttempts,
    lastEmailError: r.lastEmailError,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

function buildWhere(
  f: InquiryFilters,
  opts: { ignoreStatus?: boolean; responseHours?: number; now?: Date } = {},
): Prisma.InquiryWhereInput {
  const q = f.q?.trim()
  const insensitive = 'insensitive' as const
  const createdAt = createdAtRange(f.from, f.to)
  const and: Prisma.InquiryWhereInput[] = []
  if (f.due) and.push(dueWhere(f.due, opts.responseHours ?? 24, opts.now))
  if (f.guideEmail === 'missing') and.push(guideNotNotifiedWhere(opts.now))
  if (q) {
    and.push({
      OR: [
        { name: { contains: q, mode: insensitive } },
        { email: { contains: q, mode: insensitive } },
        { reference: { contains: q, mode: insensitive } },
        { message: { contains: q, mode: insensitive } },
        { internalNotes: { contains: q, mode: insensitive } },
        { whatsapp: { contains: q } },
      ],
    })
  }
  return {
    ...(f.status && !opts.ignoreStatus ? { status: f.status } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(f.tour ? { tourId: f.tour } : {}),
    ...(f.destination ? { destinationId: f.destination } : {}),
    ...(f.country?.trim() ? { country: { equals: f.country.trim(), mode: insensitive } } : {}),
    ...(and.length ? { AND: and } : {}),
  }
}

export function createInquiriesService(deps: AppDeps) {
  const repo = createInquiriesRepository(deps.prisma)
  const { env } = deps

  function guideMessage(r: InquiryRow): EmailMessage {
    const rendered = guideInquiryEmail({
      reference: r.reference,
      name: r.name,
      email: r.email,
      whatsapp: r.whatsapp,
      country: r.country,
      partyType: r.partyType,
      adults: r.adults,
      children: r.children,
      travelWindow: r.travelWindow,
      travelStart: isoDate(r.travelStart),
      travelEnd: isoDate(r.travelEnd),
      flexibleDates: r.flexibleDates,
      flexibility: r.flexibility,
      durationPreference: r.durationPreference,
      pace: r.pace,
      stayStyle: r.stayStyle,
      interests: r.interests,
      tourTitle: r.tour ? tr<string>(r.tour.title, 'en', r.tour.slug) : null,
      tourUrl: r.tour ? siteUrl(env.FRONTEND_URL, r.locale, `/tours/${r.tour.slug}`) : null,
      destinationName: r.destination ? tr<string>(r.destination.name, 'en', r.destination.slug) : null,
      message: r.message,
      sourcePage: r.sourcePage,
      locale: r.locale,
      adminUrl: siteUrl(env.FRONTEND_URL, 'en', `/admin/inquiries?id=${encodeURIComponent(r.id)}`),
      responseHours: env.RESPONSE_HOURS,
    })
    return { ...rendered, to: env.GUIDE_NOTIFY_EMAIL, replyTo: r.email }
  }

  async function visitorMessage(r: InquiryRow): Promise<EmailMessage> {
    const settings = await repo.emailSettings()
    const locale = r.locale === 'de' || r.locale === 'zh' ? r.locale : 'en'
    const guideTitle = tr<string>(settings.guideTitle, locale, settings.guideTitle.en)
    const rendered = visitorConfirmationEmail({
      reference: r.reference,
      name: r.name,
      whatsappNumber: settings.whatsapp,
      siteUrl: env.FRONTEND_URL,
      kind: 'inquiry',
      locale: r.locale,
      responseHours: env.RESPONSE_HOURS,
      guideName: settings.guideName,
      guideTitle,
    })
    return { ...rendered, to: r.email }
  }

  const service = {
    /**
     * Public form. The inquiry is saved before anything else can fail; emails are sent after the
     * response and their outcome is stored for the retry job.
     */
    async submit(body: InquiryBodyT, ctx: RequestContext): Promise<InquiryResultT> {
      const thankYou = thankYouMessage(env.RESPONSE_HOURS)
      if (body.website && body.website.trim() !== '') {
        ctx.log.info('inquiry honeypot triggered; submission discarded')
        return { reference: fakeReference('inquiry'), message: thankYou }
      }
      // Same submission sent again (double click, or a retry after the browser timed out while the first
      // request was still being saved): answer with the inquiry we already have — no duplicate, no new emails.
      // Checked before Turnstile, whose token is single-use and already spent by the first request.
      if (body.clientRequestId) {
        const existing = await repo.findByClientRequestId(body.clientRequestId)
        if (existing) {
          ctx.log.info({ inquiryId: existing.id, reference: existing.reference }, 'inquiry re-sent; returning the saved one')
          return { reference: existing.reference, message: thankYou }
        }
      }
      await verifyTurnstile(env.TURNSTILE_SECRET, body.turnstileToken, ctx.ip)

      const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const [tour, destination, sameAddress, total] = await Promise.all([
        body.tourSlug ? repo.findTourIdBySlug(body.tourSlug) : null,
        body.destinationSlug ? repo.findDestinationIdBySlug(body.destinationSlug) : null,
        repo.countConfirmationsSince(since, body.email),
        repo.countConfirmationsSince(since),
      ])
      // A bot can make the site email strangers (and burn the guide's daily mail quota): past the limits the
      // inquiry is still saved and the guide notified, only the visitor confirmation is skipped.
      const visitorEmailSkipped =
        sameAddress >= env.VISITOR_EMAILS_PER_ADDRESS_PER_DAY || total >= env.VISITOR_EMAILS_PER_DAY
      if (visitorEmailSkipped) ctx.log.warn({ sameAddress, total }, 'visitor confirmation limit reached; confirmation skipped')

      const data = {
        name: body.name,
        email: body.email,
        whatsapp: body.whatsapp ?? null,
        country: body.country ?? null,
        partyType: body.partyType ?? null,
        adults: body.adults,
        children: body.children,
        travelStart: body.travelStart ? parseDate(body.travelStart) : null,
        travelEnd: body.travelEnd ? parseDate(body.travelEnd) : null,
        travelWindow: body.travelWindow ?? null,
        flexibleDates: body.flexibleDates ?? false,
        flexibility: body.flexibility ?? null,
        durationPreference: body.durationPreference ?? null,
        pace: body.pace ?? null,
        stayStyle: body.stayStyle ?? null,
        interests: body.interests,
        tourId: tour?.id ?? null,
        destinationId: destination?.id ?? null,
        message: body.message ?? null,
        sourcePage: body.sourcePage ?? null,
        locale: body.locale,
        clientRequestId: body.clientRequestId ?? null,
        visitorEmailSkipped,
      }
      let created: { id: string; reference: string }
      try {
        created = await repo.create(data)
      } catch (err) {
        // Two copies of the same submission raced past the check above: the second one loses on the
        // unique index and returns the first one's reference.
        const existing = body.clientRequestId && isUniqueViolation(err) ? await repo.findByClientRequestId(body.clientRequestId) : null
        if (!existing) throw err
        return { reference: existing.reference, message: thankYou }
      }
      ctx.log.info({ inquiryId: created.id, reference: created.reference }, 'inquiry saved')

      runAfterResponse(ctx.log, { inquiryId: created.id, reference: created.reference }, () =>
        service.sendMissingEmails(created.id, ctx.log),
      )
      return { reference: created.reference, message: thankYou }
    },

    /**
     * Send the guide notification and/or visitor confirmation that have not been delivered yet and
     * record the outcome. Used after submission, by the retry job and by the admin "resend" action.
     * Returns the resulting email status (null if the inquiry no longer exists).
     */
    async sendMissingEmails(id: string, log: FastifyBaseLogger): Promise<LeadEmailStatus | null> {
      const result = await withLeadLock(`inquiry:${id}`, async () => {
        const row = await repo.findById(id)
        if (!row) return null
        const patch = await deliverMissingEmails(deps.email, row, {
          guide: () => guideMessage(row),
          visitor: () => visitorMessage(row),
        })
        if (!patch) return row.emailStatus
        await repo.updateEmailState(id, patch)
        const logData = { inquiryId: id, reference: row.reference, emailStatus: patch.emailStatus, attempt: patch.emailAttempts }
        if (patch.emailStatus === 'sent') log.info(logData, 'inquiry emails sent')
        else log.warn({ ...logData, error: patch.lastEmailError }, 'inquiry emails not fully delivered')
        return patch.emailStatus
      })
      return result ?? null
    },

    /** Ids for the retry job (see src/jobs/email-retry.ts). */
    emailRetryIds: (opts: { createdAfter: Date; createdBefore: Date; maxAttempts: number; take: number }) =>
      repo.findEmailRetryIds(opts).then((rows) => rows.map((r) => r.id)),

    // ---------------------------------------------------------------- admin

    async adminList(q: AdminInquiriesQueryT) {
      const now = new Date()
      const { skip, take } = toSkipTake(q)
      const whereOpts = { responseHours: env.RESPONSE_HOURS, now }
      const [[rows, total], groups] = await Promise.all([
        repo.list(buildWhere(q, whereOpts), skip, take, leadOrder(q)),
        repo.countByStatus(buildWhere(q, { ...whereOpts, ignoreStatus: true })),
      ])
      return {
        items: rows.map((r) => toAdminInquiryListItem(r, env.RESPONSE_HOURS, now)),
        meta: pageMeta(q, total),
        counts: countsFrom(groups),
      }
    },

    async adminGet(id: string): Promise<AdminInquiry> {
      const row = await repo.findById(id)
      if (!row) throw notFound('Inquiry')
      return toAdminInquiry(row, env.RESPONSE_HOURS)
    },

    async adminCreate(body: AdminInquiryCreateBodyT, actorName: string | null = null): Promise<AdminInquiry> {
      const now = new Date()
      const [tour, destination] = await Promise.all([
        body.tourId ? repo.findTourById(body.tourId) : null,
        body.destinationId ? repo.findDestinationById(body.destinationId) : null,
      ])
      const status = body.status ?? 'replied'
      const closed = status === 'lost' || status === 'cancelled'
      const followUpAt = !closed && body.followUpAt ? parseDate(body.followUpAt) : null
      const effStart = body.bookedStart
        ? parseDate(body.bookedStart)
        : status === 'confirmed' && body.travelStart && body.travelEnd
          ? parseDate(body.travelStart)
          : null
      const effEnd = body.bookedEnd
        ? parseDate(body.bookedEnd)
        : status === 'confirmed' && body.travelStart && body.travelEnd
          ? parseDate(body.travelEnd)
          : null
      const calendar =
        status === 'confirmed' && body.blockCalendar !== false && effStart && effEnd
          ? { startDate: effStart, endDate: effEnd, guestName: body.name }
          : undefined

      const events: Omit<Prisma.LeadEventCreateManyInput, 'inquiryId'>[] = []
      const pushEvent = (e: Omit<Prisma.LeadEventCreateManyInput, 'inquiryId' | 'createdAt'>) => {
        events.push({ ...e, createdAt: new Date(now.getTime() + events.length) })
      }
      pushEvent({ type: 'contact', text: `${body.channel ?? 'other'}: Logged manually`, actorName })
      if (effStart && effEnd) {
        pushEvent({
          type: 'booking',
          text: `${isoDate(effStart)} – ${isoDate(effEnd)}${calendar ? ' (calendar blocked)' : ''}`,
          actorName,
        })
      }
      if (followUpAt) {
        pushEvent({ type: 'follow_up', text: isoDate(followUpAt), actorName })
      }

      const created = await repo.createAdmin({
        data: {
          name: body.name,
          email: body.email?.trim() || '',
          whatsapp: body.whatsapp?.trim() || null,
          country: body.country?.trim() || null,
          partyType: body.partyType ?? null,
          adults: body.adults ?? 2,
          children: body.children ?? 0,
          travelStart: body.travelStart ? parseDate(body.travelStart) : null,
          travelEnd: body.travelEnd ? parseDate(body.travelEnd) : null,
          travelWindow: body.travelWindow?.trim() || null,
          flexibleDates: body.flexibleDates ?? !(body.travelStart && body.travelEnd),
          durationPreference: body.durationPreference?.trim() || null,
          pace: body.pace?.trim() || null,
          stayStyle: body.stayStyle?.trim() || null,
          interests: body.interests ? [...new Set(body.interests.filter(Boolean))] : [],
          tourId: tour?.id ?? null,
          destinationId: destination?.id ?? null,
          message: body.message?.trim() || null,
          sourcePage: `admin:${body.channel ?? 'manual'}`,
          locale: body.locale ?? 'en',
          status,
          internalNotes: body.internalNotes?.trim() || null,
          repliedAt: status !== 'new' ? now : null,
          confirmedAt: status === 'confirmed' ? now : null,
          closedAt: closed ? now : null,
          lastContactAt: now,
          followUpAt,
          bookedStart: effStart,
          bookedEnd: effEnd,
          emailStatus: 'sent',
          guideEmailSentAt: now,
          visitorEmailSkipped: true,
        },
        events,
        calendar,
      })
      if (calendar) deps.revalidator.revalidate([Tags.availability])
      return toAdminInquiry(created, env.RESPONSE_HOURS, now)
    },

    async update(id: string, body: InquiryUpdateBodyT, actorName: string | null = null): Promise<AdminInquiry> {
      const existing = await repo.findById(id)
      if (!existing) throw notFound('Inquiry')
      const now = new Date()
      const plan = planLeadUpdate(existing, body, now, actorName)
      const data: Prisma.InquiryUncheckedUpdateInput = { ...plan.data }
      const events = [...plan.events]
      const nextStatus = body.status ?? existing.status

      if (body.bookedStart !== undefined) {
        if (body.bookedStart !== isoDate(existing.bookedStart) || body.bookedEnd !== isoDate(existing.bookedEnd)) {
          data.bookedStart = body.bookedStart ? parseDate(body.bookedStart) : null
          data.bookedEnd = body.bookedEnd ? parseDate(body.bookedEnd) : null
        }
      } else if (
        nextStatus === 'confirmed' &&
        existing.status !== 'confirmed' &&
        !existing.bookedStart &&
        existing.travelStart &&
        existing.travelEnd
      ) {
        data.bookedStart = existing.travelStart
        data.bookedEnd = existing.travelEnd
      }

      const effStart = data.bookedStart !== undefined ? (data.bookedStart as Date | null) : existing.bookedStart
      const effEnd = data.bookedEnd !== undefined ? (data.bookedEnd as Date | null) : existing.bookedEnd

      let calendar: { action: 'upsert'; startDate: Date; endDate: Date; note: string } | { action: 'delete' } | undefined
      if (nextStatus === 'confirmed') {
        const wantBlock =
          body.blockCalendar !== undefined
            ? body.blockCalendar
            : existing.status !== 'confirmed' || existing.calendarBlock !== null
        if (wantBlock && effStart && effEnd) {
          const sameBlock =
            existing.calendarBlock !== null &&
            existing.calendarBlock.startDate.getTime() === effStart.getTime() &&
            existing.calendarBlock.endDate.getTime() === effEnd.getTime()
          if (!sameBlock) {
            calendar = {
              action: 'upsert',
              startDate: effStart,
              endDate: effEnd,
              note: `${existing.reference} · ${existing.name}`,
            }
          }
        } else if (existing.calendarBlock) {
          calendar = { action: 'delete' }
        }
      } else if (existing.calendarBlock) {
        calendar = { action: 'delete' }
      }

      const datesChanged = data.bookedStart !== undefined || data.bookedEnd !== undefined
      if (datesChanged || calendar) {
        const rangeLabel = effStart && effEnd ? `${isoDate(effStart)} – ${isoDate(effEnd)}` : null
        let text: string
        if (rangeLabel) {
          const blockNote =
            calendar?.action === 'upsert'
              ? ' (calendar blocked)'
              : calendar?.action === 'delete'
                ? ' (calendar unblocked)'
                : ''
          text = `${rangeLabel}${blockNote}`
        } else {
          text = calendar?.action === 'delete' ? 'calendar block removed' : 'booked dates cleared'
        }
        events.push({ type: 'booking', text, actorName })
      }

      const updated = await repo.applyLifecycleUpdate(id, {
        data,
        events: eventRows(events, { inquiryId: id }, now),
        calendar,
      })
      if (calendar) deps.revalidator.revalidate([Tags.availability])
      return toAdminInquiry(updated, env.RESPONSE_HOURS, now)
    },

    async logContact(id: string, body: LeadContactBodyT, actorName: string | null = null): Promise<AdminInquiry> {
      const existing = await repo.findById(id)
      if (!existing) throw notFound('Inquiry')
      const now = new Date()
      const plan = planLeadContact(existing, body, now, actorName)
      const updated = await repo.applyLifecycleUpdate(id, {
        data: plan.data,
        events: eventRows(plan.events, { inquiryId: id }, now),
      })
      return toAdminInquiry(updated, env.RESPONSE_HOURS, now)
    },

    async remove(id: string) {
      if (!(await repo.exists(id))) throw notFound('Inquiry')
      const removedBlock = await repo.delete(id)
      if (removedBlock) deps.revalidator.revalidate([Tags.availability])
    },

    async resendEmails(id: string, log: FastifyBaseLogger): Promise<AdminInquiry> {
      if (!(await repo.exists(id))) throw notFound('Inquiry')
      await service.sendMissingEmails(id, log)
      return service.adminGet(id)
    },

    async exportCsv(filters: InquiryFilters): Promise<string> {
      const rows = await repo.listForExport(
        buildWhere(filters, { responseHours: env.RESPONSE_HOURS }),
        10_000,
        leadOrder(filters),
      )
      return toCsv(
        [
          'Reference', 'Received (UTC)', 'Status', 'Name', 'Email', 'WhatsApp', 'Country', 'Travelling as',
          'Adults', 'Children', 'Travel start', 'Travel end', 'Travel window', 'Flexible dates', 'Flexibility',
          'Duration', 'Pace', 'Stay style', 'Interests', 'Tour', 'Destination', 'Message', 'Source page',
          'Language', 'Email status', 'Internal notes',
        ],
        rows.map((r) => [
          r.reference,
          r.createdAt,
          r.status,
          r.name,
          r.email,
          r.whatsapp,
          r.country,
          r.partyType,
          r.adults,
          r.children,
          isoDate(r.travelStart),
          isoDate(r.travelEnd),
          r.travelWindow,
          r.flexibleDates ? 'yes' : 'no',
          r.flexibility,
          r.durationPreference,
          r.pace,
          r.stayStyle,
          r.interests.join('; '),
          r.tour ? tr<string>(r.tour.title, 'en', r.tour.slug) : null,
          r.destination ? tr<string>(r.destination.name, 'en', r.destination.slug) : null,
          r.message,
          r.sourcePage,
          r.locale,
          r.emailStatus,
          r.internalNotes,
        ]),
      )
    },
  }
  return service
}

export type InquiriesService = ReturnType<typeof createInquiriesService>
