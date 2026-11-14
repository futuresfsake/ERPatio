#!/usr/bin/env node
/**
 * Break-it check (audit F-12). Passing tests prove little unless they fail when the code is wrong, so this breaks the
 * money-critical and security-critical rules one at a time, runs the tests that are meant to protect each, and reports any
 * break that goes unnoticed. A miss is a weak test: fix the test, not the report.
 *
 *   node scripts/break-it.mjs            run every break
 *   node scripts/break-it.mjs ledger     only breaks whose id contains "ledger"
 *
 * The original file is always restored (in a finally), and the working tree is checked afterwards.
 */
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import console from 'node:console';

const root = resolve(import.meta.dirname, '..');
const BREAKS = [
  // ledger balance check: not listed. The service check and the deferred database trigger map to the same error, so breaking the first alone is
  // not observable by design; the direct-SQL test proves the database refuses an unbalanced entry.
  { id: 'ledger-one-sided-lines', file: 'src/modules/ledger/service.ts', find: "if ((d > 0n) === (cr > 0n)) throw", replace: "if (false) throw", tests: ['tests/ledger.test.ts'] },
  { id: 'money-parse-fraction', file: 'src/lib/money.ts', find: "frac.padEnd(SCALE, '0')", replace: "frac.padStart(SCALE, '0')", tests: ['tests/ledger.test.ts', 'tests/statements.test.ts', 'tests/subledger.test.ts'] },
  { id: 'subledger-cent-rounding', file: 'src/modules/subledger/service.ts', find: "toUnits(l.unit_price) + 500000n) / 1000000n) * CENT", replace: "toUnits(l.unit_price) + 0n) / 1000000n) * CENT", tests: ['tests/subledger.test.ts'] },
  { id: 'subledger-over-allocation', file: 'src/modules/subledger/service.ts', find: "if (part > toUnits(d.total) - toUnits(d.paid_total)) throw new ApiError(422, 'over_allocation'", replace: "if (false) throw new ApiError(422, 'over_allocation'", tests: ['tests/subledger.test.ts'] },
  { id: 'subledger-aging-bucket', file: 'src/modules/subledger/service.ts', find: "late BETWEEN 1 AND 30", replace: "late BETWEEN 1 AND 31", tests: ['tests/subledger.test.ts'] },
  { id: 'subledger-note-direction', file: 'src/modules/subledger/service.ts', find: "kind === 'invoice' || kind === 'debit_note'", replace: "kind === 'invoice'", tests: ['tests/notes-bank.test.ts'] },
  { id: 'subledger-void-paid-guard', file: 'src/modules/subledger/service.ts', find: "if (toUnits(d.paid_total) > 0n) throw new ApiError(409, 'has_payments'", replace: "if (false) throw new ApiError(409, 'has_payments'", tests: ['tests/subledger.test.ts', 'tests/notes-bank.test.ts'] },
  { id: 'stock-average-cost', file: 'src/modules/stock/service.ts', find: "roundCent((m.qty * s.value) / s.qty)", replace: "roundCent((m.qty * s.value) / (s.qty + U))", tests: ['tests/stock.test.ts'] },
  { id: 'stock-insufficient', file: 'src/modules/stock/service.ts', find: "if (m.qty > s.qty) throw new ApiError(409, 'insufficient_stock'", replace: "if (false) throw new ApiError(409, 'insufficient_stock'", tests: ['tests/stock.test.ts'] },
  { id: 'stock-over-receipt', file: 'src/modules/stock/service.ts', find: "if (q > toUnits(r.quantity) - toUnits(r.done)) throw", replace: "if (false) throw", tests: ['tests/stock.test.ts'] },
  { id: 'stock-return-billed', file: 'src/modules/stock/service.ts', find: "if (q > toUnits(r.done) - toUnits(r.billed)) throw", replace: "if (q > toUnits(r.done)) throw", tests: ['tests/stock-gaps.test.ts'] },
  { id: 'stock-three-way-limit', file: 'src/modules/subledger/service.ts', find: "billed_qty + $3 <= received_qty", replace: "billed_qty + $3 >= 0", tests: ['tests/stock-gaps.test.ts'] },
  { id: 'production-share-ratio', file: 'src/modules/production/service.ts', find: "roundCent(ratio(wipBalance, q, remainingQty))", replace: "roundCent(ratio(wipBalance, q, toUnits(w.qty_planned)))", tests: ['tests/production.test.ts'] },
  { id: 'production-circular-bom', file: 'src/modules/production/service.ts', find: "if (await appearsBelow(c, p.tenantId, comps, data.item_id)) throw", replace: "if (false) throw", tests: ['tests/production.test.ts'] },
  { id: 'production-issue-state', file: 'src/modules/production/service.ts', find: "if (w.status !== 'released') throw new ApiError(409, 'not_released', 'Materials can only be issued", replace: "if (false) throw new ApiError(409, 'not_released', 'Materials can only be issued", tests: ['tests/production.test.ts'] },
  { id: 'yearend-sign', file: 'src/modules/periods/yearend.ts', find: "const profit = -accounts.reduce((s, r) => s + r.net, 0n);", replace: "const profit = accounts.reduce((s, r) => s + r.net, 0n);", tests: ['tests/yearend.test.ts'] },
  { id: 'yearend-once', file: 'src/modules/periods/yearend.ts', find: "if (x.closed) throw new ApiError(409, 'year_closed'", replace: "if (false) throw new ApiError(409, 'year_closed'", tests: ['tests/yearend.test.ts'] },
  { id: 'bank-auto-match-ambiguity', file: 'src/modules/bank/service.ts', find: "if (cands.length === 1 && rivals.length === 1) {", replace: "if (cands.length >= 1) {", tests: ['tests/notes-bank.test.ts'] },
  { id: 'bank-amount-agree', file: 'src/modules/bank/service.ts', find: "if (signed(l.amount) !== signed(s.amount)) throw", replace: "if (false) throw", tests: ['tests/notes-bank.test.ts'] },
  { id: 'payroll-self-approval', file: 'src/modules/hcm/service.ts', find: "if (run.created_by === p.userId) throw", replace: "if (false) throw", tests: ['tests/payroll.test.ts'] },
  { id: 'payroll-tax-excess', file: 'src/modules/hcm/service.ts', find: "rate(monthlyTaxable - b.lower, b.rate)", replace: "rate(monthlyTaxable, b.rate)", tests: ['tests/payroll.test.ts'] },
  { id: 'payroll-contribution-base', file: 'src/modules/hcm/service.ts', find: "rate(clamp(monthly, r.min, r.max), side", replace: "rate(monthly, side", tests: ['tests/payroll.test.ts'] },
  { id: 'payroll-ee-er-swap', file: 'src/modules/hcm/service.ts', find: "side === 'ee' ? r.ee : r.er", replace: "side === 'ee' ? r.er : r.ee", tests: ['tests/payroll.test.ts'] },
  { id: 'payroll-erase-only-former', file: 'src/modules/hcm/service.ts', find: "if (e.status !== 'terminated') throw new ApiError(409, 'still_active'", replace: "if (false) throw new ApiError(409, 'still_active'", tests: ['tests/payroll.test.ts'] },
  { id: 'payroll-overtime', file: 'src/modules/hcm/service.ts', find: "overtime = Math.max(0, net - shiftHours);", replace: "overtime = 0;", tests: ['tests/payroll.test.ts'] },
  { id: 'import-all-or-nothing', file: 'src/modules/data/service.ts', find: "if (errors.length) throw new ApiError(422, 'import_errors'", replace: "if (false) throw new ApiError(422, 'import_errors'", tests: ['tests/bi-data.test.ts'] },
  { id: 'export-strips-secrets', file: 'src/modules/data/service.ts', find: "if (SECRET_KEY.test(k)) delete r.j[k];", replace: "", tests: ['tests/bi-data.test.ts'] },
  { id: 'cache-version', file: 'src/lib/cache.ts', find: "hit.version === version", replace: "true", tests: ['tests/bi-data.test.ts'] },
  { id: 'api-key-forbidden', file: 'src/modules/apikeys/service.ts', find: "&& !(API_KEY_FORBIDDEN as string[]).includes(x));", replace: ");", tests: ['tests/integrations.test.ts'] },
  { id: 'api-key-creator-active', file: 'src/modules/apikeys/service.ts', find: "|| !k.user_active ||", replace: "||", tests: ['tests/integrations.test.ts'] },
  { id: 'api-key-held-permissions', file: 'src/modules/apikeys/service.ts', find: "filter((x) => held.has(x) && ", replace: "filter((x) => ", tests: ['tests/integrations.test.ts'] },
  { id: 'webhook-link-local', file: 'src/modules/webhooks/service.ts', find: "(a === 169 && b === 254)", replace: "false", tests: ['tests/integrations.test.ts'] },
  { id: 'webhook-signature', file: 'src/modules/webhooks/service.ts', find: ".update(`${timestamp}.${body}`)", replace: ".update(body)", tests: ['tests/integrations.test.ts'] },
  { id: 'webhook-url-credentials', file: 'src/modules/webhooks/service.ts', find: "if (u.username || u.password) throw", replace: "if (false) throw", tests: ['tests/integrations.test.ts'] },
  { id: 'plan-entry-cap', file: 'src/modules/billing/service.ts', find: "if (cap !== null && used > cap) throw", replace: "if (false) throw", tests: ['tests/integrations.test.ts'] },
  { id: 'plan-user-cap', file: 'src/modules/billing/service.ts', find: "if (r && r.m !== null && Number(r.n) >= r.m) throw", replace: "if (false) throw", tests: ['tests/integrations.test.ts'] },
  { id: 'ledger-no-hand-reversal', file: 'src/modules/ledger/service.ts', find: "if (owned.rowCount) throw new ApiError(409, 'subledger_entry'", replace: "if (false) throw new ApiError(409, 'subledger_entry'", tests: ['tests/subledger.test.ts', 'tests/yearend.test.ts'] },
];

const only = process.argv[2];
const picked = only ? BREAKS.filter((b) => b.id.includes(only)) : BREAKS;
let missed = 0;
const results = [];
for (const b of picked) {
  const path = resolve(root, b.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(b.find)) { console.log(`?  ${b.id}: the text to break was not found (the code moved: update this list)`); missed += 1; results.push([b.id, 'NOT FOUND']); continue; }
  try {
    writeFileSync(path, original.replace(b.find, b.replace));
    const r = spawnSync('npx', ['vitest', 'run', ...b.tests], { cwd: root, encoding: 'utf8', shell: true, timeout: 300_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const failed = r.status !== 0 && /failed|FAIL/.test(out);
    console.log(`${failed ? 'ok' : 'MISSED'}  ${b.id}`);
    if (!failed) missed += 1;
    results.push([b.id, failed ? 'caught' : 'MISSED']);
  } finally {
    writeFileSync(path, original);
  }
}
const dirty = execSync('git status --porcelain -- src', { cwd: root, encoding: 'utf8' }).trim();
console.log(`\n${results.filter((r) => r[1] === 'caught').length} of ${picked.length} breaks caught${missed ? `, ${missed} NOT caught` : ''}.`);
if (dirty) console.log('Note: src has other uncommitted changes (expected only if you had edits before running):\n' + dirty);
process.exit(missed ? 1 : 0);
