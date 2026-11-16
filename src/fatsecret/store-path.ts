import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Token store location for stdio use. The container default (/data/store.json)
 * is usually not writable on a workstation.
 */
export function defaultStdioStorePath(home: string = homedir()): string {
  return join(home, '.mcp-server-fatsecret', 'store.json');
}
