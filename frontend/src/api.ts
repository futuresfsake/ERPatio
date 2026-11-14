/**
 * API client. The access token lives in memory only (never localStorage, ADR-004); the refresh token is an
 * HttpOnly cookie the page cannot read. A 401 triggers exactly one silent refresh and retry.
 */
export interface SessionUser {
  id: string;
  full_name: string;
  roles: string[];
  permissions: string[];
  mfa_enabled: boolean;
  mfa_enrollment_required: boolean;
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
let supportMode = false;
/** A support session is read-only and must never silently turn into the operator's own session on a 401. */
export const setSupportMode = (on: boolean) => {
  supportMode = on;
};

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
  if (res.status === 401 && !path.startsWith('/auth/') && supportMode) {
    accessToken = null;
    onSessionLost();
  } else if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await raw(path, opts);
    else {
      accessToken = null;
      onSessionLost();
    }
  }
  if (!res.ok) throw await toError(res);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
/** For a file download, which a plain fetch must authenticate by hand. */
export const currentAccessToken = (): string | null => accessToken;

export type LoginResult = { kind: 'session'; user: SessionUser } | { kind: 'mfa'; mfaToken: string };

export async function login(workspace: string, email: string, password: string): Promise<LoginResult> {
  const body = await api<TokenResponse | { mfa_required: true; mfa_token: string }>('/auth/login', { method: 'POST', json: { workspace, email, password } });
  if ('mfa_required' in body) return { kind: 'mfa', mfaToken: body.mfa_token };
  accessToken = body.access_token;
  return { kind: 'session', user: body.user };
}

export async function loginMfa(mfaToken: string, code: string): Promise<SessionUser> {
  const body = await api<TokenResponse>('/auth/login/mfa', { method: 'POST', json: { mfa_token: mfaToken, code } });
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

// ---- account lifecycle, security and privacy ---------------------------------------------------------------
export interface Me { id: string; tenant_id: string; full_name: string; email: string; roles: string[]; permissions: string[]; mfa_enabled: boolean; mfa_enrollment_required: boolean; recovery_codes_left: number }
export interface SessionRow { id: string; started_at: string; last_active_at: string; ip: string | null; user_agent: string | null; current: boolean }

export const account = {
  publicConfig: () => api<{ signup_enabled: boolean }>('/public-config'),
  signup: (b: { company: string; full_name: string; email: string; password: string; accept_privacy: true }) => api<{ message: string }>('/auth/signup', { method: 'POST', json: b }),
  verifyEmail: (token: string) => api<{ message: string }>('/auth/verify-email', { method: 'POST', json: { token } }),
  resend: (workspace: string, email: string) => api<{ message: string }>('/auth/resend-verification', { method: 'POST', json: { workspace, email } }),
  forgot: (workspace: string, email: string) => api<{ message: string }>('/auth/forgot-password', { method: 'POST', json: { workspace, email } }),
  reset: (token: string, password: string) => api<{ message: string }>('/auth/reset-password', { method: 'POST', json: { token, password } }),
  me: () => api<Me>('/auth/me'),
  setup2fa: () => api<{ secret: string; otpauth_url: string }>('/auth/2fa/setup', { method: 'POST', json: {} }),
  enable2fa: async (code: string) => {
    const r = await api<{ recovery_codes: string[]; access_token: string; expires_in: number }>('/auth/2fa/enable', { method: 'POST', json: { code } });
    setAccessToken(r.access_token); // the new token no longer carries the enrolment gate
    return r;
  },
  disable2fa: (password: string, code: string) => api<{ mfa_enabled: boolean }>('/auth/2fa/disable', { method: 'POST', json: { password, code } }),
  sessions: () => api<SessionRow[]>('/auth/sessions'),
  revokeSession: (id: string) => api<void>(`/auth/sessions/${id}`, { method: 'DELETE' }),
  revokeAll: () => api<{ revoked: number }>('/auth/sessions/revoke-all', { method: 'POST', json: {} }),
  exportMine: () => api<unknown>('/privacy/me/export'),
};

// ---- administration and platform ----------------------------------------------------------------------------
export interface Person { id: string; email: string; full_name: string; is_active: boolean; email_verified: boolean; totp_enabled: boolean; last_login_at: string | null; created_at: string; erased_at: string | null; invite_pending: boolean; roles: { id: string; name: string }[] }
export interface RoleRow { id: string; name: string; description: string | null; is_system: boolean; permissions: string[]; user_count: number }
export interface PermissionInfo { key: string; label: string; module: string }
export interface TenantInfo { slug: string; name: string; is_demo: boolean; base_currency: string; modules: { module: string; enabled: boolean }[] }
export interface PlatformTenant { id: string; slug: string; name: string; status: 'active' | 'suspended'; is_demo: boolean; users: number; entries: number; created_at: string; modules: { module: string; enabled: boolean }[] }
export interface SupportSession { access_token: string; expires_in: number; tenant: { id: string; slug: string; name: string } }

export const admin = {
  tenant: () => api<TenantInfo>('/tenant'),
  users: () => api<Person[]>('/users'),
  invite: (b: { email: string; full_name: string; role_ids: string[] }) => api<Person>('/users', { method: 'POST', json: b }),
  patchUser: (id: string, b: { full_name?: string; is_active?: boolean }) => api<Person>(`/users/${id}`, { method: 'PATCH', json: b }),
  setRoles: (id: string, role_ids: string[]) => api<Person>(`/users/${id}/roles`, { method: 'PATCH', json: { role_ids } }),
  resendInvite: (id: string) => api<{ sent: true }>(`/users/${id}/resend-invite`, { method: 'POST', json: {} }),
  roles: () => api<RoleRow[]>('/roles'),
  permissions: () => api<PermissionInfo[]>('/permissions'),
  createRole: (b: { name: string; description?: string; permissions: string[] }) => api<RoleRow>('/roles', { method: 'POST', json: b }),
  updateRole: (id: string, b: { name?: string; description?: string; permissions?: string[] }) => api<RoleRow>(`/roles/${id}`, { method: 'PATCH', json: b }),
  deleteRole: (id: string) => api<void>(`/roles/${id}`, { method: 'DELETE' }),
};

export const platform = {
  tenants: () => api<PlatformTenant[]>('/platform/tenants'),
  setStatus: (id: string, status: 'active' | 'suspended') => api<{ status: string }>(`/platform/tenants/${id}/status`, { method: 'POST', json: { status } }),
  setModules: (id: string, modules: Record<string, boolean>) => api<{ module: string; enabled: boolean }[]>(`/platform/tenants/${id}/modules`, { method: 'PATCH', json: { modules } }),
  support: (id: string, reason: string) => api<SupportSession>(`/platform/tenants/${id}/support-session`, { method: 'POST', json: { reason } }),
};
