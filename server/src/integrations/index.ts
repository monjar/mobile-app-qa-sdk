import type { Deps } from '../deps';
import type { IntegrationRow } from '../repo/integrations';
import type { TicketRow } from '../repo/tickets';
import { sendEmail, testEmail } from './email';
import { sendGithub, testGithub, type SendResult } from './github';
import { sendWebhook, testWebhook } from './webhook';

export type { SendResult } from './github';
export { SendError } from './errors';

export function send(deps: Deps, integration: IntegrationRow, ticket: TicketRow, userId: string | null): Promise<SendResult> {
  switch (integration.kind) {
    case 'github':
      return sendGithub(deps, integration, ticket, userId);
    case 'email':
      return sendEmail(deps, integration, ticket, userId);
    case 'webhook':
      return sendWebhook(deps, integration, ticket, userId);
  }
}

export function test(deps: Deps, integration: IntegrationRow): Promise<string> {
  switch (integration.kind) {
    case 'github':
      return testGithub(deps, integration);
    case 'email':
      return testEmail(deps, integration);
    case 'webhook':
      return testWebhook(deps, integration);
  }
}
