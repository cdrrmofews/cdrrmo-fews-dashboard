import { useState, useCallback } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

export default function Login({ onLogin }) {
  const [username,   setUsername]   = useState("");
  const [password,   setPassword]   = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error,      setError]      = useState("");
  const [loading,    setLoading]    = useState(false);
  const [showPw, setShowPw] = useState(false);

  const handlePwRevealStart = useCallback((e) => {
    e.preventDefault();
    setShowPw(true);
  }, []);

  const handlePwRevealEnd = useCallback(() => {
    setShowPw(false);
  }, []);
  
  const handleLogin = async () => {
    if (!username.trim() || !password.trim()) {
      setError("Please enter your email and password.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || "Invalid credentials.");
        return;
      }
      const userData = JSON.stringify({
        id:             data.id,
        name:           data.username,
        email:          data.email,
        role:           data.role,
        department:     data.department,
        initials:       data.username.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
        photo:          data.photo || null,
        phone:          data.phone || "",
        dob:            "",
        push_enabled:   data.notif_push_enabled   ?? true,
        audio_enabled:  data.notif_audio_enabled  ?? true,
        banner_enabled: data.notif_banner_enabled ?? true,
        ticker_enabled: data.notif_ticker_enabled ?? true,
      });
      const storage = rememberMe ? localStorage : sessionStorage;
      storage.setItem("token",      data.token);
      storage.setItem("user",       userData);
      storage.setItem("rememberMe", rememberMe ? "true" : "false");
      onLogin(data.role);
    } catch {
      setError("Could not connect to the server. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => { if (e.key === "Enter") handleLogin(); };

  return (
    <div className="login-shell">
      <div className="login-bg" />
      <div className="login-box">
        <div className="login-brand">
          <img src="/logo1.jpg" alt="CDRRMO FEWS" className="login-brand-logo" />
          <div className="login-brand-tag">Flood Early Warning System</div>
        </div>
        <div className="login-form">
          <div className="login-field">
            <label className="login-label">Email</label>
            <input
              className="login-input"
              type="text"
              placeholder="you@cdrrmo.gov.ph"
              value={username}
              onChange={e => setUsername(e.target.value)}
              onKeyDown={handleKey}
              autoFocus
            />
          </div>
          <div className="login-field">
            <label className="login-label">Password</label>
            <div className="login-pw-wrap">
              <input
                className="login-input login-pw-input"
                type={showPw ? "text" : "password"}
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={handleKey}
              />
              <button
                type="button"
                className="login-pw-eye"
                onPointerDown={handlePwRevealStart}
                onPointerUp={handlePwRevealEnd}
                onPointerLeave={handlePwRevealEnd}
                aria-label={showPw ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {showPw ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8
                            a18.45 18.45 0 0 1 5.06-5.94"/>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8
                            a18.5 18.5 0 0 1-2.16 3.19"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
              </button>
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div
              onClick={() => setRememberMe(r => !r)}
              style={{
                width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                border: `1.5px solid ${rememberMe ? "var(--blue)" : "rgba(255,255,255,0.15)"}`,
                background: rememberMe ? "var(--blue)" : "transparent",
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.15s",
              }}
            >
              {rememberMe && (
                <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                  <path d="M1 3.5L3.5 6L8 1" stroke="#000" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </div>
            <label
              onClick={() => setRememberMe(r => !r)}
              style={{ fontSize:12, color:"var(--text-3)", cursor:"pointer", userSelect:"none" }}
            >
              Remember me
            </label>
          </div>
          {error && <div className="login-error">{error}</div>}
          <button
            className={`login-btn ${loading ? "login-btn-loading" : ""}`}
            onClick={handleLogin}
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </div>
        <div className="login-footer">CDRRMO · Batangas City · v2.0</div>
      </div>
    </div>
  );
}