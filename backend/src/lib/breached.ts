/**
 * Breached-password check (FR-AUT-03, US-121) using the Have I Been Pwned range API.
 * k-anonymity: only the first five characters of the SHA-1 hash leave this server, never the password.
 * Fails open: if the service is unreachable the password is accepted (and a warning is logged).
 */
import { createHash } from 'node:crypto';
import { getEnv } from '../config/env.js';
import { logger } from './logger.js';

export type BreachChecker = (password: string) => Promise<boolean>;

const defaultChecker: BreachChecker = async (password) => {
  if (!getEnv().HIBP_ENABLED) return false;
  // The Have I Been Pwned range API is defined over SHA-1 prefixes, so SHA-1 is required here. It is a lookup key
  // only: nothing is stored, nothing authenticates with it, and only five characters of it leave this server.
  // codeql[js/insufficient-password-hash]
  const sha = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha.slice(0, 5);
  const suffix = sha.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'erpatio' },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((line) => {
      const [hash, count] = line.trim().split(':');
      return hash === suffix && Number(count) > 0;
    });
  } catch (err) {
    logger().warn({ err: (err as Error).name }, 'breached-password check unavailable; accepting');
    return false;
  }
};

let checker: BreachChecker = defaultChecker;
export const isBreached = (password: string): Promise<boolean> => checker(password);
export const setBreachChecker = (fn: BreachChecker | undefined): void => {
  checker = fn ?? defaultChecker;
};
