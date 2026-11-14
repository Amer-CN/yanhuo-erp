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

  it('keeps RLS enabled and binds every exposed policy to the requested ledger', () => {
    for (const table of ['yh_records', 'yh_ledger_state', 'yh_clear_operations', 'yh_reconcile_operations']) {
      expect(executable).toMatch(new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, 'i'));
    }
    expect(executable).not.toMatch(/disable\s+row\s+level\s+security/i);
    const policies = [...executable.matchAll(/create\s+policy\s+"([^"]+)"([\s\S]*?);/gi)];
    expect(policies.map((policy) => policy[1]).sort()).toEqual([
      'yh clear receipt read', 'yh ledger read', 'yh ledger update', 'yh ledger write', 'yh reconcile receipt read'
    ]);
    for (const [, , body] of policies) {
      expect(body).toMatch(/to\s+anon\b/i);
      expect(body).toMatch(/ledger\s*=\s*public\.yh_request_ledger\(\)/i);
      expect(body).not.toMatch(/ledger\s*(?:<>|!=|>|<)/);
    }
    expect(executable).toMatch(/grant\s+select,\s*insert,\s*update\s+on\s+public\.yh_records/i);
    expect(executable).toMatch(/revoke\s+all\s+on\s+public\.yh_ledger_state\s+from\s+public,\s*anon/i);
    expect(executable).toMatch(/revoke\s+all\s+on\s+public\.yh_clear_operations\s+from\s+public,\s*anon/i);
    expect(executable).toMatch(/grant\s+select\s+on\s+public\.yh_clear_operations\s+to\s+anon/i);
    expect(executable).toMatch(/revoke\s+all\s+on\s+public\.yh_reconcile_operations\s+from\s+public,\s*anon/i);
  });
});
