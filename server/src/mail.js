// E-mail transacional pelo SMTP da Hostinger (o mesmo do formulário de contato).
import nodemailer from "nodemailer";

export function createMailer(config, log = console) {
  const { host, port, user, pass } = config.smtp;
  if (!host) {
    // Sem SMTP (desenvolvimento): o e-mail vai para o log.
    return { async send(msg) { log.info({ to: msg.to, subject: msg.subject, text: msg.text }, "e-mail (sem SMTP)"); } };
  }
  // `name` é o nome no EHLO. Sem ele o nodemailer usa o hostname do contêiner (um ID aleatório),
  // que os filtros de spam (iCloud principalmente) penalizam.
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass }, name: new URL(config.publicUrl).hostname });
  const from = config.mailFrom || `Escribanote <${user}>`;
  return {
    async send({ to, subject, text, html }) {
      await transport.sendMail({ from, to, subject, text, html, headers: { "Auto-Submitted": "auto-generated" } });
    },
  };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// HTML completo (doctype, head, título, texto de pré-visualização) e com texto suficiente:
// e-mails só com um botão e quase nada escrito parecem phishing para os filtros.
const ACCESS_NOTE = "Você recebeu este e-mail porque alguém pediu acesso ao Escribanote com este endereço. Se não foi você, pode ignorar: nada acontece sem o clique no link.";
const wrap = (title, preheader, inner, note = ACCESS_NOTE) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f6f4ef;font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:#1f1b16">
<div style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ef"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf9;border:1px solid #e7e1d6;border-radius:14px">
<tr><td style="padding:28px 28px 8px"><p style="font-size:20px;font-weight:700;margin:0">Escribanote</p></td></tr>
<tr><td style="padding:8px 28px 28px">${inner}</td></tr>
</table>
<p style="max-width:520px;font-size:12px;line-height:1.5;color:#7a7268;margin:20px auto 0">Escribanote · transcrição de reuniões · escribanote.com<br>${esc(note)}</p>
</td></tr></table></body></html>`;

export function loginEmail(link, minutes) {
  const subject = "Seu link de acesso ao Escribanote";
  return {
    subject,
    text: `Olá!\n\nRecebemos um pedido para entrar na sua conta do Escribanote. Para continuar, abra este link (vale por ${minutes} minutos e só funciona uma vez):\n\n${link}\n\nSe você não pediu, ignore este e-mail: ninguém entra na sua conta sem este link.\n\nEscribanote · escribanote.com`,
    html: wrap(subject, `Entre na sua conta do Escribanote. O link vale por ${minutes} minutos.`, `
<p style="font-size:15px;line-height:1.55;margin:0 0 12px">Olá!</p>
<p style="font-size:15px;line-height:1.55;margin:0 0 12px">Recebemos um pedido para entrar na sua conta do Escribanote. Clique no botão abaixo para continuar. O link vale por ${minutes} minutos e só funciona uma vez.</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#c8442a;color:#fffdf9;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">Entrar no Escribanote</a></p>
<p style="font-size:13px;line-height:1.5;color:#7a7268;margin:0 0 6px">Se o botão não funcionar, copie este endereço no navegador:</p>
<p style="font-size:13px;line-height:1.5;color:#7a7268;word-break:break-all;margin:0">${esc(link)}</p>`),
  };
}

export function passwordEmail(link, minutes, hasPassword) {
  const subject = hasPassword ? "Redefinir a senha do Escribanote" : "Defina a senha do Escribanote";
  const ask = hasPassword ? "Recebemos um pedido para redefinir a senha da sua conta do Escribanote." : "Recebemos um pedido para definir uma senha na sua conta do Escribanote.";
  return {
    subject,
    text: `Olá!\n\n${ask} Para escolher a senha nova, abra este link (vale por ${minutes} minutos e só funciona uma vez):\n\n${link}\n\nSe você não pediu, ignore este e-mail: sua senha continua a mesma.\n\nEscribanote · escribanote.com`,
    html: wrap(subject, `Escolha uma senha para o Escribanote. O link vale por ${minutes} minutos.`, `
<p style="font-size:15px;line-height:1.55;margin:0 0 12px">Olá!</p>
<p style="font-size:15px;line-height:1.55;margin:0 0 12px">${ask} Clique no botão abaixo para escolher a senha nova. O link vale por ${minutes} minutos e só funciona uma vez.</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#c8442a;color:#fffdf9;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">Escolher a senha</a></p>
<p style="font-size:13px;line-height:1.5;color:#7a7268;margin:0 0 6px">Se o botão não funcionar, copie este endereço no navegador:</p>
<p style="font-size:13px;line-height:1.5;color:#7a7268;word-break:break-all;margin:0">${esc(link)}</p>
<p style="font-size:13px;line-height:1.5;color:#7a7268;margin:16px 0 0">Se você não pediu, ignore este e-mail: sua senha continua a mesma.</p>`),
  };
}

export function trialEndingEmail(link, hoursLeft) {
  const when = hoursLeft <= 1 ? "em cerca de 1 hora" : `em cerca de ${hoursLeft} horas`;
  const subject = `Seu teste do Escribanote Pro termina ${when}`;
  return {
    subject,
    text: `Olá!\n\nSeu teste grátis do Escribanote Pro termina ${when}. Depois disso a conta volta para o plano grátis: a extensão continua transcrevendo no seu computador, mas a sincronização, a área web, a IA sem chave e a transcrição no servidor param. Nada do que já está na conta é apagado.\n\nPara continuar com o Pro (R$ 150 por ano ou R$ 15 por mês, Pix ou cartão, com garantia de 7 dias):\n\n${link}\n\nSe preferir ficar no grátis, não precisa fazer nada: não há cobrança.\n\nEscribanote · escribanote.com`,
    html: wrap(subject, `O Pro volta para o grátis ${when}. Nada é apagado e não há cobrança automática.`, `
<p style="font-size:15px;line-height:1.55;margin:0 0 12px">Olá!</p>
<p style="font-size:15px;line-height:1.55;margin:0 0 12px">Seu teste grátis do <b>Escribanote Pro</b> termina ${esc(when)}. Depois disso a conta volta para o plano grátis: a extensão continua transcrevendo no seu computador, mas a sincronização, a área web, a IA sem chave e a transcrição no servidor param. Nada do que já está na conta é apagado.</p>
<p style="font-size:15px;line-height:1.55;margin:0 0 12px">Para continuar com o Pro: R$ 150 por ano ou R$ 15 por mês, no Pix ou no cartão, com garantia de 7 dias.</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#c8442a;color:#fffdf9;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;display:inline-block">Assinar o Pro</a></p>
<p style="font-size:13px;line-height:1.5;color:#7a7268;margin:0">Se preferir ficar no grátis, não precisa fazer nada: o teste não tem cartão e não há cobrança.</p>`, "Você recebeu este e-mail porque começou o teste grátis do Escribanote Pro com este endereço. É o único aviso sobre o teste."),
  };
}
