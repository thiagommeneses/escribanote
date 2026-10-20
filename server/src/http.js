// Erros com código estável (o app e a extensão decidem pelo `error`, e mostram `message` ao usuário).
export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const fail = (status, code, message, extra) => {
  throw new HttpError(status, code, message, extra);
};

export const clientIp = (req) => req.ip || "";
export const iso = (d) => (d ? new Date(d).toISOString() : null);
