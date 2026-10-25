import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getEntries, createEntry, checkFavorites, getUserProfile } from '../lib/api';
import { isLoggedIn, logout, setToken, setUser, getBannedUntil, setBannedUntil as saveBannedUntil } from '../lib/auth';
import { formatDate } from '../lib/utils';
import { loadConfig } from '../lib/cfg';
import LoginModal from '../components/LoginModal';
import StarButton from '../components/StarButton';
import ConfirmDialog from '../components/ConfirmDialog';
import './EntryListPage.css';

export default function EntryListPage() {
  const navigate = useNavigate();

  const [entries, setEntries] = useState(null);
  const [favorites, setFavorites] = useState({});
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // session state
  const [loggedIn, setLoggedIn] = useState(isLoggedIn());
  const [showLogin, setShowLogin] = useState(false);
  const [siteTitle, setSiteTitle] = useState('Treehole');

  useEffect(() => { loadConfig().then(c => { const t = c.site_title || 'Treehole'; setSiteTitle(t); setSubmitAddr(c.submit_address || ''); document.title = t; }); }, []);

  // restore session from cookie
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch('/api/auth/me');
        if (resp.ok) {
          const data = await resp.json();
          setUser({ uid: data.uid, email: data.primary_email });
          setLoggedIn(true);
          setShowLogin(false);
          const banned = data.banned && new Date(data.banned) > new Date() ? data.banned : null;
          setBannedUntil(banned);
          saveBannedUntil(banned);
        }
      } catch {}
    })();
  }, []);

  // new post modal
  const [showNewPost, setShowNewPost] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAbout, setShowAbout] = useState(false);
  const [showEmailGuide, setShowEmailGuide] = useState(false);
  const [submitAddr, setSubmitAddr] = useState('');
  const [bannedUntil, setBannedUntil] = useState(getBannedUntil());
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const loadEntries = useCallback(async (query) => {
    setError('');
    try {
      const data = await getEntries(null, 20, query || undefined);
      setEntries(data.items || []);
      setHasMore(data.has_more);
      if (data.items?.length && isLoggedIn()) {
        try { const favs = await checkFavorites(data.items.map(e => e.id)); setFavorites(favs); } catch {}
      }
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  // refresh after sign-in (favorite state)
  useEffect(() => {
    if (loggedIn) loadEntries();
  }, [loggedIn]);

  function requireLogin() {
    setShowLogin(true);
  }

  // infinite scroll: load more near the bottom
  const sentinelRef = useRef(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(() => {
    if (!hasMore || loadingMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(async (obsEntries) => {
      if (obsEntries[0].isIntersecting && hasMore) {
        setLoadingMore(true);
        try {
          const last = entriesRef.current[entriesRef.current.length - 1];
          const data = await getEntries(last?.id, 20);
          setEntries((prev) => [...prev, ...(data.items || [])]);
          setHasMore(data.has_more);
        } catch (err) {
          setError(err.message);
        } finally {
          setLoadingMore(false);
        }
      }
    }, { rootMargin: '200px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore]);

  function handleEntryClick(entryId) {
    navigate(`/entries/${entryId}`);
  }

  function handleLogout() {
    setShowLogoutConfirm(true);
  }
  function confirmLogout() {
    setShowLogoutConfirm(false);
    fetch('/api/auth/logout', { method: 'POST' });
    logout();
    setLoggedIn(false);
    setBannedUntil(null);
    saveBannedUntil(null);
    loadEntries();
  }

  function openNewPost() {
    setNewTitle('');
    setNewContent('');
    setShowNewPost(true);
  }

  async function handleCreateEntry(e) {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) return;
    setSubmitting(true);
    try {
      await createEntry(newTitle.trim(), newContent.trim());
      setShowNewPost(false);
      loadEntries();
    } catch (err) {
      alert(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="entry-list-page">
      {/* sign-in modal */}
      {!loggedIn && showLogin && <LoginModal onLogin={() => { setLoggedIn(true); setShowLogin(false); }} onClose={() => setShowLogin(false)} />}
      {showLogoutConfirm && <ConfirmDialog message="Sign out?" onConfirm={confirmLogout} onCancel={() => setShowLogoutConfirm(false)} />}

      {/* Header */}
      <header className="header">
        <div className="header-inner">
          <h1 className="header-title" onClick={() => setShowAbout(true)} style={{ cursor: 'pointer' }}>{siteTitle}</h1>
          <div className="header-right">
            {loggedIn ? (
              <>
                <button className="btn btn-sm btn-outline" onClick={() => navigate('/user')}>
                  Profile
                </button>
                <button className="btn btn-sm btn-outline" onClick={handleLogout}>
                  Sign out
                </button>
              </>
            ) : (
              <button className="btn btn-sm btn-outline" onClick={requireLogin}>
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Content */}
        {bannedUntil && (
          <div style={{ background: '#dc2626', color: '#ffe066', textAlign: 'center', padding: '0.5rem', fontSize: '0.9rem' }}>
            ⚠ Your account is banned{new Date(bannedUntil).getFullYear() < 2099 ? `, ${Math.ceil((new Date(bannedUntil) - Date.now()) / 86400000)} day(s) left` : ''}
          </div>
        )}
        <main className="main-content">
          <div className="container">
            <div className="search-bar">
              <input
                className="search-input"
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') loadEntries(searchQuery.replace(/^#/, '')); }}
              />
              {searchQuery && (
                <button className="search-clear" onClick={() => { setSearchQuery(''); loadEntries(); }}>
                  ×
                </button>
              )}
            </div>
            {error && (
              <div className="alert alert-error">
                {error}
                <button className="alert-retry" onClick={loadEntries}>Retry</button>
              </div>
            )}

            {entries && !error && entries.length === 0 && (
              <div className="empty-state">
                <p>No posts yet</p>
                <p className="empty-hint">Tap + below to write the first post</p>
              </div>
            )}

            {entries && entries.length > 0 && (
              <>
                <div className="entry-list">
                  {entries.map((entry) => (
                    <article
                      key={entry.id}
                      className="entry-card"
                      onClick={() => handleEntryClick(entry.id)}
                    >
                      <StarButton entryId={entry.id} initialFavorited={!!favorites[entry.id]} />
                      <div className="entry-meta">
                        <span className="entry-id">#{entry.id}</span>
                        <span className="entry-time">{formatDate(entry.created_at)}</span>
                      </div>
                      <h2 className="entry-title">{entry.title}</h2>
                      {entry.content && (
                        <div className="entry-content-preview">{entry.content}</div>
                      )}
                      <div className="entry-footer">
                        <span className="entry-floors">{entry.floor_count} replies</span>
                      </div>
                    </article>
                  ))}
                </div>

                <div ref={sentinelRef} style={{ height: 1 }} />
                {!hasMore && <p className="all-loaded">— end of list —</p>}
              </>
            )}
          </div>
        </main>

      {/* email submission button */}
      <button className="fab email-fab" onClick={() => setShowEmailGuide(true)} title="Email submission">
        ✉
      </button>

      {/* new post button */}
      <button className="fab" onClick={loggedIn ? openNewPost : requireLogin} title="New post">
        +
      </button>

      {/* about modal */}
      {showAbout && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem 1.25rem 0' }}>
              <h2 className="modal-title" style={{ padding: 0, margin: 0 }}>About {siteTitle}</h2>
              <button className="modal-close-btn" onClick={() => setShowAbout(false)}>×</button>
            </div>
            <div className="about-content" style={{ padding: '1rem 1.25rem', minHeight: 120, color: '#888', fontSize: '0.9rem', lineHeight: 1.6 }}>
              {<p>An anonymous message board for the university, open to campus email addresses only.<br />
              You can post by email or from the web.<br />
              You can also bookmark posts to read later.<br />
              <br />
              Please keep posts civil.</p>}
            </div>
          </div>
        </div>
      )}

      {/* email submission modal */}
      {showEmailGuide && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem 1.25rem 0' }}>
              <h2 className="modal-title" style={{ padding: 0, margin: 0 }}>Email submission</h2>
              <button className="modal-close-btn" onClick={() => setShowEmailGuide(false)}>×</button>
            </div>
            <div style={{ padding: '1rem 1.25rem 1.25rem', fontSize: '0.9rem', lineHeight: 1.8 }}>
              <p><strong>Submission address</strong></p>
              <p style={{ fontFamily: 'monospace', marginBottom: '0.5rem' }}>{submitAddr}</p>
              <p style={{ marginTop: '0.75rem' }}><strong>New posts</strong></p>
              <p>Put the title in the subject and the content in the message body</p>
              <p style={{ marginTop: '0.75rem' }}><strong>Replies</strong></p>
              <p>Start the subject with <code>/r</code> followed by the ID (e.g. <code>/r a3x7</code> or <code>/r #a3x703</code>)</p>
              <p style={{ marginTop: '0.75rem' }}><strong>PGP encryption</strong></p>
              <p>Email supports<Link to="https://support.mozilla.org/en-US/kb/thunderbird-openpgp"> PGP encryption</Link>. Replies to unencrypted submissions include the public key.</p>
              <div style={{ marginTop: '1.25rem' }}>
                <a className="btn btn-primary" href={`mailto:${submitAddr}`} style={{ display: 'inline-block', textAlign: 'center' }}>
                  Open mail client
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* new post modal */}
      {showNewPost && (
        <div className="modal-overlay">
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">New post</h2>
            <form onSubmit={handleCreateEntry}>
              <div className="form-group">
                <label htmlFor="new-title">Title</label>
                <input
                  id="new-title"
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Give your post a title"
                  maxLength={200}
                  required
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label htmlFor="new-content">
                  Content
                  <span className={`char-count ${newContent.length > 200 ? 'char-over' : ''}`}>
                    {newContent.length}/200
                  </span>
                </label>
                <textarea
                  id="new-content"
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Say something..."
                  rows={6}
                  maxLength={200}
                  required
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-cancel" onClick={() => setShowNewPost(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Publishing...' : 'Publish'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
