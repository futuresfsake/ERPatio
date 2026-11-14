/** Client-side CSV export (FR-FIN-12). Cells that start with = + - @ are prefixed so a spreadsheet never runs them as a formula. */
const DANGEROUS = /^[=+\-@\t\r]/;

function cell(v: string): string {
  const safe = DANGEROUS.test(v) && !/^-?\d[\d,]*(\.\d+)?$/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const toCsv = (rows: string[][]): string => rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

export function downloadCsv(filename: string, rows: string[][]): void {
  const url = URL.createObjectURL(new Blob(['\ufeff' + toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
