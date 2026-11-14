/**
 * Starting statutory rules and monthly withholding brackets. They are data in the database, edited by the company's
 * payroll manager, so a change in rates is an edit and not a deployment. Confirm them with the accountant (audit F-53).
 */
export const STATUTORY_DEFAULTS: { code: 'sss' | 'philhealth' | 'pagibig'; ee: string; er: string; min: string; max: string }[] = [
  { code: 'sss', ee: '5', er: '10', min: '5000', max: '35000' },
  { code: 'philhealth', ee: '2.5', er: '2.5', min: '10000', max: '100000' },
  { code: 'pagibig', ee: '2', er: '2', min: '0', max: '10000' },
];
export const TAX_DEFAULTS: { lower: string; upper: string | null; base: string; rate: string }[] = [
  { lower: '0', upper: '20833', base: '0', rate: '0' },
  { lower: '20833', upper: '33333', base: '0', rate: '15' },
  { lower: '33333', upper: '66667', base: '1875', rate: '20' },
  { lower: '66667', upper: '166667', base: '8541.80', rate: '25' },
  { lower: '166667', upper: '666667', base: '33541.80', rate: '30' },
  { lower: '666667', upper: null, base: '183541.80', rate: '35' },
];
