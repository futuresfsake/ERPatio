import { describe, expect, it } from 'vitest';
import { formatNum, formatPeso, fromApi, parseAmount, toApi } from './money';

describe('money', () => {
  it('parses valid amounts and rejects the rest', () => {
    expect(parseAmount('1,234.5')).toBe(12345000n);
    expect(parseAmount('0.1')! + parseAmount('0.2')!).toBe(parseAmount('0.3'));
    for (const bad of ['', '-1', '1.234', 'abc', '1e3', '.5', '1.']) expect(parseAmount(bad)).toBeNull();
  });
  it('round-trips the API representation', () => {
    expect(toApi(parseAmount('1005')!)).toBe('1005.0000');
    expect(fromApi('1005.0000')).toBe(10050000n);
    expect(fromApi('0.3')).toBe(3000n);
  });
  it('formats pesos with grouping', () => {
    expect(formatPeso(fromApi('1234567.8900'))).toBe('₱1,234,567.89');
    expect(formatPeso(-5000n)).toBe('-₱0.50');
  });
  it('prints negatives in parentheses without a currency symbol', () => {
    expect(formatNum(fromApi('-16700'))).toBe('(16,700.00)');
    expect(formatNum(0n)).toBe('0.00');
    expect(formatNum(fromApi('1000000'))).toBe('1,000,000.00');
  });
});
