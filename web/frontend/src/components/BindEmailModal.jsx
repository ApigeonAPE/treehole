import { useState, useEffect } from 'react';
import { getToken } from '../lib/auth';
import './BindEmailModal.css';

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

export default function BindEmailModal({ onClose, onUpdated }) {
  const [step, setStep] = useState('email');     // email | code | success
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // merge confirmation
  const [conflictInfo, setConflictInfo] = useState(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => (c <= 1 ? 0 : c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  async function handleRequestCode(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await request('/api/user/request-bind-code', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      setStep('code');
      setCooldown(120);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await request('/api/user/bind-email', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), code: code.trim(), confirm_merge: false }),
      });

      if (result.status === 'bound' || result.status === 'merged') {
        setStep('success');
        setMsg(result.status === 'merged'
          ? 'Accounts merged and email bound'
          : 'Email bound successfully');
        if (onUpdated) onUpdated();
      } else if (result.status === 'conflict') {
        // the email is already bound to another account
        setConflictInfo(result);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirmMerge() {
    setError('');
    setLoading(true);
    try {
      await request('/api/user/bind-email', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim(),
          code: code.trim(),
          confirm_merge: true,
        }),
      });
      setStep('success');
      setConflictInfo(null);
      setMsg('Accounts merged; all posts and replies moved over');
      if (onUpdated) onUpdated();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    if (onUpdated) onUpdated();
    onClose();
  }

  return (
    <div className="modal-overlay">
      <div className="modal bind-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Bind email</h2>

        {error && <div className="alert alert-error">{error}</div>}
        {msg && !conflictInfo && <div className="alert alert-info">{msg}</div>}

        {/* merge confirmation */}
        {conflictInfo && (
          <div className="merge-confirm">
            <p className="merge-warn">⚠ Email <strong>{email}</strong> is already bound to another account.</p>
            <p>Emails bound to that account:</p>
            <ul>
              {conflictInfo.other_emails.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            <p className="merge-note">If you merge, all posts and replies from that account move here, all its emails are bound to this account, and the old account is deleted.</p>
            <div className="modal-actions">
              <button className="btn btn-cancel" onClick={() => setConflictInfo(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleConfirmMerge} disabled={loading}>
                {loading ? 'Merging...' : 'Confirm merge'}
              </button>
            </div>
          </div>
        )}

        {/* email input */}
        {!conflictInfo && step === 'email' && (
          <form onSubmit={handleRequestCode}>
            <div className="form-group">
              <label htmlFor="bind-email">Email address</label>
              <input
                id="bind-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email to bind"
                required
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-cancel" onClick={handleClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? 'Sending...' : 'Send code'}
              </button>
            </div>
          </form>
        )}

        {/* code input */}
        {!conflictInfo && step === 'code' && (
          <form onSubmit={handleVerify}>
            <p className="step-desc">Code sent to <strong>{email}</strong></p>
            <div className="form-group">
              <label htmlFor="bind-code">Verification code</label>
              <input
                id="bind-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="6-digit code"
                required
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-cancel" onClick={handleClose}>Cancel</button>
              <button type="button" className="btn-link" disabled={cooldown > 0} onClick={handleRequestCode}>
                {cooldown > 0 ? `Resend (${cooldown}s)` : 'Resend'}
              </button>
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? 'Verifying...' : 'Bind'}
              </button>
            </div>
          </form>
        )}

        {/* success */}
        {!conflictInfo && step === 'success' && (
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={handleClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}
