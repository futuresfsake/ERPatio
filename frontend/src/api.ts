/**
 * API client. The access token lives in memory only (never localStorage, ADR-004); the refresh token is an
 * HttpOnly cookie the page cannot read. A 401 triggers exactly one silent refresh and retry.
 */
export interface SessionUser {
  id: string;
  full_name: string;
  roles: string[];
  permissions: string[];
}
interface TokenResponse {
  access_token: string;
  expires_in: number;
  user: SessionUser;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: { field: string; reason: string }[],
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<TokenResponse | null> | null = null;
let onSessionLost: () => void = () => undefined;

export const setSessionLostHandler = (fn: () => void) => {
  onSessionLost = fn;
};

async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  headers.set('X-Requested-With', 'erpatio');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  return fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    const e = body?.error ?? {};
    return new ApiError(res.status, e.code ?? 'error', e.message ?? 'Something went wrong.', e.request_id, e.details);
  } catch {
    return new ApiError(res.status, 'error', 'Something went wrong.');
  }
}

async function refreshSession(): Promise<TokenResponse | null> {
  refreshing ??= (async () => {
    try {
      const res = await raw('/auth/refresh', { method: 'POST' });
      if (!res.ok) return null;
      const body = (await res.json()) as TokenResponse;
      accessToken = body.access_token;
      return body;
    } catch {
      return null;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const opts: RequestInit = json === undefined ? rest : { ...rest, body: JSON.stringify(json) };
  let res = await raw(path, opts);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await raw(path, opts);
    else {
      accessToken = null;
      onSessionLost();
    }
  }
  if (!res.ok) throw await toError(res);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export async function login(workspace: string, email: string, password: string): Promise<SessionUser> {
  const body = await api<TokenResponse>('/auth/login', { method: 'POST', json: { workspace, email, password } });
  accessToken = body.access_token;
  return body.user;
}

/** Restores a session from the refresh cookie on page load. */
export async function restoreSession(): Promise<SessionUser | null> {
  return (await refreshSession())?.user ?? null;
}

export async function logout(): Promise<void> {
  try {
    await api('/auth/logout', { method: 'POST' });
  } finally {
    accessToken = null;
  }
}

// ---- typed endpoints -------------------------------------------------------------------------------------------
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export interface Account { id: string; code: string; name: string; type: AccountType; is_active: boolean }
export interface Line { line_no: number; account_id: string; account_code: string; account_name: string; debit: string; credit: string; memo: string | null }
export interface Entry {
  id: string; entry_no: number; entry_date: string; description: string; reference: string | null;
  reverses_entry_id: string | null; reversed_by_entry_id: string | null; total: string; created_at: string; lines: Line[];
}
export interface EntryPage { items: Entry[]; total: number; limit: number; offset: number }
export interface TrialBalanceRow { account_id: string; code: string; name: string; type: AccountType; debit: string; credit: string }
export interface TrialBalance { as_of: string; rows: TrialBalanceRow[]; total_debit: string; total_credit: string; balanced: boolean }
export interface AuditEvent { id: number; occurred_at: string; action: string; actor_user_id: string | null; entity_type: string | null; entity_id: string | null; detail: Record<string, unknown> }
export interface NewEntry { entry_date: string; description: string; reference?: string; lines: { account_id: string; debit: string; credit: string }[] }

export interface Period { id: string; year: number; month: number; start_date: string; end_date: string; status: 'open' | 'closed'; closed_at: string | null; open_drafts: number }
export interface Settings { require_approval: boolean }
export interface DraftLine { line_no: number; account_id: string; account_code: string; account_name: string; debit: string; credit: string; memo: string | null }
export interface Draft {
  id: string; entry_date: string; description: string; reference: string | null; status: 'draft' | 'submitted';
  created_by: string; created_by_name: string; created_at: string; updated_at: string; submitted_at: string | null;
  rejection_note: string | null; total_debit: string; total_credit: string; lines?: DraftLine[];
}
export interface DraftInput { entry_date: string; description: string; reference?: string; lines: { account_id: string; debit: string; credit: string }[] }
export interface StatementLine { account_id: string; code: string; name: string; amount: string }
export interface IncomeStatement { from: string; to: string; revenue: { rows: StatementLine[]; total: string }; expenses: { rows: StatementLine[]; total: string }; net_income: string }
export interface BalanceSheet {
  as_of: string; assets: { rows: StatementLine[]; total: string }; liabilities: { rows: StatementLine[]; total: string };
  equity: { rows: StatementLine[]; earnings: string; total: string }; balanced: boolean;
}

export const endpoints = {
  accounts: () => api<Account[]>('/accounts'),
  createAccount: (a: { code: string; name: string; type: AccountType }) => api<Account>('/accounts', { method: 'POST', json: a }),
  updateAccount: (id: string, p: Partial<Pick<Account, 'name' | 'is_active'>>) => api<Account>(`/accounts/${id}`, { method: 'PATCH', json: p }),
  entries: (limit = 25, offset = 0) => api<EntryPage>(`/journal-entries?limit=${limit}&offset=${offset}`),
  entry: (id: string) => api<Entry>(`/journal-entries/${id}`),
  postEntry: (e: NewEntry) => api<Entry>('/journal-entries', { method: 'POST', json: e }),
  reverse: (id: string) => api<Entry>(`/journal-entries/${id}/reverse`, { method: 'POST', json: {} }),
  trialBalance: (asOf: string) => api<TrialBalance>(`/reports/trial-balance?as_of=${asOf}`),
  audit: () => api<AuditEvent[]>('/audit-log?limit=100'),
  periods: () => api<Period[]>('/fiscal-periods'),
  createYear: (year: number) => api<{ year: number; periods: number }>('/fiscal-years', { method: 'POST', json: { year } }),
  closePeriod: (id: string) => api<{ id: string; status: string }>(`/fiscal-periods/${id}/close`, { method: 'POST', json: {} }),
  reopenPeriod: (id: string, reason: string) => api<{ id: string; status: string }>(`/fiscal-periods/${id}/reopen`, { method: 'POST', json: { reason } }),
  settings: () => api<Settings>('/settings'),
  updateSettings: (require_approval: boolean) => api<Settings>('/settings', { method: 'PATCH', json: { require_approval } }),
  drafts: (status?: 'draft' | 'submitted') => api<Draft[]>(`/journal-drafts${status ? `?status=${status}` : ''}`),
  draft: (id: string) => api<Draft>(`/journal-drafts/${id}`),
  createDraft: (d: DraftInput) => api<Draft>('/journal-drafts', { method: 'POST', json: d }),
  updateDraft: (id: string, d: DraftInput) => api<Draft>(`/journal-drafts/${id}`, { method: 'PATCH', json: d }),
  deleteDraft: (id: string) => api<void>(`/journal-drafts/${id}`, { method: 'DELETE' }),
  submitDraft: (id: string) => api<Draft>(`/journal-drafts/${id}/submit`, { method: 'POST', json: {} }),
  rejectDraft: (id: string, note: string) => api<Draft>(`/journal-drafts/${id}/reject`, { method: 'POST', json: { note } }),
  postDraft: (id: string) => api<Entry>(`/journal-drafts/${id}/post`, { method: 'POST', json: {} }),
  incomeStatement: (from: string, to: string) => api<IncomeStatement>(`/reports/income-statement?from=${from}&to=${to}`),
  balanceSheet: (asOf: string) => api<BalanceSheet>(`/reports/balance-sheet?as_of=${asOf}`),
};
