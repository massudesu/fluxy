const net = require('net');
const tls = require('tls');

function startFakeSmtp(options = {}) {
  const {
    credentials = null,
    authMechanisms = 'PLAIN LOGIN',
    startTls = null,
    implicitTls = null,
    rejectSender = false,
    rejectRecipient = false,
    rejectData = false,
    silent = false
  } = options;

  const state = { messages: [], commands: [], connections: 0, authenticated: 0, authOverTls: 0 };

  function handleConnection(rawSocket) {
    state.connections += 1;
    if (silent) return;

    let socket = rawSocket;
    let encrypted = Boolean(implicitTls);
    let buffer = '';
    let mode = 'command';
    let loginStep = null;
    let loginUser = '';
    let authenticated = false;
    let envelope = { from: '', to: [] };

    const reply = line => socket.write(`${line}\r\n`);

    function ehloReply() {
      const lines = ['fake-smtp'];
      if (startTls && !encrypted) lines.push('STARTTLS');
      if (credentials) lines.push(`AUTH ${authMechanisms}`);
      lines.push('SIZE 1048576');
      lines.forEach((line, index) => reply(`250${index === lines.length - 1 ? ' ' : '-'}${line}`));
    }

    function checkAuth(user, pass) {
      if (credentials && user === credentials.user && pass === credentials.pass) {
        authenticated = true;
        state.authenticated += 1;
        if (encrypted) state.authOverTls += 1;
        return reply('235 2.7.0 Authentication successful');
      }
      return reply('535 5.7.8 Authentication credentials invalid');
    }

    function handleCommand(line) {
      state.commands.push(line.replace(/^(AUTH PLAIN) .*/i, '$1 ***'));
      const upper = line.toUpperCase();

      if (loginStep === 'user') {
        loginUser = Buffer.from(line, 'base64').toString();
        loginStep = 'pass';
        return reply('334 UGFzc3dvcmQ6');
      }
      if (loginStep === 'pass') {
        loginStep = null;
        return checkAuth(loginUser, Buffer.from(line, 'base64').toString());
      }

      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) return ehloReply();
      if (upper === 'STARTTLS' && startTls && !encrypted) {
        reply('220 2.0.0 Ready to start TLS');
        socket.removeAllListeners('data');
        socket = new tls.TLSSocket(rawSocket, { isServer: true, secureContext: tls.createSecureContext(startTls) });
        encrypted = true;
        buffer = '';
        attach();
        return undefined;
      }
      if (upper.startsWith('AUTH PLAIN')) {
        const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\u0000');
        return checkAuth(user, pass);
      }
      if (upper === 'AUTH LOGIN') {
        loginStep = 'user';
        return reply('334 VXNlcm5hbWU6');
      }
      if (upper.startsWith('MAIL FROM:')) {
        if (credentials && !authenticated) return reply('530 5.7.0 Authentication required');
        if (rejectSender) return reply('550 5.7.1 Sender not allowed');
        envelope = { from: line.slice(10).replace(/[<>]/g, ''), to: [] };
        return reply('250 2.1.0 OK');
      }
      if (upper.startsWith('RCPT TO:')) {
        if (rejectRecipient) return reply('550 5.1.1 Mailbox unavailable');
        envelope.to.push(line.slice(8).replace(/[<>]/g, ''));
        return reply('250 2.1.5 OK');
      }
      if (upper === 'DATA') {
        mode = 'data';
        return reply('354 End data with <CR><LF>.<CR><LF>');
      }
      if (upper === 'RSET') return reply('250 2.0.0 OK');
      if (upper === 'QUIT') {
        reply('221 2.0.0 Bye');
        return socket.end();
      }
      return reply('502 5.5.2 Command not recognized');
    }

    function onData(chunk) {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (mode === 'data') {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          const raw = buffer.slice(0, end).replace(/^\.\./gm, '.');
          buffer = buffer.slice(end + 5);
          mode = 'command';
          if (rejectData) {
            reply('554 5.6.0 Message rejected');
          } else {
            state.messages.push({ ...envelope, raw });
            reply('250 2.0.0 OK: queued');
          }
          continue;
        }
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        handleCommand(line);
      }
    }

    function attach() {
      socket.on('data', onData);
      socket.on('error', () => {});
    }

    attach();
    reply('220 fake-smtp ESMTP ready');
  }

  const server = implicitTls ? tls.createServer(implicitTls, handleConnection) : net.createServer(handleConnection);
  server.on('error', () => {});

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        clear() {
          state.messages.length = 0;
          state.commands.length = 0;
          state.connections = 0;
        },
        close: () => new Promise(done => server.close(() => done()))
      });
    });
  });
}

function parseMessage(raw) {
  const [headerBlock] = raw.split('\r\n\r\n');
  const headers = {};
  headerBlock.replace(/\r\n[ \t]+/g, ' ').split('\r\n').forEach(line => {
    const separator = line.indexOf(':');
    headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  });

  const decodeWords = value => value.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/gi, (_all, encoded) => Buffer.from(encoded, 'base64').toString('utf8'));
  const part = type => {
    const match = raw.match(new RegExp(`Content-Type: ${type}; charset=utf-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`));
    return match ? Buffer.from(match[1].replace(/\s+/g, ''), 'base64').toString('utf8') : '';
  };

  return { headers, subject: decodeWords(headers.subject || ''), text: part('text/plain'), html: part('text/html') };
}

module.exports = { startFakeSmtp, parseMessage };
