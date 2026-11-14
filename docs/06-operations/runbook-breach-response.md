# Runbook: personal-data breach response (FR-PRV-10, US-118)

Applies to any confirmed or suspected loss, theft, unauthorised access, alteration or disclosure of personal data held in ERPatio. The clock that matters: **the National Privacy Commission (Philippines) expects notification within 72 hours of knowledge of a breach that poses a real risk of serious harm**; affected people are told in the same window. Customers (the controllers of their workspaces) are told first.

## Roles
| Role | Does | Named person |
|---|---|---|
| Incident lead | Runs the incident, decides, keeps the timeline | _to be named by the operator_ |
| Engineer on call | Contains and investigates | _to be named_ |
| Data protection officer / contact | Decides on notification, talks to the regulator and customers | _to be named (open question G-21)_ |

## Timeline
| Within | Step |
|---|---|
| 0 to 1 h | **Detect and open the incident.** Write the start time. Start a private timeline document. |
| 1 to 4 h | **Contain.** See "Containment" below. Preserve evidence: do not delete logs, rows or deployments. |
| 4 to 24 h | **Assess.** What data, whose, how many, since when, is it still happening, was it readable (encrypted fields are not). |
| by 48 h | **Decide.** The data protection contact decides whether notification is required and prepares it. |
| by 72 h | **Notify** the regulator, the affected customers, and where required the affected people. |
| after | **Remediate, review, update** this runbook and the threat model. |

## Containment (what the system gives you)
| Situation | Action |
|---|---|
| A person's account is suspected stolen | Reset the password by e-mail link, which also ends every session of that person. Or the person uses Account security, Sign out everywhere. |
| Refresh tokens may have leaked | `UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL;` (owner connection). Everyone signs in again. |
| The access-token signing key may have leaked | Set a new `JWT_SECRET`, **do not** set `JWT_SECRET_PREVIOUS`, redeploy. Every access token stops working at once. |
| The master encryption key may have leaked | Generate a new `MASTER_KEY`, set the old one as `MASTER_KEY_PREVIOUS`, redeploy, run `npm run keys:rewrap`, then remove the old key. Treat any encrypted data a backup holds as exposed if the key and backup both leaked. |
| The database credentials may have leaked | Rotate the Neon role password in the Neon console, update `DATABASE_URL` and `DATABASE_URL_DIRECT` in Render and `NEON_DIRECT_URL` in GitHub. |
| A tenant is being abused | Set `tenants.status = 'suspended'` (sign-in refuses a suspended workspace). |
| Need to know who did what | The audit log: `SELECT occurred_at, actor_user_id, action, ip FROM audit_log WHERE tenant_id = $1 AND occurred_at BETWEEN $2 AND $3 ORDER BY id;` Permission denials are recorded as `security.permission_denied`; bursts also log a `security_alert` line. |
| Need the point-in-time state | Neon point-in-time restore into a **new branch** (never over production). See the restore runbook. |

## Assessment checklist
- [ ] First and last time of unauthorised access
- [ ] Which tenants, which people, which fields (use `docs/03-architecture/data-classification-register.md`)
- [ ] Were any Sensitive-Personal fields involved, and were they encrypted at that point
- [ ] Is the cause closed
- [ ] Is a customer's own staff the source

## Notification content
What happened, when, what data, how many people, what we have done, what the person should do (change passwords, watch for phishing), and who to contact. No speculation, no blame, plain language.

## Tabletop exercise
Walk this runbook with a scenario, record the result, and fix what was unclear. Required before the M0 gate closes.

| Date | Scenario | Who took part | Gaps found | Fixed |
|---|---|---|---|---|
| _not yet held_ | e.g. an administrator's refresh token is found on a paste site | | | |
