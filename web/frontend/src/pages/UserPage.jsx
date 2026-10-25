import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getUserPosts, getUserReplies, getUserProfile, getUserFavorites } from '../lib/api';
import { isLoggedIn, getUser, getBannedUntil } from '../lib/auth';
import { formatDate } from '../lib/utils';
import BindEmailModal from '../components/BindEmailModal';
import StarButton from '../components/StarButton';
import './UserPage.css';

export default function UserPage() {
  const navigate = useNavigate();
  const user = getUser();

  const [tab, setTab] = useState('posts');
  const [posts, setPosts] = useState(null);
  const [replies, setReplies] = useState(null);
  const [favorites, setFavorites] = useState(null);
  const [error, setError] = useState('');

  const [emails, setEmails] = useState(null);
  const [showBindModal, setShowBindModal] = useState(false);

  // set of favorited IDs, used to mark the user's own posts
  const favIds = new Set((favorites || []).map(f => f.id));

  useEffect(() => { document.title = 'Profile'; }, []);
  useEffect(() => {
    if (!isLoggedIn()) {
      navigate('/entries', { replace: true });
      return;
    }
    loadData();
    loadProfile();
  }, [navigate, tab]);

  async function loadProfile() {
    try {
      const profile = await getUserProfile();
      setEmails(profile.emails || []);
    } catch {}
  }

  async function loadData() {
    setError('');
    try {
      const [postsData, repliesData, favsData] = await Promise.all([
        getUserPosts(),
        getUserReplies(),
        getUserFavorites(),
      ]);
      setPosts(postsData.items || []);
      setReplies(repliesData.items || []);
      setFavorites(favsData.items || []);
    } catch (err) {
      setError(err.message);
    }
  }

  function handleBack() {
    navigate('/entries');
  }

  function handleEntryClick(entryId) {
    navigate(`/entries/${entryId}`);
  }

  function renderTabButton(key, label, count) {
    const active = tab === key;
    return (
      <button
        className={`tab-btn ${active ? 'tab-btn-active' : ''}`}
        onClick={() => setTab(key)}
      >
        {label}
        {count !== null && <span className="tab-count">{count}</span>}
      </button>
    );
  }

  return (
    <div className="user-page">
      <header className="header">
        <div className="header-inner">
          <button className="btn-back" onClick={handleBack}>
            Back
          </button>
          <h1 className="header-title">Profile</h1>
          <div className="header-spacer" />
        </div>
      </header>

      {getBannedUntil() && (
        <div style={{ background: '#dc2626', color: '#ffe066', textAlign: 'center', padding: '0.5rem', fontSize: '0.9rem' }}>
          ⚠ Your account is banned{new Date(getBannedUntil()).getFullYear() < 2099 ? `, ${Math.ceil((new Date(getBannedUntil()) - Date.now()) / 86400000)} day(s) left` : ''}
        </div>
      )}
      <main className="main-content">
        <div className="container">
          <div className="user-info-card">
            <div className="user-detail">
              <p className="user-uid">UID: {user?.uid || ''}</p>
              {emails && emails.length > 0 && (
                <div className="user-emails">
                  {emails.map((e) => (
                    <span key={e.email} className="email-tag">{e.email}</span>
                  ))}
                </div>
              )}
              <button className="btn-bind-email" onClick={() => setShowBindModal(true)}>
                + Bind email
              </button>
            </div>
          </div>

          <div className="tab-bar">
            {renderTabButton('posts', 'My posts', posts?.length ?? null)}
            {renderTabButton('replies', 'My replies', replies?.length ?? null)}
            {renderTabButton('favorites', 'My favorites', favorites?.length ?? null)}
          </div>

          {error && (
            <div className="alert alert-error">
              {error}
              <button className="alert-retry" onClick={loadData}>Retry</button>
            </div>
          )}

          {/* my posts */}
          {tab === 'posts' && (
            <>
              {posts && posts.length === 0 && (
                <div className="empty-state">
                  <p>You have not posted yet</p>
                </div>
              )}
              {posts && posts.length > 0 && (
                <div className="item-list">
                  {posts.map((post) => (
                    <article
                      key={post.id}
                      className="item-card"
                      onClick={() => handleEntryClick(post.id)}
                    >
                      <StarButton entryId={post.id} initialFavorited={favIds.has(post.id)} />
                      <div className="item-meta">
                        <span className="item-id">#{post.id}</span>
                        <span className="item-time">{formatDate(post.created_at)}</span>
                      </div>
                      <h3 className="item-title">{post.title}</h3>
                      {post.content && (
                        <div className="item-content-preview">{post.content}</div>
                      )}
                      <div className="item-footer">
                        <span className="item-floor-count">{post.floor_count || 0} replies</span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}

          {/* my replies */}
          {tab === 'replies' && (
            <>
              {replies && replies.length === 0 && (
                <div className="empty-state">
                  <p>You have not replied yet</p>
                </div>
              )}
              {replies && replies.length > 0 && (
                <div className="item-list">
                  {replies.map((reply) => (
                    <article
                      key={reply.post_id}
                      className="item-card"
                      onClick={() => handleEntryClick(reply.entry_id)}
                    >
                      <div className="item-meta">
                        <span className="item-id">#{reply.post_id}</span>
                        <span className="item-nickname-bracket">[{reply.nickname}]</span>
                        <span className="item-time">{formatDate(reply.created_at)}</span>
                      </div>
                      <div className="item-content-preview">
                        {reply.content || '(empty)'}
                      </div>
                      <div className="item-source-title">
                        {reply.entry_title || `Thread ${reply.entry_id}`}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}

          {/* my favorites */}
          {tab === 'favorites' && (
            <>
              {favorites && favorites.length === 0 && (
                <div className="empty-state">
                  <p>No favorites yet</p>
                </div>
              )}
              {favorites && favorites.length > 0 && (
                <div className="item-list">
                  {favorites.map((fav) => (
                    <article
                      key={fav.id}
                      className="item-card"
                      onClick={() => handleEntryClick(fav.id)}
                    >
                      <StarButton entryId={fav.id} initialFavorited={true} />
                      <div className="item-meta">
                        <span className="item-id">#{fav.id}</span>
                        <span className="item-time">{formatDate(fav.created_at)}</span>
                      </div>
                      <h3 className="item-title">{fav.title}</h3>
                      {fav.content && (
                        <div className="item-content-preview">{fav.content}</div>
                      )}
                      <div className="item-footer">
                        <span className="item-floor-count">{fav.floor_count || 0} replies</span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {showBindModal && (
        <BindEmailModal
          onClose={() => setShowBindModal(false)}
          onUpdated={() => loadProfile()}
        />
      )}
    </div>
  );
}
