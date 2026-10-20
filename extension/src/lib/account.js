// Conta Reunilo Pro: token do dispositivo (entregue pelo app web) e chamadas à API.
// O endereço pode ser trocado em chrome.storage.local "accountApi" (só para testes).
export const ACCOUNT_URL = "https://reunilo.meneseslabs.com.br";

export async function accountBase() {
  const { accountApi } = await chrome.storage.local.get("accountApi");
  return (accountApi || ACCOUNT_URL).replace(/\/$/, "");
}

// { token, email, deviceId, plan, balance, renewsAt, connectedAt, invalid }
export async function getAccount() {
  const { account } = await chrome.storage.local.get("account");
  return account && account.token ? account : null;
}

export async function setAccount(patch) {
  const cur = (await chrome.storage.local.get("account")).account || {};
  const next = patch === null ? null : { ...cur, ...patch };
  if (next) await chrome.storage.local.set({ account: next });
  else await chrome.storage.local.remove("account");
  return next;
}

export class AccountError extends Error {
  constructor(status, body) {
    super(body?.message || `Erro ${status} na conta Reunilo`);
    this.status = status;
    this.code = body?.error || "error";
    this.body = body || {};
  }
}

export async function accountFetch(path, { method = "GET", body, signal } = {}) {
  const acct = await getAccount();
  if (!acct) throw new AccountError(401, { error: "unauthenticated", message: "Conecte a sua conta Reunilo em Ajustes." });
  let res;
  try {
    res = await fetch(`${await accountBase()}/api/v1${path}`, {
      method,
      signal,
      headers: { authorization: `Bearer ${acct.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new AccountError(0, { error: "offline", message: "Sem conexão com a conta Reunilo." });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new AccountError(res.status, data);
  return data;
}

// IA da conta em streaming (SSE). onDelta recebe o texto acumulado; devolve o evento "done".
export async function accountStream(path, body, { onDelta, signal } = {}) {
  const acct = await getAccount();
  if (!acct) throw new AccountError(401, { error: "unauthenticated", message: "Conecte a sua conta Reunilo em Ajustes." });
  const res = await fetch(`${await accountBase()}/api/v1${path}`, {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${acct.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new AccountError(res.status, await res.json().catch(() => null));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = JSON.parse(/^data: (.+)$/m.exec(chunk)?.[1] || "null");
      if (event === "delta") onDelta?.((text += data.text));
      else if (event === "done") return data;
      else if (event === "error") throw new AccountError(502, { error: "ai_failed", message: data.message, balance: data.balance });
    }
  }
  throw new AccountError(502, { error: "ai_failed", message: "A resposta da IA foi interrompida." });
}
