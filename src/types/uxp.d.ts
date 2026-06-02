declare function require(moduleName: string): any;

declare module "fflate" {
  export function gzipSync(data: Uint8Array, opts?: Record<string, unknown>): Uint8Array;
  export function gunzipSync(data: Uint8Array): Uint8Array;
  export function strFromU8(data: Uint8Array): string;
  export function strToU8(data: string): Uint8Array;
}
