// Limite de requisições em memória (a API roda numa instância só). Janela fixa por chave.
export function createLimiter() {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, 60_000);
  sweep.unref();
  return {
    // true se a chamada ainda cabe no limite.
    take(key, max, windowMs) {
      const now = Date.now();
      let h = hits.get(key);
      if (!h || h.reset <= now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
      h.n++;
      return h.n <= max;
    },
    clear: () => hits.clear(),
  };
}
