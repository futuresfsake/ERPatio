import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(toCsv([['a,b', 'plain']])).toBe('"a,b",plain\r\n');
  });
  it('neutralises spreadsheet formulas but leaves negative numbers alone', () => {
    expect(toCsv([['=SUM(A1:A9)', '+cmd', '@x', '-1,200.50', '-5']])).toBe(`'=SUM(A1:A9),'+cmd,'@x,"-1,200.50",-5\r\n`);
  });
});
