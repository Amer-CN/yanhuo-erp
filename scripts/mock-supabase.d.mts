export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  ledger: string;
}

export interface MockFailure {
  status: number;
  body?: unknown;
}

export interface MockServerOptions {
  mode?: 'v1' | 'v2';
  // Journal runs before the gate/failure hooks; thrown or rejected errors return JSON 500.
  onRequest?: (request: MockRequest) => void;
  beforeRequest?: (request: MockRequest) => void | Promise<void>;
  failRequest?: (request: MockRequest) => MockFailure | number | false | null | undefined | Promise<MockFailure | number | false | null | undefined>;
}

export interface MockHttpServer {
  readonly listening: boolean;
  listen(port: number, host: string, callback?: () => void): this;
  address(): string | null | { address: string; family: string; port: number };
  close(callback?: (error?: Error) => void): this;
  closeAllConnections(): void;
}

export function createMockServer(options?: MockServerOptions): MockHttpServer;
