/** Account client: email-code sign-in over the same-origin /api/account/ endpoints (cookie session). */

export type AccountUser = { id: string; email: string; displayName: string; plan: string };
export type Usage = Record<"analysis" | "omr", { used: number; limit: number }>;
export type Me = { user: AccountUser | null; usage: Usage | null };

export class AccountError extends Error {
  constructor(message: string, readonly code: string, readonly retryAfter?: number) { super(message); }
}

export function accountBase(base: string): string {
  return `${base}/api/account`;
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const response = await fetch(accountBase(base) + path, {
    method, credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await response.json(); } catch { /* non-JSON error page */ }
  return { status: response.status, data };
}

function fail(status: number, data: any): never {
  throw new AccountError(data?.error || `HTTP ${status}`, data?.code || "http", data?.retryAfter);
}

/** Signed-in user and today's usage; null user when signed out or the service is unreachable. */
export async function me(base: string): Promise<Me> {
  try {
    const { status, data } = await call(base, "GET", "/me");
    if (status === 200) return { user: data.user, usage: data.usage };
    return { user: null, usage: data?.guestUsage ?? null };
  } catch { return { user: null, usage: null }; }
}

export async function sendCode(base: string, email: string, lang: "zh" | "en"): Promise<number> {
  const { status, data } = await call(base, "POST", "/code", { email, lang });
  if (status !== 200) fail(status, data);
  return data.retryAfter ?? 60;
}

export async function verify(base: string, email: string, code: string): Promise<Me> {
  const { status, data } = await call(base, "POST", "/verify", { email, code });
  if (status !== 200) fail(status, data);
  return { user: data.user, usage: data.usage };
}

export async function logout(base: string): Promise<void> {
  await call(base, "POST", "/logout", {});
}

export async function deleteAccount(base: string): Promise<void> {
  const { status, data } = await call(base, "DELETE", "/me");
  if (status !== 200) fail(status, data);
}

export async function exportData(base: string): Promise<Blob> {
  const { status, data } = await call(base, "GET", "/export");
  if (status !== 200) fail(status, data);
  return new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
}
