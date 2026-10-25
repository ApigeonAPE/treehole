/**
 * db/index.js - SQLite schema and queries
 *
 * Tables:
 *   users, user_emails, entries, posts, entry_nicknames
 */

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'treehole.db');

let db = null;

// ============================================================
// base-34 helpers
// ============================================================

const BASE34 = '0123456789abcdefghjklmnpqrstuvwxyz';

function generateEntryId() {
  // 4-character base-34 random ID
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += BASE34[Math.floor(Math.random() * 34)];
  }
  return id;
}

function generateUserId() {
  return crypto.randomUUID();
}

function floorIdToIndex(floorId) {
  let result = 0;
  for (const ch of floorId) {
    result = result * 34 + BASE34.indexOf(ch);
  }
  return result;
}

function indexToFloorId(index) {
  if (index === 0) return '00';
  let n = index;
  let result = '';
  while (n > 0) {
    result = BASE34[n % 34] + result;
    n = Math.floor(n / 34);
  }
  return result.padStart(2, '0');
}

// ============================================================
// init
// ============================================================

function initDatabase() {
  if (db) return db;

  // ensure the data directory exists
  const fs = require('fs');
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);

  // WAL improves concurrency
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        banned_until TEXT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_emails (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id        TEXT NOT NULL REFERENCES users(id),
        email          TEXT NOT NULL UNIQUE,
        verified       INTEGER DEFAULT 1,
        verified_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_primary     INTEGER DEFAULT 0,
        notify_enabled INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ue_user  ON user_emails(user_id);
    CREATE INDEX IF NOT EXISTS idx_ue_email ON user_emails(email);

    CREATE TABLE IF NOT EXISTS entries (
        id           TEXT PRIMARY KEY,
        op_uid       TEXT NOT NULL REFERENCES users(id),
        title        TEXT NOT NULL,
        content      TEXT NOT NULL,
        is_hidden    INTEGER DEFAULT 0,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_entries_op ON entries(op_uid);

    CREATE TABLE IF NOT EXISTS posts (
        id              TEXT PRIMARY KEY,
        entry_id        TEXT NOT NULL REFERENCES entries(id),
        floor_id        TEXT NOT NULL,
        uid             TEXT NOT NULL REFERENCES users(id),
        nickname        TEXT NOT NULL,
        content         TEXT NOT NULL,
        reply_to_floor  TEXT,
        is_hidden       INTEGER DEFAULT 0,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(entry_id, floor_id)
    );
    CREATE INDEX IF NOT EXISTS idx_posts_entry ON posts(entry_id, floor_id);
    CREATE INDEX IF NOT EXISTS idx_posts_uid   ON posts(uid);

    CREATE TABLE IF NOT EXISTS entry_nicknames (
        entry_id     TEXT NOT NULL REFERENCES entries(id),
        uid          TEXT NOT NULL,
        nickname     TEXT NOT NULL,
        PRIMARY KEY (entry_id, uid)
    );

    CREATE TABLE IF NOT EXISTS favorites (
        user_id      TEXT NOT NULL REFERENCES users(id),
        entry_id     TEXT NOT NULL REFERENCES entries(id),
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, entry_id)
    );

    -- FTS5 full-text search
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id, title, content, tokenize='unicode61');
  `);

  // rebuild the FTS index and triggers (plain FTS5 tables use DELETE, not delete-all)
  try { db.exec('DROP TRIGGER IF EXISTS entries_fts_insert'); } catch (e) {}
  try { db.exec('DROP TRIGGER IF EXISTS entries_fts_delete'); } catch (e) {}
  try { db.exec('DROP TRIGGER IF EXISTS entries_fts_update'); } catch (e) {}

  try {
    db.exec('DELETE FROM entries_fts');
    db.exec('INSERT INTO entries_fts(id, title, content) SELECT id, title, content FROM entries');
  } catch (e) {
    console.error('[db] FTS rebuild failed:', e.message);
  }

  try {
    db.exec(`
      CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(id, title, content) VALUES (new.id, new.title, new.content);
      END;
      CREATE TRIGGER entries_fts_delete AFTER DELETE ON entries BEGIN
        DELETE FROM entries_fts WHERE id = old.id;
      END;
      CREATE TRIGGER entries_fts_update AFTER UPDATE OF title, content ON entries BEGIN
        DELETE FROM entries_fts WHERE id = old.id;
        INSERT INTO entries_fts(id, title, content) VALUES (new.id, new.title, new.content);
      END;
    `);
  } catch (e) {
    console.error('[db] FTS trigger create failed:', e.message);
  }

  // migrations: add columns that older tables may lack
  const migrations = [
    'ALTER TABLE users ADD COLUMN banned_until TEXT',
    'ALTER TABLE entries ADD COLUMN is_hidden INTEGER DEFAULT 0',
    'ALTER TABLE posts ADD COLUMN is_hidden INTEGER DEFAULT 0',
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { if (!e.message.includes('duplicate column')) throw e; }
  }

  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

// ============================================================
// users
// ============================================================

function findOrCreateUser(email) {
  const d = getDb();

  // look up an existing email
  const existing = d.prepare('SELECT user_id FROM user_emails WHERE email = ?').get(email.toLowerCase());
  if (existing) {
    return { user_id: existing.user_id, status: 'existing' };
  }

  // create the user and bind the email
  const userId = generateUserId();

  const insertUser = d.prepare('INSERT INTO users (id) VALUES (?)');
  const insertEmail = d.prepare(
    'INSERT INTO user_emails (user_id, email, verified, verified_at, is_primary) VALUES (?, ?, 1, CURRENT_TIMESTAMP, 1)'
  );

  const tx = d.transaction(() => {
    insertUser.run(userId);
    insertEmail.run(userId, email.toLowerCase());
  });
  tx();

  return { user_id: userId, status: 'created' };
}

function getUserIdByEmail(email) {
  const d = getDb();
  const row = d.prepare('SELECT user_id FROM user_emails WHERE email = ?').get(email.toLowerCase());
  return row ? row.user_id : null;
}

function getUserFullInfoByEmail(email) {
  const d = getDb();
  const row = d.prepare('SELECT user_id FROM user_emails WHERE email = ?').get(email.toLowerCase());
  if (!row) return null;
  const emails = d.prepare('SELECT email FROM user_emails WHERE user_id = ?').all(row.user_id).map((e) => e.email);
  return { uid: row.user_id, emails };
}

function bindEmailToUser(uid, email) {
  const d = getDb();
  d.prepare(
    'INSERT INTO user_emails (user_id, email, verified, verified_at, is_primary) VALUES (?, ?, 1, CURRENT_TIMESTAMP, 0)'
  ).run(uid, email.toLowerCase());
}

function mergeAccounts(fromUid, toUid) {
  const d = getDb();
  if (fromUid === toUid) return;
  const tx = d.transaction(() => {
    // move threads
    d.prepare('UPDATE entries SET op_uid = ? WHERE op_uid = ?').run(toUid, fromUid);
    // move replies
    d.prepare('UPDATE posts SET uid = ? WHERE uid = ?').run(toUid, fromUid);
    // nicknames: keep the target row when both exist, avoiding the PRIMARY KEY(entry_id, uid) conflict
    const nicknames = d.prepare('SELECT entry_id FROM entry_nicknames WHERE uid = ?').all(fromUid);
    for (const n of nicknames) {
      const dup = d.prepare('SELECT 1 FROM entry_nicknames WHERE entry_id = ? AND uid = ?').get(n.entry_id, toUid);
      if (dup) {
        d.prepare('DELETE FROM entry_nicknames WHERE entry_id = ? AND uid = ?').run(n.entry_id, fromUid);
      } else {
        d.prepare('UPDATE entry_nicknames SET uid = ? WHERE entry_id = ? AND uid = ?').run(toUid, n.entry_id, fromUid);
      }
    }
    // favorites: merge and dedupe first, then clear the old user so DELETE FROM users does not hit the foreign key
    const favorites = d.prepare('SELECT entry_id FROM favorites WHERE user_id = ?').all(fromUid);
    for (const f of favorites) {
      d.prepare('INSERT OR IGNORE INTO favorites (user_id, entry_id) VALUES (?, ?)').run(toUid, f.entry_id);
    }
    d.prepare('DELETE FROM favorites WHERE user_id = ?').run(fromUid);
    // move emails
    const emails = d.prepare('SELECT email FROM user_emails WHERE user_id = ?').all(fromUid);
    for (const e of emails) {
      const dup = d.prepare('SELECT 1 FROM user_emails WHERE email = ? AND user_id = ?').get(e.email, toUid);
      if (!dup) {
        d.prepare('UPDATE user_emails SET user_id = ?, is_primary = 0 WHERE email = ?').run(toUid, e.email);
      }
    }
    // delete the old user
    d.prepare('DELETE FROM users WHERE id = ?').run(fromUid);
  });
  tx();
}

function getUserEmails(uid) {
  const d = getDb();
  return d.prepare('SELECT email, verified, verified_at, is_primary, notify_enabled FROM user_emails WHERE user_id = ? ORDER BY id ASC').all(uid);
}

function getUserPrimaryEmail(uid) {
  const d = getDb();
  const row = d.prepare('SELECT email FROM user_emails WHERE user_id = ? AND is_primary = 1').get(uid);
  return row ? row.email : null;
}

// ============================================================
// threads
// ============================================================

function createEntry(uid, title, content) {
  const d = getDb();

  // generate a unique 4-character ID
  let entryId;
  let attempts = 0;
  do {
    entryId = generateEntryId();
    const exists = d.prepare('SELECT 1 FROM entries WHERE id = ?').get(entryId);
    if (!exists) break;
    attempts++;
    if (attempts > 100) throw new Error('Failed to generate unique entry ID');
  } while (true);

  // nickname generation
  const nickname = generateNickname(entryId, uid);

  const insertEntry = d.prepare('INSERT INTO entries (id, op_uid, title, content) VALUES (?, ?, ?, ?)');
  const insertPost = d.prepare(
    'INSERT INTO posts (id, entry_id, floor_id, uid, nickname, content, reply_to_floor) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const postId = entryId + '00';

  const tx = d.transaction(() => {
    insertEntry.run(entryId, uid, title, content);
    insertPost.run(postId, entryId, '00', uid, nickname, content, null);
  });
  tx();

  return { entry_id: entryId, post_id: postId };
}

function createReply(entryId, uid, content, replyToFloor) {
  const d = getDb();

  // check that the thread exists
  const entry = d.prepare('SELECT id FROM entries WHERE id = ?').get(entryId);
  if (!entry) throw new Error('Entry not found');

  // find the highest floor
  const maxFloor = d.prepare("SELECT MAX(CAST(floor_id AS TEXT)) as max_floor FROM posts WHERE entry_id = ? AND floor_id != '00'").get(entryId);
  // floor_id is base-34, so compare numerically
  const allFloors = d.prepare('SELECT floor_id FROM posts WHERE entry_id = ?').all(entryId);
  let maxIndex = 0;
  for (const f of allFloors) {
    const idx = floorIdToIndex(f.floor_id);
    if (idx > maxIndex) maxIndex = idx;
  }

  // cap: zz = 1155
  if (maxIndex >= 1155) throw new Error('Floor limit reached (zz=1155)');

  const newIndex = maxIndex + 1;
  const floorId = newIndex === 1 ? '01' : indexToFloorId(newIndex);
  const postId = entryId + floorId;

  const nickname = generateNickname(entryId, uid);

  d.prepare(
    'INSERT INTO posts (id, entry_id, floor_id, uid, nickname, content, reply_to_floor) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(postId, entryId, floorId, uid, nickname, content, replyToFloor || null);

  return { entry_id: entryId, floor_id: floorId, post_id: postId };
}

function getEntryList(before, limit, query, currentUid) {
  const d = getDb();
  limit = Math.min(limit || 20, 50);

  const hideFilter = currentUid
    ? 'AND (e.is_hidden = 0 OR e.op_uid = ?)'
    : 'AND e.is_hidden = 0';

  const likeSearch = (q) => {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const params = currentUid ? [like, like, currentUid, limit] : [like, like, limit];
    return d.prepare(`
      SELECT e.id, e.title, e.content, e.created_at,
             (SELECT COUNT(*) FROM posts WHERE entry_id = e.id) as floor_count
      FROM entries e
      WHERE (e.title LIKE ? ESCAPE '\\' OR e.content LIKE ? ESCAPE '\\')
      ${hideFilter}
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(...params);
  };

  // search mode
  if (query && query.trim()) {
    const q = query.trim();
    // exact/fuzzy ID search (bypasses FTS)
    if (q.length <= 6 && /^[a-z0-9]+$/.test(q)) {
      const params = currentUid ? [`%${q}%`, `%${q}%`, currentUid, limit] : [`%${q}%`, `%${q}%`, limit];
      const rows = d.prepare(`
        SELECT e.id, e.title, e.content, e.created_at,
               (SELECT COUNT(*) FROM posts WHERE entry_id = e.id) as floor_count
        FROM entries e
        WHERE (e.id LIKE ?
           OR e.id IN (SELECT DISTINCT entry_id FROM posts WHERE id LIKE ?))
        ${hideFilter}
        ORDER BY e.created_at DESC
        LIMIT ?
      `).all(...params);
      if (rows.length > 0) return { items: rows, has_more: false };
    }

    // non-ASCII/CJK: unicode61 does not index CJK, so fall back to a LIKE substring match
    if (/[^\x00-\x7F]/.test(q)) {
      return { items: likeSearch(q), has_more: false };
    }

    // FTS5 search; fall back to LIKE when there are no hits or on syntax errors
    try {
      const ftsParams = currentUid ? [q, currentUid, limit] : [q, limit];
      const rows = d.prepare(`
        SELECT e.id, e.title, e.content, e.created_at,
               (SELECT COUNT(*) FROM posts WHERE entry_id = e.id) as floor_count,
               rank
        FROM entries_fts f
        JOIN entries e ON f.id = e.id
        WHERE entries_fts MATCH ? ${hideFilter}
        ORDER BY rank
        LIMIT ?
      `).all(...ftsParams);
      if (rows.length > 0) return { items: rows, has_more: false };
    } catch (e) {
      // FTS syntax errors (quotes/special characters) fall back to LIKE
    }

    return { items: likeSearch(q), has_more: false };
  }

  const baseQuery = `
    SELECT e.id, e.title, e.content, e.created_at,
           (SELECT COUNT(*) FROM posts WHERE entry_id = e.id) as floor_count
    FROM entries e
    WHERE 1=1
  `;

  const filterClause = currentUid
    ? 'AND (e.is_hidden = 0 OR e.op_uid = ?)'
    : 'AND e.is_hidden = 0';

  if (before) {
    const beforeEntry = d.prepare('SELECT id, created_at FROM entries WHERE id = ?').get(before);
    if (beforeEntry) {
      // cursor uses (created_at, id) so rows sharing a second are neither skipped nor duplicated
      const params = currentUid
        ? [beforeEntry.created_at, beforeEntry.created_at, beforeEntry.id, currentUid, limit + 1]
        : [beforeEntry.created_at, beforeEntry.created_at, beforeEntry.id, limit + 1];
      const rows = d.prepare(`
        ${baseQuery} ${filterClause}
          AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ?
      `).all(...params);
      const hasMore = rows.length > limit;
      // always return { items, has_more } like the first page, so clients never get a bare array
      return { items: rows.slice(0, limit), has_more: hasMore };
    }
  }

  const params = currentUid ? [currentUid, limit + 1] : [limit + 1];
  const rows = d.prepare(`${baseQuery} ${filterClause} ORDER BY e.created_at DESC, e.id DESC LIMIT ?`).all(...params);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);

  return { items, has_more: hasMore };
}

function getEntryDetail(entryId, currentUid) {
  const d = getDb();

  const entry = d.prepare('SELECT id, title, op_uid, content, is_hidden, created_at FROM entries WHERE id = ?').get(entryId);
  if (!entry) return null;

  const posts = d.prepare(
    'SELECT floor_id, uid, nickname, content, reply_to_floor, is_hidden, created_at FROM posts WHERE entry_id = ? ORDER BY CAST(floor_id AS TEXT)'
  ).all(entryId);

  // hidden threads are visible only to the OP
  if (entry.is_hidden && (!currentUid || currentUid !== entry.op_uid)) {
    return null;
  }

  return {
    id: entry.id,
    title: entry.title,
    is_hidden: !!entry.is_hidden,
    created_at: entry.created_at,
    posts: posts
      .filter((p) => {
        // hidden floors are visible only to their author
        if (!p.is_hidden) return true;
        return currentUid && p.uid === currentUid;
      })
      .map((p) => ({
        floor_id: p.floor_id,
        is_op: p.uid === entry.op_uid,
        is_me: currentUid ? p.uid === currentUid : false,
        is_hidden: !!p.is_hidden,
        nickname: p.nickname,
        content: p.content,
        reply_to_floor: p.reply_to_floor,
        created_at: p.created_at,
      })),
  };
}

// ============================================================
// user threads / replies
// ============================================================

function getUserEntries(uid) {
  const d = getDb();
  return d.prepare(`
    SELECT e.id, e.title, e.content, e.created_at,
           (SELECT COUNT(*) FROM posts WHERE entry_id = e.id) as floor_count
    FROM entries e
    WHERE e.op_uid = ?
    ORDER BY e.created_at DESC
  `).all(uid);
}

function getUserReplies(uid) {
  const d = getDb();
  return d.prepare(`
    SELECT p.id as post_id, p.entry_id, e.title as entry_title,
           p.floor_id, p.nickname, p.content, p.created_at
    FROM posts p
    JOIN entries e ON p.entry_id = e.id
    WHERE p.uid = ? AND p.floor_id != '00'
      AND (e.is_hidden = 0 OR e.op_uid = ?)
    ORDER BY p.created_at DESC
  `).all(uid, uid);
}

// ============================================================
// ID validation
// ============================================================

function validateId(id) {
  const d = getDb();

  // check characters
  const BASE34_SET = new Set(BASE34.split(''));
  if (!id.split('').every((c) => BASE34_SET.has(c))) {
    return { valid: false, error: 'ID contains invalid characters' };
  }

  // 4 characters -> thread
  if (id.length === 4) {
    const entry = d.prepare('SELECT id, is_hidden FROM entries WHERE id = ?').get(id);
    if (!entry) return { valid: false, error: 'Thread not found' };
    if (entry.is_hidden) return { valid: false, error: 'Thread not found' };
    return { valid: true, type: 'entry', entry_id: id, floor_id: null };
  }

  // 6 characters -> thread + floor
  if (id.length === 6) {
    const entryId = id.slice(0, 4);
    const floorId = id.slice(4, 6);

    const entry = d.prepare('SELECT id, is_hidden FROM entries WHERE id = ?').get(entryId);
    if (!entry) return { valid: false, error: 'Thread not found' };
    if (entry.is_hidden) return { valid: false, error: 'Thread not found' };

    const floor = d.prepare('SELECT floor_id, is_hidden FROM posts WHERE entry_id = ? AND floor_id = ?').get(entryId, floorId);
    if (!floor) return { valid: false, error: 'Floor not found' };
    if (floor.is_hidden) return { valid: false, error: 'Floor not found' };

    return { valid: true, type: 'floor', entry_id: entryId, floor_id: floorId };
  }

  return { valid: false, error: `ID must be 4 or 6 characters, got ${id.length}` };
}

// ============================================================
// favorites
// ============================================================

function toggleFavorite(uid, entryId) {
  const d = getDb();
  const existing = d.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND entry_id = ?').get(uid, entryId);
  if (existing) {
    d.prepare('DELETE FROM favorites WHERE user_id = ? AND entry_id = ?').run(uid, entryId);
    return { favorited: false };
  }
  d.prepare('INSERT INTO favorites (user_id, entry_id) VALUES (?, ?)').run(uid, entryId);
  return { favorited: true };
}

function getUserFavorites(uid) {
  const d = getDb();
  return d.prepare(`
    SELECT e.id, e.title, e.content, e.created_at,
           (SELECT COUNT(*) FROM posts WHERE entry_id = e.id) as floor_count
    FROM favorites f
    JOIN entries e ON f.entry_id = e.id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `).all(uid);
}

function checkFavorites(uid, entryIds) {
  const d = getDb();
  if (!entryIds.length) return {};
  const placeholders = entryIds.map(() => '?').join(',');
  const rows = d.prepare(
    `SELECT entry_id FROM favorites WHERE user_id = ? AND entry_id IN (${placeholders})`
  ).all(uid, ...entryIds);
  const set = {};
  for (const r of rows) set[r.entry_id] = true;
  return set;
}

// ============================================================
// moderation
// ============================================================

function hideEntry(entryId) {
  const d = getDb();
  d.prepare('UPDATE entries SET is_hidden = 1 WHERE id = ?').run(entryId);
  return { ok: true };
}

function unhideEntry(entryId) {
  const d = getDb();
  d.prepare('UPDATE entries SET is_hidden = 0 WHERE id = ?').run(entryId);
  return { ok: true };
}

function hidePost(postId) {
  const d = getDb();
  d.prepare('UPDATE posts SET is_hidden = 1 WHERE id = ?').run(postId);
  return { ok: true };
}

function unhidePost(postId) {
  const d = getDb();
  d.prepare('UPDATE posts SET is_hidden = 0 WHERE id = ?').run(postId);
  return { ok: true };
}

function deleteEntry(entryId) {
  const d = getDb();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM favorites WHERE entry_id = ?').run(entryId);
    d.prepare('DELETE FROM posts WHERE entry_id = ?').run(entryId);
    d.prepare('DELETE FROM entry_nicknames WHERE entry_id = ?').run(entryId);
    // FTS is kept in sync by the entries_fts_delete trigger
    d.prepare('DELETE FROM entries WHERE id = ?').run(entryId);
  });
  tx();
  return { ok: true };
}

function deletePost(postId) {
  const d = getDb();
  d.prepare('DELETE FROM posts WHERE id = ?').run(postId);
  return { ok: true };
}

function banUser(uid, days) {
  const d = getDb();
  if (days && days > 0) {
    const until = new Date(Date.now() + days * 86400000).toISOString();
    d.prepare('UPDATE users SET banned_until = ? WHERE id = ?').run(until, uid);
  } else {
    d.prepare('UPDATE users SET banned_until = ? WHERE id = ?').run('2099-12-31', uid);
  }
  return { ok: true };
}

function unbanUser(uid) {
  const d = getDb();
  d.prepare('UPDATE users SET banned_until = NULL WHERE id = ?').run(uid);
  return { ok: true };
}

function isUserBanned(uid) {
  if (!uid) return false;
  const d = getDb();
  const row = d.prepare('SELECT banned_until FROM users WHERE id = ?').get(uid);
  if (!row || !row.banned_until) return false;
  return new Date(row.banned_until) > new Date();
}

function getBannedInfo(uid) {
  if (!uid) return null;
  const d = getDb();
  const row = d.prepare('SELECT banned_until FROM users WHERE id = ?').get(uid);
  if (!row || !row.banned_until) return null;
  const until = new Date(row.banned_until);
  if (until <= new Date()) return null;
  return { banned_until: row.banned_until };
}

function getAllAuthorizedEmails() {
  const d = getDb();
  const rows = d.prepare('SELECT email FROM user_emails WHERE verified = 1').all();
  return rows.map((r) => r.email);
}

// ============================================================
// nickname generation (deterministic hash)
// ============================================================

// adjective and noun vocabulary
const ADJECTIVES = [
  'happy', 'quiet', 'brave', 'gentle', 'clever', 'cute', 'free', 'warm',
  'mysterious', 'elegant', 'passionate', 'calm', 'lively', 'steady', 'humorous', 'kind',
  'diligent', 'romantic', 'innocent', 'easygoing', 'nimble', 'composed', 'persistent', 'frank',
  'unhurried', 'candid', 'modest', 'unfettered', 'bright', 'graceful', 'pure', 'firm',
  'delicate', 'cheerful', 'witty', 'refined', 'plain', 'quick-witted', 'bold', 'open-minded',
  'practical', 'broad-minded', 'enlightened', 'generous', 'perceptive', 'rigorous', 'studious', 'tenacious',
  'upright', 'light-hearted', 'lyrical', 'understated', 'shy', 'honest', 'timid', 'soft-spoken',
  'elegant', 'sunny', 'radiant', 'grounded', 'direct', 'easy', 'laid-back', 'loyal',
  'warm-hearted', 'reliable', 'zen', 'introverted', 'unbothered', 'idle', 'food-loving', 'hard-working',
  'carefree', 'content', 'cool-headed', 'zen', 'energetic', 'lazy', 'slow-warming', 'outgoing',
  'nostalgic', 'curious', 'stubborn', 'zen', 'artsy', 'hot-blooded', 'aloof', 'cuddly',
  'sunny', 'green', 'tsundere', 'adorkable', 'aloof', 'healing', 'hot-blooded', 'languid',
  'low-key', 'reliable', 'clear-eyed', 'relaxed', 'reserved', 'flamboyant', 'zen', 'down-to-earth',
  'impatient', 'easygoing', 'night owl', 'health nut', 'detail-oriented', 'perfectionist', 'indecisive', 'social butterfly',
  'gossipy', 'bubble tea lover', 'sunbather', 'music lover', 'walker', 'daydreamer', 'journal writer', 'binge watcher',
  'health-conscious', 'night owl', 'early class', 'full schedule', 'deadline chaser', 'finals week', 'intern', 'exam prepper',
];

const NOUNS = [
  'cat', 'puppy', 'rabbit', 'panda', 'dolphin', 'squirrel', 'penguin', 'hamster',
  'elephant', 'giraffe', 'koala', 'hedgehog', 'sloth', 'antelope', 'rhino', 'zebra',
  'star', 'moon', 'sun', 'cloud', 'rainbow', 'snow mountain', 'wave', 'forest',
  'starry sky', 'galaxy', 'aurora', 'meteor', 'dawn', 'sunset glow', 'clear sky', 'breeze',
  'sunshine', 'dew', 'frost', 'mist', 'lightning', 'thunder', 'tide', 'sunrise',
  'dusk', 'nightfall', 'daybreak', 'twilight', 'first light', 'evening', 'moonrise',
  'spring wind', 'summer rain', 'autumn frost', 'winter snow', 'midsummer', 'late autumn', 'deep winter',
  'peach blossom', 'plum blossom', 'orchid', 'lotus', 'chrysanthemum', 'bamboo', 'pine', 'maple leaf',
  'cherry blossom', 'peony', 'jasmine', 'osmanthus', 'daffodil', 'azalea', 'rose', 'lily',
  'water lily', 'daisy', 'hydrangea', 'lavender', 'sunflower', 'mimosa', 'clover',
  'butterfly', 'dragonfly', 'firefly', 'robin', 'nightingale', 'seagull', 'egret', 'peacock',
  'swan', 'wild goose', 'swallow', 'sparrow', 'pigeon', 'owl',
  'bread', 'cake', 'cookie', 'candy', 'chocolate', 'ice cream', 'milk tea', 'coffee',
  'matcha', 'cocoa', 'pudding', 'jelly', 'cheese', 'honey', 'lemon', 'cream puff',
  'shortbread', 'gummy', 'watermelon', 'strawberry', 'mango', 'grape', 'blueberry', 'orange',
  'river', 'lake', 'mountain range', 'grassland', 'desert', 'island', 'canyon', 'waterfall',
  'hot spring', 'glacier', 'oasis', 'jungle', 'meadow', 'harbor', 'coral', 'beach',
  'lighthouse', 'windmill', 'castle', 'bridge', 'temple', 'palace', 'church', 'clock tower',
  'courtyard', 'garden', 'pier', 'sailboat', 'airship', 'cabin', 'stone steps', 'alley',
  'plaza', 'fountain', 'statue', 'mural', 'swing', 'bench', 'street lamp',
  'guitar', 'piano', 'violin', 'wind chime', 'harmonica', 'pipa', 'guzheng', 'ocarina',
  'poem', 'movement', 'painting', 'story', 'legend', 'fable', 'fairy tale', 'essay',
  'diary', 'letter', 'sticky note', 'photo album',
  'glass', 'amber', 'crystal', 'agate', 'jade', 'pearl', 'gem', 'diamond',
  'hourglass', 'compass', 'music box', 'kaleidoscope', 'wish jar', 'drift bottle', 'magnetic compass',
  'ginkgo', 'plane tree', 'banyan', 'willow', 'poplar', 'redwood', 'camphor',
  'kapok', 'gardenia', 'lily of the valley', 'bellflower', 'wisteria', 'crabapple', 'magnolia',
];

const NICKNAME_SALT = process.env.NICKNAME_SALT || 'treehole-nickname-v1';

function generateNickname(entryId, uid) {
  const d = getDb();

  // check for a manually set nickname first
  const manual = d.prepare('SELECT nickname FROM entry_nicknames WHERE entry_id = ? AND uid = ?').get(entryId, uid);
  if (manual) return manual.nickname;

  // deterministic hash
  const seedInput = `${entryId}:${uid}:${NICKNAME_SALT}`;
  const hash = crypto.createHash('sha256').update(seedInput).digest('hex').substring(0, 8);
  const adjIdx = parseInt(hash.substring(0, 4), 16) % ADJECTIVES.length;
  const nounIdx = parseInt(hash.substring(4, 8), 16) % NOUNS.length;

  const adj = ADJECTIVES[adjIdx] || 'mysterious';
  const noun = NOUNS[nounIdx] || 'wanderer';

  return adj + noun;
}

module.exports = {
  initDatabase,
  getDb,
  findOrCreateUser,
  getUserIdByEmail,
  getUserEmails,
  getUserPrimaryEmail,
  createEntry,
  createReply,
  getEntryList,
  getEntryDetail,
  getUserEntries,
  getUserReplies,
  getUserFullInfoByEmail,
  bindEmailToUser,
  mergeAccounts,
  validateId,
  toggleFavorite,
  getUserFavorites,
  checkFavorites,
  hideEntry,
  unhideEntry,
  hidePost,
  unhidePost,
  deleteEntry,
  deletePost,
  banUser,
  unbanUser,
  isUserBanned,
  getBannedInfo,
  getAllAuthorizedEmails,
  generateNickname,
};
