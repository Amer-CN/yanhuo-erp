import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCloud } from '../src/db/sync';

/**
 * 服务端 v2 策略撤销了 anon 的 DELETE 权限，清空账本必须走软删除（PATCH deleted=true）。
 * 这里锁死三点：
 * 1. 不发 DELETE；
 * 2. PATCH 的 body 带 deleted 与新 updated_at，否则另一台设备拉不到「清空」；
 * 3. 紧随其后 upsert 一条固定 id 的标记行（带 clearedAt），
 *    否则对方时钟偏快 / 同毫秒水位时 tombstone 会被增量水位裁掉、永不自愈。
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

/** 按 method 取请求：断言不依赖调用顺序，后续再加请求也不会脆断 */
function callsOf(method: string): Call[] {
  return calls.filter((c) => c.init?.method === method);
}

describe('clearCloud 软删除 + 清空标记', () => {
  it('用 PATCH 软删除并写清空标记行，不再发 DELETE', async () => {
    await clearCloud(CFG);

    // 一次 PATCH（批量打 tombstone）+ 一次 POST（标记行），且绝不发 DELETE
    expect(calls).toHaveLength(2);
    expect(callsOf('DELETE')).toHaveLength(0);

    const patched = callsOf('PATCH');
    expect(patched).toHaveLength(1);
    expect(patched[0].url).toContain('/rest/v1/yh_records?ledger=eq.led-1');
    expect(JSON.parse(String(patched[0].init?.body))).toMatchObject({ deleted: true });

    const posted = callsOf('POST');
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toContain('yh_records?on_conflict=id');
    const markerRows = JSON.parse(String(posted[0].init?.body)) as {
      id?: string;
      data?: { clearedAt?: number };
    }[];
    expect(Array.isArray(markerRows)).toBe(true);
    expect(markerRows).toHaveLength(1);
    expect(markerRows[0].id?.startsWith('__ledger_cleared__:')).toBe(true);
    expect(Number.isInteger(markerRows[0].data?.clearedAt)).toBe(true);
    expect(Number(markerRows[0].data?.clearedAt)).toBeGreaterThan(0);
  });

  it('PATCH body 带 deleted=true 与新的 updated_at，否则另一台设备拉不到这次清空', async () => {
    await clearCloud(CFG);

    const patched = callsOf('PATCH');
    expect(patched).toHaveLength(1);
    const body = JSON.parse(String(patched[0].init?.body)) as {
      deleted: boolean;
      updated_at: number;
    };
    expect(body.deleted).toBe(true);
    expect(Number.isInteger(body.updated_at)).toBe(true);
    expect(body.updated_at).toBeGreaterThan(0);
  });

  it('仍带同步码头与 return=minimal，避免响应回传整表', async () => {
    await clearCloud(CFG);

    const patched = callsOf('PATCH');
    expect(patched).toHaveLength(1);
    const headers = patched[0].init?.headers as Record<string, string>;
    expect(headers['x-ledger-key']).toBe('led-1');
    expect(headers.apikey).toBe('sb_publishable_test');
    expect(headers.Prefer).toBe('return=minimal');

    // 标记行走同一套 rest() 头，别漏了同步码（漏了会被 RLS 拒绝）
    const posted = callsOf('POST');
    expect(posted).toHaveLength(1);
    expect((posted[0].init?.headers as Record<string, string>)['x-ledger-key']).toBe('led-1');
  });
});
