/** Query keys and shared queries, so pages invalidate each other consistently. */
import { useQuery } from '@tanstack/react-query';
import type { IntegrationView, ProjectView, ServerInfo, UserView } from '@snitch/contract';
import { get } from './api';

export const qk = {
  projects: ['projects'] as const,
  tickets: (params: string) => ['tickets', params] as const,
  ticket: (id: string) => ['ticket', id] as const,
  users: ['users'] as const,
  server: ['server'] as const,
  integrations: (projectId: string) => ['integrations', projectId] as const,
  keys: (projectId: string) => ['keys', projectId] as const,
  routing: (projectId: string) => ['routing', projectId] as const,
  sdkConfig: (projectId: string) => ['sdk-config', projectId] as const,
  jobs: (state: string) => ['jobs', state] as const,
  audit: ['audit'] as const,
};

export const useProjects = () => useQuery({ queryKey: qk.projects, queryFn: () => get<ProjectView[]>('/projects'), refetchInterval: 30_000 });
export const useUsers = () => useQuery({ queryKey: qk.users, queryFn: () => get<UserView[]>('/users'), staleTime: 60_000 });
export const useServerInfo = () => useQuery({ queryKey: qk.server, queryFn: () => get<ServerInfo>('/server'), staleTime: Infinity });
export const useIntegrations = (projectId: string | undefined) =>
  useQuery({ queryKey: qk.integrations(projectId ?? ''), queryFn: () => get<IntegrationView[]>(`/projects/${projectId}/integrations`), enabled: !!projectId });
