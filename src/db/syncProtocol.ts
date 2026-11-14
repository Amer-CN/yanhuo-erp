import Dexie, { type Table } from 'dexie';
import { db as mainDb } from './db';
import type { SyncConfig } from './syncTypes';
export interface SyncCapabilities {
  protocolVersion: 2;
  conflictTarget: 'ledger,id';
  ledgerScoped: boolean;
  clearRpcEnabled: boolean;
  clearEpoch: number;
  epochHeader: 'x-yh-clear-epoch';
  epochHeaderRequired: boolean;
}
export interface LegacySyncCapabilities {
  protocolVersion: 1;
  conflictTarget: 'id';
  ledgerScoped: false;
  clearRpcEnabled: false;
  clearEpoch: 0;
  epochHeader: 'x-yh-clear-epoch';
  epochHeaderRequired: false;
}
export type SyncProtocol = SyncCapabilities | LegacySyncCapabilities;
export interface ClearReceipt {
  operationId: string;
  clearedAt: number;
  clearedCount: number;
  clearEpoch: number;
}
export type ClearOperationState = 'pending' | 'unknown' | 'confirmed';
export interface SyncProtocolStateRow {
  key: string;
  kind: 'protocol';
  scope: string;
  capabilities: SyncProtocol;
  observedAt: number;
}
export interface SyncClearOperationRow {
  key: string;
  kind: 'clear';
  scope: string;
  operationId: string;
  state: ClearOperationState;
  clearedAt?: number;
  clearedCount?: number;
  clearEpoch?: number;
  lastError?: string;
}
export type SyncProtocolRow = SyncProtocolStateRow | SyncClearOperationRow;
const TIMEOUT_MS = 15_000;
const EPOCH_HEADER = 'x-yh-clear-epoch' as const;
const LEGACY: LegacySyncCapabilities = {
  protocolVersion: 1,
  conflictTarget: 'id',
  ledgerScoped: false,
  clearRpcEnabled: false,
  clearEpoch: 0,
  epochHeader: EPOCH_HEADER,
  epochHeaderRequired: false
};
export class SyncProtocolError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'SyncProtocolError';
  }
}
function configParts(cfg: SyncConfig): { baseUrl: string; anonKey: string; ledgerKey: string } {
  if (!cfg || typeof cfg.url !== 'string' || typeof cfg.anonKey !== 'string' || typeof cfg.ledgerKey !== 'string') {
    throw new SyncProtocolError('Invalid sync configuration');
  }
  const anonKey = cfg.anonKey.trim();
  const ledgerKey = cfg.ledgerKey.trim();
  let url: URL;
  try {
    url = new URL(cfg.url.trim());
  } catch {
    throw new SyncProtocolError('Invalid sync URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !anonKey ||
    !ledgerKey ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new SyncProtocolError('Invalid sync configuration');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return { baseUrl: url.toString().replace(/\/$/, ''), anonKey, ledgerKey };
}
/** Stable endpoint/ledger identity; the anon key is never persisted. */
export function protocolScope(cfg: SyncConfig): string {
  const { baseUrl, ledgerKey } = configParts(cfg);
  return JSON.stringify([baseUrl, ledgerKey]);
}
function rpcHeaders(cfg: SyncConfig): Record<string, string> {
  const { anonKey, ledgerKey } = configParts(cfg);
  return {
    apikey: anonKey,
    ...(anonKey.startsWith('eyJ') ? { Authorization: `Bearer ${anonKey}` } : {}),
    'x-ledger-key': ledgerKey,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
}
async function callRpc<T>(
  cfg: SyncConfig,
  name: string,
  body: unknown,
  signal: AbortSignal | undefined,
  consume: (response: Response) => Promise<T>
): Promise<T> {
  const { baseUrl } = configParts(cfg);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: rpcHeaders(cfg),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return await consume(response);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value) && value >= minimum;
}
function parseCapabilities(value: unknown): SyncCapabilities {
  if (
    !isRecord(value) ||
    value.protocolVersion !== 2 ||
    value.conflictTarget !== 'ledger,id' ||
    typeof value.ledgerScoped !== 'boolean' ||
    typeof value.clearRpcEnabled !== 'boolean' ||
    !integer(value.clearEpoch) ||
    value.epochHeader !== EPOCH_HEADER ||
    typeof value.epochHeaderRequired !== 'boolean' ||
    value.clearRpcEnabled !== value.ledgerScoped ||
    value.epochHeaderRequired !== value.clearEpoch > 0
  ) {
    throw new SyncProtocolError('Invalid sync capabilities response');
  }
  return {
    protocolVersion: 2,
    conflictTarget: 'ledger,id',
    ledgerScoped: value.ledgerScoped,
    clearRpcEnabled: value.clearRpcEnabled,
    clearEpoch: value.clearEpoch,
    epochHeader: EPOCH_HEADER,
    epochHeaderRequired: value.epochHeaderRequired
  };
}
async function responseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new SyncProtocolError('Invalid JSON from sync server', response.status);
  }
}
/** Reads remote capabilities only; persistence must happen after the caller's lease check. */
export function fetchCapabilities(cfg: SyncConfig, signal?: AbortSignal): Promise<SyncProtocol> {
  return callRpc(cfg, 'yh_sync_capabilities', {}, signal, async (response) => {
    const body = await responseJson(response);
    if (response.status === 404 && isRecord(body) && body.code === 'PGRST202') return LEGACY;
    if (!response.ok)
      throw new SyncProtocolError(`Capabilities request failed (HTTP ${response.status})`, response.status);
    return parseCapabilities(body);
  });
}
function protocolKey(scope: string): string {
  return `protocol:${scope}`;
}
function clearKey(scope: string): string {
  return `clear:${scope}`;
}
function validateProtocol(value: unknown): SyncProtocol {
  if (!isRecord(value)) throw new SyncProtocolError('Invalid stored sync protocol');
  if (value.protocolVersion === 1) {
    if (
      value.conflictTarget !== 'id' ||
      value.ledgerScoped !== false ||
      value.clearRpcEnabled !== false ||
      value.clearEpoch !== 0 ||
      value.epochHeader !== EPOCH_HEADER ||
      value.epochHeaderRequired !== false
    ) {
      throw new SyncProtocolError('Invalid stored legacy sync protocol');
    }
    return LEGACY;
  }
  return parseCapabilities(value);
}
function validateReceipt(value: unknown, operationId: string): ClearReceipt {
  if (
    !isRecord(value) ||
    value.operationId !== operationId ||
    !integer(value.clearedAt, 1) ||
    !integer(value.clearedCount) ||
    !integer(value.clearEpoch)
  ) {
    throw new SyncProtocolError('Invalid clear RPC receipt or operation id mismatch');
  }
  return {
    operationId,
    clearedAt: value.clearedAt,
    clearedCount: value.clearedCount,
    clearEpoch: value.clearEpoch
  };
}
function validateOperation(value: unknown, scope: string): SyncClearOperationRow | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value.kind !== 'clear' ||
    value.scope !== scope ||
    typeof value.operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.operationId) ||
    !['pending', 'unknown', 'confirmed'].includes(String(value.state))
  ) {
    throw new SyncProtocolError('Invalid stored clear operation');
  }
  const row = value as unknown as SyncClearOperationRow;
  if (row.state === 'confirmed') {
    validateReceipt(
      {
        operationId: row.operationId,
        clearedAt: row.clearedAt,
        clearedCount: row.clearedCount,
        clearEpoch: row.clearEpoch
      },
      row.operationId
    );
  }
  return row;
}
export class SyncProtocolClient {
  constructor(
    private readonly db: Dexie,
    private readonly table: Table<SyncProtocolRow, string>
  ) {}
  private transaction<T>(mode: 'r' | 'rw', run: () => Promise<T>): Promise<T> {
    const tx = Dexie.currentTransaction;
    if (tx?.db === this.db && tx.storeNames.includes(this.table.name)) return run();
    return this.db.transaction(mode, this.table, run);
  }
  private writeAhead<T>(run: () => Promise<T>): Promise<T> {
    return Dexie.ignoreTransaction(() => this.db.transaction('rw', this.table, run));
  }
  readProtocol(cfg: SyncConfig, signal?: AbortSignal): Promise<SyncProtocol> {
    return fetchCapabilities(cfg, signal);
  }
  async storeProtocol(cfg: SyncConfig, capabilities: SyncProtocol): Promise<void> {
    const scope = protocolScope(cfg);
    const valid = validateProtocol(capabilities);
    await this.transaction('rw', async () => {
      const key = protocolKey(scope);
      const existing = await this.table.get(key);
      if (existing !== undefined) {
        if (existing.kind !== 'protocol' || existing.scope !== scope)
          throw new SyncProtocolError('Invalid stored sync protocol row');
        const current = validateProtocol(existing.capabilities);
        if (current.protocolVersion > valid.protocolVersion || current.clearEpoch > valid.clearEpoch) return;
      }
      await this.table.put({ key, kind: 'protocol', scope, capabilities: valid, observedAt: Date.now() });
    });
  }
  async readStoredProtocol(cfg: SyncConfig): Promise<number | undefined> {
    const scope = protocolScope(cfg);
    return this.transaction('r', async () => {
      const row = await this.table.get(protocolKey(scope));
      if (row === undefined) return undefined;
      if (row.kind !== 'protocol' || row.scope !== scope)
        throw new SyncProtocolError('Invalid stored sync protocol row');
      return validateProtocol(row.capabilities).clearEpoch;
    });
  }
  async pendingClear(cfg: SyncConfig): Promise<SyncClearOperationRow | undefined> {
    const scope = protocolScope(cfg);
    return this.transaction('r', async () => validateOperation(await this.table.get(clearKey(scope)), scope));
  }
  async clearLedgerRpc(cfg: SyncConfig, signal?: AbortSignal): Promise<ClearReceipt> {
    if (Dexie.currentTransaction?.db === this.db)
      throw new SyncProtocolError('clearLedgerRpc must run outside a Dexie transaction');
    const scope = protocolScope(cfg);
    const confirmed = await this.pendingClear(cfg);
    if (confirmed?.state === 'confirmed')
      return validateReceipt(
        {
          operationId: confirmed.operationId,
          clearedAt: confirmed.clearedAt,
          clearedCount: confirmed.clearedCount,
          clearEpoch: confirmed.clearEpoch
        },
        confirmed.operationId
      );
    const capabilities = await this.readProtocol(cfg, signal);
    if (capabilities.protocolVersion !== 2 || !capabilities.ledgerScoped || !capabilities.clearRpcEnabled) {
      throw new SyncProtocolError('Clear requires the upgraded ledger-scoped sync protocol v2');
    }
    const operation = await this.writeAhead(async () => {
      const key = clearKey(scope);
      const existing = validateOperation(await this.table.get(key), scope);
      if (existing) return existing;
      const created: SyncClearOperationRow = {
        key,
        kind: 'clear',
        scope,
        operationId: crypto.randomUUID(),
        state: 'pending'
      };
      await this.table.put(created);
      return created;
    });
    if (operation.state === 'confirmed')
      return validateReceipt(
        {
          operationId: operation.operationId,
          clearedAt: operation.clearedAt,
          clearedCount: operation.clearedCount,
          clearEpoch: operation.clearEpoch
        },
        operation.operationId
      );
    try {
      const receipt = await callRpc(
        cfg,
        'yh_clear_ledger',
        { p_operation_id: operation.operationId },
        signal,
        async (response) => {
          if (!response.ok)
            throw new SyncProtocolError(`Clear RPC rejected (HTTP ${response.status})`, response.status);
          return validateReceipt(await responseJson(response), operation.operationId);
        }
      );
      await this.updateOperation(scope, operation.operationId, (row) => ({
        ...row,
        state: 'confirmed',
        clearedAt: receipt.clearedAt,
        clearedCount: receipt.clearedCount,
        clearEpoch: receipt.clearEpoch,
        lastError: undefined
      }));
      return receipt;
    } catch (error) {
      const definiteClientError =
        error instanceof SyncProtocolError && error.status !== undefined && error.status >= 400 && error.status < 500;
      await this.updateOperation(scope, operation.operationId, (row) =>
        row.state === 'confirmed'
          ? row
          : {
              ...row,
              state: definiteClientError ? 'pending' : 'unknown',
              lastError: definiteClientError ? `HTTP ${error.status}` : 'Outcome unknown; retry the same operation'
            }
      );
      throw error instanceof SyncProtocolError
        ? error
        : new SyncProtocolError('Clear RPC outcome is unknown; retry the same operation');
    }
  }
  private async updateOperation(
    scope: string,
    operationId: string,
    update: (row: SyncClearOperationRow) => SyncClearOperationRow
  ): Promise<void> {
    await this.writeAhead(async () => {
      const key = clearKey(scope);
      const row = validateOperation(await this.table.get(key), scope);
      if (!row || row.operationId !== operationId)
        throw new SyncProtocolError('Clear operation changed before its result was stored');
      await this.table.put(update(row));
    });
  }
  async finishClearOperation(cfg: SyncConfig, operationId: string): Promise<void> {
    const scope = protocolScope(cfg);
    await this.transaction('rw', async () => {
      const key = clearKey(scope);
      const row = validateOperation(await this.table.get(key), scope);
      if (!row) return;
      if (row.operationId !== operationId)
        throw new SyncProtocolError('Clear operation id does not match the pending operation');
      if (row.state !== 'confirmed') throw new SyncProtocolError('Cannot finish an unconfirmed clear operation');
      await this.table.delete(key);
    });
  }
}
let production: SyncProtocolClient | undefined;
function client(): SyncProtocolClient {
  return (production ??= new SyncProtocolClient(mainDb, mainDb.table<SyncProtocolRow, string>('syncMeta')));
}
export function readProtocol(cfg: SyncConfig, signal?: AbortSignal): Promise<SyncProtocol> {
  return client().readProtocol(cfg, signal);
}
export function storeProtocol(cfg: SyncConfig, capabilities: SyncProtocol): Promise<void> {
  return client().storeProtocol(cfg, capabilities);
}
export function readStoredProtocol(cfg: SyncConfig): Promise<number | undefined> {
  return client().readStoredProtocol(cfg);
}
export function pendingClear(cfg: SyncConfig): Promise<SyncClearOperationRow | undefined> {
  return client().pendingClear(cfg);
}
export function clearLedgerRpc(cfg: SyncConfig, signal?: AbortSignal): Promise<ClearReceipt> {
  return client().clearLedgerRpc(cfg, signal);
}
export function finishClearOperation(cfg: SyncConfig, operationId: string): Promise<void> {
  return client().finishClearOperation(cfg, operationId);
}
