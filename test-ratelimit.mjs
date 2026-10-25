// test-ratelimit.mjs - send repeatedly to trigger the rate limit
import * as net from 'node:net';

const HOST = 'localhost';
const PORT = 2525;
const FROM = 'spammer@gmail.com';
const TO = 'submit@localhost';
const COUNT = 11;

function sendOne(i) {
  return new Promise((resolve) => {
    const client = net.createConnection({ host: HOST, port: PORT }, () => {
      let step = 0;
      let buffer = '';
      let dataSent = false;
      let lastLine = '';

      const commands = ['EHLO test', `MAIL FROM:<${FROM}>`, `RCPT TO:<${TO}>`, 'DATA'];

      function nextCmd() {
        if (step >= commands.length) return;
        client.write(commands[step++] + '\r\n');
      }

      client.on('data', (data) => {
        buffer += data.toString();
        while (buffer.includes('\r\n')) {
          const idx = buffer.indexOf('\r\n');
          const line = buffer.substring(0, idx);
          buffer = buffer.substring(idx + 2);
          if (!line) continue;
          lastLine = line;

          if (line.length >= 4 && line[3] === '-') continue;
          if (line.startsWith('220')) { nextCmd(); continue; }

          if (line.startsWith('354')) {
            client.write(`Subject: test${i}\r\nFrom: ${FROM}\r\nTo: ${TO}\r\n\r\nbody${i}\r\n.\r\n`);
            dataSent = true;
            continue;
          }

          if (dataSent) {
            client.write('QUIT\r\n');
            setTimeout(() => { client.end(); resolve(lastLine); }, 200);
            continue;
          }

          nextCmd();
        }
      });

      client.on('error', () => resolve('ERROR'));
    });
  });
}

console.log(`Sending ${COUNT} emails from ${FROM}...`);
for (let i = 1; i <= COUNT; i++) {
  const line = await sendOne(i);
  console.log(`#${i}: ${line}`);
}
console.log('\nDone. Check: docker logs treehole-haraka --tail 20 | Select-String "mg"');
