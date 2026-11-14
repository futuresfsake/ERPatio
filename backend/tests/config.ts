/** Test database: an owner role that resembles Neon's (CREATEROLE + BYPASSRLS, not superuser). */
export const TEST_DB =
  process.env.TEST_DATABASE_URL ?? 'postgresql://neon_like_owner:testpw@localhost:5544/erpatio_test';

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DB,
  DATABASE_URL_DIRECT: TEST_DB,
  JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
  COOKIE_SECURE: 'false',
  AUTH_RATE_PER_MINUTE: '1000',
  LOCKOUT_THRESHOLD: '5',
  DEMO_MAX_ENTRIES: '100',
  WEBHOOK_ALLOW_INSECURE: 'true',
  WEBHOOK_ALLOW_PRIVATE: 'true',
  DOCS_ENABLED: 'true',
  SIGNUP_ENABLED: 'true',
  HIBP_ENABLED: 'false',
};
