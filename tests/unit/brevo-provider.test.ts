import { describe, expect, it, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import { loadEnv } from '@/config/env'
import { createEmailService } from '@/lib/email'
import { createBrevoProvider } from '@/lib/email/providers'
import { TEST_ENV } from '../helpers'

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger

describe('createBrevoProvider', () => {
  it('posts formatted sender, recipients, replyTo, and content to Brevo API', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ messageId: '<brevo-123@relay>' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const provider = createBrevoProvider('xkeysib-test-key', fetchMock)
    const result = await provider.send({
      from: '"Serendiva" <guide@gmail.com>',
      to: ['visitor@example.com', 'Jane <jane@example.com>'],
      replyTo: 'visitor@example.com',
      subject: 'Your inquiry',
      html: '<p>Hello</p>',
      text: 'Hello',
    })

    expect(provider.name).toBe('brevo')
    expect(result).toEqual({ id: '<brevo-123@relay>' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.brevo.com/v3/smtp/email')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      accept: 'application/json',
      'api-key': 'xkeysib-test-key',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      sender: { name: 'Serendiva', email: 'guide@gmail.com' },
      to: [{ email: 'visitor@example.com' }, { name: 'Jane', email: 'jane@example.com' }],
      replyTo: { email: 'visitor@example.com' },
      subject: 'Your inquiry',
      htmlContent: '<p>Hello</p>',
      textContent: 'Hello',
    })
  })

  it('throws a Brevo error on non-2xx responses and network failures', async () => {
    const apiErrorFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401 }),
    )
    const provider1 = createBrevoProvider('bad-key', apiErrorFetch)
    await expect(
      provider1.send({
        from: 'guide@gmail.com',
        to: 'visitor@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
      }),
    ).rejects.toThrow('Brevo error: 401 unauthorized: Key not found')

    const networkErrorFetch = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
    const provider2 = createBrevoProvider('xkeysib-test-key', networkErrorFetch)
    await expect(
      provider2.send({
        from: 'guide@gmail.com',
        to: 'visitor@example.com',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
      }),
    ).rejects.toThrow('Brevo error: fetch failed')
  })
})

describe('EMAIL_DRIVER=brevo configuration', () => {
  it('selects the brevo provider when EMAIL_DRIVER=brevo and BREVO_API_KEY are set', () => {
    const env = loadEnv({ ...TEST_ENV, EMAIL_DRIVER: 'brevo', BREVO_API_KEY: 'xkeysib-test-key' })
    const service = createEmailService(env, silentLog)
    expect(service.provider).toBe('brevo')
  })
})
