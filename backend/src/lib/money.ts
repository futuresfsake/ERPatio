/** Money is NUMERIC(19,4) in Postgres and a decimal *string* in the API: never a JS float. */
const SCALE = 4;
const RE = /^\d{1,15}(\.\d{1,4})?$/;

export const isMoney = (s: string): boolean => RE.test(s);

export function toUnits(s: string): bigint {
  const [whole = '0', frac = ''] = s.split('.');
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(frac.padEnd(SCALE, '0'));
}

export function fromUnits(n: bigint): string {
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const s = abs.toString().padStart(SCALE + 1, '0');
  return `${neg ? '-' : ''}${s.slice(0, -SCALE)}.${s.slice(-SCALE)}`;
}
