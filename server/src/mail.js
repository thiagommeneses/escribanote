// E-mail transacional pelo SMTP da Hostinger (o mesmo do formulário de contato).
import nodemailer from "nodemailer";

export function createMailer(config, log = console) {
  const { host, port, user, pass } = config.smtp;
  if (!host) {
    // Sem SMTP (desenvolvimento): o e-mail vai para o log.
    return { async send(msg) { log.info({ to: msg.to, subject: msg.subject, text: msg.text }, "e-mail (sem SMTP)"); } };
  }
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  const from = config.mailFrom || `Reunilo <${user}>`;
  return {
    async send({ to, subject, text, html }) {
      await transport.sendMail({ from, to, subject, text, html });
    },
  };
}

const wrap = (inner) => `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f6f4ef;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1f1b16">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<p style="font-size:20px;font-weight:700;margin:0 0 24px">Reunilo</p>${inner}
<p style="font-size:12px;color:#7a7268;margin-top:32px">Você recebeu este e-mail porque alguém pediu acesso ao Reunilo com este endereço. Se não foi você, ignore.</p>
</div></body></html>`;

export function loginEmail(link, minutes) {
  return {
    subject: "Seu link de acesso ao Reunilo",
    text: `Para entrar no Reunilo, abra este link (vale por ${minutes} minutos e só funciona uma vez):\n\n${link}\n\nSe você não pediu, ignore este e-mail.`,
    html: wrap(`<p style="font-size:15px;line-height:1.5">Clique no botão para entrar. O link vale por ${minutes} minutos e só funciona uma vez.</p>
<p style="margin:24px 0"><a href="${link}" style="background:#c8442a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:600;display:inline-block">Entrar no Reunilo</a></p>
<p style="font-size:13px;color:#7a7268;word-break:break-all">Ou copie o endereço: ${link}</p>`),
  };
}
