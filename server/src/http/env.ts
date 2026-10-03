import type { Project } from '../repo/projects';
import type { SessionRow, UserRow } from '../repo/users';

/** Per-request values set by middleware. */
export interface AppEnv {
  Variables: {
    ip: string;
    project: Project;
    ingestKeyId: string;
    user: UserRow;
    session: SessionRow;
  };
}
