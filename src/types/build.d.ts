/** Vite 在构建时注入的确定性标识，开发服务固定为 dev。 */
declare const __APP_BUILD__: string;

/** 配置只需这两个 Node API，不把 Node 全局类型带进浏览器代码。 */
declare module 'node:child_process' {
  export function execFileSync(
    file: string,
    args: readonly string[],
    options: { encoding: 'utf8'; timeout: number; stdio: ['ignore', 'pipe', 'ignore'] }
  ): string;
}

declare module 'node:process' {
  export const env: Record<string, string | undefined>;
}
