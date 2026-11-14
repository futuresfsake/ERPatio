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

/** Reads CSV text into rows of cells. Honours double quotes (a comma or newline inside quotes stays in the cell) and "" as a quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  const src = text.replace(/^\ufeff/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cur.trim()); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cur.trim()); cur = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/** First row is the header; its names (lower-cased, spaces to underscores) become the keys. */
export function csvToObjects(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const [head, ...body] = parseCsv(text);
  const headers = (head ?? []).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  return { headers, rows: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))) };
}
