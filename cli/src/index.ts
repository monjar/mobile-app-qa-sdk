/**
 * snitch: Snitch QA tickets from the terminal, and an MCP server for coding
 * agents. See docs/cli.md.
 */
import { SnitchError } from './client';
import { processIo, run, UsageError } from './commands';

run(process.argv.slice(2)).catch((e: unknown) => {
  if (e instanceof UsageError || e instanceof SnitchError) processIo.err(`snitch: ${e.message}`);
  else if (e instanceof Error && (e as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) processIo.err(`snitch: ${e.message}. Try \`snitch --help\`.`);
  else processIo.err(`snitch: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
