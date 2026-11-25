import { describe, expect, it } from 'vitest'
import { loadEnv } from '@/config/env'
import { isConfirmedInquiryExpired, retentionCutoffs, shouldRunDailyJob, subMonthsUtc } from '@/jobs/data-retention'
import { shouldRunDailyDigest } from '@/jobs/follow-up-digest'
import {
  guideFollowUpDigestEmail,
  guideReviewEmail,
  newsletterConfirmEmail,
  visitorConfirmationEmail,
} from '@/lib/email/templates'
import { AdminInquiryCreateBody, InquiryBody } from '@/modules/inquiries/inquiries.schemas'
import { NewsletterSubscribeBody } from '@/modules/newsletter/newsletter.schemas'
import { ProposalFields } from '@/modules/proposals/proposals.schemas'

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://serendiva:serendiva@localhost:5432/serendiva_test',
  REVALIDATE_SECRET: 'test-revalidate-secret-0123456789',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789-0123456789-abcdef',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789-0123456789-abcdef',
}

describe('Phase 4 env config', () => {
  it('parses DOCS_ENABLED, RESPONSE_HOURS, and job flags', () => {
    const defaults = loadEnv({ ...BASE_ENV })
    expect(defaults.DOCS_ENABLED).toBe(false)
    expect(defaults.RESPONSE_HOURS).toBe(24)
    expect(defaults.FOLLOW_UP_DIGEST_HOUR_UTC).toBe(3)
    expect(defaults.FOLLOW_UP_DIGEST_DISABLED).toBe(false)
    expect(defaults.RETENTION_DISABLED).toBe(false)

    const custom = loadEnv({
      ...BASE_ENV,
      DOCS_ENABLED: 'true',
      RESPONSE_HOURS: '48',
      FOLLOW_UP_DIGEST_HOUR_UTC: '6',
      FOLLOW_UP_DIGEST_DISABLED: '1',
      RETENTION_DISABLED: 'true',
    })
    expect(custom.DOCS_ENABLED).toBe(true)
    expect(custom.RESPONSE_HOURS).toBe(48)
    expect(custom.FOLLOW_UP_DIGEST_HOUR_UTC).toBe(6)
    expect(custom.FOLLOW_UP_DIGEST_DISABLED).toBe(true)
    expect(custom.RETENTION_DISABLED).toBe(true)
  })
})

describe('Phase 4 email templates', () => {
  it('localizes visitor confirmations (en / de / zh) with dynamic responseHours and guide profile', () => {
    const en = visitorConfirmationEmail({
      reference: 'SRD-2026-0001',
      name: 'Emma',
      whatsappNumber: '94771234567',
      siteUrl: 'https://serendiva.lk',
      locale: 'en',
      responseHours: 48,
      guideName: 'Kasun Perera',
      guideTitle: 'Senior Wildlife Guide · Serendiva',
    })
    expect(en.html).toContain('<html lang="en">')
    expect(en.text).toContain('48 hours')
    expect(en.html).toContain('Kasun Perera')
    expect(en.html).toContain('Senior Wildlife Guide · Serendiva')

    const de = visitorConfirmationEmail({
      reference: 'SRD-2026-0002',
      name: 'Lukas',
      siteUrl: 'https://serendiva.lk',
      locale: 'de',
      responseHours: 12,
    })
    expect(de.html).toContain('<html lang="de">')
    expect(de.subject).toContain('Reiseanfrage')
    expect(de.text).toContain('12 Stunden')

    const zh = visitorConfirmationEmail({
      reference: 'SRD-C-2026-0003',
      name: 'Lin <Wei>',
      siteUrl: 'https://serendiva.lk',
      kind: 'proposal',
      locale: 'zh',
      responseHours: 24,
    })
    expect(zh.html).toContain('<html lang="zh">')
    expect(zh.html).toContain('Lin &lt;Wei&gt;')
    expect(zh.subject).toContain('企业方案咨询')
    expect(zh.text).toContain('24 小时')
  })

  it('localizes newsletter confirmation emails', () => {
    const de = newsletterConfirmEmail({
      confirmUrl: 'https://serendiva.lk/de/newsletter/confirm?token=abc',
      unsubscribeUrl: 'https://serendiva.lk/de/newsletter/unsubscribe?token=xyz',
      locale: 'de',
    })
    expect(de.subject).toBe('Bitte bestätigen Sie Ihre Serendiva-Anmeldung')
    expect(de.html).toContain('<html lang="de">')

    const zh = newsletterConfirmEmail({
      confirmUrl: 'https://serendiva.lk/zh/newsletter/confirm?token=abc',
      unsubscribeUrl: 'https://serendiva.lk/zh/newsletter/unsubscribe?token=xyz',
      locale: 'zh',
    })
    expect(zh.subject).toBe('请确认您的 Serendiva 订阅')
    expect(zh.html).toContain('<html lang="zh">')
  })

  it('renders review notification and follow-up digest emails with escaped content', () => {
    const review = guideReviewEmail({
      id: 'rev-1',
      guestName: 'Claire <Guest>',
      email: 'claire@example.com',
      country: 'GB',
      travellerType: 'couple',
      rating: 5,
      title: 'Memorable trip',
      text: 'Everything was seamlessly organized.',
      tourTitle: 'Cultural Odyssey',
      locale: 'en',
      adminUrl: 'https://serendiva.lk/admin/reviews?status=pending',
    })
    expect(review.subject).toBe('New guest review (5/5) — Claire <Guest>')
    expect(review.html).toContain('Claire &lt;Guest&gt;')
    expect(review.html).toContain('Cultural Odyssey')
    expect(review.text).toContain('https://serendiva.lk/admin/reviews?status=pending')

    const digest = guideFollowUpDigestEmail({
      dateIso: '2026-11-24',
      responseHours: 24,
      overdueReplies: [
        {
          kind: 'inquiry',
          id: 'inq-1',
          reference: 'SRD-2026-0100',
          title: 'John Smith',
          subtitle: 'Yala Safari · UK',
          dateLabel: 'Received 2026-11-22',
          adminUrl: 'https://serendiva.lk/admin/inquiries?id=inq-1',
        },
      ],
      dueFollowUps: [
        {
          kind: 'proposal',
          id: 'prop-1',
          reference: 'SRD-C-2026-0005',
          title: 'Acme Corp',
          subtitle: 'Jane Doe',
          dateLabel: 'Follow up 2026-11-24',
          adminUrl: 'https://serendiva.lk/admin/proposals?id=prop-1',
        },
      ],
      adminDashboardUrl: 'https://serendiva.lk/admin',
    })
    expect(digest.subject).toBe('Daily Serendiva reminder — 2 leads need attention (2026-11-24)')
    expect(digest.html).toContain('SRD-2026-0100')
    expect(digest.html).toContain('SRD-C-2026-0005')
    expect(digest.text).toContain('Overdue replies (> 24 hours) (1):')
    expect(digest.text).toContain('Follow-ups due today or earlier (1):')
  })
})

describe('Phase 4 form validation tightening', () => {
  it('validates phone numbers and rejects past travelStart on public InquiryBody while preserving admin historical dates', () => {
    const yesterdayUtc = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)

    expect(
      InquiryBody.safeParse({
        name: 'Emma',
        email: 'emma@example.com',
        whatsapp: 'not-a-phone',
        travelStart: '2020-01-01',
      }),
    ).toMatchObject({ success: false })

    const parsed = InquiryBody.safeParse({
      name: 'Emma',
      email: 'emma@example.com',
      whatsapp: '+44 7700 900123',
      travelStart: yesterdayUtc,
      travelEnd: future,
    })
    expect(parsed.success).toBe(true)

    const adminPast = AdminInquiryCreateBody.safeParse({
      name: 'Historical Guest',
      email: 'hist@example.com',
      travelStart: '2022-05-01',
      travelEnd: '2022-05-10',
      bookedStart: '2022-05-01',
      bookedEnd: '2022-05-10',
      status: 'confirmed',
    })
    expect(adminPast.success).toBe(true)
  })

  it('validates corporate proposal phone & clientRequestId and newsletter turnstileToken', () => {
    const badPhone = ProposalFields.safeParse({
      company: 'Acme Ltd',
      contactPerson: 'Jane',
      email: 'jane@acme.example',
      phone: 'hello!',
      groupSize: '15 guests',
      dates: 'Next year',
      eventType: 'Retreat',
    })
    expect(badPhone.success).toBe(false)

    const badReqId = ProposalFields.safeParse({
      company: 'Acme Ltd',
      contactPerson: 'Jane',
      email: 'jane@acme.example',
      phone: '+44 20 7946 0000',
      groupSize: '15 guests',
      dates: 'Next year',
      eventType: 'Retreat',
      clientRequestId: 'short',
    })
    expect(badReqId.success).toBe(false)

    const okProp = ProposalFields.safeParse({
      company: 'Acme Ltd',
      contactPerson: 'Jane',
      email: 'jane@acme.example',
      phone: '+44 20 7946 0000',
      groupSize: '15 guests',
      dates: 'Next year',
      eventType: 'Retreat',
      clientRequestId: 'req_1234567890',
    })
    expect(okProp.success).toBe(true)

    const okNews = NewsletterSubscribeBody.safeParse({
      email: 'reader@example.com',
      locale: 'de',
      turnstileToken: 'cf-token-123',
    })
    expect(okNews.success).toBe(true)
    if (okNews.success) expect(okNews.data.turnstileToken).toBe('cf-token-123')
  })
})

describe('Phase 4 job scheduling and GDPR retention windows', () => {
  it('checks daily digest schedule against UTC hour and JobState', () => {
    const tooEarly = new Date('2026-11-24T02:59:00.000Z')
    const afterHour = new Date('2026-11-24T03:05:00.000Z')
    const yesterday = new Date('2026-11-23T03:05:00.000Z')
    const earlierToday = new Date('2026-11-24T03:01:00.000Z')

    expect(shouldRunDailyDigest(tooEarly, null, 3)).toBe(false)
    expect(shouldRunDailyDigest(afterHour, null, 3)).toBe(true)
    expect(shouldRunDailyDigest(afterHour, yesterday, 3)).toBe(true)
    expect(shouldRunDailyDigest(afterHour, earlierToday, 3)).toBe(false)
    expect(shouldRunDailyJob(afterHour, yesterday)).toBe(true)
    expect(shouldRunDailyJob(afterHour, earlierToday)).toBe(false)
  })

  it('computes calendar-safe UTC retention cutoffs and confirmed-journey anchor dates', () => {
    const marchEnd = new Date('2026-03-31T08:00:00.000Z')
    expect(subMonthsUtc(marchEnd, 1).toISOString()).toBe('2026-02-28T08:00:00.000Z')

    const cutoffs = retentionCutoffs(new Date('2026-11-24T00:00:00.000Z'))
    expect(cutoffs.nonConfirmedLeadCutoff.toISOString()).toBe('2024-11-24T00:00:00.000Z')
    expect(cutoffs.confirmedLeadCutoff.toISOString()).toBe('2020-11-24T00:00:00.000Z')
    expect(cutoffs.proposalAttachmentCutoff.toISOString()).toBe('2025-11-24T00:00:00.000Z')
    expect(cutoffs.unconfirmedNewsletterCutoff.toISOString()).toBe('2026-10-25T00:00:00.000Z')

    expect(
      isConfirmedInquiryExpired(
        {
          bookedEnd: new Date('2020-11-23T00:00:00.000Z'),
          travelEnd: new Date('2021-01-01T00:00:00.000Z'),
          lastContactAt: new Date('2021-01-01T00:00:00.000Z'),
        },
        cutoffs.confirmedLeadCutoff,
      ),
    ).toBe(true)
    expect(
      isConfirmedInquiryExpired(
        {
          bookedEnd: new Date('2020-11-25T00:00:00.000Z'),
          travelEnd: null,
          lastContactAt: new Date('2020-01-01T00:00:00.000Z'),
        },
        cutoffs.confirmedLeadCutoff,
      ),
    ).toBe(false)
  })
})
