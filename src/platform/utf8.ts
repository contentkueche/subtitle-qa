import { strFromU8, strToU8 } from "fflate";

export function decodeUtf8(bytes: Uint8Array): string {
  return strFromU8(bytes);
}

export function encodeUtf8(text: string): Uint8Array {
  return strToU8(text);
}
