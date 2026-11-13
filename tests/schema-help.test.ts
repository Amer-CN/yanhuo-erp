import { describe, expect, it } from 'vitest';
import schemaSql from '../supabase/schema.sql?raw';

// The rendered and copied text is verified by scripts/e2e-sync-help.py.
// Here we guard executable SQL, allowing historical rollback comments to remain.
const executable = schemaSql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

describe('published setup SQL permissions', () => {
  it('does not grant physical delete or unrestricted row access', () => {
    expect(executable).not.toMatch(/grant[^;]*\bdelete\b/i);
    expect(executable).not.toMatch(/(?:using|with\s+check)\s*\(\s*true\s*\)/i);
    expect(executable).toMatch(/revoke\s+delete\s+on\s+public\.yh_records\s+from\s+anon/i);
  });

  it('scopes read, insert and update policies to the supplied ledger', () => {
    expect(executable.match(/create\s+policy/gi)).toHaveLength(3);
    expect(executable.match(/x-ledger-key/g)).toHaveLength(4);
    expect(executable).toMatch(/grant\s+select,\s*insert,\s*update\s+on/i);
  });
});
