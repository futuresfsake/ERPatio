/** Money handling with integer units (1/10000), never floats. Mirrors backend/src/lib/money.ts. */
const SCALE = 4;

/** Parses user input with up to 2 decimals (display currency). Returns null when invalid. */
export function parseAmount(input: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ''));
  if (!m) return null;
  return BigInt(m[1]!) * 10n ** BigInt(SCALE) + BigInt((m[2] ?? '').padEnd(SCALE, '0'));
}

/** API decimal string (e.g. "1234.5000") to units. */
export function fromApi(s: string): bigint {
  const [w = '0', f = ''] = s.split('.');
  return BigInt(w) * 10n ** BigInt(SCALE) + BigInt(f.padEnd(SCALE, '0').slice(0, SCALE));
}

/** Units to the decimal string the API expects, e.g. 10050000n -> "1005.0000". */
export function toApi(n: bigint): string {
  const s = n.toString().padStart(SCALE + 1, '0');
  return `${s.slice(0, -SCALE)}.${s.slice(-SCALE)}`;
}

const GROUP = /\B(?=(\d{3})+(?!\d))/g;

export function formatPeso(n: bigint): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(SCALE + 1, '0');
  const whole = s.slice(0, -SCALE).replace(GROUP, ',');
  const cents = s.slice(-SCALE, -SCALE + 2);
  return `${neg ? '-' : ''}₱${whole}.${cents}`;
}

export const formatApiPeso = (s: string): string => formatPeso(fromApi(s));

/** Ledger style: grouped, two decimals, negatives in parentheses, no currency symbol (it is in the column header). */
export function formatNum(n: bigint): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(SCALE + 1, '0');
  const t = `${s.slice(0, -SCALE).replace(GROUP, ',')}.${s.slice(-SCALE, -SCALE + 2)}`;
  return neg ? `(${t})` : t;
}

export const formatApiNum = (s: string): string => formatNum(fromApi(s));
