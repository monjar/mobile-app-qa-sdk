import type { Project } from '../repo/projects';
import type { SessionRow, UserRow } from '../repo/users';
import type { ApiTokenRow } from '../repo/apiTokens';

/** Per-request values set by middleware. */
export interface AppEnv {
  Variables: {
    ip: string;
    project: Project;
    ingestKeyId: string;
    user: UserRow;
    /** Set for dashboard requests. */
    session: SessionRow;
    /** Set instead of `session` for requests made with an API token. */
    apiToken: ApiTokenRow | undefined;
  };
}
