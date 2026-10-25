import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getEntryDetail, createReply } from '../lib/api';
import { isLoggedIn } from '../lib/auth';
import { getBannedUntil } from '../lib/auth';
import { formatDate } from '../lib/utils';
import LoginModal from '../components/LoginModal';
import './EntryDetailPage.css';

export default function EntryDetailPage() {
  const { entryId } = useParams();
  const navigate = useNavigate();
  const [loggedIn, setLoggedIn] = useState(isLoggedIn());
  const [showLogin, setShowLogin] = useState(false);

  const [entry, setEntry] = useState(null);
  const [error, setError] = useState('');

  // reply form
  const [replyContent, setReplyContent] = useState('');
  const [replyToFloor, setReplyToFloor] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [replyError, setReplyError] = useState('');

  useEffect(() => {
    // detail pages are public
  }, []);

  const loadEntry = useCallback(async () => {
    setError('');
    try {
      const data = await getEntryDetail(entryId);
      setEntry(data);
      if (data) document.title = data.title;
    } catch (err) {
      setError(err.message);
    }
  }, [entryId]);

  useEffect(() => {
    loadEntry();
  }, [loadEntry]);

  // clicking a floor selects it for quoting
  function handleQuoteFloor(floorId) {
    if (replyToFloor === floorId) {
      setReplyToFloor(null); // clicking again clears the quote
    } else {
      setReplyToFloor(floorId);
    }
  }

  // submit reply
  async function handleReply(e) {
    e.preventDefault();
    if (!replyContent.trim()) return;
    setSubmitting(true);
    setReplyError('');
    try {
      await createReply(entryId, replyContent.trim(), replyToFloor);
      setReplyContent('');
      setReplyToFloor(null);
      loadEntry(); // refresh
    } catch (err) {
      setReplyError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function handleBack() {
    navigate('/entries');
  }

  return (
    <div className="detail-page">
      <header className="header">
        <div className="header-inner">
          <button className="btn-back" onClick={handleBack}>Back</button>
          <h1 className="header-title">Post</h1>
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
          {error && (
            <div className="alert alert-error">
              {error}
              <button className="alert-retry" onClick={loadEntry}>Retry</button>
            </div>
          )}

          {entry && (
            <>
              <div className="entry-header-card">
                <h2 className="entry-detail-title">{entry.title}</h2>
                <div className="entry-detail-meta">
                  <span className="entry-detail-id">#{entry.id}</span>
                  <span>·</span>
                  <span>{formatDate(entry.created_at)}</span>
                  <span>·</span>
                  <span>{entry.posts?.length || 0} replies</span>
                </div>
              </div>

              <div className="floor-list">
                {entry.posts?.map((post) => {
                  const fullId = entry.id + post.floor_id;
                  return (
                  <div
                    key={post.floor_id}
                    className={`floor-card ${replyToFloor === post.floor_id ? 'floor-targeted' : ''}`}
                    id={`floor-${post.floor_id}`}
                    onClick={() => handleQuoteFloor(post.floor_id)}
                  >
                    <div className="floor-header">
                      <span className="floor-full-id">#{fullId}</span>
                      <span className="floor-nickname-bracket">[{post.nickname}]</span>
                      {post.is_op && (
                        <span className="floor-op-badge">OP</span>
                      )}
                      {post.is_me && (
                        <span className="floor-me-badge">me</span>
                      )}
                      <span className="floor-time">{formatDate(post.created_at)}</span>
                    </div>

                    {post.reply_to_floor && (() => {
                      const refPost = entry.posts.find(p => p.floor_id === post.reply_to_floor);
                      return (
                        <div className="floor-reply-to">
                          <span className="floor-reply-to-id">#{entry.id + post.reply_to_floor}</span>
                          {refPost && <span className="floor-reply-to-nick">[{refPost.nickname}]</span>}
                          {refPost?.is_op && <span className="floor-op-badge">OP</span>}
                          {refPost?.is_me && <span className="floor-me-badge">me</span>}
                          {refPost && <div className="floor-reply-to-content">{refPost.content}</div>}
                        </div>
                      );
                    })()}

                    <div className="floor-content">{post.content}</div>

                    <div className="floor-quote-hint">
                      {replyToFloor === post.floor_id ? 'Selected, click again to clear' : 'Click to quote'}
                    </div>
                  </div>
                  );
                })}
              </div>

              {(!entry.posts || entry.posts.length === 0) && (
                <div className="empty-state"><p>No replies yet</p></div>
              )}

              {/* reply form */}
              <div className="reply-form-wrapper">
                {loggedIn ? (
                  <>
                    {replyToFloor && (
                      <div className="reply-indicator">
                        <span>Quoting <span className="reply-indicator-id">#{entry.id + replyToFloor}</span></span>
                        <button className="reply-indicator-cancel" onClick={() => setReplyToFloor(null)}>×</button>
                      </div>
                    )}
                    {replyError && (
                      <div className="alert alert-error reply-error">{replyError}</div>
                    )}
                    <form className="reply-form" onSubmit={handleReply}>
                      <div className="reply-char-info">
                        <span className={`char-count ${replyContent.length > 200 ? 'char-over' : ''}`}>
                          {replyContent.length}/200
                        </span>
                      </div>
                      <textarea
                        value={replyContent}
                        onChange={(e) => setReplyContent(e.target.value)}
                        placeholder="Reply..."
                        rows={3}
                        maxLength={200}
                        required
                      />
                      <button type="submit" className="btn btn-primary" disabled={submitting || !replyContent.trim()}>
                        {submitting ? 'Sending...' : 'Reply'}
                      </button>
                    </form>
                  </>
                ) : (
                  <button className="btn btn-primary login-to-reply" onClick={() => setShowLogin(true)}>
                    Sign in to reply
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </main>

      {showLogin && (
        <LoginModal
          onLogin={() => { setLoggedIn(true); setShowLogin(false); }}
          onClose={() => setShowLogin(false)}
        />
      )}
    </div>
  );
}
