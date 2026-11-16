import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultStdioStorePath } from '../src/fatsecret/store-path.js';

describe('defaultStdioStorePath', () => {
  it('places the stdio token store in the home directory', () => {
    expect(defaultStdioStorePath('/home/alice')).toBe(join('/home/alice', '.mcp-server-fatsecret', 'store.json'));
  });
});
