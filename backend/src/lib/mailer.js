const { SMTP, MAIL_MODE, IS_PRODUCTION, APP_URL_IS_EXPLICIT } = require('../config');
const smtp = require('./smtp');
const { log } = require('./logger');

function mailStatus() {
  if (MAIL_MODE === 'console' && !IS_PRODUCTION) return { mode: 'console' };
  if (!SMTP.host || !SMTP.from) return { mode: 'disabled', reason: 'SMTP_HOST e MAIL_FROM nao foram definidos' };
  if (IS_PRODUCTION && !APP_URL_IS_EXPLICIT) return { mode: 'disabled', reason: 'APP_URL nao foi definido' };
  return { mode: 'smtp' };
}

function escapeHtml(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(value ?? '').replace(/[&<>"']/g, char => entities[char]);
}

function passwordResetMessage({ name, link, minutes }) {
  const firstName = String(name || '').trim().split(/\s+/)[0];
  const greeting = /^[\p{L}'-]{1,40}$/u.test(firstName) ? `Olá, ${firstName}!` : 'Olá!';

  const text = [
    greeting,
    '',
    'Recebemos um pedido para redefinir a senha da sua conta no Fluxy.',
    'Para criar uma nova senha, abra o link abaixo:',
    '',
    link,
    '',
    `O link vale por ${minutes} minutos e só pode ser usado uma vez.`,
    'Se você não fez esse pedido, ignore este e-mail: sua senha continua a mesma.',
    '',
    'Equipe Fluxy'
  ].join('\n');

  const html = `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:24px;background:#f4f5fb;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
      <h1 style="margin:0 0 16px;font-size:20px;color:#5b50e0">Fluxy</h1>
      <p style="margin:0 0 12px;font-size:15px">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 20px;font-size:15px;line-height:1.5">
        Recebemos um pedido para redefinir a senha da sua conta. Para criar uma nova senha, use o botão abaixo.
      </p>
      <p style="margin:0 0 20px">
        <a href="${escapeHtml(link)}" style="display:inline-block;background:#6b60e9;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;font-size:15px">Criar nova senha</a>
      </p>
      <p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:#5d6676">
        O link vale por ${minutes} minutos e só pode ser usado uma vez. Se o botão não abrir, copie e cole este endereço no navegador:
      </p>
      <p style="margin:0 0 20px;font-size:12px;word-break:break-all;color:#5d6676">${escapeHtml(link)}</p>
      <p style="margin:0;font-size:13px;line-height:1.5;color:#5d6676">
        Se você não fez esse pedido, ignore este e-mail: sua senha continua a mesma.
      </p>
    </div>
  </body>
</html>`;

  return { subject: 'Fluxy: redefinição de senha', text, html };
}

async function sendPasswordResetEmail({ to, name, link, minutes }) {
  const message = passwordResetMessage({ name, link, minutes });

  if (mailStatus().mode === 'console') {
    console.log(`\n[Fluxy] MAIL_MODE=console - e-mail NAO enviado, exibido apenas aqui\nPara: ${to}\nAssunto: ${message.subject}\n\n${message.text}\n`);
    return;
  }

  await smtp.sendMail(SMTP, { from: SMTP.from, to, ...message });
}

async function checkMailServer() {
  if (mailStatus().mode === 'console') return;
  await smtp.verifyConnection(SMTP, SMTP.from);
}

function logMailStatus() {
  const status = mailStatus();
  if (status.mode === 'smtp') log(`e-mail .....: SMTP ${SMTP.host}:${SMTP.port}`);
  else if (status.mode === 'console') log('e-mail .....: MODO CONSOLE (nada e enviado; o link aparece neste terminal)');
  else log(`e-mail .....: NAO CONFIGURADO (${status.reason}) - "Esqueci minha senha" fica indisponivel`);
}

module.exports = { mailStatus, sendPasswordResetEmail, checkMailServer, logMailStatus };
