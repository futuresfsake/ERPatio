import { describe, expect, it } from 'vitest';
import { parseStatement } from './Bank';

describe('parseStatement', () => {
  it('reads date, description, amount and reference, skipping the header', () => {
    const rows = parseStatement('date,description,amount,reference\n2026-11-02,Deposit,"1,500.00",DEP1\n2026-11-03,Fee,-25.5,');
    expect(rows).toEqual([
      { date: '2026-11-02', description: 'Deposit', amount: '1500.00', reference: 'DEP1' },
      { date: '2026-11-03', description: 'Fee', amount: '-25.5' },
    ]);
  });

  it('treats brackets as negative and ignores blank, malformed and impossible lines', () => {
    const rows = parseStatement('2026-11-04,Check,(300.00)\n\nnot a row\n2026-13-45x,Bad date,5\n2026-11-05,Odd,12abc\n2026-11-06,,10');
    expect(rows).toEqual([
      { date: '2026-11-04', description: 'Check', amount: '-300.00' },
      { date: '2026-11-06', description: 'Statement line', amount: '10' },
    ]);
  });
});
