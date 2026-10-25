import { useState, useEffect } from 'react';
import {
  checkAuthStatus,
  requestLoginCode,
  verifyLoginCode,
  requestVerifyCode,
  checkVerified,
} from '../lib/api';
import { setToken, setUser } from '../lib/auth';
import { loadConfig } from '../lib/cfg';
import './LoginModal.css';

export default function LoginModal({ onLogin, onClose }) {
  const [siteTitle, setSiteTitle] = useState('Treehole');
  const [verifyAddr, setVerifyAddr] = useState('verify@');
  const [trustedDomains, setTrustedDomains] = useState([]);
  const [email, setEmail] = useState('');
  const [step, setStep] = useState('email');    // email | otp | verify
  const [code, setCode] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => { loadConfig().then(c => { setSiteTitle(c.site_title || 'Treehole'); setVerifyAddr(c.verify_address || 'verify@'); setTrustedDomains(c.trusted_domains || []); }); }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) { clearInterval(timer); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  async function handleEmailSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await checkAuthStatus(email.trim());
      if (result.authorized) {
        await sendLoginCode();
      } else {
        await sendVerifyCode();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function sendLoginCode() {
    setError('');
    setLoading(true);
    try {
      await requestLoginCode(email.trim());
      setStep('otp');
      setCooldown(120);
      setStatusMsg(`Code sent to ${email}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function sendVerifyCode() {
    setError('');
    setLoading(true);
    try {
      const result = await requestVerifyCode(email.trim());
      setVerifyCode(result.code || '');
      setStep('verify');
      setCooldown(120);
      setStatusMsg(result.instructions || 'Send the code to complete verification');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOtpSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await verifyLoginCode(email.trim(), code.trim());
      setToken(result.token);
      setUser({ uid: result.uid, email: result.email });
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckVerified() {
    setError('');
    setLoading(true);
    try {
      const result = await checkVerified(email.trim());
      setStatusMsg(result.message || 'Not verified yet');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleBack() {
    setStep('email');
    setCode('');
    setVerifyCode('');
    setError('');
    setStatusMsg('');
  }

  return (
    <div className="login-modal-overlay">
      <div className="login-modal">
        {onClose && <button className="login-modal-close" onClick={onClose}>×</button>}
        <h1 className="login-modal-title">{siteTitle}</h1>
        <p className="login-modal-subtitle">Sign in with email</p>

        {error && <div className="alert alert-error">{error}</div>}
        {statusMsg && step !== 'verify' && <div className="alert alert-info">{statusMsg}</div>}

        {step === 'email' && (
          <form onSubmit={handleEmailSubmit}>
            <div className="form-group">
              <label htmlFor="login-email">Email address</label>
              <input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                autoFocus
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Checking...' : 'Continue'}
            </button>
          </form>
        )}

        {step === 'otp' && (
          <form onSubmit={handleOtpSubmit}>
            <p className="step-desc">Code sent to <strong>{email}</strong></p>
            <div className="form-group">
              <label htmlFor="login-code">Sign-in code</label>
              <input
                id="login-code"
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
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Verifying...' : 'Sign in'}
            </button>
            <div className="form-actions">
              <button type="button" className="btn-link" onClick={handleBack}>Change email</button>
              <button type="button" className="btn-link" disabled={cooldown > 0} onClick={sendLoginCode}>
                {cooldown > 0 ? `Resend (${cooldown}s)` : 'Resend code'}
              </button>
            </div>
          </form>
        )}

        {step === 'verify' && (
          <div>
            <p className="step-desc">Your email <strong>{email}</strong> is not verified yet.</p>
            <div className="verify-instructions">
              <p>Follow these steps to verify:</p>
              <ol>
                <li>Put the code <code className="verify-code">{verifyCode}</code> in the email body</li>
                <li>Send it from a {trustedDomains.join(', ')} address to <strong>{verifyAddr}</strong></li>
                <li>Then click Refresh below to check the status</li>
                <li>Once verified, go back and sign in</li>
              </ol>
            </div>
            <button className="btn btn-primary" disabled={loading} onClick={handleCheckVerified}>
              {loading ? 'Checking...' : 'Refresh'}
            </button>
            <div className="form-actions">
              <button type="button" className="btn-link" onClick={handleBack}>Change email</button>
              <button type="button" className="btn-link" disabled={cooldown > 0} onClick={sendVerifyCode}>
                {cooldown > 0 ? `Resend (${cooldown}s)` : 'Get a new code'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
