const net = require('net');
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 15000;

class SmtpError extends Error {
  constructor(message, stage) {
    super(message);
    this.name = 'SmtpError';
    this.stage = stage;
  }
}

function createReplyReader(socket) {
  let buffer = '';
  let lines = [];
  const replies = [];
  const waiting = [];
  let failure = null;

  function deliver() {
    while (waiting.length && (replies.length || failure)) {
      const { resolve, reject } = waiting.shift();
      if (replies.length) resolve(replies.shift());
      else reject(failure);
    }
  }

  function onData(chunk) {
    buffer += chunk.toString('utf8');
    let lineEnd;
    while ((lineEnd = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
      buffer = buffer.slice(lineEnd + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        replies.push({ code: Number(line.slice(0, 3)), lines });
        lines = [];
      }
    }
    deliver();
  }

  function fail(error) {
    failure = failure || error;
    deliver();
  }

  const onError = error => fail(new SmtpError(`falha de conexao (${error.code || error.message})`, 'connection'));
  const onClose = () => fail(new SmtpError('o servidor encerrou a conexao', 'connection'));
  const onTimeout = () => {
    fail(new SmtpError('o servidor demorou demais para responder', 'timeout'));
    socket.destroy();
  };

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  socket.on('timeout', onTimeout);

  return {
    next: () => new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      deliver();
    }),
    detach() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('timeout', onTimeout);
    }
  };
}

function connect({ host, port, secure, timeoutMs, tlsOptions }) {
  return new Promise((resolve, reject) => {
    const onError = error => reject(new SmtpError(`nao foi possivel conectar (${error.code || error.message})`, 'connection'));
    const options = { host, port, servername: net.isIP(host) ? undefined : host, ...(secure ? tlsOptions : {}) };
    const socket = secure ? tls.connect(options) : net.connect(options);

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new SmtpError('tempo esgotado ao conectar', 'timeout'));
    });
    socket.once('error', onError);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      socket.off('error', onError);
      socket.removeAllListeners('timeout');
      resolve(socket);
    });
  });
}

function upgradeToTls(socket, host, tlsOptions, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secureSocket = tls.connect({
      socket,
      servername: net.isIP(host) ? undefined : host,
      ...tlsOptions
    });
    secureSocket.setTimeout(timeoutMs, () => {
      secureSocket.destroy();
      reject(new SmtpError('tempo esgotado ao negociar TLS', 'timeout'));
    });
    secureSocket.once('error', error => reject(new SmtpError(`falha ao negociar TLS (${error.code || error.message})`, 'tls')));
    secureSocket.once('secureConnect', () => {
      secureSocket.removeAllListeners('timeout');
      resolve(secureSocket);
    });
  });
}

async function openSession(config) {
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  const tlsOptions = config.tlsOptions || {};
  const clientName = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';

  let socket = await connect({ ...config, timeoutMs, tlsOptions });
  socket.setTimeout(timeoutMs);
  let reader = createReplyReader(socket);
  let encrypted = Boolean(config.secure);

  async function command(line, expectedCodes, stage) {
    if (line !== null) socket.write(`${line}\r\n`);
    const reply = await reader.next();
    if (!expectedCodes.includes(reply.code)) {
      throw new SmtpError(`o servidor respondeu ${reply.code} na etapa "${stage}"`, stage);
    }
    return reply;
  }

  async function hello() {
    const reply = await command(`EHLO ${clientName}`, [250], 'ehlo');
    return reply.lines.slice(1).map(line => line.slice(4).toUpperCase());
  }

  try {
    await command(null, [220], 'greeting');
    let capabilities = await hello();

    if (!encrypted) {
      if (capabilities.includes('STARTTLS')) {
        await command('STARTTLS', [220], 'starttls');
        reader.detach();
        socket = await upgradeToTls(socket, config.host, tlsOptions, timeoutMs);
        socket.setTimeout(timeoutMs);
        reader = createReplyReader(socket);
        encrypted = true;
        capabilities = await hello();
      } else if (config.requireTls !== false) {
        throw new SmtpError('o servidor nao oferece conexao criptografada (STARTTLS)', 'starttls');
      }
    }

    if (config.user) {
      const authLine = capabilities.find(capability => capability.startsWith('AUTH')) || '';
      const mechanisms = authLine.split(/[ =]+/).slice(1);
      const plain = Buffer.from(`\u0000${config.user}\u0000${config.pass}`).toString('base64');

      if (mechanisms.includes('PLAIN')) {
        await command(`AUTH PLAIN ${plain}`, [235], 'auth');
      } else if (mechanisms.includes('LOGIN')) {
        await command('AUTH LOGIN', [334], 'auth');
        await command(Buffer.from(config.user).toString('base64'), [334], 'auth');
        await command(Buffer.from(config.pass).toString('base64'), [235], 'auth');
      } else {
        throw new SmtpError('o servidor nao aceita login com usuario e senha (AUTH PLAIN/LOGIN)', 'auth');
      }
    }

    return {
      command,
      write: data => socket.write(data),
      async close() {
        await command('QUIT', [221], 'quit').catch(() => {});
        socket.destroy();
      },
      abort: () => socket.destroy()
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function encodeHeaderText(text) {
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  const words = [];
  let chunk = '';
  for (const char of text) {
    if (Buffer.byteLength(chunk + char) > 42) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map(word => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
}

function base64Lines(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
}

function parseAddress(value) {
  const match = String(value || '').match(/^\s*(.*?)\s*<([^<>\s]+)>\s*$/);
  const address = (match ? match[2] : String(value || '')).trim();
  const name = match ? match[1].replace(/^"|"$/g, '') : '';
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(address)) throw new SmtpError('endereco de e-mail invalido', 'address');
  return { name, address };
}

function formatAddress({ name, address }) {
  const cleanName = name.replace(/[\r\n"\\]/g, '');
  if (!cleanName) return address;
  const isPlainAscii = /^[\x20-\x7E]*$/.test(cleanName);
  return `${isPlainAscii ? `"${cleanName}"` : encodeHeaderText(cleanName)} <${address}>`;
}

function buildMessage({ from, to, subject, text, html }) {
  const boundary = `fluxy-${crypto.randomBytes(12).toString('hex')}`;
  const domain = from.address.split('@')[1];
  const headers = [
    `From: ${formatAddress(from)}`,
    `To: ${to.address}`,
    `Subject: ${encodeHeaderText(String(subject).replace(/[\r\n]+/g, ' '))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];
  const part = (type, content) =>
    `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(content)}`;

  return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', text)}${part('text/html', html)}--${boundary}--\r\n`;
}

// So resolve depois do "250" final: o servidor aceitou a mensagem.
async function sendMail(config, message) {
  const from = parseAddress(message.from);
  const to = parseAddress(message.to);
  const session = await openSession(config);

  try {
    await session.command(`MAIL FROM:<${from.address}>`, [250], 'mail-from');
    await session.command(`RCPT TO:<${to.address}>`, [250, 251], 'rcpt-to');
    await session.command('DATA', [354], 'data');
    session.write(buildMessage({ ...message, from, to }).replace(/^\./gm, '..'));
    await session.command('.', [250], 'data-end');
  } catch (error) {
    session.abort();
    throw error;
  }

  await session.close();
}

async function verifyConnection(config, fromAddress) {
  const session = await openSession(config);
  try {
    if (fromAddress) {
      await session.command(`MAIL FROM:<${parseAddress(fromAddress).address}>`, [250], 'mail-from');
      await session.command('RSET', [250], 'rset');
    }
  } catch (error) {
    session.abort();
    throw error;
  }
  await session.close();
}

module.exports = { sendMail, verifyConnection, SmtpError };
