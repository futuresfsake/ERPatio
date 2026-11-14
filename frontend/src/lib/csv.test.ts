import { describe, expect, it } from 'vitest';
import { csvToObjects, parseCsv, toCsv } from './csv';

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(toCsv([['a,b', 'plain']])).toBe('"a,b",plain\r\n');
  });
  it('neutralises spreadsheet formulas but leaves negative numbers alone', () => {
    expect(toCsv([['=SUM(A1:A9)', '+cmd', '@x', '-1,200.50', '-5']])).toBe(`'=SUM(A1:A9),'+cmd,'@x,"-1,200.50",-5\r\n`);
  });
});

describe('csv reading', () => {
  it('handles quotes, doubled quotes, embedded newlines, CRLF and a byte-order mark', () => {
    expect(parseCsv('\ufeffa,"b,1","say ""hi"""\r\n"x\ny",2,3\r\n')).toEqual([['a', 'b,1', 'say "hi"'], ['x\ny', '2', '3']]);
  });
  it('skips blank lines and turns the header into keys', () => {
    expect(csvToObjects('Code, Full Name\n\nk1,Kopi\n')).toEqual({ headers: ['code', 'full_name'], rows: [{ code: 'k1', full_name: 'Kopi' }] });
  });
  it('round-trips what toCsv writes', () => {
    const rows = [['a,b', 'c"d', 'e\nf']];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
