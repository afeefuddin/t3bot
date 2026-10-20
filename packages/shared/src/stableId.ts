import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export function stableId(namespace: string, ...parts: ReadonlyArray<string | number>): string {
  const tuple = parts.map((part) => `${typeof part}:${String(part).length}:${part}`).join("|");
  return `${namespace}:${bytesToHex(sha256(utf8ToBytes(tuple)))}`;
}
