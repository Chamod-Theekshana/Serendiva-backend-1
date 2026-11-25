import { brand, button, detailsTable, detailsText, esc, layout, p } from './layout'

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

export type EmailLocale = 'en' | 'de' | 'zh'

export function normalizeLocale(locale?: string | null): EmailLocale {
  return locale === 'de' || locale === 'zh' ? locale : 'en'
}

export function formatHours(hours: number, locale: EmailLocale): string {
  if (locale === 'de') return hours === 1 ? '1 Stunde' : `${hours} Stunden`
  if (locale === 'zh') return `${hours} 小时`
  return hours === 1 ? '1 hour' : `${hours} hours`
}

export interface InquiryEmailData {
  reference: string
  name: string
  email: string
  whatsapp?: string | null
  country?: string | null
  partyType?: string | null
  adults: number
  children: number
  travelWindow?: string | null
  travelStart?: string | null
  travelEnd?: string | null
  flexibleDates: boolean
  flexibility?: string | null
  durationPreference?: string | null
  pace?: string | null
  stayStyle?: string | null
  interests: string[]
  tourTitle?: string | null
  tourUrl?: string | null
  destinationName?: string | null
  message?: string | null
  sourcePage?: string | null
  locale: string
  adminUrl: string
  responseHours?: number
}

function waLink(number: string, text: string): string {
  const digits = number.replace(/[^\d]/g, '')
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
}

export function guideInquiryEmail(d: InquiryEmailData): RenderedEmail {
  const replyWindow = formatHours(d.responseHours ?? 24, 'en')
  const travel = d.travelWindow ?? ([d.travelStart, d.travelEnd].filter(Boolean).join(' → ') || null)
  const rows: [string, string | null | undefined][] = [
    ['Reference', d.reference],
    ['Name', d.name],
    ['Email', d.email],
    ['WhatsApp', d.whatsapp],
    ['Country', d.country],
    ['Tour', d.tourTitle],
    ['Destination', d.destinationName],
    ['Travelling as', d.partyType],
    ['Guests', `${d.adults} adult(s)${d.children ? `, ${d.children} child(ren)` : ''}`],
    ['Travel dates', travel],
    ['Flexibility', d.flexibility ?? (d.flexibleDates ? 'Flexible dates' : null)],
    ['Duration', d.durationPreference],
    ['Pace', d.pace],
    ['Stay style', d.stayStyle],
    ['Interests', d.interests.length ? d.interests.join(', ') : null],
    ['Message', d.message],
    ['Sent from', d.sourcePage],
    ['Language', d.locale],
  ]
  const actions = [
    button(`mailto:${d.email}?subject=${encodeURIComponent(`Your Sri Lanka journey (${d.reference})`)}`, 'Reply by email', brand.primary),
    d.whatsapp ? button(waLink(d.whatsapp, `Ayubowan ${d.name}! Thank you for your inquiry ${d.reference}.`), 'Reply on WhatsApp', '#2c4e23') : '',
    d.tourUrl ? button(d.tourUrl, 'View tour', brand.cinnamon) : '',
  ].join('')
  return {
    subject: `New inquiry ${d.reference} — ${d.name}${d.tourTitle ? ` · ${d.tourTitle}` : ''}`,
    html: layout({
      preheader: `${d.name} sent a new travel inquiry`,
      title: `New inquiry from ${d.name}`,
      body:
        p(`A visitor has sent a new inquiry through the website. Reply within ${esc(replyWindow)}.`) +
        detailsTable(rows) +
        `<div>${actions}</div>` +
        p(`<a href="${esc(d.adminUrl)}" style="color:${brand.teal}">Open in admin panel</a>`),
    }),
    text: `New inquiry ${d.reference}\nReply within ${replyWindow}.\n\n${detailsText(rows)}\n\nAdmin: ${d.adminUrl}`,
  }
}

const DEFAULT_GUIDE_NAME = 'Dinesh Jayasuriya'
const DEFAULT_GUIDE_TITLE = 'Licensed National Tourist Guide Lecturer · Serendiva'

interface VisitorCopy {
  subject: string
  preheader: string
  title: string
  intro: string
  refLabel: string
  promiseHtml: string
  promiseText: string
  waPrompt: string
  waButton: string
  waPrefill: string
  regards: string
  footer: (linkHtml: string) => string
}

function visitorCopy(
  locale: EmailLocale,
  d: { reference: string; name: string; isProposal: boolean; hours: string },
): VisitorCopy {
  if (locale === 'de') {
    const intro = d.isProposal
      ? 'Vielen Dank für Ihre Firmen-Angebotsanfrage. Ich habe Ihr Briefing erhalten und erstelle Ihnen ein maßgeschneidertes Angebot.'
      : 'Vielen Dank für Ihre Reiseanfrage — ich habe Ihre Reisewünsche erhalten und beginne persönlich mit der Planung Ihrer Tour.'
    return {
      subject: `Wir haben ${d.isProposal ? 'Ihre Angebotsanfrage' : 'Ihre Reiseanfrage'} erhalten (${d.reference})`,
      preheader: `Ihre Referenz lautet ${d.reference}. Ich antworte innerhalb von ${d.hours}.`,
      title: `Ayubowan, ${d.name}!`,
      intro,
      refLabel: 'Ihre Referenz',
      promiseHtml: `<strong>Ich antworte innerhalb von ${esc(d.hours)}.</strong> In diesem Schritt gibt es weder eine Zahlung noch eine Verpflichtung.`,
      promiseText: `Ich antworte innerhalb von ${d.hours}.`,
      waPrompt: 'Schnelle Frage? Schreiben Sie mir per WhatsApp:',
      waButton: 'Per WhatsApp schreiben',
      waPrefill: `Hallo! Meine Referenz lautet ${d.reference}.`,
      regards: 'Herzliche Grüße,',
      footer: (link) => `Sie erhalten diese E-Mail, weil Sie uns über ${link} kontaktiert haben.`,
    }
  }
  if (locale === 'zh') {
    const intro = d.isProposal
      ? '感谢您的企业定制需求——我已收到您的简报，将为您准备专属方案。'
      : '感谢您的咨询——我已收到您的旅行偏好，并将亲自为您规划行程。'
    return {
      subject: `我们已收到您的${d.isProposal ? '企业方案咨询' : '旅行咨询'}（${d.reference}）`,
      preheader: `您的咨询编号为 ${d.reference}，我将在 ${d.hours} 内回复您。`,
      title: `Ayubowan，${d.name}！`,
      intro,
      refLabel: '您的编号',
      promiseHtml: `<strong>我将在 ${esc(d.hours)} 内回复您。</strong>目前无需付款，也无任何预订义务。`,
      promiseText: `我将在 ${d.hours} 内回复您。`,
      waPrompt: '想更快联系？欢迎通过 WhatsApp 与我沟通：',
      waButton: 'WhatsApp 联系',
      waPrefill: `您好！我的咨询编号是 ${d.reference}。`,
      regards: '谨致问候，',
      footer: (link) => `您收到此邮件是因为您在 ${link} 提交了咨询。`,
    }
  }
  const intro = d.isProposal
    ? 'Thank you for your corporate proposal request. I have received your brief and will prepare a tailored proposal.'
    : 'Thank you for your inquiry — I have received your travel preferences and will start planning your journey personally.'
  return {
    subject: `We received your ${d.isProposal ? 'proposal request' : 'inquiry'} (${d.reference})`,
    preheader: `Your reference is ${d.reference}. I will reply within ${d.hours}.`,
    title: `Ayubowan, ${d.name}!`,
    intro,
    refLabel: 'Your reference',
    promiseHtml: `<strong>I will reply within ${esc(d.hours)}.</strong> There is no payment and no obligation at this stage.`,
    promiseText: `I will reply within ${d.hours}.`,
    waPrompt: 'Need a quick answer? Message me on WhatsApp:',
    waButton: 'Chat on WhatsApp',
    waPrefill: `Hello! My reference is ${d.reference}.`,
    regards: 'Warm regards,',
    footer: (link) => `You received this email because you contacted us at ${link}.`,
  }
}

export function visitorConfirmationEmail(d: {
  reference: string
  name: string
  whatsappNumber?: string | null
  siteUrl: string
  kind?: 'inquiry' | 'proposal'
  locale?: string | null
  responseHours?: number
  guideName?: string | null
  guideTitle?: string | null
}): RenderedEmail {
  const locale = normalizeLocale(d.locale)
  const hours = formatHours(d.responseHours ?? 24, locale)
  const copy = visitorCopy(locale, {
    reference: d.reference,
    name: d.name,
    isProposal: d.kind === 'proposal',
    hours,
  })
  const guideName = d.guideName?.trim() || DEFAULT_GUIDE_NAME
  const guideTitle = d.guideTitle?.trim() || DEFAULT_GUIDE_TITLE
  const siteLink = `<a href="${esc(d.siteUrl)}" style="color:${brand.teal}">${esc(d.siteUrl.replace(/^https?:\/\//, ''))}</a>`

  return {
    subject: copy.subject,
    html: layout({
      lang: locale,
      preheader: copy.preheader,
      title: copy.title,
      body:
        p(esc(copy.intro)) +
        `<div style="background:${brand.surface};border-left:3px solid ${brand.gold};padding:14px 18px;margin:0 0 18px;border-radius:6px;"><div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${brand.muted}">${esc(copy.refLabel)}</div><div style="font-size:22px;font-weight:bold;color:${brand.primary};margin-top:4px">${esc(d.reference)}</div></div>` +
        p(copy.promiseHtml) +
        (d.whatsappNumber ? p(`${esc(copy.waPrompt)} ${button(waLink(d.whatsappNumber, copy.waPrefill), copy.waButton, '#2c4e23')}`) : '') +
        p(`${esc(copy.regards)}<br>${esc(guideName)}<br><span style="color:#40484b;font-size:13px">${esc(guideTitle)}</span>`),
      footer: copy.footer(siteLink),
    }),
    text: `${copy.title}\n\n${copy.intro}\n\n${copy.refLabel}: ${d.reference}\n${copy.promiseText}\n\n${guideName} — Serendiva`,
  }
}

export interface ProposalEmailData {
  reference: string
  company: string
  contactPerson: string
  email: string
  phone: string
  groupSize: string
  dates: string
  eventType: string
  logistics: string[]
  message?: string | null
  attachmentUrl?: string | null
  attachmentName?: string | null
  adminUrl: string
  responseHours?: number
}

export function guideProposalEmail(d: ProposalEmailData): RenderedEmail {
  const replyWindow = formatHours(d.responseHours ?? 24, 'en')
  const rows: [string, string | null | undefined][] = [
    ['Reference', d.reference],
    ['Company', d.company],
    ['Contact', d.contactPerson],
    ['Email', d.email],
    ['Phone', d.phone],
    ['Group size', d.groupSize],
    ['Dates', d.dates],
    ['Mission', d.eventType],
    ['Logistics', d.logistics.length ? d.logistics.join(', ') : null],
    ['Brief', d.message],
    ['Attachment', d.attachmentName],
  ]
  return {
    subject: `Corporate proposal request ${d.reference} — ${d.company}`,
    html: layout({
      preheader: `${d.company} requested a corporate proposal`,
      title: `Corporate proposal request: ${d.company}`,
      body:
        p(`A corporate client has submitted a proposal request. Reply within ${esc(replyWindow)}.`) +
        detailsTable(rows) +
        `<div>${button(`mailto:${d.email}?subject=${encodeURIComponent(`Serendiva proposal ${d.reference}`)}`, 'Reply by email', brand.primary)}${d.attachmentUrl ? button(d.attachmentUrl, 'Download brief', brand.cinnamon) : ''}</div>` +
        p(`<a href="${esc(d.adminUrl)}" style="color:${brand.teal}">Open in admin panel</a>`),
    }),
    text: `Corporate proposal request ${d.reference}\nReply within ${replyWindow}.\n\n${detailsText(rows)}\n\nAdmin: ${d.adminUrl}`,
  }
}

export function newsletterConfirmEmail(d: {
  confirmUrl: string
  unsubscribeUrl: string
  locale?: string | null
}): RenderedEmail {
  const locale = normalizeLocale(d.locale)
  const copy =
    locale === 'de'
      ? {
          subject: 'Bitte bestätigen Sie Ihre Serendiva-Anmeldung',
          preheader: 'Nur ein Klick, um Ihre Anmeldung zu bestätigen',
          title: 'Anmeldung bestätigen',
          body: 'Vielen Dank für Ihr Interesse am Serendiva-Newsletter — saisonale Notizen zu Tierwanderungen, Festen und ruhigen Orten in Sri Lanka.',
          cta: 'Anmeldung bestätigen',
          ignore: 'Falls Sie sich nicht angemeldet haben, können Sie diese E-Mail einfach ignorieren.',
          unsub: 'Abbestellen',
          text: `Bitte bestätigen Sie Ihre Serendiva-Anmeldung: ${d.confirmUrl}\n\nAbbestellen: ${d.unsubscribeUrl}`,
        }
      : locale === 'zh'
        ? {
            subject: '请确认您的 Serendiva 订阅',
            preheader: '只需点击一次即可确认订阅',
            title: '确认订阅',
            body: '感谢您订阅 Serendiva 季节通信——分享斯里兰卡野生动物迁徙、传统节日与小众秘境的季节手记。',
            cta: '确认订阅',
            ignore: '如果您并未申请订阅，请直接忽略此邮件。',
            unsub: '退订',
            text: `请确认您的 Serendiva 订阅：${d.confirmUrl}\n\n退订：${d.unsubscribeUrl}`,
          }
        : {
            subject: 'Please confirm your Serendiva subscription',
            preheader: 'One click to confirm your subscription',
            title: 'Confirm your subscription',
            body: 'Thank you for joining the Serendiva dispatch — seasonal notes on wildlife migrations, festivals and quiet corners of Sri Lanka.',
            cta: 'Confirm subscription',
            ignore: 'If you did not sign up, simply ignore this email.',
            unsub: 'Unsubscribe',
            text: `Confirm your Serendiva subscription: ${d.confirmUrl}\n\nUnsubscribe: ${d.unsubscribeUrl}`,
          }

  return {
    subject: copy.subject,
    html: layout({
      lang: locale,
      preheader: copy.preheader,
      title: copy.title,
      body:
        p(esc(copy.body)) +
        `<div style="margin:8px 0 20px">${button(d.confirmUrl, copy.cta, brand.primary)}</div>` +
        p(`<span style="font-size:13px;color:#40484b">${esc(copy.ignore)}</span>`),
      footer: `<a href="${esc(d.unsubscribeUrl)}" style="color:${brand.teal}">${esc(copy.unsub)}</a>`,
    }),
    text: copy.text,
  }
}

export interface ReviewEmailData {
  id: string
  guestName: string
  email?: string | null
  country: string
  location?: string | null
  travellerType: string
  rating: number
  title?: string | null
  text: string
  tourTitle?: string | null
  travelDate?: string | null
  locale: string
  adminUrl: string
}

export function guideReviewEmail(d: ReviewEmailData): RenderedEmail {
  const clamped = Math.max(1, Math.min(5, Math.round(d.rating)))
  const stars = `${'★'.repeat(clamped)}${'☆'.repeat(5 - clamped)} (${clamped}/5)`
  const rows: [string, string | null | undefined][] = [
    ['Guest', d.guestName],
    ['Email', d.email],
    ['Country', d.country],
    ['Location', d.location],
    ['Traveller type', d.travellerType],
    ['Rating', stars],
    ['Tour', d.tourTitle],
    ['Travel date', d.travelDate],
    ['Headline', d.title],
    ['Review', d.text],
    ['Language', d.locale],
  ]
  return {
    subject: `New guest review (${clamped}/5) — ${d.guestName}`,
    html: layout({
      preheader: `${d.guestName} left a ${clamped}/5 guest review (pending moderation)`,
      title: `New guest review from ${d.guestName}`,
      body:
        p('A guest submitted a new review through the website. It stays hidden until approved in the admin panel.') +
        detailsTable(rows) +
        `<div>${button(d.adminUrl, 'Review in admin panel', brand.primary)}</div>`,
    }),
    text: `New guest review (${clamped}/5) from ${d.guestName}\n\n${detailsText(rows)}\n\nModerate: ${d.adminUrl}`,
  }
}

export interface FollowUpDigestItem {
  kind: 'inquiry' | 'proposal'
  id: string
  reference: string
  title: string
  subtitle?: string | null
  dateLabel: string
  adminUrl: string
}

export interface FollowUpDigestData {
  dateIso: string
  responseHours: number
  overdueReplies: FollowUpDigestItem[]
  dueFollowUps: FollowUpDigestItem[]
  adminDashboardUrl: string
}

function digestSectionHtml(heading: string, items: FollowUpDigestItem[]): string {
  if (items.length === 0) return ''
  const rows = items
    .map(
      (i) =>
        `<tr>` +
        `<td style="padding:8px 10px 8px 0;border-bottom:1px solid #ede8dd;font-size:13px;font-weight:bold;white-space:nowrap;"><a href="${esc(i.adminUrl)}" style="color:${brand.primary};text-decoration:none;">${esc(i.reference)}</a></td>` +
        `<td style="padding:8px 10px;border-bottom:1px solid #ede8dd;font-size:14px;">${esc(i.title)}${i.subtitle ? `<br><span style="font-size:12px;color:${brand.muted}">${esc(i.subtitle)}</span>` : ''}</td>` +
        `<td style="padding:8px 0;border-bottom:1px solid #ede8dd;font-size:12px;color:${brand.cinnamon};white-space:nowrap;text-align:right;">${esc(i.dateLabel)}</td>` +
        `</tr>`,
    )
    .join('')
  return (
    `<h2 style="font-family:Georgia,'Times New Roman',serif;font-size:17px;color:${brand.primary};margin:20px 0 8px;">${esc(heading)} (${items.length})</h2>` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #ede8dd;margin:0 0 16px;">${rows}</table>`
  )
}

function digestSectionText(heading: string, items: FollowUpDigestItem[]): string {
  if (items.length === 0) return ''
  const lines = items.map(
    (i) => `- [${i.reference}] ${i.title}${i.subtitle ? ` (${i.subtitle})` : ''} — ${i.dateLabel} · ${i.adminUrl}`,
  )
  return `${heading} (${items.length}):\n${lines.join('\n')}`
}

export function guideFollowUpDigestEmail(d: FollowUpDigestData): RenderedEmail {
  const total = d.overdueReplies.length + d.dueFollowUps.length
  const overdueHeading = `Overdue replies (> ${formatHours(d.responseHours, 'en')})`
  const followUpHeading = 'Follow-ups due today or earlier'
  const textSections = [
    digestSectionText(overdueHeading, d.overdueReplies),
    digestSectionText(followUpHeading, d.dueFollowUps),
  ].filter(Boolean)

  return {
    subject: `Daily Serendiva reminder — ${total} lead${total === 1 ? '' : 's'} need attention (${d.dateIso})`,
    html: layout({
      preheader: `${total} lead${total === 1 ? '' : 's'} waiting for reply or follow-up`,
      title: `Daily lead reminder (${d.dateIso})`,
      body:
        p(`You have <strong>${total}</strong> open lead${total === 1 ? '' : 's'} waiting for attention today.`) +
        digestSectionHtml(overdueHeading, d.overdueReplies) +
        digestSectionHtml(followUpHeading, d.dueFollowUps) +
        `<div style="margin-top:18px">${button(d.adminDashboardUrl, 'Open admin dashboard', brand.primary)}</div>`,
    }),
    text: `Daily Serendiva reminder (${d.dateIso})\n${total} open lead${total === 1 ? '' : 's'} need attention:\n\n${textSections.join('\n\n')}\n\nDashboard: ${d.adminDashboardUrl}`,
  }
}
