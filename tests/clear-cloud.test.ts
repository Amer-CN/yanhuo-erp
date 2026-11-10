import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCloud } from '../src/db/sync';

/**
 * 服务端 v2 策略撤销了 anon 的 DELETE 权限，清空账本必须走软删除（PATCH deleted=true）。
 * 这里锁死两点：不发 DELETE；body 带 deleted 与新 updated_at，否则另一台设备拉不到「清空」。
 */

interface Call {
  url: string;
  init?: RequestInit;
}

const calls: Call[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      // 204 不能带 body，否则 undici 会直接抛 TypeError
      return new Response(null, { status: 204 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const CFG = {
  url: 'https://example.supabase.co',
  anonKey: 'sb_publishable_test',
  ledgerKey: 'led-1'
};

describe('clearCloud 软删除', () => {
  it('用 PATCH 标记 deleted，不再发 DELETE', async () => {
    await clearCloud(CFG);

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('PATCH');
    expect(calls[0].url).toContain('/rest/v1/yh_records?ledger=eq.led-1');
  });

  it('body 带 deleted=true 与新的 updated_at，否则另一台设备拉不到这次清空', async () => {
    await clearCloud(CFG);

    const body = JSON.parse(String(calls[0].init?.body)) as {
      deleted: boolean;
      updated_at: number;
    };
    expect(body.deleted).toBe(true);
    expect(Number.isInteger(body.updated_at)).toBe(true);
    expect(body.updated_at).toBeGreaterThan(0);
  });

  it('仍带同步码头与 return=minimal，避免响应回传整表', async () => {
    await clearCloud(CFG);

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['x-ledger-key']).toBe('led-1');
    expect(headers.apikey).toBe('sb_publishable_test');
    expect(headers.Prefer).toBe('return=minimal');
  });
});