// Cliente da API do Escribanote (mesmo endereço do app: o cookie da sessão vai sozinho).

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Erro ${status}`);
    this.status = status;
    this.code = body?.error || "error";
    this.body = body || {};
  }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: "same-origin",
      headers: { "x-escribanote": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: "offline", message: "Sem conexão com o Escribanote. Confira a internet e tente de novo." });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get: (p) => call("GET", p),
  post: (p, b = {}) => call("POST", p, b),
  put: (p, b) => call("PUT", p, b),
  del: (p, b) => call("DELETE", p, b),
};

// IA em streaming (SSE via fetch): onDelta(textoAcumulado), devolve o evento "done".
export async function stream(path, body, { onStart, onDelta, signal } = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-escribanote": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
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
      if (event === "start") onStart?.(data);
      else if (event === "delta") onDelta?.((text += data.text));
      else if (event === "done") return data;
      else if (event === "error") throw new ApiError(502, { error: "ai_failed", message: data.message, balance: data.balance });
    }
  }
  throw new ApiError(502, { error: "ai_failed", message: "A resposta foi interrompida." });
}
