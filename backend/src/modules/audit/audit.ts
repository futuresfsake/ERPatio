/** Append-only audit trail (FR-IAM-11, T-05). Never put PII in `detail`. */
import type { PoolClient } from 'pg';

export interface AuditEvent {
  tenantId: string;
  action: string;
  actorUserId?: string | null;
  entityType?: string;
  entityId?: string;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;
export const safeIp = (ip: string | undefined): string | null => (ip && IP_RE.test(ip) ? ip : null);

export async function recordAudit(c: PoolClient, e: AuditEvent): Promise<void> {
  await c.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, ip, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.tenantId, e.actorUserId ?? null, e.action, e.entityType ?? null, e.entityId ?? null, safeIp(e.ip ?? undefined), JSON.stringify(e.detail ?? {})],
  );
}
