// @effect-diagnostics nodeBuiltinImport:off -- Pure verification at the external webhook boundary.
import * as NodeCrypto from "node:crypto";

export function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
}

export function verifySlackRequest(
  secret: string,
  timestamp: string,
  signature: string,
  raw: string,
  now: number,
): boolean {
  if (
    !/^\d+$/.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp)) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    return false;
  const expected = `v0=${NodeCrypto.createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  return equalSecret(signature, expected);
}
