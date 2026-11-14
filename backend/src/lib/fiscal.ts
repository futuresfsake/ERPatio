/** Fiscal calendar helpers. v1 uses calendar months, January to December (customer profile, doc 03). */
const pad = (n: number) => String(n).padStart(2, '0');

export interface MonthRange {
  month: number;
  start: string;
  end: string;
}

export function monthRanges(year: number): MonthRange[] {
  return Array.from({ length: 12 }, (_, i) => {
    const month = i + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { month, start: `${year}-${pad(month)}-01`, end: `${year}-${pad(month)}-${pad(lastDay)}` };
  });
}

/** Years provisioned for a new tenant: last year, this year, next year. */
export function defaultFiscalYears(now = new Date()): number[] {
  const y = now.getUTCFullYear();
  return [y - 1, y, y + 1];
}
