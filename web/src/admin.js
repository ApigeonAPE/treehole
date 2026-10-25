#!/usr/bin/env node
/**
 * admin.js - admin CLI (operates through the internal API)
 * Usage: docker exec treehole-web node src/admin.js <command> <args>
 */
const http = require('http');
const { getAdminConfig } = require('./config');

const HOST = 'localhost';
const PORT = 9000;

function api(method, path, body) {
  const token = getAdminConfig().token || '';
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST, port: PORT, path,
      method, headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) { console.log('Usage: node admin.js --hide|--del|--ban|--unban|--whois|--history|--mail-stats <args>'); process.exit(0); }

  const token = getAdminConfig().token || '';
  if (!token || token.startsWith('change-me')) {
    console.error('admin.token is not configured (/app/config.json)');
    process.exit(1);
  }

  const cmd = args[0];
  let id, uid, days;

  switch (cmd) {
    case '--hide':
    case '--unhide':
    case '--del':
      id = (args[1] || '').replace(/^#/, '');
      if (!id) { console.error('Missing ID (quote it when it starts with #)'); process.exit(1); }
      {
        const r = await api('POST', `/api/admin/${cmd.replace('--', '')}/${id}`);
        const labels = { '--hide': 'hidden', '--unhide': 'unhidden', '--del': 'deleted' };
        console.log(r.data.ok ? `[admin] ${id} ${labels[cmd]}` : r.data.error);
      }
      break;

    case '--ban':
      uid = args[1]; days = args[2] ? parseInt(args[2]) : 0;
      if (!uid) { console.error('Missing UID'); process.exit(1); }
      {
        const r = await api('POST', '/api/admin/ban', { uid, days: days || null });
        console.log(r.data.ok ? `[admin] user ${uid.slice(0, 8)}... banned` + (days ? ` for ${days} day(s)` : ' permanently') : r.data.error);
      }
      break;

    case '--unban':
      uid = args[1];
      if (!uid) { console.error('Missing UID'); process.exit(1); }
      {
        const r = await api('POST', '/api/admin/unban', { uid });
        console.log(r.data.ok ? `[admin] user ${uid.slice(0, 8)}... unbanned` : r.data.error);
      }
      break;

    case '--whois':
      id = (args[1] || '').replace(/^#/, '');
      if (!id) { console.error('Missing ID'); process.exit(1); }
      {
        const r = await api('POST', `/api/admin/whois/${id}`);
        if (r.data.uid) {
          console.log(`ID: ${id}`);
          console.log(`UID: ${r.data.uid}`);
        } else console.error(r.data.error || 'not found');
      }
      break;

    case '--history':
      uid = args[1];
      if (!uid) { console.error('Missing UID'); process.exit(1); }
      {
        const r = await api('POST', '/api/admin/history', { uid });
        if (r.data.uid) {
          console.log(`=== UID: ${r.data.uid} ===`);
          console.log(`\nPosts (${r.data.entries.length}):`);
          r.data.entries.forEach(e => console.log(`  ${e.id}  ${e.created_at}  ${e.title}`));
          console.log(`\nReplies (${r.data.replies.length}):`);
          r.data.replies.forEach(p => console.log(`  ${p.id}  ${p.created_at}  ${p.content}`));
        } else console.error(r.data.error || 'not found');
      }
      break;

    case '--mail-stats':
      {
        const r = await api('GET', '/api/admin/mail-stats');
        if (r.data.providers) {
          console.log(`Date: ${r.data.date} (${r.data.timezone})  Strategy: ${r.data.strategy}  Quota: ${r.data.quota_enabled ? 'on' : 'off'}${r.data.degraded ? '  [ledger unavailable]' : ''}`);
          Object.entries(r.data.providers).forEach(([name, p]) => {
            console.log(`  ${name.padEnd(8)} used=${p.used}${p.cap ? '/' + p.cap : ''}  reserve=${p.reserve == null ? '-' : p.reserve}  down=${p.down}`);
          });
        } else console.error(r.data.error || 'query failed');
      }
      break;

    default:
      console.error('unknown command:', cmd);
      process.exit(1);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
