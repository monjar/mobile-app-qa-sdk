/**
 * Gathers what every escalation sender needs about a ticket, creating public
 * share links only when the integration opted in.
 */
import type { Deps } from '../deps';
import type { IntegrationRow } from '../repo/integrations';
import type { AttachmentRow, TicketRow } from '../repo/tickets';
import { ticketKey } from '../repo/tickets';
import type { RenderInput } from './render';

export interface TicketContext {
  render: RenderInput;
  project: { id: string; slug: string; name: string };
  attachments: AttachmentRow[];
  screenshot: AttachmentRow | null;
  video: AttachmentRow | null;
}

export function dashboardTicketUrl(deps: Deps, ticketId: string): string {
  return `${deps.config.publicUrl}/tickets/${ticketId}`;
}

export function buildTicketContext(
  deps: Deps,
  ticket: TicketRow,
  share: { enabled: boolean; ttlDays: number; userId: string | null; integration?: IntegrationRow },
): TicketContext {
  const project = deps.projects.get(ticket.project_id);
  if (!project) throw new Error(`project ${ticket.project_id} missing`);
  const attachments = deps.tickets.attachments(ticket.id);
  const screenshot = attachments.find((a) => a.state === 'stored' && a.content_type.startsWith('image/')) ?? null;
  const video = attachments.find((a) => a.state === 'stored' && a.content_type === 'video/mp4') ?? null;
  const links: RenderInput['links'] = {};
  if (share.enabled) {
    for (const [slot, att] of [
      ['screenshot', screenshot],
      ['video', video],
    ] as const) {
      if (!att) continue;
      const link = deps.tickets.createShareLink(att.id, share.ttlDays, share.userId);
      links[slot] = `${deps.config.publicUrl}/s/${link.token}`;
      deps.tickets.addEvent(ticket.id, { type: 'integration' }, 'share_link_created', {
        attachment: att.name,
        linkId: link.id,
        expiresAt: link.expiresAt,
        integration: share.integration?.name ?? null,
      });
    }
  }
  const typeLabel = project.reportTypes.find((r) => r.id === ticket.type)?.label ?? ticket.type;
  return {
    project: { id: project.id, slug: project.slug, name: project.name },
    attachments,
    screenshot,
    video,
    render: {
      key: ticketKey(project.ticketPrefix, ticket.number),
      ticket,
      meta: deps.tickets.metadata(ticket),
      typeLabel,
      projectName: project.name,
      dashboardUrl: dashboardTicketUrl(deps, ticket.id),
      links,
      hasScreenshot: !!screenshot,
      videoSeconds: video?.duration_ms ? Math.round(video.duration_ms / 100) / 10 : null,
    },
  };
}
