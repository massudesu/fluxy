const { SMTP, MAIL_MODE } = require('../src/config');
const smtp = require('../src/lib/smtp');

async function run() {
  const to = process.argv[2];
  if (!to) {
    console.log('Uso: npm run mail:test -- seu-email@exemplo.com');
    process.exit(1);
  }
  if (!SMTP.host || !SMTP.from) {
    console.log('SMTP nao configurado: preencha SMTP_HOST, SMTP_USER, SMTP_PASS e MAIL_FROM em backend/.env.');
    process.exit(1);
  }
  if (MAIL_MODE === 'console') console.log('Aviso: MAIL_MODE=console esta ativo; o Fluxy em si nao envia e-mails nesse modo.');

  console.log(`Conectando em ${SMTP.host}:${SMTP.port} (${SMTP.secure ? 'TLS direto' : 'STARTTLS'})...`);
  try {
    await smtp.verifyConnection(SMTP);
    console.log('Conexao e login aceitos pelo servidor de e-mail.');

    await smtp.sendMail(SMTP, {
      from: SMTP.from,
      to,
      subject: 'Fluxy: teste de envio',
      text: 'Este e-mail confirma que o envio do Fluxy está configurado corretamente.',
      html: '<p>Este e-mail confirma que o envio do Fluxy está configurado corretamente.</p>'
    });
    console.log(`Mensagem aceita pelo servidor para ${to}. Confira a caixa de entrada e o spam.`);
  } catch (error) {
    console.log(`FALHOU: ${error.message}`);
    console.log('Confira host, porta, usuario e senha. No Gmail e preciso usar uma "senha de app".');
    process.exit(1);
  }
}

run();
