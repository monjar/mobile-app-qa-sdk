/**
 * Outbound webhook payload (format "generic"). Signed with
 * X-Snitch-Signature: sha256=HMAC_SHA256(secret, `${timestamp}.${body}`)
 * where timestamp is the X-Snitch-Timestamp header (unix seconds).
 */
import { z } from 'zod';
import { Platform, ReleaseType, TicketStatus } from './enums';

export const WEBHOOK_EVENTS = ['ticket.created', 'ticket.escalated', 'integration.test'] as const;
export const WebhookEvent = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const WebhookPayload = z.object({
  event: WebhookEvent,
  sentAt: z.string(),
  project: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  ticket: z.object({
    id: z.string(),
    key: z.string(),
    type: z.string(),
    title: z.string(),
    description: z.string(),
    status: TicketStatus,
    url: z.string(),
    platform: Platform,
    releaseType: ReleaseType,
    app: z.object({ id: z.string(), version: z.string(), build: z.string() }),
    device: z.object({ model: z.string(), osVersion: z.string() }),
    reporterEmail: z.string().nullable(),
    attachments: z.array(z.object({ name: z.string(), contentType: z.string(), url: z.string().nullable() })),
  }),
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;
