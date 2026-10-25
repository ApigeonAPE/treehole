// test-smtp.mjs - submission test with a configurable sender
// Usage: node test-smtp.mjs [from] [to] [subject] [body]
import * as net from 'node:net';

const HOST = 'localhost';
const PORT = 2525;
const FROM = process.argv[2] || 'test@localhost';
const TO = process.argv[3] || 'submit@localhost';
const SUBJECT = process.argv[4] || 'Hello treehole, first post';
const BODY = process.argv[5] || 'This is the body of a test submission.';

const client = net.createConnection({ host: HOST, port: PORT }, () => {
  console.log('[connected]\n');
});

let step = 0;
let dataSent = false;
let buffer = '';

const commands = [
  'EHLO test',
  `MAIL FROM:<${FROM}>`,
  `RCPT TO:<${TO}>`,
  'DATA',
];

function sendNext() {
  if (step >= commands.length) return;
  const cmd = commands[step++];
  console.log(`[C] ${cmd}`);
  client.write(cmd + '\r\n');
}

client.on('data', (data) => {
  buffer += data.toString();

  while (buffer.includes('\r\n')) {
    const idx = buffer.indexOf('\r\n');
    const line = buffer.substring(0, idx);
    buffer = buffer.substring(idx + 2);
    if (!line) continue;

    console.log(`[S] ${line}`);

    if (line.length >= 4 && line[3] === '-') continue;

    if (line.startsWith('354')) {
      const body = [
        `Subject: ${SUBJECT}`,
        `From: ${FROM}`,
        `To: ${TO}`,
        '',
        BODY,
        '.',
      ];
      for (const b of body) {
        console.log(`[C] ${b === '.' ? '.' : (b || '(blank line)')}`);
        client.write(b + '\r\n');
      }
      dataSent = true;
      continue;
    }

    if (dataSent) {
      dataSent = false;
      console.log(`[C] QUIT`);
      client.write('QUIT\r\n');
      setTimeout(() => client.end(), 500);
      continue;
    }

    sendNext();
  }
});

client.on('end', () => console.log('\n=== done ==='));
client.on('error', (err) => console.error('error:', err.message));
