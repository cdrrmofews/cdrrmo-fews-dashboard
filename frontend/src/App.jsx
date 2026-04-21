import "./App.css";
import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Line } from "react-chartjs-2";
import { createPortal } from "react-dom";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import annotationPlugin from "chartjs-plugin-annotation";
import Login from "./Login";

ChartJS.register(
  CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip, Legend,
  annotationPlugin
);

try { delete L.Icon.Default.prototype._getIconUrl; } catch (e) {}
L.Icon.Default.mergeOptions({
    iconRetinaUrl: "/leaflet/marker-icon-2x.png",
    iconUrl:       "/leaflet/marker-icon.png",
    shadowUrl:     "/leaflet/marker-shadow.png",
});

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ height:"100vh", width:"100vw", background:"#080e1a", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16, fontFamily:"sans-serif" }}>
          <div style={{ fontSize:36 }}>⚠️</div>
          <div style={{ color:"#e2e8f0", fontSize:18, fontWeight:700 }}>Something went wrong</div>
          <div style={{ color:"#7e92b4", fontSize:12, maxWidth:400, textAlign:"center" }}>{this.state.error?.message || "An unexpected error occurred."}</div>
          <button onClick={() => window.location.reload()} style={{ marginTop:8, padding:"10px 24px", background:"#38bdf8", color:"#000", border:"none", borderRadius:10, fontWeight:700, fontSize:14, cursor:"pointer" }}>
            Reload Dashboard
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── STORAGE HELPERS ─────────────────────────────────────────────────────────
function getStorage() {
  return localStorage.getItem("rememberMe") === "true" ? localStorage : sessionStorage;
}
function getStoredToken() {
  return localStorage.getItem("token") || sessionStorage.getItem("token") || "";
}
function getStoredUser() {
  return localStorage.getItem("user") || sessionStorage.getItem("user") || null;
}
function clearStoredSession() {
  ["token", "user", "rememberMe"].forEach(k => {
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  });
}

// Central fetch wrapper — auto-logs out on 401 (expired JWT)
let _onUnauthorized = null;
function setUnauthorizedHandler(fn) { _onUnauthorized = fn; }
async function authFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401 && _onUnauthorized) {
    _onUnauthorized();
    throw new Error("Unauthorized");
  }
  return res;
}

// ─── RBAC HELPERS ────────────────────────────────────────────────────────────
const ROLE_ACCESS = {
  Admin:    ["Dashboard", "UnitControl", "Logs", "Settings"],
  Operator: ["Dashboard", "Logs", "Settings"],
};

function can(role, feature) {
  if (role === "Admin") return true;
  if (role === "Operator") {
    if (feature === "unitControl")  return false;
    if (feature === "manageUsers")  return false;
    if (feature === "sirenControl") return true;
    return true;
  }
  return false;
}

// ─── User normalization helper ────────────────────────────────────────────────
function normalizeUser(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return { name: "", role: "Operator", department: "", email: "", phone: "", photo: null, sms_enabled: false, initials: "?" };
  }
  const name = parsed.name || "";
  const initials =
    name.split(" ").filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase() ||
    "?";
  return {
    name,
    role:        parsed.role        || "Operator",
    department:  parsed.department  || "",
    email:       parsed.email       || "",
    phone:       parsed.phone       || "",
    photo:       parsed.photo       || null,
    sms_enabled: parsed.sms_enabled ?? false,
    initials,
  };
}

// ─── FEWS BASE DATA ───────────────────────────────────────────────────────────
const FEWS1_BASE = {
  id: 1, name: "FEWS 1", location: "Bolbok",
  lat: 13.7703472, lng: 121.0525449,
  status: "safe", waterLevel: 0,
  description: "Deployed along the upper tributary of Sta. Rita River. Monitors early upstream surge from heavy rainfall in the Mataas na Gulod watershed.",
  installedDate: "—", technician: "Engr. Andrew Van Ryan",
  isLive: true,
};

const STATUS_CONFIG = {
  safe:     { color: "#22c55e", bg: "rgba(34,197,94,0.12)",  label: "SAFE"     },
  warning:  { color: "#f59e0b", bg: "rgba(245,158,11,0.12)", label: "WARNING"  },
  danger:   { color: "#ef4444", bg: "rgba(239,68,68,0.12)",  label: "DANGER"   },
  NORMAL:   { color: "#22c55e", bg: "rgba(34,197,94,0.12)",  label: "NORMAL"   },
  ADVISORY: { color: "#38bdf8", bg: "rgba(56,189,248,0.12)", label: "ADVISORY" },
  WARNING:  { color: "#f59e0b", bg: "rgba(245,158,11,0.12)", label: "WARNING"  },
  CRITICAL: { color: "#ef4444", bg: "rgba(239,68,68,0.12)",  label: "CRITICAL" },
};

function backendStatusToKey(status) {
  if (!status) return "safe";
  switch (status.toUpperCase()) {
    case "NORMAL":   return "safe";
    case "ADVISORY": return "safe";
    case "WARNING":  return "warning";
    case "CRITICAL": return "danger";
    default:         return "safe";
  }
}

const ALL_NAV_ITEMS = [
  { key: "Dashboard",   icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>, label: "Dashboard"    },
  { key: "UnitControl", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><polyline points="12 6 12 12 16 14"/><path d="M16 2l4 4-4 4"/></svg>, label: "Unit Control" },
  { key: "Logs",        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>, label: "Logs"         },
  { key: "Settings",    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>, label: "Settings"     },
];

const PAGE_TITLES = {
  Dashboard:   { title: "Flood Monitoring Dashboard", sub: "Live overview" },
  UnitControl: { title: "Unit Control",               sub: "Manage FEWS units" },
  Logs:        { title: "Logs",                       sub: "System activity log" },
  Settings:    { title: "Settings",                   sub: "System configuration" },
};

const MONTHS     = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS_SHORT = ["Su","Mo","Tu","We","Th","Fr","Sa"];

// ─── LOG HELPERS ──────────────────────────────────────────────────────────────
function _pad(n) { return String(n).padStart(2, "0"); }

function _fmtDate(d) {
  const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${mo[d.getMonth()]} ${_pad(d.getDate())}, ${d.getFullYear()}`;
}

function _fmtTime(d) {
  let hours   = d.getHours();
  const mins  = _pad(d.getMinutes());
  const secs  = _pad(d.getSeconds());
  const ampm  = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${_pad(hours)}:${mins}:${secs} ${ampm}`;
}

function parseLog(row) {
  const raw = row.timestamp;
  const utcStr = typeof raw === "string"
    ? raw.replace(" ", "T").replace(/Z?$/, "Z")
    : raw;
  const utc = new Date(utcStr);
  const opts = { timeZone: "Asia/Manila", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" };
  const parts = new Intl.DateTimeFormat("en-PH", opts).formatToParts(utc);
  const get = (type) => parts.find(p => p.type === type)?.value ?? "00";
  const year = get("year"), month = get("month"), day = get("day");
  const hour = get("hour"), minute = get("minute"), second = get("second");
  const ph = new Date(year, parseInt(month) - 1, parseInt(day),
                      parseInt(hour), parseInt(minute), parseInt(second));
  return {
    id:      row.id,
    date:    _fmtDate(ph),
    time:    _fmtTime(ph),
    rawDate: utc,
    station: row.station,
    type:    row.type,
    msg:     row.message,
  };
}

const LOG_TYPE_CFG = {
  info:    { label: "INFO",     color: "#94a3b8", bg: "rgba(148,163,184,0.10)" },
  warning: { label: "WARNING",  color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  danger:  { label: "DANGER",   color: "#ef4444", bg: "rgba(239,68,68,0.12)"  },
  system:  { label: "ACTIVITY", color: "#38bdf8", bg: "rgba(56,189,248,0.12)" },
};

const LOG_TYPES_BY_ROLE = {
  Admin:    ["info", "warning", "danger", "system"],
  Operator: ["info", "warning", "danger"],
};

const ROWS_PER_PAGE = 30;

function ExportMenu({ token, activeFilters, exporting, setExporting, showToast }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const buildFilterSummary = () => {
    const parts = [];
    if (activeFilters.search)          parts.push(`Search: "${activeFilters.search}"`);
    if (activeFilters.station !== "All") parts.push(`Station: ${activeFilters.station}`);
    if (activeFilters.type    !== "All") parts.push(`Type: ${activeFilters.type}`);
    if (activeFilters.dateFrom)          parts.push(`From: ${activeFilters.dateFrom}`);
    if (activeFilters.dateTo)            parts.push(`To: ${activeFilters.dateTo}`);
    return parts.length ? parts.join("  ·  ") : "None";
  };

  const handleExport = async (format) => {
    setOpen(false);
    setExporting(format);
    try {
      const params = new URLSearchParams();
      if (activeFilters.search)            params.set("search",    activeFilters.search);
      if (activeFilters.station !== "All") params.set("station",   activeFilters.station);
      if (activeFilters.type    !== "All") params.set("type",      activeFilters.type);
      if (activeFilters.dateFrom)          params.set("date_from", activeFilters.dateFrom);
      if (activeFilters.dateTo)            params.set("date_to",   activeFilters.dateTo);

      const res  = await authFetch(`${API_BASE}/logs/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!Array.isArray(data)) return;
      const rows = data.map(parseLog);
      const summary = buildFilterSummary();
      if (format === "xlsx") exportToXLSX(rows, summary, showToast);
      else                   exportToPDF(rows, summary, showToast);
    } catch (e) {
      console.error("Export failed", e);
    } finally {
      setTimeout(() => setExporting(null), 1200);
    }
  };

  return (
    <div className="export-menu-wrap" ref={ref} style={{ alignSelf: "flex-end" }}>
      <button className="export-menu-trigger" onClick={() => setOpen(o => !o)} disabled={!!exporting}>
        {exporting ? <span style={{ fontFamily: "var(--mono)", fontSize: 10 }}>⏳</span> : (
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
            <path d="M7.5 1v9M4 7l3.5 3.5L11 7M2 13h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </button>
      {open && (
        <div className="export-menu-dropdown">
          {[{ fmt:"xlsx", icon:"📊", label:"Excel (.xlsx)", color:"#22c55e" }, { fmt:"pdf", icon:"📄", label:"PDF (.pdf)", color:"#ef4444" }]
            .map(({ fmt, icon, label, color }) => (
              <button key={fmt} className="export-menu-item" onClick={() => handleExport(fmt)}>
                <span className="export-menu-item-icon" style={{ color }}>{icon}</span>
                <span className="export-menu-item-label">{label}</span>
              </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LogsPage({ token, userRole, showToast }) {
  const allowedTypes = LOG_TYPES_BY_ROLE[userRole] || LOG_TYPES_BY_ROLE["Operator"];

  const [rows,       setRows]       = useState([]);
  const [counts,     setCounts]     = useState({ info:0, warning:0, danger:0, system:0, total:0 });
  const [loading,    setLoading]    = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [page,       setPage]       = useState(1);
  const [exporting,  setExporting]  = useState(null);

  const [search,          setSearch]          = useState("");
  const [filterStation,   setFilterStation]   = useState("All");
  const [filterType,      setFilterType]      = useState("All");
  const [filterDateRange, setFilterDateRange] = useState({ from: "", to: "" });
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search 400ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 1 whenever filters change
  useEffect(() => { setPage(1); }, [debouncedSearch, filterStation, filterType, filterDateRange]);

  const fetchLogs = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({
        limit:  ROWS_PER_PAGE,
        offset: (page - 1) * ROWS_PER_PAGE,
      });
      if (debouncedSearch)            params.set("search",    debouncedSearch);
      if (filterStation !== "All")    params.set("station",   filterStation);
      if (filterType    !== "All")    params.set("type",      filterType);
      if (filterDateRange.from)       params.set("date_from", filterDateRange.from);
      if (filterDateRange.to)         params.set("date_to",   filterDateRange.to);

      const res  = await authFetch(`${API_BASE}/logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data?.rows) {
        // Filter rows to only allowed types for this role
        const parsed = data.rows
          .map(parseLog)
          .filter(l => allowedTypes.includes(l.type));
        setRows(parsed);
        // Filter counts to only allowed types
        const filteredCounts = { ...data.counts };
        let total = 0;
        allowedTypes.forEach(t => { total += filteredCounts[t] || 0; });
        filteredCounts.total = total;
        setCounts(filteredCounts);
        setFetchError(false);
      }
    } catch (e) {
      if (e?.message !== "Unauthorized") setFetchError(true);
    } finally {
      setLoading(false);
    }
  }, [token, page, debouncedSearch, filterStation, filterType, filterDateRange, userRole]);

  // Initial + filter/page change fetch
  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  // Auto-refresh every 30s (silent — no loading spinner)
  useEffect(() => {
    const id = setInterval(() => fetchLogs(true), 30000);
    return () => clearInterval(id);
  }, [fetchLogs]);

  const totalPages = Math.max(1, Math.ceil(counts.total / ROWS_PER_PAGE));
  const safePage   = Math.min(page, totalPages);

  const stationOptions = [
    { value: "All",    label: "All Stations" },
    { value: "System", label: "System"       },
    { value: "FEWS 1", label: "Fews 1"       },
  ];

  const typeOptions = [
    { value: "All", label: "All Types" },
    ...allowedTypes.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) })),
  ];

  const hasFilters = debouncedSearch || filterStation !== "All" || filterType !== "All" || filterDateRange.from || filterDateRange.to;

  const activeFilters = {
    search:    debouncedSearch,
    station:   filterStation,
    type:      filterType,
    dateFrom:  filterDateRange.from,
    dateTo:    filterDateRange.to,
  };

  return (
    <div className="page-body logs-page-body">
      <div className="page-card" style={{ gap: 12 }}>
        <div className="logs-filters-row">
          <div className="logs-search-wrap">
            <span className="logs-search-icon">🔍</span>
            <input
              className="logs-search-input"
              placeholder="Search logs…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className="logs-search-clear" onClick={() => setSearch("")}>✕</button>
            )}
          </div>
          <FilterDropdown label="All Stations" options={stationOptions} value={filterStation} onChange={v => setFilterStation(v)} />
          <FilterDropdown label="All Types"    options={typeOptions}    value={filterType}    onChange={v => setFilterType(v)}    />
          <DateRangeFilter
            from={filterDateRange.from}
            to={filterDateRange.to}
            onChange={v => setFilterDateRange(v)}
          />
          {hasFilters && (
            <button className="logs-reset-icon-btn" onClick={() => {
              setSearch("");
              setFilterStation("All");
              setFilterType("All");
              setFilterDateRange({ from: "", to: "" });
            }} title="Reset">↺</button>
          )}
          <ExportMenu
            token={token}
            activeFilters={activeFilters}
            exporting={exporting}
            setExporting={setExporting}
            showToast={showToast}
          />
        </div>
        <div className="logs-stat-bar">
          {allowedTypes.map(t => {
            const cfg = LOG_TYPE_CFG[t];
            return (
              <div key={t} className="logs-stat-item">
                <span className="logs-stat-count" style={{ color: cfg.color }}>{counts[t] ?? 0}</span>
                <span className="logs-stat-label">{cfg.label}</span>
              </div>
            );
          })}
          <div className="logs-stat-divider" />
          <div className="logs-stat-item logs-stat-total">
            <span className="logs-stat-count">{counts.total}</span>
            <span className="logs-stat-label">TOTAL</span>
          </div>
        </div>
      </div>

      <div className="page-card logs-table-card" style={{ gap:0, padding:0, overflow:"hidden", flex:1, minHeight:0 }}>
        <div className="logs-table-head">
          <span className="logs-col-date">Date &amp; Time</span>
          <span className="logs-col-station">Station</span>
          <span className="logs-col-type">Type</span>
          <span className="logs-col-msg">Message</span>
        </div>
        <div className="logs-table-body">
          {loading ? (
            <div className="logs-empty">
              <div style={{ fontSize:24, marginBottom:8 }}>⏳</div>
              <div style={{ color:"var(--text-2)", fontWeight:600 }}>Loading logs…</div>
            </div>
          ) : fetchError ? (
            <div className="logs-empty">
              <div style={{ fontSize:28, marginBottom:8 }}>⚠️</div>
              <div style={{ color:"var(--red)", fontWeight:600 }}>Failed to load logs</div>
              <div style={{ color:"var(--text-3)", fontSize:11, marginTop:4 }}>Check your connection and try refreshing</div>
            </div>
          ) : rows.length === 0 ? (
            <div className="logs-empty">
              <div style={{ fontSize:28, marginBottom:8 }}>🔍</div>
              <div style={{ color:"var(--text-2)", fontWeight:600 }}>No logs match your filters</div>
            </div>
          ) : rows.map((l, i) => {
            const cfg = LOG_TYPE_CFG[l.type] || LOG_TYPE_CFG["system"];
            return (
              <div key={l.id} className={`logs-row ${i % 2 === 1 ? "logs-row-alt" : ""}`}>
                <span className="logs-col-date">
                  <span className="logs-date-day">{l.date}</span>
                  <span className="logs-date-time">{l.time}</span>
                </span>
                <span className="logs-col-station">
                  <span className="logs-station-tag">{l.station.toUpperCase()}</span>
                </span>
                <span className="logs-col-type">
                  <span className="logs-type-badge" style={{ color:cfg.color, background:cfg.bg, border:`1px solid ${cfg.color}30` }}>
                    {cfg.label}
                  </span>
                </span>
                <span className="logs-col-msg" style={{ color: l.type==="danger"?"var(--red)":l.type==="warning"?"var(--amber)":"var(--text-2)" }}>
                  {l.msg}
                </span>
              </div>
            );
          })}
        </div>
        <div className="logs-pagination">
          <span className="logs-page-info">
            Showing {counts.total === 0 ? 0 : (safePage - 1) * ROWS_PER_PAGE + 1}–{Math.min(safePage * ROWS_PER_PAGE, counts.total)} of {counts.total} entries
          </span>
          <div className="logs-page-btns">
            <button className="logs-page-btn" disabled={safePage === 1}          onClick={() => setPage(1)}>«</button>
            <button className="logs-page-btn" disabled={safePage === 1}          onClick={() => setPage(p => p - 1)}>‹</button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || Math.abs(p - safePage) <= 1)
              .reduce((acc, p, i, arr) => {
                if (i > 0 && p - arr[i - 1] > 1) acc.push("…");
                acc.push(p);
                return acc;
              }, [])
              .map((p, i) => p === "…"
                ? <span key={"el" + i} className="logs-page-ellipsis">…</span>
                : <button key={p} className={`logs-page-btn ${p === safePage ? "logs-page-active" : ""}`} onClick={() => setPage(p)}>{p}</button>
              )}
            <button className="logs-page-btn" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)}>›</button>
            <button className="logs-page-btn" disabled={safePage === totalPages} onClick={() => setPage(totalPages)}>»</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── EXPORT HELPERS ───────────────────────────────────────────────────────────
function exportToXLSX(rows, filterSummary = "", showToast = () => {}) {
  const header = ["Date", "Time", "Station", "Type", "Message"];
  const meta   = [
    ["CDRRMO – FEWS Incident Log Report"],
    [`Generated: ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}`],
    [`Filters: ${filterSummary || "None"}`],
    [`Total Records: ${rows.length}`],
    [],
  ];
  const data = [...meta, header, ...rows.map(r => [r.date, r.time, r.station, r.type.toUpperCase(), r.msg])];
  const doIt = () => {
    const wb = window.XLSX.utils.book_new();
    const ws = window.XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = [{ wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 9 }, { wch: 80 }];
    window.XLSX.utils.book_append_sheet(wb, ws, "FEWS Logs");
    window.XLSX.writeFile(wb, `FEWS_Logs_${Date.now()}.xlsx`);
  };
  if (window.XLSX) { doIt(); return; }
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  s.onload = doIt;
  s.onerror = () => showToast("Excel export failed — could not load required library. Check your internet connection.");
  document.head.appendChild(s);
}

function exportToPDF(rows, filterSummary = "", showToast = () => {}) {
  const load = (src) => new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  const doIt = () => {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();

    // --- Header background ---
    doc.setFillColor(8, 14, 26);
    doc.rect(0, 0, pageW, 80, "F");

    // --- Load and draw CDRRMO seal ---
    const sealImg = new Image();
    sealImg.src = "/cdrrmo-seal.png";
    sealImg.onload = () => {
      doc.addImage(sealImg, "PNG", 20, 8, 56, 56);

      const batImg = new Image();
      batImg.src = "/batscity-seal.png";
      batImg.onload = () => {
        doc.addImage(batImg, "PNG", 84, 10, 52, 52);

        // --- Title block ---
        doc.setFontSize(16);
        doc.setTextColor(226, 232, 240);
        doc.setFont("helvetica", "bold");
        doc.text("CDRRMO – FEWS Incident Log Report", 150, 32);

        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(126, 146, 180);
        doc.text("City Disaster Risk Reduction and Management Office · Batangas City", 150, 46);

        doc.setFontSize(8);
        doc.setTextColor(100, 116, 139);
        doc.text(`Filters: ${filterSummary || "None"}`, 150, 59);
        doc.text(`Generated: ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}  ·  ${rows.length} records`, 150, 70);

        // --- Table ---
        doc.autoTable({
          startY: 92,
          head: [["Date", "Time", "Station", "Type", "Message"]],
          body: rows.map(r => [r.date, r.time, r.station, r.type.toUpperCase(), r.msg]),
          styles: { fontSize: 8, cellPadding: 5 },
          headStyles: { fillColor: [17, 29, 53], textColor: [226, 232, 240], fontStyle: "bold" },
          alternateRowStyles: { fillColor: [245, 248, 252] },
          columnStyles: {
            0: { cellWidth: 80 }, 1: { cellWidth: 65 },
            2: { cellWidth: 55 }, 3: { cellWidth: 55 }, 4: { cellWidth: "auto" },
          },
          theme: "grid",
          didDrawPage: (hookData) => {
            // Footer on every page
            const pg    = hookData.pageNumber;
            const total = doc.internal.getNumberOfPages();
            doc.setFontSize(7);
            doc.setTextColor(148, 163, 184);
            doc.text(
              `CDRRMO FEWS · Batangas City · Page ${pg} of ${total}`,
              pageW / 2, doc.internal.pageSize.getHeight() - 10,
              { align: "center" }
            );
          },
        });

        doc.save(`FEWS_Logs_${Date.now()}.pdf`);
      };
      batImg.onerror = () => {
        // Continue without batscity seal
        finalizePDF(doc, rows, filterSummary, pageW, 150);
      };
    };
    sealImg.onerror = () => {
      // Continue without any seal
      doc.setFontSize(16);
      doc.setTextColor(226, 232, 240);
      doc.setFont("helvetica", "bold");
      doc.text("CDRRMO – FEWS Incident Log Report", 40, 32);
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(126, 146, 180);
      doc.text("City Disaster Risk Reduction and Management Office · Batangas City", 40, 46);
      doc.setFontSize(8);
      doc.setTextColor(100, 116, 139);
      doc.text(`Filters: ${filterSummary || "None"}`, 40, 59);
      doc.text(`Generated: ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}  ·  ${rows.length} records`, 40, 70);
      doc.autoTable({
        startY: 92,
        head: [["Date", "Time", "Station", "Type", "Message"]],
        body: rows.map(r => [r.date, r.time, r.station, r.type.toUpperCase(), r.msg]),
        styles: { fontSize: 8, cellPadding: 5 },
        headStyles: { fillColor: [17, 29, 53], textColor: [226, 232, 240], fontStyle: "bold" },
        alternateRowStyles: { fillColor: [245, 248, 252] },
        columnStyles: {
          0: { cellWidth: 80 }, 1: { cellWidth: 65 },
          2: { cellWidth: 55 }, 3: { cellWidth: 55 }, 4: { cellWidth: "auto" },
        },
        theme: "grid",
        didDrawPage: (hookData) => {
          const pg    = hookData.pageNumber;
          const total = doc.internal.getNumberOfPages();
          doc.setFontSize(7);
          doc.setTextColor(148, 163, 184);
          doc.text(
            `CDRRMO FEWS · Batangas City · Page ${pg} of ${total}`,
            pageW / 2, doc.internal.pageSize.getHeight() - 10,
            { align: "center" }
          );
        },
      });
      doc.save(`FEWS_Logs_${Date.now()}.pdf`);
    };
  };
  if (window.jspdf?.jsPDF) { doIt(); return; }
  load("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js")
    .then(() => load("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js"))
    .then(doIt)
    .catch(() => showToast("PDF export failed — could not load required library. Check your internet connection."));
}

// ─── CUSTOM DATE PICKER ───────────────────────────────────────────────────────
function CustomDatePicker({ value, onChange }) {
  const [open, setOpen]           = useState(false);
  const [view, setView]           = useState("day");
  const [viewYear, setViewYear]   = useState(() => {
    if (value) { const d = new Date(value + "T00:00:00"); return d.getFullYear(); }
    return new Date().getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    if (value) { const d = new Date(value + "T00:00:00"); return d.getMonth(); }
    return new Date().getMonth();
  });
  const [yearPage, setYearPage]   = useState(() => {
    const y = value ? new Date(value + "T00:00:00").getFullYear() : new Date().getFullYear();
    return Math.floor(y / 16) * 16;
  });
  const ref = useRef();

  const selected = value ? (() => {
    const d = new Date(value + "T00:00:00");
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
  })() : null;

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setView("day"); } };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const getDaysInMonth     = (y, m) => new Date(y, m + 1, 0).getDate();
  const getFirstDayOfMonth = (y, m) => new Date(y, m, 1).getDay();

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  };

  const selectDay = (day) => {
    const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    onChange(iso); setOpen(false); setView("day");
  };
  const selectMonth = (m) => { setViewMonth(m); setView("day"); };
  const selectYear  = (y) => { setViewYear(y); setView("month"); };

  const goToday = () => {
    const t = new Date();
    setViewYear(t.getFullYear()); setViewMonth(t.getMonth());
    const iso = `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}-${String(t.getDate()).padStart(2,"0")}`;
    onChange(iso); setOpen(false); setView("day");
  };

  const displayValue = value ? (() => {
    const d = new Date(value + "T00:00:00");
    return `${MONTHS[d.getMonth()].slice(0,3)} ${d.getDate()}, ${d.getFullYear()}`;
  })() : null;

  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay    = getFirstDayOfMonth(viewYear, viewMonth);
  const cells       = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const isSelected = (day) =>
    selected && selected.year === viewYear && selected.month === viewMonth && selected.day === day;
  const today    = new Date();
  const isToday  = (day) =>
    today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === day;
  const years = Array.from({ length: 16 }, (_, i) => yearPage + i);

  return (
    <div className="cdp-wrap" ref={ref}>
      <button className="cdp-trigger" onClick={() => { setOpen(o => !o); setView("day"); }} type="button">
        <span className="cdp-icon">📅</span>
        <span className={displayValue ? "cdp-val" : "cdp-placeholder"}>
          {displayValue || "Select date of birth"}
        </span>
        <span className="cdp-arrow">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="cdp-calendar">
          {view === "day" && (
            <>
              <div className="cdp-header">
                <button className="cdp-nav" onClick={prevMonth} type="button">‹</button>
                <button className="cdp-month-year-btn" onClick={() => setView("month")} type="button">
                  <span className="cdp-month">{MONTHS[viewMonth]}</span>
                  <span className="cdp-year">{viewYear}</span>
                  <span className="cdp-picker-arrow">▾</span>
                </button>
                <button className="cdp-nav" onClick={nextMonth} type="button">›</button>
              </div>
              <div className="cdp-days-header">
                {DAYS_SHORT.map(d => <span key={d} className="cdp-day-label">{d}</span>)}
              </div>
              <div className="cdp-grid">
                {cells.map((day, i) => (
                  <button key={i} type="button"
                    className={["cdp-cell", !day ? "cdp-empty" : "", isSelected(day) ? "cdp-selected" : "", isToday(day) && !isSelected(day) ? "cdp-today" : ""].join(" ")}
                    onClick={() => day && selectDay(day)} disabled={!day}>
                    {day || ""}
                  </button>
                ))}
              </div>
              <div className="cdp-footer">
                <button className="cdp-clear" type="button" onClick={() => { onChange(""); setOpen(false); }}>Clear</button>
                <button className="cdp-today-btn" type="button" onClick={goToday}>Today</button>
              </div>
            </>
          )}
          {view === "month" && (
            <>
              <div className="cdp-header">
                <button className="cdp-nav" onClick={() => setViewYear(y => y - 1)} type="button">‹</button>
                <button className="cdp-month-year-btn" onClick={() => { setYearPage(Math.floor(viewYear / 16) * 16); setView("year"); }} type="button">
                  <span className="cdp-year" style={{ fontSize: 13, color: "var(--text-1)" }}>{viewYear}</span>
                  <span className="cdp-picker-arrow">▾</span>
                </button>
                <button className="cdp-nav" onClick={() => setViewYear(y => y + 1)} type="button">›</button>
              </div>
              <div className="cdp-month-grid">
                {MONTHS.map((m, i) => (
                  <button key={m} type="button"
                    className={["cdp-month-cell", selected && selected.year === viewYear && selected.month === i ? "cdp-selected" : "", today.getFullYear() === viewYear && today.getMonth() === i ? "cdp-today" : ""].join(" ")}
                    onClick={() => selectMonth(i)}>
                    {m.slice(0, 3)}
                  </button>
                ))}
              </div>
              <div className="cdp-footer">
                <button className="cdp-clear" type="button" onClick={() => setView("day")}>← Back</button>
              </div>
            </>
          )}
          {view === "year" && (
            <>
              <div className="cdp-header">
                <button className="cdp-nav" onClick={() => setYearPage(p => p - 16)} type="button">‹</button>
                <div className="cdp-month-year" style={{ pointerEvents: "none" }}>
                  <span className="cdp-year" style={{ fontSize: 12, color: "var(--text-2)" }}>{yearPage} — {yearPage + 15}</span>
                </div>
                <button className="cdp-nav" onClick={() => setYearPage(p => p + 16)} type="button">›</button>
              </div>
              <div className="cdp-year-grid">
                {years.map(y => (
                  <button key={y} type="button"
                    className={["cdp-year-cell", selected && selected.year === y ? "cdp-selected" : "", today.getFullYear() === y ? "cdp-today" : ""].join(" ")}
                    onClick={() => selectYear(y)}>
                    {y}
                  </button>
                ))}
              </div>
              <div className="cdp-footer">
                <button className="cdp-clear" type="button" onClick={() => setView("month")}>← Back</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MAP HELPERS ──────────────────────────────────────────────────────────────
function FlyToStation({ fews }) {
  const map    = useMap();
  const fewsId = fews?.id ?? null;
  useEffect(() => {
    if (!fews) return;
    map.setView([fews.lat, fews.lng], 16, { animate: true, duration: 0.6 });
  }, [fewsId]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function OpenPopup({ fews, markerRefs }) {
  const fewsId = fews?.id ?? null;
  useEffect(() => {
    if (!fewsId) return;
    const t = setTimeout(() => {
      const markerRef = markerRefs.current[fewsId];
      if (markerRef) markerRef.openPopup();
    }, 700);
    return () => clearTimeout(t);
  }, [fewsId]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// ─── MODALS ───────────────────────────────────────────────────────────────────
function ConfirmModal({ icon, iconColor, title, message, confirmLabel, confirmColor, onConfirm, onCancel, noSaved }) {
  const [saving, setSaving] = useState(false);
  const handle = async () => {
    setSaving(true);
    await new Promise(r => setTimeout(r, 700));
    onConfirm();
  };
  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {icon && <div className="modal-icon" style={{ color: iconColor, marginBottom: 0 }}>{icon}</div>}
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-msg">{message}</div>
        <div className="modal-actions">
          <button className="modal-btn modal-cancel" onClick={onCancel} disabled={saving}>Cancel</button>
          <button className="modal-btn" style={{ background: confirmColor || "var(--blue)", color: "#fff", minWidth: 90 }}
            onClick={handle} disabled={saving}>
            {saving
              ? <span className="btn-spinner" style={{ borderTopColor: "#fff", borderColor: "rgba(255,255,255,0.25)" }} />
              : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangeEmailModal({ onClose, token, user, onEmailChanged, addLog }) {
  const [email, setEmail]     = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError]     = useState("");
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const closeTimerRef         = useRef(null);

  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);

  const handle = async () => {
    if (!email.trim())        { setError("New email is required."); return; }
    if (email !== confirm)    { setError("Emails do not match."); return; }
    if (email === user.email) { setError("New email must be different from current."); return; }
    setSaving(true); setError("");
    try {
      const res  = await authFetch(`${API_BASE}/users/me/email`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.detail || "Failed to update email."); setSaving(false); return; }
      addLog({ station: "System", type: "system",
        message: `${user.name} changed their email address` });
      onEmailChanged(email);
      setSaved(true);
      closeTimerRef.current = setTimeout(() => onClose(), 1200);
    } catch (err) {
      if (err?.message === "Unauthorized") return;
      setError("Network error. Try again.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ alignItems: "stretch", gap: 14 }}>
        <div className="modal-title" style={{ textAlign: "left" }}>Change Email</div>
        <div className="modal-msg" style={{ textAlign: "left", marginBottom: 0 }}>
          Current: <span style={{ color: "var(--blue)", fontSize: 12 }}>{user.email}</span>
        </div>
        <div className="settings-field">
          <label className="settings-label">New Email</label>
          <input className="settings-input" type="email" placeholder="you@cdrrmo.gov.ph"
            value={email} onChange={e => { setEmail(e.target.value); setError(""); }} autoFocus />
        </div>
        <div className="settings-field">
          <label className="settings-label">Confirm New Email</label>
          <input className="settings-input" type="email" placeholder="you@cdrrmo.gov.ph"
            value={confirm} onChange={e => { setConfirm(e.target.value); setError(""); }} />
        </div>
        {error && <div className="settings-error">{error}</div>}
        <div className="modal-actions" style={{ marginTop: 4 }}>
          <button className="modal-btn modal-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="modal-btn modal-confirm" onClick={handle} disabled={saving || saved}>
            {saved ? "Saved" : saving ? <span className="btn-spinner" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangePasswordModal({ onClose, token, user, addLog }) {
  const [pw, setPw]         = useState({ current: "", next: "", confirm: "" });
  const [error, setError]   = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const closeTimerRef       = useRef(null);

  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);

  const handle = async () => {
    if (!pw.current)             { setError("Current password is required."); return; }
    if (!pw.next)                { setError("New password is required."); return; }
    if (pw.next.length < 6)      { setError("New password must be at least 6 characters."); return; }
    if (pw.next !== pw.confirm)  { setError("New passwords do not match."); return; }
    if (pw.next === pw.current)  { setError("New password must be different from current."); return; }
    setSaving(true); setError("");
    try {
      const res  = await authFetch(`${API_BASE}/users/me/password`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ current_password: pw.current, new_password: pw.next }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.detail || "Failed to update password."); setSaving(false); return; }
      addLog({ station: "System", type: "system",
        message: `${user.name} changed their password` });
      setSaved(true);
      closeTimerRef.current = setTimeout(() => onClose(), 1200);
    } catch (err) {
      if (err?.message === "Unauthorized") return;
      setError("Network error. Try again.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ alignItems: "stretch", gap: 14 }}>
        <div className="modal-title" style={{ textAlign: "left" }}>Change Password</div>
        <div className="modal-msg" style={{ textAlign: "left", marginBottom: 0 }}>Update your login credentials.</div>
        <div className="settings-field">
          <label className="settings-label">Current Password</label>
          <input className="settings-input" type="password" placeholder="••••••••"
            value={pw.current} onChange={e => { setPw(p => ({...p, current: e.target.value})); setError(""); }} autoFocus />
        </div>
        <div className="settings-field">
          <label className="settings-label">New Password</label>
          <input className="settings-input" type="password" placeholder="••••••••"
            value={pw.next} onChange={e => { setPw(p => ({...p, next: e.target.value})); setError(""); }} />
        </div>
        <div className="settings-field">
          <label className="settings-label">Confirm New Password</label>
          <input className="settings-input" type="password" placeholder="••••••••"
            value={pw.confirm} onChange={e => { setPw(p => ({...p, confirm: e.target.value})); setError(""); }} />
        </div>
        {error && <div className="settings-error">{error}</div>}
        <div className="modal-actions" style={{ marginTop: 4 }}>
          <button className="modal-btn modal-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="modal-btn modal-confirm" onClick={handle} disabled={saving || saved}>
            {saved ? "Updated" : saving ? <span className="btn-spinner" /> : "Update"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangePhoneModal({ onClose, token, user, onPhoneChanged, addLog }) {
  const [phone, setPhone]           = useState("");
  const [phoneConfirm, setConfirm]  = useState("");
  const [error, setError]           = useState("");
  const [saving, setSaving]         = useState(false);
  const [saved, setSaved]           = useState(false);
  const closeTimerRef               = useRef(null);

  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);

  const handle = async () => {
    const cleaned = phone.trim().replace(/\s+/g, "");
    const cleanedC = phoneConfirm.trim().replace(/\s+/g, "");
    if (!cleaned)  { setError("New phone number is required."); return; }
    if (!/^\+?\d{10,15}$/.test(cleaned)) { setError("Enter a valid phone number (e.g. +639XXXXXXXXX)."); return; }
    if (!cleanedC) { setError("Please confirm your phone number."); return; }
    if (cleaned !== cleanedC) { setError("Phone numbers do not match."); return; }
    setSaving(true); setError("");
    try {
      const res  = await authFetch(`${API_BASE}/users/me/phone`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ phone: cleaned }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.detail || "Failed to update phone number."); setSaving(false); return; }
      addLog({ station: "System", type: "system", message: `${user.name} updated their phone number` });
      onPhoneChanged(cleaned);
      setSaved(true);
      closeTimerRef.current = setTimeout(() => onClose(), 1200);
    } catch (err) {
      if (err?.message === "Unauthorized") return;
      setError("Network error. Try again.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ alignItems: "stretch", gap: 14 }}>
        <div className="modal-title" style={{ textAlign: "left" }}>Change Phone Number</div>
        <div className="modal-msg" style={{ textAlign: "left", marginBottom: 0 }}>
          {user.phone
            ? <>Current: <span style={{ color: "var(--blue)", fontSize: 12 }}>{user.phone}</span></>
            : "No phone number registered yet."}
        </div>
        <div className="settings-field">
          <label className="settings-label">New Phone Number</label>
          <input className="settings-input" type="tel" placeholder="+639XXXXXXXXX"
            value={phone} onChange={e => { setPhone(e.target.value); setError(""); }} autoFocus />
        </div>
        <div className="settings-field">
          <label className="settings-label">Confirm Phone Number</label>
          <input className="settings-input" type="tel" placeholder="+639XXXXXXXXX"
            value={phoneConfirm} onChange={e => { setConfirm(e.target.value); setError(""); }} />
        </div>
        {error && <div className="settings-error">{error}</div>}
        <div className="modal-actions" style={{ marginTop: 4 }}>
          <button className="modal-btn modal-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="modal-btn modal-confirm" onClick={handle} disabled={saving || saved}>
            {saved ? "Saved" : saving ? <span className="btn-spinner" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ADD USER MODAL ───────────────────────────────────────────────────────────
const EMPTY_ADD_FORM = { name: "", email: "", password: "", role: "Operator", department: "C3", phone: "" };

function AddUserModal({ onAdd, onClose, token, addLog }) {
  const [form, setForm]     = useState(EMPTY_ADD_FORM);
  const [error, setError]   = useState("");
  const [saving, setSaving] = useState(false);

  const set = (key, val) => { setForm(f => ({ ...f, [key]: val })); setError(""); };

  const handle = async () => {
    if (!form.name.trim())        { setError("Full name is required."); return; }
    if (!form.email.trim())       { setError("Email is required."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) { setError("Enter a valid email address."); return; }
    if (!form.password.trim())    { setError("Password is required."); return; }
    if (form.password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (!form.phone.trim())       { setError("Phone number is required."); return; }
    if (!/^\+?\d{10,15}$/.test(form.phone.trim().replace(/\s+/g,""))) { setError("Enter a valid phone number (e.g. +639XXXXXXXXX)."); return; }
    setSaving(true);
    try {
      const res = await authFetch(`${API_BASE}/users`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body:    JSON.stringify({ name: form.name, email: form.email, password: form.password, role: form.role, department: form.department, phone: form.phone.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.detail || "Failed to create user."); setSaving(false); return; }
      onAdd(data);
      addLog({
        station: "System", type: "system",
        message: `New user ${form.name} (${form.role}, ${form.department}) has been added to the system`,
      });
      onClose();
    } catch (err) {
      if (err?.message === "Unauthorized") return;
      setError("Network error. Try again.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-box aum-box" style={{ alignItems: "stretch", gap: 16, maxWidth: 420 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="modal-icon" style={{ color: "var(--blue)", marginBottom: 0, fontSize: 22 }}>👤</div>
          <div className="modal-title">Add New User</div>
        </div>
        <div className="modal-msg" style={{ textAlign: "left", marginBottom: 0, marginTop: -8 }}>
          Create a new account for a CDRRMO team member.
        </div>
        <div style={{ height: 1, background: "var(--border)" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="settings-field">
            <label className="settings-label">Full Name</label>
            <input className="settings-input" placeholder="e.g. Juan dela Cruz"
              autoComplete="off" autoFocus
              value={form.name} onChange={e => set("name", e.target.value)} />
          </div>
          <div className="settings-field">
            <label className="settings-label">Email</label>
            <input className="settings-input" type="email" placeholder="e.g. juan@cdrrmo.gov.ph"
              autoComplete="off"
              value={form.email} onChange={e => set("email", e.target.value)} />
          </div>
          <div className="settings-field">
            <label className="settings-label">Phone Number</label>
            <input className="settings-input" type="tel" placeholder="+639XXXXXXXXX"
              autoComplete="off"
              value={form.phone} onChange={e => set("phone", e.target.value)} />
          </div>
          <div className="settings-field">
            <label className="settings-label">Password</label>
            <input className="settings-input" type="password" placeholder="Min. 6 characters"
              autoComplete="new-password"
              value={form.password} onChange={e => set("password", e.target.value)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div className="settings-field">
              <label className="settings-label">Role</label>
              <MuDropdown
                value={form.role}
                options={["Admin", "Operator"]}
                onChange={val => set("role", val)}
              />
            </div>
            <div className="settings-field">
              <label className="settings-label">Department</label>
              <MuDropdown
                value={form.department}
                options={["C3", "MIAD", "OPS", "ITSD"]}
                onChange={val => set("department", val)}
              />
            </div>
          </div>
        </div>
        {error && <div className="settings-error">{error}</div>}
        <div className="modal-actions" style={{ marginTop: 4 }}>
          <button className="modal-btn modal-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="modal-btn" style={{ background: "var(--blue)", color: "#000", opacity: saving ? 0.7 : 1 }}
            onClick={handle} disabled={saving}>
            {saving ? "Adding…" : "Add User"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── PROFILE DROPDOWN ─────────────────────────────────────────────────────────
function ProfileDropdown({ user, token, onSave, onClose, addLog }) {
  const ref                   = useRef();
  const fileRef               = useRef();
  const [editing, setEditing] = useState(false);
  const [name, setName]       = useState(user.name);
  const [photo, setPhoto]     = useState(user.photo || null);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState("");

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handlePhoto = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setPhoto(ev.target.result);
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    if (!name.trim()) { setError("Name cannot be empty."); return; }
    setSaving(true);
    setError("");
    try {
      const res = await authFetch(`${API_BASE}/users/me`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ name, photo }),
      });
      if (!res.ok) throw new Error("Failed to save");
      const updated = await res.json();
      const normalized = normalizeUser({ ...user, name: updated.name, photo: updated.photo });
      onSave(normalized);
      addLog({
        station: "System",
        type: "system",
        message: `${updated.name} updated their profile`,
      });
      onClose();
    } catch (err) {
      if (err?.message === "Unauthorized") return;
      setError("Failed to save. Try again.");
      setSaving(false);
    }
  };

  return (
    <div className="profile-dropdown" ref={ref}>
      {!editing ? (
        <>
          <div className="pd-header-view">
            <div className="pd-avatar-lg">
              {user.photo
                ? <img src={user.photo} alt="profile" style={{ width:"100%", height:"100%", borderRadius:"50%", objectFit:"cover" }} />
                : <span>{user.initials}</span>
              }
            </div>
            <div className="pd-view-info">
              <div className="pd-view-name">{user.name}</div>
              <div className="pd-view-role">{user.role}</div>
              <div className="pd-view-dept">{user.department}</div>
            </div>
          </div>
          <div className="pd-divider" />
          <button className="pd-btn" onClick={() => setEditing(true)}>✎  Edit Profile</button>
          <button className="pd-btn pd-logout-mobile" onClick={() => { if(typeof window.__onMobileLogout === 'function') window.__onMobileLogout(); }}>Logout</button>
        </>
      ) : (
        <>
          <div className="pd-edit-photo-wrap">
            <div className="pd-edit-avatar" onClick={() => fileRef.current.click()}>
              {photo
                ? <img src={photo} alt="profile" style={{ width:"100%", height:"100%", borderRadius:"50%", objectFit:"cover" }} />
                : <span style={{ fontSize: 26 }}>{user.initials}</span>
              }
              <div className="pd-photo-overlay">Change</div>
            </div>
            <input ref={fileRef} type="file" accept="image/*" style={{ display:"none" }} onChange={handlePhoto} />
            <div className="pd-edit-photo-label">Change Profile Photo</div>
          </div>
          <div className="pd-divider" />
          <div className="settings-field">
            <label className="settings-label">Change Name</label>
            <input className="settings-input" value={name} onChange={e => setName(e.target.value)} placeholder="Full name" />
          </div>
          {error && <div className="settings-error" style={{ fontSize: 11 }}>{error}</div>}
          <div className="pd-edit-actions">
            <button className="pd-btn" onClick={() => { setEditing(false); setError(""); }}>Cancel</button>
            <button className="pd-save-btn" onClick={handleSave} disabled={saving}>
              {saving ? <span className="btn-spinner" /> : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── UNIT CONTROL PAGE ────────────────────────────────────────────────────────
function UnitControlPage({ allFews, fews1Connected, userRole, userName, addLog, token, onThresholdSaved }) {
  const [fewsData, setFewsData]           = useState(allFews.map(f => ({ ...f })));
  const [thresholds, setThr]              = useState(Object.fromEntries(allFews.map(f => [f.id, { warning: 200, danger: 300 }])));
  const [prevThresholds, setPrevThr]      = useState(Object.fromEntries(allFews.map(f => [f.id, { warning: 200, danger: 300 }])));
  const [thrSaving, setThrSaving]         = useState({});
  const [thrConfirm, setThrConfirm]       = useState(null);
  const [editing, setEditing]             = useState({});
  const [infoSaving, setInfoSaving]       = useState({});
  const [loadError, setLoadError]         = useState(false);
  const [thrError, setThrError]           = useState({});
  const [infoError, setInfoError]         = useState({});

  const canControl = can(userRole, "unitControl");

  useEffect(() => {
    authFetch(`${API_BASE}/units`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(rows => {
        if (!Array.isArray(rows)) return;
        setLoadError(false);
        setFewsData(prev => prev.map(f => {
          const row = rows.find(r => r.device_id === (f.deviceId || "fews_" + f.id));
          if (!row) return f;
          return {
            ...f,
            installedDate: row.installed_date || f.installedDate,
            technician:    row.technician     || f.technician,
            description:   row.description    || f.description,
          };
        }));
        setThr(prev => {
          const next = { ...prev };
          rows.forEach(row => {
            const f = allFews.find(f => "fews_" + f.id === row.device_id);
            if (f) next[f.id] = { warning: row.threshold_warning, danger: row.threshold_danger };
          });
          return next;
        });
        setPrevThr(prev => {
          const next = { ...prev };
          rows.forEach(row => {
            const f = allFews.find(f => "fews_" + f.id === row.device_id);
            if (f) next[f.id] = { warning: row.threshold_warning, danger: row.threshold_danger };
          });
          return next;
        });
      })
      .catch(err => {
        if (err?.message !== "Unauthorized") setLoadError(true);
      });
  }, [token]);

  const getDeviceId = (id) => "fews_" + id;

  const saveThr = async (id) => {
    if (!canControl) return;
    const f    = fewsData.find(x => x.id === id);
    const thr  = thresholds[id];
    const prev = prevThresholds[id];
    // Validation already done before modal opens, but double-check here as safety
    setThrSaving(p => ({ ...p, [id]: true }));
    setThrError(p => ({ ...p, [id]: "" }));
    try {
      const res = await authFetch(`${API_BASE}/units/${getDeviceId(id)}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ threshold_warning: thr.warning, threshold_danger: thr.danger }),
      });
      if (!res.ok) { setThrError(p => ({ ...p, [id]: "Failed to save thresholds." })); return; }
      if (thr.warning !== prev.warning) addLog({ station: f.name, type: "info", message: `${f.name} (${f.location}) warning threshold updated from ${prev.warning} cm to ${thr.warning} cm by ${userName}` });
      if (thr.danger  !== prev.danger)  addLog({ station: f.name, type: "info", message: `${f.name} (${f.location}) danger threshold updated from ${prev.danger} cm to ${thr.danger} cm by ${userName}` });
      setPrevThr(p => ({ ...p, [id]: { ...thr } }));
      // Notify App to update chart thresholds
      if (onThresholdSaved) onThresholdSaved({ warning: thr.warning, danger: thr.danger });
    } catch (err) {
      if (err?.message !== "Unauthorized") setThrError(p => ({ ...p, [id]: "Network error. Try again." }));
    } finally {
      setThrSaving(p => ({ ...p, [id]: false }));
    }
  };

  const startEdit = (id) => {
    if (!canControl) return;
    const f = fewsData.find(x => x.id === id);
    setEditing(prev => ({ ...prev, [id]: { installedDate: f.installedDate, technician: f.technician, description: f.description } }));
  };

  const saveInfo = async (id) => {
    const f        = fewsData.find(x => x.id === id);
    const snapshot = editing[id];
    setInfoSaving(prev => ({ ...prev, [id]: true }));
    setInfoError(prev => ({ ...prev, [id]: "" }));
    try {
      const res = await authFetch(`${API_BASE}/units/${getDeviceId(id)}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({
          installed_date: snapshot.installedDate,
          technician:     snapshot.technician,
          description:    snapshot.description,
        }),
      });
      if (!res.ok) { setInfoError(prev => ({ ...prev, [id]: "Failed to save. Try again." })); return; }
      setFewsData(prev => prev.map(x => x.id === id ? { ...x, ...snapshot } : x));
      addLog({ station: f.name, type: "info", message: `${f.name} (${f.location}) station information updated by ${userName}` });
      setEditing(prev => { const n = {...prev}; delete n[id]; return n; });
    } catch (err) {
      if (err?.message !== "Unauthorized") setInfoError(prev => ({ ...prev, [id]: "Network error. Try again." }));
    } finally {
      setInfoSaving(prev => ({ ...prev, [id]: false }));
    }
  };

  const cancelEdit = (id) => setEditing(prev => { const n = {...prev}; delete n[id]; return n; });

  return (
    <>
      {thrConfirm !== null && (() => {
        const confirmId  = thrConfirm;
        const confirmThr = thresholds[confirmId];
        return (
          <div className="modal-overlay">
            <div className="modal-box">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="modal-icon" style={{ color: "var(--amber)", marginBottom: 0 }}>⚠</div>
                <div className="modal-title">Update Alert Thresholds?</div>
              </div>
              <div className="modal-msg">
                Warning will be set to <strong style={{ color: "var(--amber)" }}>{confirmThr?.warning} cm</strong> and Danger to <strong style={{ color: "var(--red)" }}>{confirmThr?.danger} cm</strong>. This will also update the Arduino device.
              </div>
              <div className="modal-actions">
                <button className="modal-btn modal-cancel"
                  onClick={() => setThrConfirm(null)}
                  disabled={thrSaving[confirmId]}>
                  Cancel
                </button>
                <button className="modal-btn"
                  style={{ background: "var(--blue)", color: "#000", minWidth: 90 }}
                  disabled={thrSaving[confirmId]}
                  onClick={() => saveThr(confirmId).then(() => setThrConfirm(null))}>
                  {thrSaving[confirmId]
                    ? <span className="btn-spinner" style={{ borderTopColor: "#000", borderColor: "rgba(0,0,0,0.2)" }} />
                    : "Yes, Save"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
      <div className="page-body">
        {loadError && (
          <div style={{ background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)", borderRadius:10, padding:"12px 16px", color:"var(--red)", fontSize:12, fontWeight:600 }}>
            ⚠️ Failed to load unit data — showing defaults. Check your connection and refresh.
          </div>
        )}
        {fewsData.map(f => {
          const cfg = STATUS_CONFIG[f.status] || STATUS_CONFIG["safe"];
          const thr = thresholds[f.id];
          const ed  = editing[f.id];
          const isActuallyLive = f.isLive && fews1Connected;
          return (
            <div key={f.id} className={`uc-card ${!isActuallyLive ? "uc-card-offline" : ""}`} style={{ "--status-color": cfg.color }}>
              <div className="uc-card-header">
                <div className="uc-card-left">
                  <div className="uc-status-dot" style={{ background: isActuallyLive ? cfg.color : "#334155" }} />
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div className="uc-card-name">{f.name}</div>
                      {f.isLive && (
                        <span style={{
                          fontSize: 9, fontWeight: 700, fontFamily: "var(--mono)",
                          background: isActuallyLive ? "rgba(34,197,94,0.15)" : "rgba(148,163,184,0.12)",
                          color: isActuallyLive ? "var(--green)" : "var(--text-3)",
                          border: `1px solid ${isActuallyLive ? "rgba(34,197,94,0.3)" : "rgba(148,163,184,0.2)"}`,
                          borderRadius: 999, padding: "2px 7px", letterSpacing: "0.07em"
                        }}>
                          {isActuallyLive ? "● LIVE" : "◌ WAITING"}
                        </span>
                      )}
                    </div>
                    <div className="uc-card-loc">📍 {f.location}, Batangas City</div>
                  </div>
                </div>
                <div className="uc-card-right">
                  <div className="uc-badge" style={{ color: isActuallyLive ? cfg.color : "var(--text-3)", background: isActuallyLive ? cfg.bg : "rgba(255,255,255,0.04)" }}>
                    {isActuallyLive ? cfg.label : "OFFLINE"}
                  </div>
                  <button
                    className={`uc-power-btn ${isActuallyLive ? "uc-power-on" : "uc-power-off"}`}
                    style={{ cursor: "default", pointerEvents: "none" }}
                    tabIndex={-1}
                    aria-hidden="true"
                  >
                    ↻
                  </button>
                </div>
              </div>

              <div className="uc-stats-row">
                <div className="uc-stat">
                  <span className="uc-stat-label">Water Level</span>
                  <span className="uc-stat-val" style={{ color: isActuallyLive ? cfg.color : "var(--text-3)" }}>
                    {isActuallyLive ? `${f.waterLevel} cm` : "—"}
                  </span>
                </div>
                <div className="uc-stat">
                  <span className="uc-stat-label">Coordinates</span>
                  <span className="uc-stat-val" style={{ fontFamily:"var(--mono)", fontSize:10 }}>{f.lat}, {f.lng}</span>
                </div>
                <div className="uc-stat">
                  <span className="uc-stat-label">Installed</span>
                  {ed ? (
                    <input className="uc-inline-input" value={ed.installedDate}
                      onChange={e => setEditing(prev => ({ ...prev, [f.id]: { ...prev[f.id], installedDate: e.target.value } }))} />
                  ) : <span className="uc-stat-val">{f.installedDate}</span>}
                </div>
                <div className="uc-stat">
                  <span className="uc-stat-label">Technician</span>
                  {ed ? (
                    <input className="uc-inline-input" value={ed.technician}
                      onChange={e => setEditing(prev => ({ ...prev, [f.id]: { ...prev[f.id], technician: e.target.value } }))} />
                  ) : <span className="uc-stat-val">{f.technician}</span>}
                </div>
              </div>

              <div className="uc-desc-section">
                <div className="uc-desc-header">
                  <span className="uc-thr-label">Station Description</span>
                  {canControl && !ed && (
                    <button className="uc-edit-btn" onClick={() => startEdit(f.id)}>✎ Edit</button>
                  )}
                  {canControl && ed && (
                    <div style={{ display:"flex", gap:6 }}>
                      <button className="uc-edit-btn" onClick={() => cancelEdit(f.id)}>Cancel</button>
                      <button className="uc-save-info-btn" onClick={() => saveInfo(f.id)}>{infoSaving[f.id] ? <span className="btn-spinner" /> : "Save"}</button>
                    </div>
                  )}
                </div>
                {ed ? (
                  <textarea className="uc-desc-textarea" rows={3} value={ed.description}
                    onChange={e => setEditing(prev => ({ ...prev, [f.id]: { ...prev[f.id], description: e.target.value } }))} />
                ) : <div className="uc-description">{f.description}</div>}
                {infoError[f.id] && <div className="settings-error" style={{ fontSize: 11, marginTop: 4 }}>{infoError[f.id]}</div>}
              </div>

              {canControl && (
                <div className="uc-thr-section">
                  <div className="uc-thr-label">Alert Thresholds</div>
                  <div className="uc-thr-row">
                    <div className="uc-thr-field">
                      <label className="uc-thr-field-label">⚠ Warning (cm)</label>
                      <input className="settings-input" type="number" step="100" min="100" max="300"
                        value={thr.warning}
                        disabled={!isActuallyLive}
                        onChange={e => setThr(prev => ({ ...prev, [f.id]: { ...prev[f.id], warning: parseInt(e.target.value) } }))} />
                    </div>
                    <div className="uc-thr-field">
                      <label className="uc-thr-field-label">🔴 Danger (cm)</label>
                      <input className="settings-input" type="number" step="100" min="200" max="400"
                        value={thr.danger}
                        disabled={!isActuallyLive}
                        onChange={e => setThr(prev => ({ ...prev, [f.id]: { ...prev[f.id], danger: parseInt(e.target.value) } }))} />
                    </div>
                    <button className="uc-thr-save" disabled={!isActuallyLive} onClick={() => {
                      // Run validation first before showing modal
                      const thr = thresholds[f.id];
                      if (!thr.warning || thr.warning < 100 || thr.warning % 100 !== 0) {
                        setThrError(p => ({ ...p, [f.id]: "Warning must be a multiple of 100 and at least 100cm." })); return;
                      }
                      if (!thr.danger || thr.danger > 400 || thr.danger % 100 !== 0) {
                        setThrError(p => ({ ...p, [f.id]: "Danger must be a multiple of 100 and at most 400cm." })); return;
                      }
                      if (thr.danger < thr.warning + 100) {
                        setThrError(p => ({ ...p, [f.id]: "Danger must be at least Warning + 100cm." })); return;
                      }
                      setThrError(p => ({ ...p, [f.id]: "" }));
                      setThrConfirm(f.id);
                    }}>Save</button>
                  </div>
                  {thrError[f.id] && <div className="settings-error" style={{ fontSize: 11, marginTop: 4 }}>{thrError[f.id]}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ─── FILTER DROPDOWN ──────────────────────────────────────────────────────────
function FilterDropdown({ label, options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const selected     = options.find(o => o.value === value);
  const displayLabel = selected ? selected.label : label;
  const isFiltered   = value !== options[0]?.value;

  return (
    <div className="fdd-wrap" ref={ref}>
      <button
        type="button"
        className={`fdd-trigger ${isFiltered ? "fdd-trigger-active" : ""} ${open ? "fdd-trigger-open" : ""}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="fdd-label">{displayLabel}</span>
        <svg className="fdd-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="fdd-menu">
          {options.map(opt => (
            <button key={opt.value} type="button"
              className={`fdd-item ${opt.value === value ? "fdd-item-selected" : ""}`}
              onClick={() => { onChange(opt.value); setOpen(false); }}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── DATE RANGE FILTER ────────────────────────────────────────────────────────
function DateRangeFilter({ from, to, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  const today = new Date();
  const [viewYear, setViewYear]   = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1); };
  const toIso = (d) => `${viewYear}-${String(viewMonth + 1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  const fmt = (iso) => { if (!iso) return null; const d = new Date(iso + "T00:00:00"); return `${MONTHS[d.getMonth()].slice(0,3)} ${d.getDate()}`; };

  const handleDayClick = (day) => {
    const iso = toIso(day);
    if (!from && !to) { onChange({ from: iso, to: iso }); }
    else if (from && to && from === to) {
      if (iso === from) { onChange({ from: "", to: "" }); }
      else { const [a, b] = iso < from ? [iso, from] : [from, iso]; onChange({ from: a, to: b }); }
    } else { onChange({ from: iso, to: iso }); }
  };

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDay    = new Date(viewYear, viewMonth, 1).getDay();
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const hasFilter = from || to;
  const isSingle  = from && to && from === to;
  let displayLabel = "All Dates";
  if (isSingle) displayLabel = fmt(from);
  else if (from && to) displayLabel = `${fmt(from)} — ${fmt(to)}`;

  return (
    <div className="fdd-wrap drf-wrap" ref={ref}>
      <button type="button" className={`fdd-trigger ${hasFilter ? "fdd-trigger-active" : ""} ${open ? "fdd-trigger-open" : ""}`}
       onClick={() => setOpen(o => !o)}>
        <span className="fdd-icon" style={{ fontSize: 12 }}>📅</span>
        <span className="fdd-label">{displayLabel}</span>
        <svg className="fdd-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="drf-panel drf-panel-single">
          <div className="mc-header">
            <button className="cdp-nav" type="button" onClick={prevMonth}>‹</button>
            <span className="mc-month-label">{MONTHS[viewMonth]} {viewYear}</span>
            <button className="cdp-nav" type="button" onClick={nextMonth}>›</button>
          </div>
          <div className="cdp-days-header">
            {DAYS_SHORT.map(d => <span key={d} className="cdp-day-label">{d}</span>)}
          </div>
          <div className="cdp-grid">
            {cells.map((day, i) => {
              const iso   = day ? toIso(day) : null;
              const endpt = day && (iso === from || iso === to);
              const inRng = day && from && to && from !== to && iso > from && iso < to;
              return (
                <button key={i} type="button" disabled={!day}
                  className={["cdp-cell", !day ? "cdp-empty" : "", endpt ? "cdp-selected" : "",
                    day && today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === day && !endpt ? "cdp-today" : "",
                    inRng ? "mc-in-range" : "",
                    day && iso === from ? "mc-range-from" : "",
                    day && iso === to   ? "mc-range-to"   : "",
                  ].join(" ")}
                  onClick={() => day && handleDayClick(day)}>
                  {day || ""}
                </button>
              );
            })}
          </div>
          <div className="drf-footer">
            <span className="drf-hint">{!hasFilter && "Pick a day"}{isSingle && "Pick another for range"}{from && to && !isSingle && `${fmt(from)} — ${fmt(to)}`}</span>
            {hasFilter && <button className="cdp-clear" type="button" onClick={() => onChange({ from: "", to: "" })}>Clear</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SETTINGS PAGE ────────────────────────────────────────────────────────────
function MuDropdown({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const selected = options.find(o => o === value) || value;

  return (
    <div className="mu-dd-wrap" ref={ref}>
      <button
        type="button"
        className={`mu-dd-trigger ${open ? "mu-dd-open" : ""}`}
        onClick={() => setOpen(o => !o)}
      >
        <span className="mu-dd-label">{selected}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" className="mu-dd-chevron">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="mu-dd-menu">
          {options.map(opt => (
            <button
              key={opt}
              type="button"
              className={`mu-dd-item ${opt === value ? "mu-dd-item-selected" : ""}`}
              onClick={() => { onChange(opt); setOpen(false); }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsPage({ userRole, userName, user, onUserUpdate, token, addLog }) {
  const [showEmail, setShowEmail]           = useState(false);
  const [showPassword, setShowPassword]     = useState(false);
  const [showPhone, setShowPhone]           = useState(false);
  const [showAddUser, setShowAddUser]       = useState(false);
  const [smsSaving, setSmsSaving]           = useState({});
  const [confirmSms, setConfirmSms]         = useState(null);
  const [users, setUsers]                   = useState([]);
  const [loadingUsers, setLoadingUsers]     = useState(false);
  const [loadUsersError, setLoadUsersError] = useState(false);
  const [actionError, setActionError]       = useState("");
  const [drafts, setDrafts]                 = useState({});
  const [confirmSave, setConfirmSave]       = useState(null);
  const [confirmRemove, setConfirmRemove]   = useState(null);

  const isAdmin = userRole === "Admin";

  useEffect(() => {
    setLoadingUsers(true);
    setLoadUsersError(false);
    authFetch(`${API_BASE}/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { setUsers(Array.isArray(data) ? data : []); })
      .catch(() => setLoadUsersError(true))
      .finally(() => setLoadingUsers(false));
  }, [token]);

  useEffect(() => {
    setUsers(prev => prev.map(u => u.id === user.id ? { ...u, name: user.name, photo: user.photo } : u));
  }, [user.name, user.photo]);

  const getDraft    = (u) => drafts[u.id] || { role: u.role, department: u.department };
  const handleDraft = (id, key, val) => setDrafts(prev => ({ ...prev, [id]: { ...getDraft(users.find(u => u.id === id)), [key]: val } }));

  const doSave = async () => {
    const u = confirmSave;
    const d = getDraft(u);
    try {
      const res = await authFetch(`${API_BASE}/users/${u.id}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify(d),
      });
      if (res.ok) {
        if (d.role !== u.role) addLog({ station: "System", type: "system", message: `${u.name}'s role has been changed from ${u.role} to ${d.role} by ${userName}` });
        if (d.department !== u.department) addLog({ station: "System", type: "system", message: `${u.name}'s department has been changed from ${u.department} to ${d.department} by ${userName}` });
        setUsers(prev => prev.map(x => x.id === u.id ? { ...x, ...d } : x));
        setDrafts(prev => { const n={...prev}; delete n[u.id]; return n; });
        if (u.id === user.id) onUserUpdate(normalizeUser({ ...user, ...d }));
      } else {
        setActionError("Failed to save changes. Try again.");
      }
    } catch (err) {
      if (err?.message !== "Unauthorized") setActionError("Failed to save changes. Try again.");
    }
  };

  const doRemove = async () => {
    const u = confirmRemove;
    try {
      const res = await authFetch(`${API_BASE}/users/${u.id}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        addLog({
          station: "System", type: "system",
          message: `User ${u.name} (${u.role}, ${u.department}) has been removed from the system`,
        });
        setUsers(prev => prev.filter(x => x.id !== u.id));
      } else {
        setActionError("Failed to remove user. Try again.");
      }
    } catch (err) {
      if (err?.message !== "Unauthorized") setActionError("Failed to remove user. Try again.");
    }
    setConfirmRemove(null);
  };

  const doAdd = (newUser) => { setUsers(prev => [...prev, newUser]); setActionError(""); };

  const handleSmsToggle = async (userId, newVal) => {
    setSmsSaving(p => ({ ...p, [userId]: true }));
    try {
      const res = await authFetch(`${API_BASE}/users/${userId}/sms`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ sms_enabled: newVal }),
      });
      if (res.ok) {
        const target = users.find(u => u.id === userId);
        setUsers(prev => prev.map(u => u.id === userId ? { ...u, sms_enabled: newVal } : u));
        if (userId === user.id) onUserUpdate(normalizeUser({ ...user, sms_enabled: newVal }));
        addLog({
          station: "System", type: "system",
          message: `SMS alerts for ${target?.name || "user"} have been ${newVal ? "enabled" : "disabled"} by ${userName}`,
        });
      } else {
        setActionError("Failed to update SMS setting. Try again.");
      }
    } catch (err) {
      if (err?.message !== "Unauthorized") setActionError("Failed to update SMS setting. Try again.");
    }
    setSmsSaving(p => ({ ...p, [userId]: false }));
  };

  return (
    <>
      {showAddUser  && <AddUserModal onAdd={doAdd} onClose={() => setShowAddUser(false)} token={token} addLog={addLog} />}
      {showEmail    && <ChangeEmailModal
        onClose={() => setShowEmail(false)}
        token={token} user={user} addLog={addLog}
        onEmailChanged={(newEmail) => {
          onUserUpdate(normalizeUser({ ...user, email: newEmail }));
          setUsers(prev => prev.map(u => u.id === user.id ? { ...u, email: newEmail } : u));
        }} />}
      {showPassword && <ChangePasswordModal
        onClose={() => setShowPassword(false)}
        token={token} user={user} addLog={addLog} />}
      {showPhone && <ChangePhoneModal
        onClose={() => setShowPhone(false)}
        token={token} user={user} addLog={addLog}
        onPhoneChanged={(newPhone) => {
          onUserUpdate(normalizeUser({ ...user, phone: newPhone }));
          setUsers(prev => prev.map(u => u.id === user.id ? { ...u, phone: newPhone } : u));
        }} />}
      {confirmSms && <ConfirmModal
        icon={confirmSms.newVal ? "🔔" : "🔕"}
        iconColor={confirmSms.newVal ? "var(--green)" : "var(--red)"}
        title={confirmSms.newVal ? `Enable SMS for ${confirmSms.name}?` : `Disable SMS for ${confirmSms.name}?`}
        message={confirmSms.newVal ? `${confirmSms.name} will receive SMS alerts on CRITICAL events.` : `${confirmSms.name} will no longer receive SMS alerts.`}
        confirmLabel={confirmSms.newVal ? "Yes, Enable" : "Yes, Disable"}
        confirmColor={confirmSms.newVal ? "var(--green)" : "var(--red)"}
        onConfirm={() => { handleSmsToggle(confirmSms.userId, confirmSms.newVal); setConfirmSms(null); }}
        onCancel={() => setConfirmSms(null)} />}
      {confirmSave   && <ConfirmModal icon="👤" iconColor="var(--blue)" title={`Save Changes for ${confirmSave.name}?`} message={`Role → ${getDraft(confirmSave).role} · Department → ${getDraft(confirmSave).department}`} confirmLabel="Yes, Save" onConfirm={doSave} onCancel={() => setConfirmSave(null)} />}
      {confirmRemove && <ConfirmModal icon="🗑" iconColor="var(--red)" title={`Remove ${confirmRemove.name}?`} message={`This will permanently remove ${confirmRemove.name} from the system.`} confirmLabel="Yes, Remove" confirmColor="var(--red)" onConfirm={doRemove} onCancel={() => setConfirmRemove(null)} />}
      <div className="page-body">

        <div className="page-card">
          <div className="page-card-title">Account</div>
          <div className="page-card-sub">Manage your login credentials.</div>
          <div className="settings-action-row">
            <button className="settings-action-btn" onClick={() => setShowEmail(true)}>
              <span className="sa-icon">✉</span><div className="sa-text"><div className="sa-label">Change Email</div><div className="sa-sub">Update your account email address</div></div><span className="sa-arrow">›</span>
            </button>
            <button className="settings-action-btn" onClick={() => setShowPassword(true)}>
              <span className="sa-icon">🔒</span><div className="sa-text"><div className="sa-label">Change Password</div><div className="sa-sub">Update your login password</div></div><span className="sa-arrow">›</span>
            </button>
            <button className="settings-action-btn" onClick={() => setShowPhone(true)}>
              <span className="sa-icon">📱</span><div className="sa-text"><div className="sa-label">Change Phone Number</div><div className="sa-sub">Update your SMS notification number</div></div><span className="sa-arrow">›</span>
            </button>
          </div>
        </div>

        {isAdmin && (
          <div className="page-card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <div>
                <div className="page-card-title">Manage Users</div>
                <div className="page-card-sub" style={{ marginBottom: 0 }}>Update roles and departments for all system users.</div>
              </div>
              <button className="mu-add-btn" onClick={() => setShowAddUser(true)} title="Add new user">
                <span style={{ fontSize: 16, lineHeight: 1, marginRight: 5 }}>+</span><span className="mu-add-label">Add User</span>
              </button>
            </div>
            {loadingUsers ? (
              <div style={{ color: "var(--text-3)", fontSize: 12, padding: "12px 0" }}>Loading users…</div>
            ) : loadUsersError ? (
              <div style={{ color: "var(--red)", fontSize: 12, padding: "12px 0" }}>⚠️ Failed to load users — check your connection and refresh.</div>
            ) : (
              <>
                {actionError && (
                  <div style={{ color: "var(--red)", fontSize: 12, padding: "8px 12px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, marginBottom: 8 }}>
                    ⚠️ {actionError}
                  </div>
                )}
              <div className="mu-list">
                {users.map(u => {
                  const d = getDraft(u); const changed = d.role !== u.role || d.department !== u.department;
                  return (
                    <div key={u.id} className="mu-row">
                      <div className="mu-avatar">
                        {u.photo
                          ? <img src={u.photo} alt={u.name} style={{ width:"100%", height:"100%", borderRadius:"50%", objectFit:"cover" }} />
                          : u.name.split(" ").map(w=>w[0]).join("").slice(0,2)
                        }
                      </div>
                      <div className="mu-info"><div className="mu-name">{u.name}</div><div className="mu-email">{u.email}</div></div>
                      <div className="mu-controls">
                        <MuDropdown
                          value={d.role}
                          options={["Admin", "Operator"]}
                          onChange={val => handleDraft(u.id, "role", val)}
                        />
                        <MuDropdown
                          value={d.department}
                          options={["C3", "MIAD", "OPS", "ITSD"]}
                          onChange={val => handleDraft(u.id, "department", val)}
                        />
                        <button className="mu-save-btn" disabled={!changed} onClick={() => setConfirmSave(u)}>Save</button>
                        <button className="mu-remove-btn" onClick={() => setConfirmRemove(u)}>✕</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
            )}
          </div>
        )}

      {isAdmin && (
        <div className="page-card">
          <div className="page-card-title">SMS Notifications</div>
          <div className="page-card-sub">Send SMS alerts to registered operators on CRITICAL events.</div>
          <div className="sms-table">
            <div className="sms-table-header">
              <span>Name</span><span>Role</span><span>Department</span><span>Phone Number</span><span style={{textAlign:"center"}}>Alerts</span>
            </div>
            {(isAdmin ? users : users.filter(u => u.role !== "Admin")).map(u => (
              <div key={u.id} className="sms-table-row">
                <span className="sms-name">
                  {u.name}
                  <span className="sms-phone-inline"> · {u.phone || "—"}</span>
                </span>
                <span className="sms-role-text">{u.role}</span>
                <span style={{ color:"var(--text-2)", fontSize:12 }}>{u.department}</span>
                <span className="sms-phone-col" style={{ color: u.phone ? "var(--text-1)" : "var(--text-3)", fontSize: 12 }}>
                  {u.phone || "—"}
                </span>
                <div style={{ display:"flex", justifyContent:"center" }}>
                  <button
                    className={`settings-toggle ${u.sms_enabled ? "stoggle-on" : "stoggle-off"}`}
                    style={{ minWidth: 48 }}
                    onClick={() => setConfirmSms({ userId: u.id, name: u.name, newVal: !u.sms_enabled })}
                  >
                    {smsSaving[u.id] ? <span className="btn-spinner" style={{ width:10, height:10, borderWidth:1.5 }} /> : u.sms_enabled ? "ON" : "OFF"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      </div>
    </>
  );
}

// ─── TOAST ───────────────────────────────────────────────────────────────────
function useToast() {
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((msg) => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev, { id, msg, leaving: false }]);
    setTimeout(() => {
      setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, 220);
    }, 3500);
  }, []);

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 220);
  }, []);

  const ToastContainer = useCallback(() => (
    toasts.length === 0 ? null : (
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.leaving ? "toast-leaving" : ""}`}>
            <span className="toast-icon">⚠</span>
            <span className="toast-msg">{t.msg}</span>
            <button className="toast-close" onClick={() => dismiss(t.id)}>✕</button>
          </div>
        ))}
      </div>
    )
  ), [toasts, dismiss]);

  return { showToast, ToastContainer };
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    try {
      const tok    = getStoredToken();
      const stored = getStoredUser();
      if (!tok || !stored) return false;
      const parsed = JSON.parse(stored);
      return !!(parsed && typeof parsed.name === "string" && parsed.name && parsed.role);
    } catch { return false; }
  });
  const [showLogoutModal, setShowLogoutModal]         = useState(false);
  const [showProfileDropdown, setShowProfileDropdown] = useState(false);
  const [sidebarOpen, setSidebarOpen]                 = useState(false);
  const [selectedFEWS, setSelectedFEWS]               = useState(null);
  const [activeNav, setActiveNav]                     = useState(() => {
    return sessionStorage.getItem("activeNav") || "Dashboard";
  });
  const markerRefs = useRef({});
  const [copiedId, setCopiedId] = useState(null);
  const avatarBtnRef = useRef();
  const copiedTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const [fews1Live, setFews1Live]                   = useState(null);
  const [fews1Connected, setFews1Connected]       = useState(false);
  const [fews1StatusOnline, setFews1StatusOnline] = useState(false);

  const [user, setUser] = useState(() => {
    try {
      const stored = getStoredUser();
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed.name === "string" && typeof parsed.role === "string" && parsed.role) {
          return normalizeUser(parsed);
        }
      }
    } catch {}
    return normalizeUser({});
  });

  const [token, setToken] = useState(() => getStoredToken());
  const { showToast, ToastContainer: AppToastContainer } = useToast();
  const [sirens, setSirens] = useState({ 1: false });
  const [sirenLoading, setSirenLoading] = useState({});
  const [thresholds, setThresholds] = useState({ warning: 200, danger: 300 });

  useEffect(() => {
    if (!token) return;

    let timeoutId = null;
    let failCount = 0;

    const pollUnits = () => {
        fetch(`${API_BASE}/units`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.ok ? r.json() : null)
            .then(rows => {
                if (!Array.isArray(rows)) return;
                failCount = 0;

                const sirenMap = {};
                rows.forEach(row => {
                    const f = [{ id: 1, deviceId: "fews_1" }].find(x => "fews_" + x.id === row.device_id);
                    if (f) sirenMap[f.id] = row.siren_state ?? false;
                });
                setSirenLoading(currentLoading => {
                    setSirens(prev => {
                        const next = { ...prev };
                        Object.entries(sirenMap).forEach(([id, val]) => {
                            if (!currentLoading[id]) next[id] = val;
                        });
                        return next;
                    });
                    return currentLoading;
                });

                const fews1Row = rows.find(r => r.device_id === "fews_1");
                if (fews1Row) {
                    setThresholds({
                        warning: fews1Row.threshold_warning ?? 200,
                        danger:  fews1Row.threshold_danger  ?? 300,
                    });
                }
            })
            .catch(() => { failCount += 1; })
            .finally(() => {
                const delay = failCount === 0 ? 10000 : failCount <= 2 ? 20000 : 30000;
                timeoutId = setTimeout(pollUnits, delay);
            });
    };

    pollUnits();
    return () => { if (timeoutId) clearTimeout(timeoutId); };
}, [token]);
  const [historyData, setHistoryData] = useState({ positions: [], values: [], exactLabels: [] });
  const [hadDataBefore, setHadDataBefore] = useState(() => {
  return sessionStorage.getItem("fews1_had_data") === "true";
});

  const [chartNow, setChartNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setChartNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const addLog = useCallback(async ({ station, type, message }) => {
    const tok = sessionStorage.getItem("token") || token;
    if (!tok) return;
    try {
      await fetch(`${API_BASE}/logs`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ station, type, message, user_name: user.name }),
      });
    } catch {
      // Silently ignore
    }
  }, [token, user.name]);

  const handleLogin = (role) => {
    try {
      const stored = getStoredUser();
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed.name === "string" && parsed.name && parsed.role) {
          setUser(normalizeUser(parsed));
        }
      }
    } catch {}
    setToken(getStoredToken());
    setIsLoggedIn(true);
    setActiveNav("Dashboard");
    sessionStorage.setItem("activeNav", "Dashboard");
  };

  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);

  const handleLogout = useCallback(async () => {
    const tok = getStoredToken();

    if (tok) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        await fetch(`${API_BASE}/logout`, {
          method:  "POST",
          headers: { Authorization: `Bearer ${tok}` },
          signal:  controller.signal,
        });
      } catch (err) {
        if (err.name === "AbortError") {
          console.warn("[LOGOUT] Server unreachable — session cleared locally only. Token may still be valid on server.");
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    clearStoredSession();
    sessionStorage.removeItem("fews1_offline_time");
    sessionStorage.removeItem("fews1_was_offline");
    sessionStorage.removeItem("fews1_initial_logged");
    sessionStorage.removeItem("fews1_had_data");
    sessionStorage.removeItem("activeNav");
    setIsLoggedIn(false);
    setUser(normalizeUser({}));
    setToken("");
    setShowLogoutModal(false);
    setSelectedFEWS(null);
    setSirens({ 1: false });
    setFews1Live(null);
    setFews1Connected(false);
    setHistoryData({ positions: [], values: [], exactLabels: [] });
    setHadDataBefore(false);
    setShowProfileDropdown(false);
    setSidebarOpen(false);
    setActiveNav("Dashboard");
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(handleLogout);
    return () => setUnauthorizedHandler(null);
  }, [handleLogout]);

  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === "token" && !e.newValue) {
        setIsLoggedIn(false);
        setUser(normalizeUser({}));
        setToken("");
        setSelectedFEWS(null);
        setSirens({ 1: false });
        setFews1Live(null);
        setFews1Connected(false);
        setHistoryData({ positions: [], values: [], exactLabels: [] });
        setHadDataBefore(false);
        setShowProfileDropdown(false);
        setSidebarOpen(false);
        setActiveNav("Dashboard");
      }
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const mobileLogoutRef = useRef(null);
  mobileLogoutRef.current = () => setShowLogoutModal(true);
  useEffect(() => {
    window.__onMobileLogout = () => { if (mobileLogoutRef.current) mobileLogoutRef.current(); };
    return () => { delete window.__onMobileLogout; };
  }, []);

  const navItems = useMemo(() =>
      ALL_NAV_ITEMS.filter(item => ROLE_ACCESS[user.role]?.includes(item.key)),
      [user.role]
    );

  const wasConnectedRef = useRef(
    sessionStorage.getItem("fews1_was_offline") === "true" ? false : null
  );
  const offlineTimeRef = useRef(
    (() => { const t = sessionStorage.getItem("fews1_offline_time"); return t ? parseInt(t, 10) : null; })()
  );

  useEffect(() => {
      wasConnectedRef.current = sessionStorage.getItem("fews1_was_offline") === "true" ? false : null;
      const storedOfflineTime = sessionStorage.getItem("fews1_offline_time");
      if (storedOfflineTime) offlineTimeRef.current = parseInt(storedOfflineTime, 10);
    }, []);

  const handleOnline = useCallback(() => {
    setFews1Connected(true);
    setFews1StatusOnline(true);

    if (wasConnectedRef.current === false) {
      const offlineTime = offlineTimeRef.current;
      if (offlineTime) {
        const diffMs   = Date.now() - offlineTime;
        const diffMins = Math.floor(diffMs / 60000);
        const diffSecs = Math.floor((diffMs % 60000) / 1000);
        let duration;
        if (diffMins >= 60) {
          const hours = Math.floor(diffMins / 60);
          const mins  = diffMins % 60;
          duration = mins > 0
            ? `${hours} hour${hours !== 1 ? "s" : ""} ${mins} minute${mins !== 1 ? "s" : ""}`
            : `${hours} hour${hours !== 1 ? "s" : ""}`;
        } else if (diffMins > 0) {
          duration = `${diffMins} minute${diffMins !== 1 ? "s" : ""}`;
        } else {
          duration = `${diffSecs} second${diffSecs !== 1 ? "s" : ""}`;
        }
        addLog({
          station: "FEWS 1", type: "system",
          message: `FEWS 1 is back online after ${duration} of inactivity`,
        });
      } else {
        addLog({
          station: "FEWS 1", type: "system",
          message: `FEWS 1 is back online`,
        });
      }
      offlineTimeRef.current = null;
      sessionStorage.removeItem("fews1_offline_time");
      sessionStorage.removeItem("fews1_was_offline");
    } else if (wasConnectedRef.current === null) {
      // Startup log is now handled by backend on receipt of cdrrmo/fews1/status
      sessionStorage.setItem("fews1_initial_logged", "true");
    }

    wasConnectedRef.current = true;
  }, [addLog]);

  const handleOffline = useCallback(() => {
    setFews1Connected(false);
    // Note: fews1StatusOnline is driven by /status/fews1 poll independently
    // so we don't reset it here — the status poll will handle its own timeout

    if (wasConnectedRef.current === true && !offlineTimeRef.current) {
      const offlineTime = Date.now();
      offlineTimeRef.current = offlineTime;
      sessionStorage.setItem("fews1_offline_time", String(offlineTime));
      sessionStorage.setItem("fews1_was_offline", "true");
      sessionStorage.removeItem("fews1_initial_logged");
      addLog({
        station: "FEWS 1", type: "warning",
        message: `FEWS 1 went offline — no data received`,
      });
    }

    wasConnectedRef.current = false;
  }, [addLog]);

  useEffect(() => {
    const failCount = { current: 0 };
    let timeoutId = null;

    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/data/latest`);
        if (!res.ok) throw new Error("non-200");
        const data = await res.json();
        if (data.fews_1) {
          const rawTs  = data.fews_1.timestamp;
          const utcStr = typeof rawTs === "string"
            ? rawTs.replace(" ", "T").replace(/Z?$/, "Z")
            : null;
          const lastSeen = utcStr ? new Date(utcStr) : null;
          const isRecent = lastSeen && (Date.now() - lastSeen.getTime()) < 180000;

          if (isRecent) {
            setFews1Live(data.fews_1);
            handleOnline();
            failCount.current = 0;
          } else {
            handleOffline();
            failCount.current += 1;
          }
        } else {
          handleOffline();
          failCount.current += 1;
        }
      } catch {
        handleOffline();
        failCount.current += 1;
      } finally {
        const delay = failCount.current === 0 ? 5000
                    : failCount.current === 1 ? 10000
                    : failCount.current === 2 ? 20000
                    : 30000;
        timeoutId = setTimeout(poll, delay);
      }
    };

    poll();
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [handleOnline, handleOffline]);

  // ── Poll /status/fews1 for startup ping (drives topbar/sidebar online state) ──
  useEffect(() => {
    let statusTimeoutId = null;
    let statusFailCount = 0;

    const pollStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/status/fews1`);
        if (!res.ok) throw new Error("non-200");
        const data = await res.json();
        setFews1StatusOnline(data.online === true);
        statusFailCount = 0;
      } catch {
        statusFailCount += 1;
      } finally {
        const delay = statusFailCount === 0 ? 10000
                    : statusFailCount === 1 ? 20000
                    : statusFailCount === 2 ? 40000
                    : 60000;
        statusTimeoutId = setTimeout(pollStatus, delay);
      }
    };

    pollStatus();
    return () => { if (statusTimeoutId) clearTimeout(statusTimeoutId); };
  }, []);

  useEffect(() => {
    const buildChart = (rows) => {
      const all = rows || [];

      const rawTimestamps = all.map((r) => {
        const utcStr = r.timestamp.replace(" ", "T").replace(/Z?$/, "Z");
        return new Date(utcStr).getTime();
      });

      const rawValues = all.map((r) => r.water_level_cm);

      const rawLabels = all.map((r) => {
        const utcStr = r.timestamp.replace(" ", "T").replace(/Z?$/, "Z");
        return new Intl.DateTimeFormat("en-PH", {
          timeZone: "Asia/Manila",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        }).format(new Date(utcStr));
      });

      const GAP_THRESHOLD = 90 * 60 * 1000;
      const positions = [];
      const values = [];
      const exactLabels = [];

      for (let i = 0; i < rawTimestamps.length; i++) {
        if (i > 0 && rawTimestamps[i] - rawTimestamps[i - 1] > GAP_THRESHOLD) {
          // Insert a null point to break the line
          positions.push(rawTimestamps[i - 1] + 1000);
          values.push(null);
          exactLabels.push("");
        }
        positions.push(rawTimestamps[i]);
        values.push(rawValues[i]);
        exactLabels.push(rawLabels[i]);
      }

      setHistoryData({ positions, values, exactLabels });
      sessionStorage.setItem("fews1_had_data", "true");
      setHadDataBefore(true);
    };

    const historyFailCount = { current: 0 };
    let historyTimeoutId = null;

    const scheduledFetch = async () => {
      try {
        const res = await fetch(`${API_BASE}/data/history`);
        if (!res.ok) throw new Error("non-200");
        const rows = await res.json();
        if (!Array.isArray(rows)) throw new Error("bad data");
        buildChart(rows);
        historyFailCount.current = 0;
      } catch {
        historyFailCount.current += 1;
      } finally {
        const delay = historyFailCount.current === 0 ? 10000
                    : historyFailCount.current === 1 ? 20000
                    : historyFailCount.current === 2 ? 40000
                    : 60000;
        historyTimeoutId = setTimeout(scheduledFetch, delay);
      }
    };

    scheduledFetch();
    return () => {
      if (historyTimeoutId) clearTimeout(historyTimeoutId);
    };
  }, []);

  const allFews = useMemo(() => {
      let fews1 = { ...FEWS1_BASE };
      if (fews1Live) {
        fews1 = {
          ...fews1,
          waterLevel: fews1Live.water_level_cm,
          status:     backendStatusToKey(fews1Live.status),
          lat:        fews1Live.latitude,
          lng:        fews1Live.longitude,
        };
      }
      return [fews1];
    }, [fews1Live]);

    const isCritical = useMemo(() => allFews.some(f => f.status === "danger"), [allFews]);

    const prevCriticalRef = useRef(false);
    useEffect(() => {
      if (isCritical && !prevCriticalRef.current) {
        const alreadyNotified = localStorage.getItem("fews_critical_notified") === "true";
        if (!alreadyNotified && typeof Notification !== "undefined" && Notification.permission === "granted") {
          const n = new Notification("⚠ CDRRMO FEWS ALERT", {
            body: "Critical water level detected! Tap to open the dashboard.",
            icon: "/cdrrmo-seal.png",
            tag:  "fews-critical",
            requireInteraction: true,
          });
          n.onclick = () => {
            window.open("https://cdrrmo-fews.vercel.app/", "_blank");
            n.close();
          };
          localStorage.setItem("fews_critical_notified", "true");
        }
      }
      if (!isCritical && prevCriticalRef.current) {
        localStorage.removeItem("fews_critical_notified");
      }
      prevCriticalRef.current = isCritical;
    }, [isCritical]);

    useEffect(() => {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        Notification.requestPermission();
      }
    }, []);

    const [sirenConfirm, setSirenConfirm] = useState(null);

    const toggleSiren = async (id) => {
        if (!can(user.role, "sirenControl")) return;
        if (sirenLoading[id]) return;

        const turningOn = !sirens[id];
        if (turningOn) {
          setSirenConfirm(id);
          return;
        }

        await doToggleSiren(id, false);
      };

    const doToggleSiren = async (id, turningOn) => {
        const deviceId = "fews_" + id;

        setSirenLoading(prev => ({ ...prev, [id]: true }));
        setSirens(prev => ({ ...prev, [id]: turningOn }));

    try {
      await authFetch(`${API_BASE}/siren/${deviceId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ state: turningOn ? "on" : "off" })
      });
      console.log(`[SIREN] Command sent: ${turningOn ? "on" : "off"}`);
    } catch (e) {
      console.error("[SIREN] Control failed:", e);
      setSirens(prev => ({ ...prev, [id]: !turningOn }));
      showToast("Siren command failed — check your connection and try again.");
    }

    // Siren log is now handled server-side in /siren/{device_id}

    setTimeout(() => {
      setSirenLoading(prev => ({ ...prev, [id]: false }));
    }, 7000);
  };

  const chartPoints = useMemo(() =>
    (historyData?.values?.length)
      ? historyData.positions.map((ms, i) => ({ x: ms, y: historyData.values[i] }))
      : [],
    [historyData]
  );

  const CHART_WINDOW  = 12 * 60 * 60 * 1000;
  const CHART_PADDING = 10 * 60 * 1000;
  const chartWinEnd   = useMemo(() => Math.ceil(chartNow / 300000) * 300000, [chartNow]);
  const chartWinStart = useMemo(() => chartWinEnd - CHART_WINDOW - CHART_PADDING, [chartWinEnd]);
  const hasEverHadData = historyData?.values?.length > 0 || hadDataBefore;
  const waterChartData = useMemo(() => ({
    datasets: [{
      label: "FEWS 1",
      data: chartPoints,
      spanGaps: false,
      borderColor: "#38bdf8",
      backgroundColor: "rgba(56,189,248,0.08)",
      tension: 0,
      pointRadius: 3,
      pointHoverRadius: 6,
      borderWidth: 2,
      segment: {
        borderColor: () => "#38bdf8",
      },
      pointBackgroundColor: (ctx) => {
        const v = ctx.parsed?.y;
        if (v == null) return "transparent";
        if (v > thresholds.danger)  return "#ef4444";
        if (v > thresholds.warning) return "#f59e0b";
        return "#22c55e";
      },
      pointBorderColor: (ctx) => {
        const v = ctx.parsed?.y;
        if (v == null) return "transparent";
        if (v > thresholds.danger)  return "#ef4444";
        if (v > thresholds.warning) return "#f59e0b";
        return "#22c55e";
      },
    }],
  }), [chartPoints, thresholds]);

const waterChartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: "top",
        align: "center",
        labels: {
          color: "#94a3b8",
          font: { size: 9 },
          boxWidth: 8,
          boxHeight: 8,
          padding: 8,
          generateLabels: () => [{
            text: "FEWS 1",
            fillStyle: "#38bdf8",
            strokeStyle: "#38bdf8",
            fontColor: "#94a3b8",
            textColor: "#94a3b8",
            color: "#94a3b8",
            lineWidth: 0,
            hidden: false,
            datasetIndex: 0,
          }],
        },
      },
      tooltip: {
        backgroundColor: "#1e293b",
        titleColor: "#fff",
        bodyColor: "#94a3b8",
        borderColor: "#334155",
        borderWidth: 1,
        callbacks: {
          title: (items) => {
            const i = items[0]?.dataIndex;
            return historyData?.exactLabels?.[i] ?? "";
          },
          label: (ctx) => {
            const v = ctx.parsed.y;
            const status = v > thresholds.danger ? "CRITICAL" : v > thresholds.warning ? "WARNING" : "SAFE";
            return ` ${v} cm  [${status}]`;
          },
          labelColor: (ctx) => {
            const v = ctx.parsed.y;
            const color = v > thresholds.danger ? "#ef4444" : v > thresholds.warning ? "#f59e0b" : "#22c55e";
            return { borderColor: color, backgroundColor: color };
          },
        },
      },
      annotation: {
        annotations: {
          zoneSafe:    { type: "box", yMin: 0,                    yMax: thresholds.warning, backgroundColor: "rgba(34,197,94,0.60)",  borderWidth: 0 },
          zoneWarning: { type: "box", yMin: thresholds.warning,   yMax: thresholds.danger,  backgroundColor: "rgba(245,158,11,0.60)", borderWidth: 0 },
          zoneCritical:{ type: "box", yMin: thresholds.danger,    yMax: 500,                backgroundColor: "rgba(239,68,68,0.60)",  borderWidth: 0 },
          lineWarning: { type: "line", yMin: thresholds.warning, yMax: thresholds.warning, borderColor: "rgba(245,158,11,0.80)", borderWidth: 2, borderDash: [4, 4], label: { display: false } },
          lineCritical:{ type: "line", yMin: thresholds.danger,  yMax: thresholds.danger,  borderColor: "rgba(239,68,68,0.80)",  borderWidth: 2, borderDash: [4, 4], label: { display: false } },
        },
      },
    },
    scales: {
      y: {
        min: 0, max: 500,
        grid: { color: "rgba(255,255,255,0.05)" },
        ticks: {
          color: (ctx) => {
            const v = ctx.tick.value;
            if (v > thresholds.danger)  return "#ef4444";
            if (v > thresholds.warning) return "#f59e0b";
            return "#22c55e";
          },
          font: { size: 10 },
          callback: (v) => `${v}cm`,
          stepSize: 100,
        },
      },
      x: {
        type: "linear",
        min: chartWinStart,
        max: chartWinEnd,
        grid: { color: "rgba(255,255,255,0.04)" },
        afterBuildTicks: (axis) => {
          const ticks = [];
          const step = 60 * 60 * 1000;
          const start = Math.ceil(chartWinStart / step) * step;
          for (let t = start; t <= chartWinEnd; t += step) {
            ticks.push({ value: t });
          }
          axis.ticks = ticks;
        },
        ticks: {
          color: "#64748b",
          maxRotation: 0,
          minRotation: 0,
          font: { size: 9 },
          callback: (val) => new Intl.DateTimeFormat("en-PH", {
            timeZone: "Asia/Manila",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }).format(new Date(val)),
        },
      },
    },
  }), [chartWinStart, chartWinEnd, historyData, thresholds]);

  // Connected = either recent sensor reading OR recent status ping
  const isHardwareOnline = fews1Connected || fews1StatusOnline;

  const alertCount      = allFews.filter(f => f.status === "danger").length;
  const selectedStation = allFews.find(f => f.id === selectedFEWS) || null;
  const pageInfo        = PAGE_TITLES[activeNav];

  const lastUpdatedStr = fews1Live?.timestamp
  ? new Date(fews1Live.timestamp.replace(" ", "T").replace(/Z?$/, "Z"))
      .toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour:"2-digit", minute:"2-digit", second:"2-digit" })
  : null;

  if (!isLoggedIn) return <Login onLogin={handleLogin} />;

  return (
      <ErrorBoundary>
      <AppToastContainer />
      <div className="app-shell" style={{ flexDirection: "column" }}>
        {sirenConfirm !== null && (() => {
        const f = allFews.find(x => x.id === sirenConfirm);
        return (
          <ConfirmModal
            icon="🔊"
            iconColor="var(--red)"
            title="Activate Siren?"
            message={`This will physically sound the siren at ${f?.name || "the station"} (${f?.location || ""}). Only activate during an actual emergency.`}
            confirmLabel="Yes, Activate"
            confirmColor="var(--red)"
            onConfirm={() => { doToggleSiren(sirenConfirm, true); setSirenConfirm(null); }}
            onCancel={() => setSirenConfirm(null)}
          />
        );
      })()}
        {showLogoutModal && (
        <ConfirmModal title="Logout" message="Are you sure you want to log out of the CDRRMO dashboard?"
          confirmLabel="Yes, Logout" confirmColor="var(--red)"
          onConfirm={handleLogout}
          onCancel={() => setShowLogoutModal(false)}
          noSaved />
      )}

      {/* ─── CRITICAL BANNER ─── */}
      <div className={`critical-banner ${isCritical ? "active" : ""}`}>
        <div className="critical-banner-inner">
          <div className="marquee-track">
            <div className="marquee-content">
              CRITICAL WATER LEVEL DETECTED — IMMEDIATE ACTION REQUIRED &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; CRITICAL WATER LEVEL DETECTED — IMMEDIATE ACTION REQUIRED &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; CRITICAL WATER LEVEL DETECTED — IMMEDIATE ACTION REQUIRED &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            </div>
            <div className="marquee-content" aria-hidden="true">
              CRITICAL WATER LEVEL DETECTED — IMMEDIATE ACTION REQUIRED &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; CRITICAL WATER LEVEL DETECTED — IMMEDIATE ACTION REQUIRED &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; CRITICAL WATER LEVEL DETECTED — IMMEDIATE ACTION REQUIRED &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            </div>
          </div>
        </div>
      </div>

      {/* ─── APP BODY ─── */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>

      {/* ─── SIDEBAR ─── */}
      <aside className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
        <div className="brand">
          {sidebarOpen && <div className="brand-icon">🌊</div>}
          <div className={`brand-text ${sidebarOpen ? "" : "hidden"}`}>
            <div className="brand-name">CDRRMO</div>
          </div>
          <button
            className="nav-btn"
            style={{ marginLeft: sidebarOpen ? "auto" : "0", padding: "10px", flexShrink: 0 }}
            onClick={() => setSidebarOpen(o => !o)}
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            <span className="nav-icon">
              {sidebarOpen ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <line x1="9" y1="3" x2="9" y2="21"/>
                  <polyline points="5 8 7 12 5 16"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <line x1="9" y1="3" x2="9" y2="21"/>
                  <polyline points="13 8 17 12 13 16"/>
                </svg>
              )}
            </span>
          </button>
        </div>
        <nav className="nav">
          {navItems.map(item => (
            <button key={item.key} className={`nav-btn ${activeNav === item.key ? "active" : ""}`} onClick={() => {
              setActiveNav(item.key);
              sessionStorage.setItem("activeNav", item.key);
            }}>
              <span className="nav-icon">{item.icon}</span>
              <span className={`nav-label ${sidebarOpen ? "" : "hidden"}`}>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className="logout-btn" onClick={() => setShowLogoutModal(true)}>
            <span className="nav-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" />
                <polyline points="17 15 20 12 17 9" />
                <line x1="20" y1="12" x2="9" y2="12" />
              </svg>
            </span>
            <span className={`nav-label ${sidebarOpen ? "" : "hidden"}`}>Logout</span>
          </button>
        </div>
      </aside>

      {/* ─── MAIN ─── */}
      <div className="main">
        <header className="topbar">
          <div className="top-left">
            <div className="title-block">
              <h1>{pageInfo.title}</h1>
              <div className="subtitle">{pageInfo.sub}</div>
            </div>
          </div>
          <div className="topbar-seals">
            <img src="/batscity-seal.png" alt="Batangas City Seal" className="topbar-seal-img" />
            <img src="/cdrrmo-seal.png"   alt="CDRRMO Seal"        className="topbar-seal-img" />
          </div>
          <div className="top-right">
            {alertCount > 0 && (
              <div className="alert-badge">
                <span className="alert-dot" />
                {alertCount} Alert{alertCount > 1 ? "s" : ""}
              </div>
            )}
            <div className={`connection ${isHardwareOnline ? "online" : "waiting"}`}>
              <span className={isHardwareOnline ? "pulse-dot" : "wait-dot"} />
              {isHardwareOnline ? "System Online" : "Waiting for Data"}
            </div>
            <div className="profile-wrap">
              <div className="profile-avatar-btn" ref={avatarBtnRef} onClick={() => setShowProfileDropdown(v => !v)}>
                {user.photo ? <img src={user.photo} alt="avatar" style={{ width:"100%", height:"100%", borderRadius:"50%", objectFit:"cover" }} /> : user.initials}
              </div>
              {showProfileDropdown && (() => {
                  const rect    = avatarBtnRef.current?.getBoundingClientRect();
                  const top     = rect ? rect.bottom + 8 : 72;
                  const rawRight = rect ? window.innerWidth - rect.right : 16;
                  const dropdownWidth = 260;
                  const right   = Math.max(8, Math.min(rawRight, window.innerWidth - dropdownWidth - 8));
                  return createPortal(
                      <div style={{ position:"fixed", top:`${top}px`, right:`${right}px`, zIndex:99999 }}
                          onKeyDown={e => { if (e.key === "Escape") setShowProfileDropdown(false); }}>
                          <ProfileDropdown
                              user={user}
                              token={token}
                              onSave={u => {
                                  const normalized = normalizeUser(u);
                                  setUser(normalized);
                                  getStorage().setItem("user", JSON.stringify(normalized));
                              }}
                              onClose={() => setShowProfileDropdown(false)}
                              addLog={addLog}
                          />
                      </div>, document.body
                  );
              })()}
            </div>
          </div>
        </header>

        {/* ─── DASHBOARD ─── */}
        {activeNav === "Dashboard" && (
          <div className="dashboard-body">
            <main className="content">
              <div className="card card-map">
                <div className="card-header">
                  <h2>FEWS Locations</h2>
                  <span className="card-tag">Batangas City</span>
                </div>
                <div className="map-wrap">
                  <MapContainer center={[13.7703472, 121.0525449]} zoom={15} style={{ height:"100%", width:"100%", borderRadius:"10px" }} scrollWheelZoom={false}>
                    <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                    <FlyToStation fews={selectedStation} />
                    <OpenPopup fews={selectedStation} markerRefs={markerRefs} />
                    {allFews.map(f => {
                      const cfg            = STATUS_CONFIG[f.status] || STATUS_CONFIG["safe"];
                      const isSel          = selectedFEWS === f.id;
                      const isActuallyLive = f.isLive && isHardwareOnline;
                      const markerColor    = isActuallyLive ? cfg.color : "#64748b";
                      const icon = L.divIcon({
                        className: "",
                        html: `<div style="width:${isSel?"18px":"14px"};height:${isSel?"18px":"14px"};border-radius:50%;background:${markerColor};border:2px solid white;box-shadow:0 0 ${isSel?"12px":"8px"} ${markerColor};transition:all 0.3s;"></div>`,
                        iconSize: [isSel?18:14, isSel?18:14],
                        iconAnchor: [isSel?9:7, isSel?9:7],
                      });
                      return (
                        <Marker key={f.id} position={[f.lat, f.lng]} icon={icon}
                          ref={el => { markerRefs.current[f.id] = el; }}
                          eventHandlers={{ click: () => setSelectedFEWS(selectedFEWS === f.id ? null : f.id) }}>
                          <Popup minWidth={160}>
                          <div style={{ fontFamily:"sans-serif", padding:"2px 0" }}>
                            <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:6 }}>
                              <strong style={{ fontSize:"13px", color:"#1e293b" }}>{f.name}</strong>
                              <span style={{ fontSize:9, color: isHardwareOnline ? "#22c55e" : "#94a3b8", fontWeight:700 }}>
                                {isHardwareOnline ? "● LIVE" : "◌ WAITING"}
                              </span>
                            </div>
                            <div style={{ fontSize:"11px", color:"#475569", lineHeight:1.6, marginBottom:4 }}>
                              <strong style={{ color:"#1e293b" }}>{f.location}</strong> · Water: {isHardwareOnline ? `${f.waterLevel} cm` : "—"}
                            </div>
                              <button onClick={() => {
                                navigator.clipboard.writeText(`${f.lat}, ${f.lng}`);
                                setCopiedId(f.id);
                                if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
                                copiedTimerRef.current = setTimeout(() => {
                                  setCopiedId(null);
                                  copiedTimerRef.current = null;
                                }, 1500);
                              }} style={{ marginTop:"7px", padding:"3px 8px", background: copiedId===f.id?"#38bdf8":markerColor, color:"#ffffff", border:"none", outline:"none", boxShadow:"none", borderRadius:"4px", cursor:"pointer", fontWeight:"700", fontSize:"10px", width:"100%", transition:"background 0.2s" }}>
                                {copiedId===f.id ? "Copied!" : "📋 Copy Coordinates"}
                              </button>
                            </div>
                          </Popup>
                        </Marker>
                      );
                    })}
                  </MapContainer>
                </div>
              </div>

              {/* ─── WATER LEVEL CHART ─── */}
              <div className="card card-water">
                <div className="card-header">
                  <h2>Water Level</h2>
                    <span className="card-tag">
                      {hasEverHadData
                        ? (fews1Connected ? "Last 12 hrs" : "Last known data")
                        : fews1Connected ? "Loading…" : "Waiting for data"}
                    </span>
                </div>
                  {hasEverHadData ? (
                    <div className="chart-wrap">
                      <Line data={waterChartData} options={waterChartOptions} />
                    </div>
                  ) : fews1Connected ? (
                    <div className="chart-wrap skeleton" />
                  ) : (
                    <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8 }}>
                      <div style={{ fontSize:24 }}>📡</div>
                      <div style={{ color:"var(--text-3)", fontSize:12, fontWeight:600 }}>Waiting for FEWS 1 to come online</div>
                      <div style={{ color:"var(--text-3)", fontSize:10, fontFamily:"var(--mono)" }}>Data will appear once the sensor starts transmitting</div>
                    </div>
                  )}
              </div>

             {/* ─── ALARM STATUS ─── */}
              {(() => {
                const ALARM_CFG = {
                  safe: {
                    color:  "#34d399",
                    bg:     "rgba(34,197,94,0.60)",
                    border: "rgba(34,197,94,0.70)",
                    sqBg:   "rgba(34,197,94,0.65)",
                    sqBor:  "rgba(34,197,94,0.80)",
                    label:  "ALL CLEAR",
                    icon:   "✓",
                    anim:   false,
                  },
                  warning: {
                    color:  "#fcd34d",
                    bg:     "rgba(245,158,11,0.60)",
                    border: "rgba(245,158,11,0.70)",
                    sqBg:   "rgba(245,158,11,0.65)",
                    sqBor:  "rgba(245,158,11,0.80)",
                    label:  "WARNING",
                    icon:   "!",
                    anim:   true,
                  },
                  danger: {
                    color:  "#fc6f6f",
                    bg:     "rgba(239,68,68,0.60)",
                    border: "rgba(239,68,68,0.70)",
                    sqBg:   "rgba(239,68,68,0.65)",
                    sqBor:  "rgba(239,68,68,0.80)",
                    label:  "CRITICAL",
                    icon:   "!!",
                    anim:   true,
                  },
                  offline: {
                    color:    "#a8b8cc",
                    bg:       "rgba(74,96,126,0.60)",
                    border:   "rgba(74,96,126,0.70)",
                    sqBg:     "rgba(74,96,126,0.65)",
                    sqBor:    "rgba(74,96,126,0.80)",
                    label:    "OFFLINE",
                    icon:     "◌",
                    anim:     false,
                    iconFont: "sans-serif",
                  },
                };

                const anyLive = allFews.some(f => f.isLive && isHardwareOnline);
                const worstStatus = anyLive
                  ? allFews.reduce((worst, f) => {
                      if (!f.isLive || !isHardwareOnline) return worst;
                      const rank = { safe: 0, warning: 1, danger: 2 };
                      return (rank[f.status] ?? 0) > (rank[worst] ?? 0) ? f.status : worst;
                    }, "safe")
                  : "offline";

                const cfg = ALARM_CFG[worstStatus];

                // Build dynamic sub message based on affected stations
                const buildSub = () => {
                  if (worstStatus === "offline") return "No stations online.";
                  if (worstStatus === "safe")    return "No critical advisories at this time.";

                  const affected = allFews.filter(f =>
                    f.isLive && isHardwareOnline && f.status === worstStatus
                  );
                  const names = affected.map(f => f.name);

                  const prefix = worstStatus === "warning"
                    ? "Water level is rising"
                    : "Immediate action required";

                  if (names.length === 0) return `${prefix}.`;

                  const allMatch = allFews
                    .filter(f => f.isLive && isHardwareOnline)
                    .length === names.length;

                  if (allMatch) return `${prefix} for All Fews.`;

                  if (names.length === 1) return `${prefix} for ${names[0]}.`;

                  const last = names[names.length - 1];
                  const rest = names.slice(0, -1).join(", ");
                  return `${prefix} for ${rest} and ${last}.`;
                };

                return (
                  <div className="card card-battery">
                    <div className="card-header">
                      <h2>Alarm Status</h2>
                      <span className="card-tag">All Fews</span>
                    </div>

                    <div style={{
                      flex: 1,
                      borderRadius: 10,
                      border: `1px solid ${cfg.border}`,
                      background: cfg.bg,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 10,
                      padding: "12px 10px",
                      minHeight: 0,
                    }}>
                      {/* Square icon — fixed wrapper prevents pulse from shifting layout */}
                      <div style={{ width: 38, height: 38, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <div style={{
                          width: 38, height: 38,
                          borderRadius: 8,
                          border: `2px solid ${cfg.sqBor}`,
                          background: cfg.sqBg,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: worstStatus === "danger" ? 15 : 18,
                          fontWeight: 900,
                          fontFamily: cfg.iconFont || "var(--mono)",
                          lineHeight: 1,
                          color: cfg.color,
                          letterSpacing: worstStatus === "danger" ? "-1px" : "0",
                          animation: cfg.anim ? "pulse 1.8s ease-in-out infinite" : "none",
                        }}>
                          {cfg.icon}
                        </div>
                      </div>

                      {/* Label */}
                      <div style={{
                        fontSize: 14,
                        fontWeight: 800,
                        color: cfg.color,
                        fontFamily: "var(--mono)",
                        letterSpacing: "0.10em",
                        animation: cfg.anim ? "blink 1.2s infinite" : "none",
                      }}>
                        {cfg.label}
                      </div>

                      {/* Dynamic sub message */}
                      <div style={{
                        fontSize: 10,
                        color: cfg.color,
                        textAlign: "center",
                        lineHeight: 1.5,
                        opacity: 0.75,
                        maxWidth: 160,
                      }}>
                        {buildSub()}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </main>

            <aside className="right-sidebar">
              <div className="rsb-header">
                <h3>FEWS Stations</h3>
                <span className="rsb-count">{allFews.length}</span>
              </div>
              <div className="rsb-list">
                {allFews.map(f => {
                  const cfg   = STATUS_CONFIG[f.status] || STATUS_CONFIG["safe"];
                  const isSel = selectedFEWS === f.id;
                  const isActuallyLive = f.isLive && isHardwareOnline;
                  return (
                    <button key={f.id} className={`rsb-item ${isSel ? "selected" : ""}`}
                      onClick={() => setSelectedFEWS(isSel ? null : f.id)}
                      style={{ "--status-color": cfg.color }}>
                      <div className="rsb-dot" style={{ background: isActuallyLive ? cfg.color : "#334155" }} />
                      <div className="rsb-info">
                        <div className="rsb-name" style={{ display:"flex", alignItems:"center", gap:5 }}>
                          {f.name}
                          {f.isLive && (
                            <span style={{ fontSize: 8, fontWeight: 700, color: isActuallyLive ? "var(--green)" : "var(--text-3)", fontFamily: "var(--mono)" }}>
                              {isActuallyLive ? "LIVE" : "WAITING"}
                            </span>
                          )}
                        </div>
                        <div className="rsb-loc">{f.location || "-"}</div>
                      </div>
                      <div className="rsb-badge" style={{ 
                        color: isActuallyLive ? cfg.color : "var(--text-3)", 
                        background: isActuallyLive ? cfg.bg : "rgba(255,255,255,0.04)" 
                      }}>
                        {isActuallyLive ? cfg.label : "—"}
                      </div>
                    </button>
                  );
                })}
              </div>
              {selectedFEWS && (() => {
                const f       = allFews.find(s => s.id === selectedFEWS);
                const cfg     = STATUS_CONFIG[f.status] || STATUS_CONFIG["safe"];
                const sirenOn = sirens[f.id];
                const isActuallyLive = f.isLive && isHardwareOnline;
                const canSiren = can(user.role, "sirenControl");
                return (
                  <div className="rsb-detail" style={{ "--status-color": isActuallyLive ? cfg.color : "var(--text-3)" }}>
                    <div className="rsb-detail-title">
                      {f.name} · {f.location}
                      {f.isLive && (
                        <span style={{ marginLeft:8, fontSize:9, fontWeight:700, fontFamily:"var(--mono)",
                          color: isActuallyLive ? "var(--green)" : "var(--text-3)" }}>
                          {isActuallyLive ? "● LIVE" : "◌ WAITING"}
                        </span>
                      )}
                    </div>
                    <div className="rsb-stat"><span>Water Level</span><strong style={{ color: isActuallyLive ? cfg.color : "var(--text-3)" }}>{isActuallyLive ? `${f.waterLevel} cm` : "—"}</strong></div>
                    <div className="rsb-stat"><span>Status</span><strong style={{ color: isActuallyLive ? cfg.color : "var(--text-3)" }}>{isActuallyLive ? cfg.label : "WAITING"}</strong></div>
                    <div className="rsb-stat">
                      <span>Last sync</span>
                      <strong style={{ color: !isActuallyLive ? "var(--text-3)" : "var(--text-1)" }}>
                        {lastUpdatedStr
                          ? isActuallyLive
                            ? lastUpdatedStr
                            : <span>{lastUpdatedStr} <span style={{ fontSize: 9, color: "var(--text-3)", fontFamily: "var(--mono)" }}>· last known</span></span>
                          : "—"}
                      </strong>
                    </div>
                    {canSiren && (
                      <div className="rsb-siren">
                        <div className="rsb-siren-label">Siren Control</div>
                        <div className="rsb-siren-row">
                          <span style={{ color: isActuallyLive ? "var(--text-2)" : "var(--text-3)" }}>{sirenOn ? "🔊 Active" : "🔇 Off"}</span>
                          <button
                            className={`siren-btn ${sirenOn ? "siren-on" : "siren-off"}`}
                            onClick={() => toggleSiren(f.id)}
                            disabled={!isActuallyLive || sirenLoading[f.id]}
                          >
                            {sirenLoading[f.id]
                              ? <span className="btn-spinner" style={{ width: 10, height: 10, borderWidth: 1.5, borderTopColor: sirenOn ? "#fff" : "var(--text-2)", borderColor: sirenOn ? "rgba(255,255,255,0.25)" : "rgba(126,146,180,0.25)" }} />
                              : sirenOn ? "SILENCE" : "MANUAL ON"}
                          </button>
                        </div>
                        <div className="rsb-siren-note">
                          {!isActuallyLive ? "Available once station is live" : sirenOn ? "Tap to silence" : "Tap to manually activate"}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </aside>
          </div>
        )}

        {activeNav === "UnitControl" && <UnitControlPage allFews={allFews} fews1Connected={isHardwareOnline} userRole={user.role} userName={user.name} addLog={addLog} token={token} onThresholdSaved={(t) => setThresholds(t)} />}
        {activeNav === "Logs"        && <LogsPage token={token} userRole={user.role} showToast={showToast} />}
        {activeNav === "Settings"    && <SettingsPage
          userRole={user.role}
          userName={user.name}
          user={user}
          onUserUpdate={(u) => {
            const normalized = normalizeUser(u);
            setUser(normalized);
            getStorage().setItem("user", JSON.stringify(normalized));
          }}
          token={token}
          addLog={addLog}
        />}
      </div>
      </div>
    </div>
    </ErrorBoundary>
  );
}