const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const smtp = require('../backend/src/lib/smtp');
const { startFakeSmtp, parseMessage } = require('./helpers/fake-smtp');

const CREDENTIALS = { user: 'fluxy@exemplo.test', pass: 'segredo-do-teste' };
const MESSAGE = {
  from: 'Fluxy <fluxy@exemplo.test>',
  to: 'cliente@exemplo.test',
  subject: 'Fluxy: redefinição de senha',
  text: 'Olá, João!\n.linha que começa com ponto\nAção concluída.',
  html: '<p>Olá, <b>João</b>!</p>'
};

const configFor = (server, extra = {}) => ({
  host: '127.0.0.1', port: server.port, secure: false, requireTls: false, timeoutMs: 3000, ...CREDENTIALS, ...extra
});

async function withServer(options, run) {
  const server = await startFakeSmtp(options);
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

function temporaryCertificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxy-tls-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')
    ], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
  } catch (_error) {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const certificate = temporaryCertificate();
const tlsSkip = certificate ? false : 'openssl nao encontrado nesta maquina';

test('entrega a mensagem e so termina depois do "250" final do servidor', async () => {
  await withServer({ credentials: CREDENTIALS }, async server => {
    await smtp.sendMail(configFor(server), MESSAGE);

    assert.equal(server.state.messages.length, 1);
    const [received] = server.state.messages;
    assert.equal(received.from, 'fluxy@exemplo.test');
    assert.deepEqual(received.to, ['cliente@exemplo.test']);

    const parsed = parseMessage(received.raw);
    assert.equal(parsed.subject, MESSAGE.subject, 'assunto com acento chega intacto');
    assert.equal(parsed.text, MESSAGE.text, 'corpo com acento e linha iniciada por ponto chega intacto');
    assert.equal(parsed.html, MESSAGE.html);
    assert.match(parsed.headers['message-id'], /^<[a-f0-9]+@exemplo\.test>$/);
    assert.ok(parsed.headers.date);
    assert.ok(received.raw.split('\r\n').every(line => line.length <= 998), 'nenhuma linha acima do limite do protocolo');
  });
});

test('autentica com AUTH LOGIN quando o servidor nao oferece PLAIN', async () => {
  await withServer({ credentials: CREDENTIALS, authMechanisms: 'LOGIN' }, async server => {
    await smtp.sendMail(configFor(server), MESSAGE);
    assert.equal(server.state.authenticated, 1);
    assert.equal(server.state.messages.length, 1);
  });
});

test('senha errada vira erro (e nada e entregue)', async () => {
  await withServer({ credentials: CREDENTIALS }, async server => {
    await assert.rejects(
      smtp.sendMail(configFor(server, { pass: 'senha-errada' }), MESSAGE),
      error => error.stage === 'auth' && !error.message.includes('senha-errada')
    );
    assert.equal(server.state.messages.length, 0);
  });
});

test('sem criptografia disponivel, a senha nao e enviada (exigencia de TLS e o padrao)', async () => {
  await withServer({ credentials: CREDENTIALS }, async server => {
    await assert.rejects(
      smtp.sendMail(configFor(server, { requireTls: true }), MESSAGE),
      error => error.stage === 'starttls'
    );
    assert.ok(!server.state.commands.some(command => /^AUTH/i.test(command)), 'nenhum AUTH pode ter sido enviado');
    assert.equal(server.state.messages.length, 0);
  });
});

test('destinatario recusado pelo servidor vira erro', async () => {
  await withServer({ credentials: CREDENTIALS, rejectRecipient: true }, async server => {
    await assert.rejects(smtp.sendMail(configFor(server), MESSAGE), error => error.stage === 'rcpt-to');
    assert.equal(server.state.messages.length, 0);
  });
});

test('mensagem recusada no final dos dados vira erro', async () => {
  await withServer({ credentials: CREDENTIALS, rejectData: true }, async server => {
    await assert.rejects(smtp.sendMail(configFor(server), MESSAGE), error => error.stage === 'data-end');
  });
});

test('servidor que nao responde gera erro de tempo esgotado', async () => {
  await withServer({ silent: true }, async server => {
    await assert.rejects(
      smtp.sendMail(configFor(server, { timeoutMs: 300 }), MESSAGE),
      error => error.stage === 'timeout' || error.stage === 'connection'
    );
  });
});

test('servidor fora do ar gera erro de conexao', async () => {
  const server = await startFakeSmtp();
  const { port } = server;
  await server.close();

  await assert.rejects(
    smtp.verifyConnection({ host: '127.0.0.1', port, secure: false, requireTls: false, timeoutMs: 1000 }),
    error => error.stage === 'connection'
  );
});

test('endereco com quebra de linha e recusado antes de qualquer conexao', async () => {
  await withServer({ credentials: CREDENTIALS }, async server => {
    await assert.rejects(
      smtp.sendMail(configFor(server), { ...MESSAGE, to: 'cliente@exemplo.test\r\nBcc: outro@exemplo.test' }),
      error => error.stage === 'address'
    );
    assert.equal(server.state.connections, 0);
  });
});

test('verifyConnection confere login sem enviar mensagem', async () => {
  await withServer({ credentials: CREDENTIALS }, async server => {
    await smtp.verifyConnection(configFor(server));
    assert.equal(server.state.authenticated, 1);
    assert.equal(server.state.messages.length, 0);
  });
});

test('servidor que trava durante o STARTTLS nao deixa o envio pendurado', async () => {
  const net = require('net');
  const stalled = net.createServer(socket => {
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', chunk => {
      const line = chunk.toString();
      if (/^EHLO/i.test(line)) socket.write('250-fake\r\n250 STARTTLS\r\n');
      else if (/^STARTTLS/i.test(line)) socket.write('220 go ahead\r\n');
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      smtp.verifyConnection({ host: '127.0.0.1', port: stalled.address().port, secure: false, requireTls: true, timeoutMs: 400 }),
      error => error.stage === 'timeout'
    );
  } finally {
    stalled.closeAllConnections?.();
    await new Promise(resolve => stalled.close(resolve));
  }
});

test('nome do remetente com virgula vai entre aspas no cabecalho', async () => {
  await withServer({ credentials: CREDENTIALS }, async server => {
    await smtp.sendMail(configFor(server), { ...MESSAGE, from: '"Fluxy, Suporte" <fluxy@exemplo.test>' });
    assert.equal(parseMessage(server.state.messages[0].raw).headers.from, '"Fluxy, Suporte" <fluxy@exemplo.test>');
  });
});

test('a sonda sem envio tambem detecta remetente recusado', async () => {
  await withServer({ credentials: CREDENTIALS, rejectSender: true }, async server => {
    await assert.rejects(smtp.verifyConnection(configFor(server), 'fluxy@exemplo.test'), error => error.stage === 'mail-from');
  });
});

test('STARTTLS (porta 587): a senha so trafega depois da criptografia', { skip: tlsSkip }, async () => {
  await withServer({ credentials: CREDENTIALS, startTls: certificate }, async server => {
    await smtp.sendMail(
      { host: 'localhost', port: server.port, secure: false, requireTls: true, timeoutMs: 3000, ...CREDENTIALS, tlsOptions: { ca: certificate.cert } },
      MESSAGE
    );
    assert.equal(server.state.authOverTls, 1, 'a autenticacao tem de acontecer dentro do TLS');
    assert.equal(server.state.messages.length, 1);
    assert.equal(parseMessage(server.state.messages[0].raw).text, MESSAGE.text);
  });
});

test('TLS direto (porta 465) funciona', { skip: tlsSkip }, async () => {
  await withServer({ credentials: CREDENTIALS, implicitTls: certificate }, async server => {
    await smtp.sendMail(
      { host: 'localhost', port: server.port, secure: true, timeoutMs: 3000, ...CREDENTIALS, tlsOptions: { ca: certificate.cert } },
      MESSAGE
    );
    assert.equal(server.state.authOverTls, 1);
    assert.equal(server.state.messages.length, 1);
  });
});

test('certificado que nao e de confianca interrompe o envio', { skip: tlsSkip }, async () => {
  await withServer({ credentials: CREDENTIALS, startTls: certificate }, async server => {
    await assert.rejects(
      smtp.sendMail({ host: 'localhost', port: server.port, secure: false, requireTls: true, timeoutMs: 3000, ...CREDENTIALS }, MESSAGE),
      error => error.stage === 'tls'
    );
    assert.equal(server.state.authenticated, 0);
    assert.equal(server.state.messages.length, 0);
  });
});
