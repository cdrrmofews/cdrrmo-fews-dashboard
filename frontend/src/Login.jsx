import { useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState("");
  const [loading,  setLoading]  = useState(false);

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
      // Store token and user info in sessionStorage
      sessionStorage.setItem("token", data.token);
      sessionStorage.setItem("user", JSON.stringify({
        id:         data.id,
        name:       data.username,
        email:      data.email,
        role:       data.role,
        department: data.department,
        initials:   data.username.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
        photo:      null,
        dob:        "",
      }));
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
          <div className="login-brand-icon">🌊</div>
          <div className="login-brand-name">CDRRMO</div>
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
            <input
              className="login-input"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKey}
            />
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