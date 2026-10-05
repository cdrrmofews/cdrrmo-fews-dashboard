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
} from "chart.js";
import annotationPlugin from "chartjs-plugin-annotation";
import Login from "./Login";

ChartJS.register(
  CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip,
  annotationPlugin
);

try { delete L.Icon.Default.prototype._getIconUrl; } catch (e) {}
L.Icon.Default.mergeOptions({
    iconRetinaUrl: "/leaflet/marker-icon-2x.png",
    iconUrl:       "/leaflet/marker-icon.png",
    shadowUrl:     "/leaflet/marker-shadow.png",
});

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

const CARTO_KEY = import.meta.env.VITE_CARTO_KEY || "";
const MAP_TILE_URL = CARTO_KEY
  ? `https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key=${CARTO_KEY}`
  : "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const MAP_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
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
        <div style={{ height:"100vh", width:"100vw", background:"#0a0a0b", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16, fontFamily:"sans-serif" }}>
          <div style={{ fontSize:36 }}>⚠️</div>
          <div style={{ color:"#e2e8f0", fontSize:18, fontWeight:700 }}>Something went wrong</div>
          <div style={{ color:"#9aa0a8", fontSize:12, maxWidth:400, textAlign:"center" }}>{this.state.error?.message || "An unexpected error occurred."}</div>
          <button onClick={() => window.location.reload()} style={{ marginTop:8, padding:"10px 24px", background:"#38bdf8", color:"#000", border:"none", borderRadius:10, fontWeight:700, fontSize:14, cursor:"pointer" }}>
            Reload Dashboard
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- PULL TO REFRESH ---
function usePullToRefresh(onRefresh) {
  const indicatorRef = useRef(null);
  const startYRef    = useRef(0);
  const pullingRef   = useRef(false);

  useEffect(() => {
    const indicator = indicatorRef.current;
    if (!indicator) return;

    const onTouchStart = (e) => {
      if (e.target?.closest?.(".map-fullscreen-overlay")) return;
      if (window.scrollY === 0 || document.documentElement.scrollTop === 0) {
        startYRef.current = e.touches[0].clientY;
        pullingRef.current = true;
      }
    };

    const onTouchMove = (e) => {
      if (!pullingRef.current) return;
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy > 10) {
        indicator.classList.add("ptr-visible");
        const deg = Math.min(dy * 2, 360);
        indicator.querySelector("svg").style.transform = `rotate(${deg}deg)`;
      } else {
        indicator.classList.remove("ptr-visible");
      }
    };

    const onTouchEnd = (e) => {
      if (!pullingRef.current) return;
      const dy = e.changedTouches[0].clientY - startYRef.current;
      pullingRef.current = false;

      if (dy > 60) {
        indicator.classList.add("ptr-spinning");
        setTimeout(() => {
          indicator.classList.remove("ptr-visible");
          indicator.classList.remove("ptr-spinning");
          indicator.querySelector("svg").style.transform = "";
          onRefresh();
        }, 400);
      } else {
        indicator.classList.remove("ptr-visible");
        indicator.querySelector("svg").style.transform = "";
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove",  onTouchMove,  { passive: true });
    document.addEventListener("touchend",   onTouchEnd,   { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove",  onTouchMove);
      document.removeEventListener("touchend",   onTouchEnd);
    };
  }, [onRefresh]);

  const PullIndicator = () => (
    <div className="ptr-indicator" ref={indicatorRef}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
      </svg>
    </div>
  );

  return { PullIndicator };
}

// --- STORAGE HELPERS ---
function isTokenExpired(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const payload = JSON.parse(atob(parts[1]));
    return payload.exp * 1000 < Date.now();
  } catch { return true; }
}

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

// Locks page scroll behind a modal while it's mounted, restores on close.
function useLockBodyScroll() {
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = original; };
  }, []);
}

// autoFocus on open is fine on desktop, but on mobile it forces the
// keyboard up mid-animation before the modal has settled — this lets
// each modal skip autoFocus below the 768px breakpoint.
function isMobileViewport() {
  return typeof window !== "undefined" && window.innerWidth <= 768;
}

// ─── RBAC HELPERS ────────────────────────────────────────────────────────────
const ROLE_ACCESS = {
  Admin:    ["Dashboard", "Statistics", "UnitControl", "Logs", "Settings"],
  Operator: ["Dashboard", "Statistics", "UnitControl", "Logs", "Settings"],
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
    return {
      name: "", role: "Operator", department: "", email: "", phone: "", photo: null,
      sms_enabled: false,
      push_enabled: true, audio_enabled: true, banner_enabled: true, ticker_enabled: true,
      unit_preference: "cm",
      initials: "?",
    };
  }
  const name = parsed.name || "";
  const initials =
    name.split(" ").filter(Boolean).map(w => w[0]).join("").slice(0, 2).toUpperCase() ||
    "?";
  return {
    name,
    role:             parsed.role             || "Operator",
    department:       parsed.department       || "",
    email:            parsed.email            || "",
    phone:            parsed.phone            || "",
    photo:            parsed.photo            || null,
    sms_enabled:      parsed.sms_enabled      ?? false,
    push_enabled:     parsed.push_enabled     ?? true,
    audio_enabled:    parsed.audio_enabled    ?? true,
    banner_enabled:   parsed.banner_enabled   ?? true,
    ticker_enabled:   parsed.ticker_enabled   ?? true,
    unit_preference:  parsed.unit_preference  || "cm",
    initials,
  };
}

// ─── FEWS BASE DATA ───────────────────────────────────────────────────────────
const FEWS1_BASE = {
  id: 1, name: "FEWS 1", location: "Bridge of Progress",
  lat: 13.762466, lng: 121.068331,
  status: "safe", waterLevel: 0,
  description: "",
  installedDate: "—",
  hw_technician: "Engr. Andrew Van Ryan / Engr. Katrina Rivera",
  sw_technician: "Zhenrel Ocampo",
  isLive: true,
};

const STATUS_CONFIG = {
  base:     { color: "#e2e8f0", bg: "rgba(226,232,240,0.12)", label: "BASE"     },
  safe:     { color: "#fde047", bg: "rgba(253,224,71,0.12)",  label: "NORMAL"   },
  warning:  { color: "#f97316", bg: "rgba(249,115,22,0.12)", label: "WARNING"  },
  danger:   { color: "#ef4444", bg: "rgba(239,68,68,0.12)",  label: "CRITICAL" },
  NORMAL:   { color: "#fde047", bg: "rgba(253,224,71,0.12)",  label: "NORMAL"   },
  WARNING:  { color: "#f97316", bg: "rgba(249,115,22,0.12)", label: "WARNING"  },
  CRITICAL: { color: "#ef4444", bg: "rgba(239,68,68,0.12)",  label: "CRITICAL" },
};

const BASELINE_CM = 100;

function getBaselineCutoff(thresholds) {
  return Math.min(BASELINE_CM, thresholds.warning);
}

// Only downgrades a live, "safe" reading into "base" when it's below the
// baseline cutoff. Warning/danger/offline pass through unchanged.
function getDisplayStatus(status, waterLevel, isActuallyLive, thresholds) {
  if (!isActuallyLive) return status;
  if (status === "safe" && waterLevel < getBaselineCutoff(thresholds)) return "base";
  return status;
}

const CM_PER_UNIT = { cm: 1, m: 100, ft: 30.48, in: 2.54 };
const UNIT_DECIMALS = { cm: 0, m: 2, ft: 1, in: 1 };

function convertCm(cm, unit = "cm") {
  if (cm == null || Number.isNaN(cm)) return null;
  const factor = CM_PER_UNIT[unit] || 1;
  return cm / factor;
}

function formatWaterLevel(cm, unit = "cm") {
  const converted = convertCm(cm, unit);
  if (converted == null) return "—";
  const decimals = UNIT_DECIMALS[unit] ?? 0;
  return `${converted.toFixed(decimals)}${unit}`;
}

function fmtCoord(n) {
  return Number(n).toFixed(4);
}

function backendStatusToKey(status) {
  if (!status) return "safe";
  switch (status.toUpperCase()) {
    case "NORMAL":   return "safe";
    case "WARNING":  return "warning";
    case "CRITICAL": return "danger";
    default:         return "safe";
  }
}

const ALL_NAV_ITEMS = [
  { key: "Dashboard",   icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>, label: "Dashboard"    },
  { key: "Statistics",  icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="21" x2="21" y2="21"/><rect x="5" y="12" width="4" height="9"/><rect x="15" y="4" width="4" height="17"/></svg>, label: "Statistics"    },  { key: "UnitControl", icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><polyline points="12 6 12 12 16 14"/><path d="M16 2l4 4-4 4"/></svg>, label: "Unit Control" },
  { key: "Logs",        icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>, label: "Logs"         },
  { key: "Settings",    icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>, label: "Settings"     },
];

const PAGE_TITLES = {
  Dashboard:   { title: "Flood Monitoring Dashboard", sub: "Live overview" },
  Statistics:  { title: "Statistics",                 sub: "Historical trends and reports" },
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
  baseline:     { label: "BASELINE",     mobileLabel: "BASE",     color: "#e2e8f0", bg: "rgba(226,232,240,0.10)" },
  info:         { label: "NORMAL",       mobileLabel: "NORMAL",   color: "#fde047", bg: "rgba(253,224,71,0.10)" },
  warning:      { label: "WARNING",      mobileLabel: "WARNING",  color: "#f97316", bg: "rgba(249,115,22,0.12)" },
  danger:       { label: "CRITICAL",     mobileLabel: "CRITICAL", color: "#ef4444", bg: "rgba(239,68,68,0.12)"  },
  connectivity: { label: "CONNECTIVITY", mobileLabel: "CONN",     color: "#a78bfa", bg: "rgba(167,139,250,0.12)" },
  system:       { label: "ACTIVITY",     mobileLabel: "ACTIVITY", color: "#38bdf8", bg: "rgba(56,189,248,0.12)" },
};

// Some ACTIVITY-type events (auto-siren) are more urgent than a routine
// activity entry (login, threshold edit, etc). This layers a visual
// override on top of the base type config, without introducing a new type.
function getLogRowCfg(l) {
  const cfg = LOG_TYPE_CFG[l.type] || LOG_TYPE_CFG["system"];
  if (l.type === "system" && l.msg.includes("automatically activated due to sustained CRITICAL")) {
    return { ...cfg, color: "#ef4444", bg: "rgba(239,68,68,0.12)" };
  }
  return cfg;
}

const LOG_TYPES_BY_ROLE = {
  Admin:    ["baseline", "info", "warning", "danger", "connectivity", "system"],
  Operator: ["baseline", "info", "warning", "danger", "connectivity"],
};

// Only water-level severity types get a dedicated count box in the stat bar —
// Activity and Connectivity stay fully filterable/exportable, just not in this row.
const READING_TYPES = ["baseline", "info", "warning", "danger"];

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

// ─── STATISTICS PAGE ──────────────────────────────────────────────────────────
function getPresetRange(preset) {
  const to = new Date();
  const from = new Date();
  if (preset === "30d") from.setDate(from.getDate() - 30);
  else if (preset === "90d") from.setDate(from.getDate() - 90);
  else if (preset === "12m") from.setFullYear(from.getFullYear() - 1);
  const toIso = (d) => d.toISOString().slice(0, 10);
  return { from: toIso(from), to: toIso(to) };
}

function getShadowRange(from, to) {
  const fromD = new Date(from + "T00:00:00");
  const toD   = new Date(to + "T00:00:00");
  const spanMs = toD - fromD;
  const shadowTo   = new Date(fromD.getTime() - 86400000);
  const shadowFrom = new Date(shadowTo.getTime() - spanMs);
  const toIso = (d) => d.toISOString().slice(0, 10);
  return { from: toIso(shadowFrom), to: toIso(shadowTo) };
}

function DeltaBadge({ current, previous, mode = "neutral", pointsMode = false, precision = 1 }) {
  if (current == null) return null;
  if (previous == null) return <div className="stats-delta stats-delta-flat">No prior-period data</div>;

  // No baseline to divide by — can't express a percentage, but we can
  // still say something instead of rendering nothing.
  if (previous === 0) {
    if (current === 0) return <div className="stats-delta stats-delta-flat">No change vs prior period</div>;
    const isUp = current > 0;
    const arrow = isUp ? "▲" : "▼";
    const amount = Number.isInteger(current) ? Math.abs(current) : Math.abs(current).toFixed(precision);
    const label = `${arrow} ${amount}${pointsMode ? "pp" : ""} more than prior period`;
    let cls = "stats-delta-neutral";
    if (mode === "goodUp")   cls = isUp ? "stats-delta-good" : "stats-delta-bad";
    if (mode === "goodDown") cls = isUp ? "stats-delta-bad"  : "stats-delta-good";
    return <div className={`stats-delta ${cls}`}>{label}</div>;
  }

  const diff = pointsMode ? (current - previous) : ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(diff) < 0.05) return <div className="stats-delta stats-delta-flat">No change vs prior period</div>;
  const isUp = diff > 0;
  const arrow = isUp ? "▲" : "▼";
  const label = `${arrow} ${Math.abs(diff).toFixed(precision)}${pointsMode ? "pp" : "%"} vs prior period`;
  let cls = "stats-delta-neutral";
  if (mode === "goodUp")   cls = isUp ? "stats-delta-good" : "stats-delta-bad";
  if (mode === "goodDown") cls = isUp ? "stats-delta-bad"  : "stats-delta-good";
  return <div className={`stats-delta ${cls}`}>{label}</div>;
}

function fmtBucketLabel(iso, bucket) {
  const d = new Date(iso + "T00:00:00");
  if (bucket === "month") return d.toLocaleDateString("en-PH", { month: "short", year: "2-digit" });
  return d.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
}

function fmtIncidentStart(iso) {
  const d = new Date(iso.replace(" ", "T").replace(/Z?$/, "Z"));
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(d);
}

function fmtDuration(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

function buildTrendChartData(waterLevel) {
  const labels = waterLevel.series.map(s => fmtBucketLabel(s.bucket_start, waterLevel.bucket));
  return {
    labels,
    datasets: [
      { label: "High",    data: waterLevel.series.map(s => s.high), borderColor: "#ef4444", backgroundColor: "transparent", tension: 0.2, pointRadius: 2, borderWidth: 2 },
      { label: "Average", data: waterLevel.series.map(s => s.avg),  borderColor: "#38bdf8", backgroundColor: "transparent", tension: 0.2, pointRadius: 2, borderWidth: 2 },
      { label: "Low",     data: waterLevel.series.map(s => s.low),  borderColor: "#e2e8f0", backgroundColor: "transparent", tension: 0.2, pointRadius: 2, borderWidth: 2 },
    ],
  };
}

function TrendChart({ waterLevel }) {
  const chartRef = useRef(null);
  const wrapRef  = useRef(null);

  // Data changed (new bucket, new range) — the chart instance is reused
  // now (no more `key` remount below), so just re-layout it once the new
  // data has painted.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (chartRef.current) chartRef.current.resize();
    });
    return () => cancelAnimationFrame(raf);
  }, [waterLevel.bucket, waterLevel.series.length]);

  // Container's actual box size changed (zoom, window resize, sidebar
  // toggle) — independent of the data-driven resize above.
  useEffect(() => {
    if (!wrapRef.current) return;
    const observer = new ResizeObserver(() => {
      if (chartRef.current) chartRef.current.resize();
    });
    observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%" }}>
      <Line
        ref={chartRef}
        data={buildTrendChartData(waterLevel)}
        options={TREND_CHART_OPTIONS}
      />
    </div>
  );
}

const TREND_CHART_OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: "#202024", titleColor: "#fff", bodyColor: "#9aa0a8",
      borderColor: "rgba(255,255,255,0.12)", borderWidth: 1,
      callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y ?? "—"} cm` },
    },
  },
  scales: {
    y: { grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: "#7e92b4", font: { size: 10 } } },
    x: { grid: { color: "rgba(255,255,255,0.04)" }, ticks: { color: "#64748b", font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
  },
};

function StatisticsPage({ userRole, token, manualFews }) {
  const [preset, setPreset]         = useState("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo]     = useState("");
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(false);

  const [waterLevel, setWaterLevel]           = useState(null);
  const [statusBreakdown, setStatusBreakdown] = useState(null);
  const [uptime, setUptime]                   = useState(null);
  const [prevWaterLevel, setPrevWaterLevel]           = useState(null);
  const [prevStatusBreakdown, setPrevStatusBreakdown] = useState(null);
  const [prevUptime, setPrevUptime]                   = useState(null);

  const range = preset === "custom" ? { from: customFrom, to: customTo } : getPresetRange(preset);
  const hasValidRange = !!(range.from && range.to);
  const shadow = hasValidRange ? getShadowRange(range.from, range.to) : null;

  useEffect(() => {
    if (!hasValidRange || !token) return;
    let cancelled = false;
    setLoading(true);
    setError(false);

    const qs  = `?date_from=${range.from}&date_to=${range.to}`;
    const qsP = `?date_from=${shadow.from}&date_to=${shadow.to}`;
    const headers = { Authorization: `Bearer ${token}` };

    const fetchJson = (url) => authFetch(url, { headers }).then(r => {
      if (!r.ok) throw new Error(`${url} → ${r.status}`);
      return r.json();
    });

    Promise.all([
      fetchJson(`${API_BASE}/stats/water-level${qs}`),
      fetchJson(`${API_BASE}/stats/status-breakdown${qs}`),
      fetchJson(`${API_BASE}/stats/uptime${qs}`),
      fetchJson(`${API_BASE}/stats/water-level${qsP}`),
      fetchJson(`${API_BASE}/stats/status-breakdown${qsP}`),
      fetchJson(`${API_BASE}/stats/uptime${qsP}`),
    ]).then(([wl, sb, up, pWl, pSb, pUp]) => {
      if (cancelled) return;
      const shapeOk = wl?.series && Array.isArray(sb) && up?.uptime_pct != null
                   && pWl?.series && Array.isArray(pSb) && pUp?.uptime_pct != null;
      if (!shapeOk) { setError(true); return; }
      setWaterLevel(wl); setStatusBreakdown(sb); setUptime(up);
      setPrevWaterLevel(pWl); setPrevStatusBreakdown(pSb); setPrevUptime(pUp);
    }).catch((e) => {
      if (e?.message !== "Unauthorized" && !cancelled) { console.error("[Statistics]", e); setError(true); }
    }).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [range.from, range.to, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const summarize = (wl, sb, up) => {
    if (!wl || !Array.isArray(sb) || !up) return null;
    const series = Array.isArray(wl.series) ? wl.series : [];
    const highs  = series.map(s => s.high).filter(v => v != null);
    const peak   = highs.length ? Math.max(...highs) : null;
    const avgs   = series.map(s => s.avg).filter(v => v != null);
    const avg    = avgs.length ? avgs.reduce((a, v) => a + v, 0) / avgs.length : null;
    const weeksWithAlerts = sb.filter(w => w.warning_pct > 0 || w.critical_pct > 0).length;
    return {
      avg:  avg  != null ? Math.round(avg * 10) / 10 : null,
      peak: peak != null ? Math.round(peak * 10) / 10 : null,
      weeksWithAlerts,
      totalWeeks: sb.length,
      uptimePct: up.uptime_pct,
    };
  };

  const current  = summarize(waterLevel, statusBreakdown, uptime);
  const previous = summarize(prevWaterLevel, prevStatusBreakdown, prevUptime);

  return (
    <div className="page-body">
      <div className="page-card stats-controls-card">
        <div className="stats-date-controls">
          {[
            { key: "30d", label: "Last 30 days" },
            { key: "90d", label: "Last 90 days" },
            { key: "12m", label: "Last 12 months" },
          ].map(p => (
            <button key={p.key} className={`stats-preset-btn ${preset === p.key ? "stats-preset-active" : ""}`} onClick={() => { setPreset(p.key); setCustomFrom(""); setCustomTo(""); }}>
              {p.label}
            </button>
          ))}
          <DateRangeFilter
            from={customFrom}
            to={customTo}
            onChange={(v) => { setCustomFrom(v.from); setCustomTo(v.to); setPreset("custom"); }}
          />
        </div>
      </div>

      {preset === "custom" && !hasValidRange ? (
        <div className="page-card"><div className="page-card-sub" style={{ marginBottom: 0 }}>Pick a custom date range to view statistics.</div></div>
      ) : loading ? (
        <div className="page-card"><div className="page-card-sub" style={{ marginBottom: 0 }}>Loading statistics…</div></div>
      ) : error ? (
        <div className="page-card"><div className="settings-error">⚠️ Failed to load statistics — check your connection and try refreshing.</div></div>
      ) : (
        <>
          <div className="stats-summary-grid">
            <div className="stats-card">
              <div className="stats-card-label">Average Water Level</div>
              <div className="stats-card-value">{current?.avg != null ? `${current.avg} cm` : "—"}</div>
              <DeltaBadge current={current?.avg} previous={previous?.avg} mode="neutral" />
            </div>
            <div className="stats-card">
              <div className="stats-card-label">Peak Reading</div>
              <div className="stats-card-value">{current?.peak != null ? `${current.peak} cm` : "—"}</div>
              <DeltaBadge current={current?.peak} previous={previous?.peak} mode="neutral" />
            </div>
            <div className="stats-card">
              <div className="stats-card-label">Weeks With Alerts</div>
              <div className="stats-card-value">{current ? `${current.weeksWithAlerts} of ${current.totalWeeks}` : "—"}</div>
              <DeltaBadge current={current?.weeksWithAlerts} previous={previous?.weeksWithAlerts} mode="goodDown" />
            </div>
            <div className="stats-card">
              <div className="stats-card-label">FEWS 1 Uptime</div>
              <div className="stats-card-value">{current?.uptimePct != null ? `${current.uptimePct}%` : "—"}</div>
              <DeltaBadge current={current?.uptimePct} previous={previous?.uptimePct} mode="goodUp" pointsMode precision={2} />
            </div>
          </div>

          <div className="page-card stats-chart-card">
            <div className="card-header stats-header-grid">
              <h2>Water Level Trend</h2>
              <div className="wl-legend-row">
                <span className="wl-legend"><span className="wl-legend-dot" style={{ background: "#ef4444" }} />High</span>
                <span className="wl-legend"><span className="wl-legend-dot" style={{ background: "#38bdf8" }} />Average</span>
                <span className="wl-legend"><span className="wl-legend-dot" style={{ background: "#e2e8f0" }} />Low</span>
              </div>
              <span className="card-tag">By {waterLevel?.bucket || "—"}</span>
            </div>
            {waterLevel?.series?.length ? (
              <div className="stats-chart-wrap">
                <TrendChart waterLevel={waterLevel} />
              </div>
            ) : (
              <div className="stats-chart-empty">No water level data for this range.</div>
            )}
          </div>

          <div className="stats-grid-pair">
            <div className="page-card stats-breakdown-card">
              <div className="card-header stats-header-grid">
                <h2>Status Breakdown by Week</h2>
                <div className="wl-legend-row">
                  <span className="wl-legend"><span className="wl-legend-dot" style={{ background: "#e2e8f0" }} />Base</span>
                  <span className="wl-legend"><span className="wl-legend-dot" style={{ background: "#fde047" }} />Normal</span>
                  <span className="wl-legend"><span className="wl-legend-dot" style={{ background: "#f97316" }} />Warning</span>
                  <span className="wl-legend"><span className="wl-legend-dot" style={{ background: "#ef4444" }} />Critical</span>
                </div>
              </div>
              {statusBreakdown?.length ? (
                <div className="stats-breakdown-list">
                  {statusBreakdown.map(w => (
                    <div key={w.week_start} className="stats-breakdown-row">
                      <span className="stats-breakdown-week">{fmtBucketLabel(w.week_start, "week")}</span>
                      <div className="stats-breakdown-bar">
                        {w.base_pct > 0     && <div style={{ width: `${w.base_pct}%`,     background: "#e2e8f0" }} title={`Base: ${w.base_pct}%`} />}
                        {w.normal_pct > 0   && <div style={{ width: `${w.normal_pct}%`,   background: "#fde047" }} title={`Normal: ${w.normal_pct}%`} />}
                        {w.warning_pct > 0  && <div style={{ width: `${w.warning_pct}%`,  background: "#f97316" }} title={`Warning: ${w.warning_pct}%`} />}
                        {w.critical_pct > 0 && <div style={{ width: `${w.critical_pct}%`, background: "#ef4444" }} title={`Critical: ${w.critical_pct}%`} />}
                      </div>
                      <span className="stats-breakdown-count">{w.total_readings} readings</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="stats-chart-empty">No status data for this range.</div>
              )}
            </div>

            <div className="page-card stats-donut-card">
              <div className="card-header stats-header-grid">
                <h2>Manual Station Health</h2>
                <span className="card-tag">{manualFews.length} stations</span>
              </div>
              {manualFews.length ? (() => {
                const serviceable = manualFews.filter(m => m.status === "serviceable").length;
                const total = manualFews.length;
                const pct = total ? Math.round((serviceable / total) * 100) : 0;
                const circumference = 2 * Math.PI * 40;
                const dashLength = (pct / 100) * circumference;
                return (
                  <div className="stats-donut-row">
                    <svg viewBox="0 0 100 100" className="stats-donut-svg">
                      <circle cx="50" cy="50" r="40" fill="none" stroke="var(--bg-raised)" strokeWidth="14" />
                      <circle
                        cx="50" cy="50" r="40" fill="none" stroke="#22c55e" strokeWidth="14"
                        strokeDasharray={`${dashLength} ${circumference}`}
                        strokeLinecap="round"
                        transform="rotate(-90 50 50)"
                      />
                      <text x="50" y="46" textAnchor="middle" className="stats-donut-pct">{pct}%</text>
                      <text x="50" y="62" textAnchor="middle" className="stats-donut-sub">serviceable</text>
                    </svg>
                    <div className="stats-donut-legend">
                      <div className="stats-donut-legend-row">
                        <span className="stats-donut-dot" style={{ background: "#22c55e" }} />
                        Serviceable <strong>{serviceable}</strong>
                      </div>
                      <div className="stats-donut-legend-row">
                        <span className="stats-donut-dot" style={{ background: "var(--bg-raised)", border: "1px solid var(--border)" }} />
                        Unserviceable <strong>{total - serviceable}</strong>
                      </div>
                    </div>
                  </div>
                );
              })() : (
                <div className="stats-chart-empty">No manual station data available.</div>
              )}
            </div>
          </div>

          <div className="page-card">
            <div className="card-header stats-header-grid">
              <h2>Offline Incidents</h2>
              <span className="card-tag">FEWS 1 · gaps ≥ 5 min</span>
            </div>
            {uptime?.worst_incidents?.length ? (
              <div className="stats-incidents-list">
                {uptime.worst_incidents.map((inc, i) => (
                  <div key={i} className={`stats-incident-row ${inc.ongoing ? "stats-incident-ongoing" : ""}`}>
                    <span className="stats-incident-start">{fmtIncidentStart(inc.start_ts)}</span>
                    <span className="stats-incident-duration">{fmtDuration(inc.duration_sec)}</span>
                    {inc.ongoing && <span className="stats-incident-badge">ONGOING</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="stats-chart-empty">No offline incidents of 5+ minutes in this range.</div>
            )}
          </div>
        </>
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
    { value: "All",         label: "All Stations" },
    { value: "System",      label: "System"       },
    { value: "FEWS 1",      label: "Fews 1"       },
    { value: "Manual FEWS", label: "Manual Fews"  },
  ];

  const typeOptions = [
    { value: "All", label: "All Types" },
    ...allowedTypes.map(t => ({ value: t, label: LOG_TYPE_CFG[t]?.label || t })),
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
          {allowedTypes.filter(t => READING_TYPES.includes(t)).map(t => {
            const cfg = LOG_TYPE_CFG[t];
            return (
              <div key={t} className="logs-stat-item">
                <span className="logs-stat-count" style={{ color: cfg.color }}>{counts[t] ?? 0}</span>
                <span className="logs-stat-label">
                  <span className="stat-label-full">{cfg.label}</span>
                  <span className="stat-label-abbr">{cfg.mobileLabel}</span>
                </span>
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
            const cfg = getLogRowCfg(l);
            const isFlaggedActivity = l.type === "system" && cfg.color === "#ef4444";
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
                    <span className="type-badge-full">{cfg.label}</span>
                    <span className="type-badge-abbr">{cfg.mobileLabel}</span>
                  </span>
                </span>
                <span className="logs-col-msg" style={{ color: READING_TYPES.includes(l.type) || isFlaggedActivity ? cfg.color : "var(--text-2)" }}>
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
  const data = [...meta, header, ...rows.map(r => [r.date, r.time, r.station, LOG_TYPE_CFG[r.type]?.label || r.type.toUpperCase(), r.msg])];
  const doIt = () => {
    const wb = window.XLSX.utils.book_new();
    const ws = window.XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = [{ wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 9 }, { wch: 80 }];
    window.XLSX.utils.book_append_sheet(wb, ws, "FEWS Logs");
    const now = new Date();
    const todayStr = now.toLocaleDateString("en-CA");
    const fromStr = filterSummary.includes("From:") ? filterSummary.match(/From: (\S+)/)?.[1] || "" : "";
    const toStr   = filterSummary.includes("To:")   ? filterSummary.match(/To: (\S+)/)?.[1]   || "" : "";
    let datePart;
    if (fromStr && toStr && fromStr === toStr) datePart = fromStr;
    else if (fromStr && toStr)                 datePart = `${fromStr}_to_${toStr}`;
    else                                       datePart = `All_${todayStr}`;
    window.XLSX.writeFile(wb, `FEWS_Incident-Log_${datePart}.xlsx`);
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
    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const centerX = pageW / 2;

    const drawTable = (startY, logo3 = null) => {
      doc.autoTable({
        startY,
        margin: { top: 120, left: 30, right: 30 },
        tableLineColor: [255, 255, 255],
        tableLineWidth: 0,
        head: [["Date", "Time", "Station", "Type", "Message"]],
        body: rows.map(r => {
          const cfg = LOG_TYPE_CFG[r.type];
          const typeLabel = r.type === "connectivity"
            ? (cfg?.mobileLabel || r.type.toUpperCase())   // stays "CONN"
            : (cfg?.label || r.type.toUpperCase());        // full label, e.g. "BASELINE"
          return [r.date, r.time, r.station, typeLabel, r.msg];
        }),
        styles: { fontSize: 8, cellPadding: 5 },
        headStyles: { fillColor: [17, 29, 53], textColor: [226, 232, 240], fontStyle: "bold" },
        alternateRowStyles: { fillColor: [245, 248, 252] },
        columnStyles: {
          0: { cellWidth: 58 },
          1: { cellWidth: 48 },
          2: { cellWidth: 40 },
          3: { cellWidth: 52 },
          4: { cellWidth: "auto" },
        },
        theme: "grid",
        didDrawPage: (data) => {
          const pg = doc.internal.getCurrentPageInfo().pageNumber;

          // Header on every page after page 1
          if (pg > 1 && logo3) {
            const margin = 30;
            const imgW2 = pageW - margin * 2;
            doc.addImage(logo3, "PNG", margin, 20, imgW2, 110, "cdrrmoLogo");
          }
          // Footer — just page number
          doc.setFontSize(7);
          doc.setTextColor(100, 116, 139);
          doc.text(
            `CDRRMO FEWS · Batangas City · Page ${pg}`, 
            centerX, pageH - 12,
            { align: "center" }
          );
        },
      });
      const now = new Date();
      const todayStr = now.toLocaleDateString("en-CA");
      const fromStr = filterSummary.includes("From:") ? filterSummary.match(/From: (\S+)/)?.[1] || "" : "";
      const toStr   = filterSummary.includes("To:")   ? filterSummary.match(/To: (\S+)/)?.[1]   || "" : "";
      let datePart;
      if (fromStr && toStr && fromStr === toStr) datePart = fromStr;
      else if (fromStr && toStr)                 datePart = `${fromStr}_to_${toStr}`;
      else                                       datePart = `All_${todayStr}`;
      doc.save(`FEWS_Incident-Log_${datePart}.pdf`);
    };

    const drawHeader = (logo3) => {
      const margin = 30;
      const imgW = pageW - margin * 2;
      const imgH = 110;
      let y = margin;

      if (logo3) {
        doc.addImage(logo3, "PNG", margin, y, imgW, imgH, "cdrrmoLogo");
        y += imgH - 10;
      }

      // Divider line
      doc.setDrawColor(0, 0, 0);
      doc.setLineWidth(0.5);
      doc.line(30, y, pageW - 30, y);

      // Report title
      y += 12;
      doc.setFont("times", "bold");
      doc.setFontSize(11);
      doc.setTextColor(0, 0, 0);
      doc.text("FEWS INCIDENT LOG REPORT", centerX, y, { align: "center" });

      // Filters & generated
      y += 11;
      doc.setFont("times", "normal");
      doc.setFontSize(8);
      doc.setTextColor(80, 80, 80);
      doc.text(`Filters: ${filterSummary || "None"}`, centerX, y, { align: "center" });

      y += 10;
      doc.text(`Generated: ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}  ·  ${rows.length} records`, centerX, y, { align: "center" });

      y += 14;
      return y;
    };

    // Load both logos
    const logo3Img = new Image();
    logo3Img.src = "/logo3.png";
    logo3Img.onload = () => {
      const startY = drawHeader(logo3Img);
      drawTable(startY, logo3Img);
    };
    logo3Img.onerror = () => {
      const startY = drawHeader(null);
      drawTable(startY, null);
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
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
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
    const r = 0.002; // ~200m radius
    const bounds = [
      [fews.lat - r, fews.lng - r],
      [fews.lat + r, fews.lng + r],
    ];
    map.flyToBounds(bounds, {
      paddingTopLeft: [20, 90],
      paddingBottomRight: [20, 20],
      duration: 0.6,
    });
  }, [fewsId]);
  return null;
}

function OpenPopup({ fews, markerRefs }) {
  const fewsId = fews?.id ?? null;
  useEffect(() => {
    if (!fewsId) {
      // Close all popups when deselected
      Object.values(markerRefs.current).forEach(marker => {
        if (marker) marker.closePopup();
      });
      return;
    }
    const t = setTimeout(() => {
      const markerRef = markerRefs.current[fewsId];
      if (markerRef) markerRef.openPopup();
    }, 700);
    return () => clearTimeout(t);
  }, [fewsId]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Covers FEWS 1 plus manual stations 2–14 and 16–18, all clustered
// around Batangas City proper. Deliberately excludes FEWS 15 (Talahib
// Pandayan), which sits ~15km south and would force an extreme zoom-out
// if included — its popup just opens off-screen until the user pans out.
const CITY_DEFAULT_BOUNDS = [[13.744, 121.050], [13.766, 121.082]];

// FEWS 1 close-up — the dashboard map's home view (also used by its center button)
const DASH_DEFAULT_BOUNDS = [[13.760466, 121.066331], [13.764466, 121.070331]];

function OpenAllPopups({ fewsList, markerRefs, active }) {
  const map = useMap();
  useEffect(() => {
    if (!active) return;
    if (fewsList.length === 0) return;

    // Single upfront pan, same as before — autoPan={false} on the popups
    // means none of them can trigger their own pan, so this is safe
    // regardless of which bounds we fit to.
    map.fitBounds(CITY_DEFAULT_BOUNDS, { padding: [20, 20] });

    const t = setTimeout(() => {
      fewsList.forEach(f => {
        const markerRef = markerRefs.current[f.id];
        if (markerRef) markerRef.openPopup();
      });
    }, 700);
    return () => clearTimeout(t);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Hands the Leaflet map instance to a ref so buttons outside <MapContainer> can drive it
function MapRefSetter({ mapRef }) {
  const map = useMap();
  useEffect(() => {
    mapRef.current = map;
    return () => { mapRef.current = null; };
  }, [map, mapRef]);
  return null;
}

// Leaflet only re-measures its container on window resize. Collapsing the
// sidebar resizes the container without a window resize, so we watch the
// container ourselves and tell Leaflet to re-measure.
function MapResizeWatcher() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = null;
    const observer = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => map.invalidateSize({ animate: false }));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [map]);
  return null;
}

const CenterIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3"/>
    <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
    <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
  </svg>
);
const ExpandIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 8 3 3 8 3"/><polyline points="16 3 21 3 21 8"/>
    <polyline points="21 16 21 21 16 21"/><polyline points="8 21 3 21 3 16"/>
  </svg>
);
const CollapseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="8 3 8 8 3 8"/><polyline points="21 8 16 8 16 3"/>
    <polyline points="16 21 16 16 21 16"/><polyline points="3 16 8 16 8 21"/>
  </svg>
);

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

// Fullscreen marker: dot + "FEWS 1 - LIVE" style label. iconSize is 0x0 so the
// dot sits exactly on the coordinate; CSS positions the label above it.
function makeFsLabelIcon({ name, statusWord, statusColor, markerColor, markerBorderColor, showPulse, isSel }) {
  return L.divIcon({
    className: "",
    html: `<div class="fs-mk">
      <span class="fs-lb ${isSel ? "fs-lb-sel" : ""}">${escapeHtml(name)} - <span style="color:${statusColor}">${statusWord}</span></span>
      <div class="fs-dot-wrap">
        <div class="fs-dot ${isSel ? "fs-dot-sel" : ""}" style="background:${markerColor};border-color:${markerBorderColor};box-shadow:0 0 8px ${markerColor}"></div>
        ${showPulse ? `<div class="radar-pulse" style="width:14px;height:14px;background:${markerColor};top:0;left:0;"></div>` : ""}
      </div>
    </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

// Px of map hidden behind the open drawer (desktop) — used so flyTo centers on the visible part
const FS_DRAWER_PAD = 384;

// Phone bottom sheet covers this fraction of the screen height (keep in sync with `height: 55%` in App.css)
const FS_SHEET_VH = 0.55;

// Map padding (right, bottom) so flyTo keeps the target in the visible part of the map
function fsInsets(drawerOpen) {
  if (!drawerOpen) return { right: 20, bottom: 20 };
  if (isMobileViewport()) return { right: 20, bottom: Math.round(window.innerHeight * FS_SHEET_VH) + 20 };
  return { right: FS_DRAWER_PAD, bottom: 20 };
}

// DB text sometimes has a literal "\n" at the end; turn it into a real line break and trim
function cleanText(s) {
  return String(s ?? "").replace(/\\n/g, "\n").trim();
}

function FsDrawer({
  open, onToggle, stations, selectedId, onSelect, onBack,
  isHardwareOnline, thresholds, unitPref, todayStats, lastUpdatedStr,
  fews1Info, sirens, sirenLoading, canSiren, onToggleSiren,
}) {
  const [query, setQuery]   = useState("");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  useEffect(() => { setCopied(false); }, [selectedId]);

  const selected = selectedId != null ? stations.find(s => s.id === selectedId) : null;
  const clean = (v) => (v && v !== "—" ? v : "");

  // Phone-only (hidden by CSS on desktop): chevron that collapses the sheet
  const collapseBtn = (extra = "") => (
    <button type="button" className={`fs-dr-collapse ${extra}`} onClick={onToggle} aria-label="Hide station panel">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
  );

  const present = (f) => {
    if (f.isLive) {
      const online = isHardwareOnline;
      const ds  = getDisplayStatus(f.status, f.waterLevel, online, thresholds);
      const cfg = STATUS_CONFIG[ds] || STATUS_CONFIG.safe;
      return {
        online, cfg,
        dot:        online ? cfg.color : "#64748b",
        badge:      online ? "LIVE" : "WAITING",
        badgeColor: online ? "#22c55e" : "#94a3b8",
        badgeBg:    online ? "rgba(34,197,94,0.15)" : "rgba(148,163,184,0.12)",
      };
    }
    const ok = f.manualStatus === "serviceable";
    return {
      online: false, cfg: null,
      dot:        ok ? "#38bdf8" : "#64748b",
      badge:      ok ? "SERVICEABLE" : "UNSERVICEABLE",
      badgeColor: ok ? "#38bdf8" : "#9aa0a8",
      badgeBg:    ok ? "rgba(56,189,248,0.12)" : "rgba(255,255,255,0.06)",
    };
  };

  const renderRow = (f) => {
    const p = present(f);
    return (
      <button key={f.id} type="button" className="fs-dr-row" onClick={() => onSelect(f.id)}>
        <span className="fs-dr-dot" style={{ background: p.dot }} />
        <span className="fs-dr-row-info">
          <span className="fs-dr-row-name">{f.name}</span>
          <span className="fs-dr-row-loc">{f.location || "—"}</span>
        </span>
        <span className="fs-dr-badge" style={{ color: p.badgeColor, background: p.badgeBg }}>{p.badge}</span>
      </button>
    );
  };

  const renderList = () => {
    const q = query.trim().toLowerCase();
    const shown = q
      ? stations.filter(f => `${f.name} ${f.location || ""}`.toLowerCase().includes(q))
      : stations;
    const live   = shown.filter(f => f.isLive);
    const manual = shown.filter(f => !f.isLive);
    return (
      <>
        <div className="fs-dr-head">
          <span className="fs-dr-title">Stations</span>
          <span className="fs-dr-count">{stations.length} total</span>
          {collapseBtn()}
        </div>
        <div className="fs-dr-search">
          <input className="fs-dr-search-input" placeholder="Search stations" value={query}
            onChange={e => setQuery(e.target.value)} />
        </div>
        <div className="fs-dr-body">
          {live.length > 0 && (
            <>
              <div className="fs-dr-sec-label">Live · {live.length}</div>
              {live.map(renderRow)}
            </>
          )}
          {manual.length > 0 && (
            <>
              <div className="fs-dr-sec-label">Manual · {manual.length}</div>
              {manual.map(renderRow)}
            </>
          )}
          {live.length === 0 && manual.length === 0 && (
            <div className="fs-dr-empty">No stations match your search.</div>
          )}
        </div>
      </>
    );
  };

  const renderDetails = (f) => {
    const p = present(f);
    const info = f.isLive
      ? {
          description: cleanText(fews1Info.description),
          installed:   clean(fews1Info.installed_date) || clean(f.installedDate),
          hw:          clean(fews1Info.hw_technician)  || clean(f.hw_technician),
          sw:          clean(fews1Info.sw_technician)  || clean(f.sw_technician),
        }
      : {
          description: cleanText(f.description),
          installed:   clean(f.installedDate),
          hw:          clean(f.hw_technician),
          sw:          "",
        };
    const today = todayStats[`fews_${f.id}`] || {};
    const sirenOn = !!sirens[f.id];

    return (
      <>
        <div className="fs-dr-head">
          <button type="button" className="fs-dr-back" onClick={onBack} aria-label="Back to station list">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span className="fs-dr-title">{f.name}</span>
          <span className="fs-dr-badge" style={{
            marginLeft: "auto",
            color:      f.isLive ? p.badgeColor : "var(--text-2)",
            background: f.isLive ? p.badgeBg    : "rgba(255,255,255,0.06)",
          }}>
            {f.isLive ? p.badge : "MANUAL"}
          </span>
          {collapseBtn("fs-dr-collapse-end")}
        </div>

        <div className="fs-dr-body">
          {f.isLive ? (
            <div className="fs-dr-hero">
              <div className="fs-dr-hero-val" style={{ color: p.online ? p.cfg.color : "var(--text-3)" }}>
                {p.online ? convertCm(f.waterLevel, unitPref)?.toFixed(UNIT_DECIMALS[unitPref] ?? 0) : "—"}
                {p.online && <span className="fs-dr-hero-unit">{unitPref}</span>}
              </div>
              <span className="fs-dr-hero-pill" style={{ color: p.online ? p.cfg.color : "var(--text-3)", background: p.online ? p.cfg.bg : "rgba(255,255,255,0.06)" }}>
                {p.online ? p.cfg.label : "OFFLINE"}
              </span>
            </div>
          ) : (
            <div className="fs-dr-hero">
              <div className="fs-dr-hero-val fs-dr-hero-word">MANUAL</div>
              <span className="fs-dr-hero-pill" style={{ color: p.badgeColor, background: p.badgeBg }}>{p.badge}</span>
            </div>
          )}

          {f.isLive && (
            <div className="fs-dr-sec">
              <div className="fs-dr-kv"><span>Last sync</span><strong>{lastUpdatedStr ?? "—"}</strong></div>
              <div className="fs-dr-kv"><span>Today's highest</span><strong>{today.high != null ? formatWaterLevel(today.high, unitPref) : "—"}</strong></div>
              <div className="fs-dr-kv"><span>Today's lowest</span><strong>{today.low != null ? formatWaterLevel(today.low, unitPref) : "—"}</strong></div>
              <div className="fs-dr-kv"><span>Warning at</span><strong style={{ color: "#f97316" }}>{formatWaterLevel(thresholds.warning, unitPref)}</strong></div>
              <div className="fs-dr-kv"><span>Critical at</span><strong style={{ color: "var(--red)" }}>{formatWaterLevel(thresholds.danger, unitPref)}</strong></div>
            </div>
          )}

          {info.description && (
            <div className="fs-dr-sec">
              <div className="fs-dr-sec-title">Description</div>
              <div className="fs-dr-desc">{info.description}</div>
            </div>
          )}

          <div className="fs-dr-sec">
            <div className="fs-dr-sec-title">Details</div>
            <div className="fs-dr-kv"><span>Location</span><strong>{f.location || "—"}</strong></div>
            {info.installed && <div className="fs-dr-kv"><span>Installed</span><strong>{info.installed}</strong></div>}
            {info.hw && <div className="fs-dr-kv"><span>Hardware</span><strong>{info.hw}</strong></div>}
            {info.sw && <div className="fs-dr-kv"><span>Software</span><strong>{info.sw}</strong></div>}
            <div className="fs-dr-kv">
              <span>Coordinates</span>
              <strong style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{fmtCoord(f.lat)}, {fmtCoord(f.lng)}</strong>
            </div>
          </div>

          {f.isLive && canSiren && (
          <div className="fs-dr-sec fs-dr-siren-in">
            <div className="rsb-siren-label">Siren Control</div>
            <div className="rsb-siren-row">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: sirenOn && p.online ? "var(--red)" : (p.online ? "var(--text-2)" : "var(--text-3)") }}>
                {sirenOn && p.online ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                )}
                {sirenOn && p.online ? "Active" : "Off"}
              </span>
              <button
                type="button"
                className={`siren-btn ${sirenOn && p.online ? "siren-on" : "siren-off"}`}
                onClick={() => onToggleSiren(f.id)}
                disabled={!p.online || sirenLoading[f.id]}
              >
                {sirenLoading[f.id]
                  ? <span className="btn-spinner" style={{ width: 10, height: 10, borderWidth: 1.5, borderTopColor: sirenOn && p.online ? "#fff" : "var(--text-2)", borderColor: sirenOn && p.online ? "rgba(255,255,255,0.25)" : "rgba(126,146,180,0.25)" }} />
                  : sirenOn && p.online ? "SILENCE" : "MANUAL ON"}
              </button>
            </div>
            <div className="rsb-siren-note">
              {!p.online ? "Available if fews is live" : sirenOn ? "Tap to silence" : "Tap to manually activate"}
            </div>
          </div>
          )}
        </div>

        <div className="fs-dr-foot">
          <button type="button" className="fs-dr-btn" onClick={() => {
            navigator.clipboard.writeText(`${f.lat}, ${f.lng}`);
            setCopied(true);
            if (copyTimer.current) clearTimeout(copyTimer.current);
            copyTimer.current = setTimeout(() => setCopied(false), 1500);
          }}>
            {copied ? "Copied!" : "Copy"}
          </button>
          <a className="fs-dr-btn" href={`https://www.google.com/maps?q=${f.lat},${f.lng}`} target="_blank" rel="noopener noreferrer">
            Open in Maps
          </a>
        </div>
      </>
    );
  };

  return (
    <>
      <button type="button"
        className={`fs-dr-toggle ${open ? "fs-dr-toggle-open" : ""}`}
        onClick={onToggle}
        title={open ? "Hide station panel" : "Show station panel"}
        aria-label={open ? "Hide station panel" : "Show station panel"}>
        <svg className="fs-ic-side" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>
        </svg>
        <svg className="fs-ic-bottom" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="15" x2="21" y2="15"/>
        </svg>
      </button>
      {open && (
        <aside className="fs-drawer">
          <button type="button" className="fs-dr-handle" onClick={onToggle} aria-label="Hide station panel">
            <span />
          </button>
          {selected ? renderDetails(selected) : renderList()}
        </aside>
      )}
    </>
  );
}

// ─── MODALS ───────────────────────────────────────────────────────────────────
function ConfirmModal({ icon, iconColor, title, message, confirmLabel, confirmColor, onConfirm, onCancel, confirmLoading }) {
  useLockBodyScroll();

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !confirmLoading) onCancel(); }}>
      <div className="modal-box">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {icon && <div className="modal-icon" style={{ color: iconColor, marginBottom: 0 }}>{icon}</div>}
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-msg">{message}</div>
        <div className="modal-actions">
          <button className="modal-btn modal-cancel" onClick={onCancel} disabled={confirmLoading}>Cancel</button>
          <button className="modal-btn" style={{ background: confirmColor || "var(--blue)", color: "#fff", minWidth: 90 }}
            onClick={onConfirm} disabled={confirmLoading}>
            {confirmLoading ? <span className="btn-spinner" style={{ borderTopColor: "#fff", borderColor: "rgba(255,255,255,0.25)" }} /> : confirmLabel}
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
  const [saving, setSaving] = useState(false);

  useLockBodyScroll();

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
      onClose();
    } catch (err) {
      if (err?.message === "Unauthorized") return;
      setError("Network error. Try again.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal-box" style={{ alignItems: "stretch", gap: 14 }}>
        <div className="modal-title" style={{ textAlign: "left" }}>Change Email</div>
        <div className="modal-msg" style={{ textAlign: "left", marginBottom: 0 }}>
          Current: <span style={{ color: "var(--blue)", fontSize: 12 }}>{user.email}</span>
        </div>
        <div className="settings-field">
          <label className="settings-label">New Email</label>
          <input className="settings-input" type="email" placeholder="you@cdrrmo.gov.ph"
            value={email} onChange={e => { setEmail(e.target.value); setError(""); }} autoFocus={!isMobileViewport()} />
        </div>
        <div className="settings-field">
          <label className="settings-label">Confirm New Email</label>
          <input className="settings-input" type="email" placeholder="you@cdrrmo.gov.ph"
            value={confirm} onChange={e => { setConfirm(e.target.value); setError(""); }} />
        </div>
        {error && <div className="settings-error">{error}</div>}
        <div className="modal-actions" style={{ marginTop: 4 }}>
          <button className="modal-btn modal-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="modal-btn modal-confirm" onClick={handle} disabled={saving}>
            {saving ? <span className="btn-spinner" /> : "Save"}
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

  useLockBodyScroll();

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
      onClose();
    } catch (err) {
      if (err?.message === "Unauthorized") return;
      setError("Network error. Try again.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="modal-box" style={{ alignItems: "stretch", gap: 14 }}>
        <div className="modal-title" style={{ textAlign: "left" }}>Change Password</div>
        <div className="modal-msg" style={{ textAlign: "left", marginBottom: 0 }}>Update your login credentials.</div>
        <div className="settings-field">
          <label className="settings-label">Current Password</label>
          <input className="settings-input" type="password" placeholder="••••••••"
            value={pw.current} onChange={e => { setPw(p => ({...p, current: e.target.value})); setError(""); }} autoFocus={!isMobileViewport()} />
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
          <button className="modal-btn modal-confirm" onClick={handle} disabled={saving}>
            {saving ? <span className="btn-spinner" /> : "Update"}
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
  const [saving, setSaving] = useState(false);

  useLockBodyScroll();

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
      onClose();
    } catch (err) {
      if (err?.message === "Unauthorized") return;
      setError("Network error. Try again.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
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
            value={phone} onChange={e => { setPhone(e.target.value); setError(""); }} autoFocus={!isMobileViewport()} />
        </div>
        <div className="settings-field">
          <label className="settings-label">Confirm Phone Number</label>
          <input className="settings-input" type="tel" placeholder="+639XXXXXXXXX"
            value={phoneConfirm} onChange={e => { setConfirm(e.target.value); setError(""); }} />
        </div>
        {error && <div className="settings-error">{error}</div>}
        <div className="modal-actions" style={{ marginTop: 4 }}>
          <button className="modal-btn modal-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="modal-btn modal-confirm" onClick={handle} disabled={saving}>
            {saving ? <span className="btn-spinner" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ADD USER MODAL ───────────────────────────────────────────────────────────
const EMPTY_ADD_FORM = { name: "", email: "", password: "", role: "Operator", department: "MIAD", phone: "" };

function AddUserModal({ onAdd, onClose, token, addLog }) {
  const [form, setForm]     = useState(EMPTY_ADD_FORM);
  const [error, setError]   = useState("");
  const [saving, setSaving] = useState(false);

  useLockBodyScroll();

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
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
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
              autoComplete="off" autoFocus={!isMobileViewport()}
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
                options={["MIAD", "OPS", "ITSD"]}
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
// Default avatar shown when a user has no profile photo (head + shoulders).
// Fills its container; the circular overflow:hidden parent clips the shoulders.
function DefaultAvatar() {
  return (
    <svg width="100%" height="100%" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="9" r="4.2" />
      <path d="M3.5 24c0-5.2 3.8-8.2 8.5-8.2s8.5 3 8.5 8.2z" />
    </svg>
  );
}

function ProfileDropdown({ user, token, onSave, onClose, addLog }) {
  const ref                   = useRef();
  const fileRef               = useRef();
  const [editing, setEditing] = useState(false);
  const [name, setName]       = useState(user.name);
  const [photo, setPhoto]     = useState(user.photo || null);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState("");

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose; // always call the latest one, no stale closure

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onCloseRef.current(); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    const handleScroll = () => onCloseRef.current();
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, []); // ← attach once, never torn down while mounted

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
                : <DefaultAvatar />
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
                : <DefaultAvatar />
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

const MANUAL_STATUS_OPTIONS = ["Serviceable", "Unserviceable"];

function ManualFewsCard({ m, canControl, token, manualEditing, setManualEditing, manualSaving, setManualSaving, manualError, setManualError, onSaved }) {
  const ed = manualEditing[m.id];
  const isServiceable = m.status === "serviceable";

  const startEdit = () => {
    setManualEditing(prev => ({
      ...prev,
      [m.id]: {
        latitude:       String(m.latitude),
        longitude:      String(m.longitude),
        installed_date: m.installed_date || "",
        status:         isServiceable ? "Serviceable" : "Unserviceable",
        hw_technician:  m.hw_technician || "",
        description:    m.description || "",
      }
    }));
  };

  const cancelEdit = () => {
    setManualEditing(prev => { const n = { ...prev }; delete n[m.id]; return n; });
    setManualError(prev => ({ ...prev, [m.id]: "" }));
  };

  const save = async () => {
    const draft = manualEditing[m.id];
    const lat = parseFloat(draft.latitude);
    const lng = parseFloat(draft.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      setManualError(prev => ({ ...prev, [m.id]: "Latitude and longitude must be valid numbers." }));
      return;
    }
    setManualSaving(prev => ({ ...prev, [m.id]: true }));
    setManualError(prev => ({ ...prev, [m.id]: "" }));
    try {
      const res = await fetch(`${API_BASE}/manual-units/${m.device_id}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          latitude:       lat,
          longitude:      lng,
          installed_date: draft.installed_date,
          status:         draft.status.toLowerCase(),
          hw_technician:  draft.hw_technician,
          description:    draft.description,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setManualError(prev => ({ ...prev, [m.id]: data.detail || "Failed to save." }));
        return;
      }
      onSaved(data);
      cancelEdit();
    } catch {
      setManualError(prev => ({ ...prev, [m.id]: "Network error. Try again." }));
    } finally {
      setManualSaving(prev => ({ ...prev, [m.id]: false }));
    }
  };

  return (
    <div className={`uc-card ${!isServiceable ? "uc-card-offline" : ""}`} style={{ "--status-color": "#38bdf8" }}>
      <div className="uc-card-header">
        <div className="uc-card-left">
          <div className="uc-status-dot" style={{ background: isServiceable ? "#38bdf8" : "#334155" }} />
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="uc-card-name">{m.name}</div>
              <span style={{
                fontSize: 10, fontWeight: 700, fontFamily: "var(--mono)",
                background: "rgba(56,189,248,0.12)", color: "var(--text-3)",
                border: "1px solid rgba(56,189,248,0.2)",
                borderRadius: 999, padding: "2px 7px", letterSpacing: "0.07em"
              }}>
                <span className="uc-manual-icon">◌</span> MANUAL
              </span>
            </div>
            <div className="uc-card-loc">📍 {m.location}, Batangas City</div>
          </div>
        </div>
        <div className="uc-card-right">
          <div className="uc-badge uc-badge-manual" style={{
            color: isServiceable ? "#38bdf8" : "var(--text-3)",
            background: isServiceable ? "rgba(56,189,248,0.12)" : "rgba(255,255,255,0.04)"
          }}>
            {isServiceable ? "SERVICEABLE" : "UNSERVICEABLE"}
          </div>
        </div>
      </div>

      <div className="uc-stats-row">
        <div className="uc-stat">
          <span className="uc-stat-label">Coordinates</span>
          {ed ? (
            <div style={{ display: "flex", gap: 4 }}>
              <input className="uc-inline-input" type="number" step="any" value={ed.latitude}
                onChange={e => setManualEditing(prev => ({ ...prev, [m.id]: { ...prev[m.id], latitude: e.target.value } }))} />
              <input className="uc-inline-input" type="number" step="any" value={ed.longitude}
                onChange={e => setManualEditing(prev => ({ ...prev, [m.id]: { ...prev[m.id], longitude: e.target.value } }))} />
            </div>
          ) : <span className="uc-stat-val" style={{ fontFamily:"var(--mono)", fontSize:10 }}>{m.latitude}, {m.longitude}</span>}
        </div>
        <div className="uc-stat">
          <span className="uc-stat-label">Installed</span>
          {ed ? (
            <input className="uc-inline-input" value={ed.installed_date}
              onChange={e => setManualEditing(prev => ({ ...prev, [m.id]: { ...prev[m.id], installed_date: e.target.value } }))} />
          ) : <span className="uc-stat-val">{m.installed_date || "—"}</span>}
        </div>
        <div className="uc-stat">
          <span className="uc-stat-label">Status</span>
          {ed ? (
            <MuDropdown value={ed.status} options={MANUAL_STATUS_OPTIONS}
              onChange={val => setManualEditing(prev => ({ ...prev, [m.id]: { ...prev[m.id], status: val } }))} />
          ) : <span className="uc-stat-val">{isServiceable ? "Serviceable" : "Unserviceable"}</span>}
        </div>
        <div className="uc-stat" style={{ flex: 1 }}>
          <span className="uc-stat-label">Hardware Technician</span>
          {ed ? (
            <input className="uc-inline-input" value={ed.hw_technician}
              onChange={e => setManualEditing(prev => ({ ...prev, [m.id]: { ...prev[m.id], hw_technician: e.target.value } }))} />
          ) : <span className="uc-stat-val">{m.hw_technician || "—"}</span>}
        </div>
      </div>

      <div className="uc-desc-section">
        <div className="uc-desc-header">
          <span className="uc-thr-label">Station Description</span>
          {canControl && !ed && (
            <button className="uc-edit-btn" onClick={startEdit}>✎ Edit</button>
          )}
          {canControl && ed && (
            <div style={{ display:"flex", gap:6 }}>
              <button className="uc-edit-btn" onClick={cancelEdit}>Cancel</button>
              <button className="uc-save-info-btn" onClick={save}>{manualSaving[m.id] ? <span className="btn-spinner" /> : "Save"}</button>
            </div>
          )}
        </div>
        {ed ? (
          <textarea className="uc-desc-textarea" rows={3} value={ed.description}
            onChange={e => setManualEditing(prev => ({ ...prev, [m.id]: { ...prev[m.id], description: e.target.value } }))} />
        ) : <div className="uc-description">{m.description || "—"}</div>}
        {manualError[m.id] && <div className="settings-error" style={{ fontSize: 11, marginTop: 4 }}>{manualError[m.id]}</div>}
      </div>
    </div>
  );
}

function UnitControlPage({ allFews, manualFews, fews1Connected, userRole, userName, unitPreference, addLog, token, onThresholdSaved, onManualUnitSaved }) {
  const liveFewsOnly = allFews.filter(f => f.isLive);
  const manualFewsOnly = manualFews;

  const [fewsData, setFewsData]           = useState(liveFewsOnly.map(f => ({ ...f })));
  const [thresholds, setThr]              = useState(Object.fromEntries(liveFewsOnly.map(f => [f.id, { warning: 200, danger: 300 }])));
  const [prevThresholds, setPrevThr]      = useState(Object.fromEntries(liveFewsOnly.map(f => [f.id, { warning: 200, danger: 300 }])));
  const [thrSaving, setThrSaving]         = useState({});
  const [thrConfirm, setThrConfirm]       = useState(null);
  const [editing, setEditing]             = useState({});
  const [infoSaving, setInfoSaving]       = useState({});
  const [loadError, setLoadError]         = useState(false);
  const [thrError, setThrError]           = useState({});
  const [infoError, setInfoError]         = useState({});
  const [initialLoad, setInitialLoad]     = useState(true);

  const [manualEditing, setManualEditing] = useState({});
  const [manualSaving, setManualSaving]   = useState({});
  const [manualError, setManualError]     = useState({});

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
            installedDate:  row.installed_date  || f.installedDate,
            hw_technician:  row.hw_technician   || f.hw_technician,
            sw_technician:  row.sw_technician   || f.sw_technician,
            description:    row.description     || f.description,
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
      })
      .finally(() => setInitialLoad(false));
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
      if (thr.warning !== prev.warning) addLog({ station: f.name, type: "system", message: `${f.name} (${f.location}) warning threshold updated from ${prev.warning} cm to ${thr.warning} cm by ${userName}` });
      if (thr.danger  !== prev.danger)  addLog({ station: f.name, type: "system", message: `${f.name} (${f.location}) danger threshold updated from ${prev.danger} cm to ${thr.danger} cm by ${userName}` });
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
    setEditing(prev => ({ ...prev, [id]: { installedDate: f.installedDate, hw_technician: f.hw_technician, sw_technician: f.sw_technician, description: f.description } }));
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
          hw_technician:  snapshot.hw_technician,
          sw_technician:  snapshot.sw_technician,
          description:    snapshot.description,
        }),
      });
      if (!res.ok) { setInfoError(prev => ({ ...prev, [id]: "Failed to save. Try again." })); return; }
      setFewsData(prev => prev.map(x => x.id === id ? { ...x, ...snapshot } : x));
      addLog({ station: f.name, type: "system", message: `${f.name} (${f.location}) station information updated by ${userName}` });
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
                Warning will be set to <strong style={{ color: "var(--amber)" }}>{formatWaterLevel(confirmThr?.warning, unitPreference)}</strong> and Danger to <strong style={{ color: "var(--red)" }}>{formatWaterLevel(confirmThr?.danger, unitPreference)}</strong>. This will also update the Arduino device.
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

        <div style={{ fontSize: 9, fontWeight: 700, color: "var(--text-3)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Live · {liveFewsOnly.length}
        </div>

        {!initialLoad && liveFewsOnly.map(f => {
          const localData = fewsData.find(x => x.id === f.id) || f;
          const thr = thresholds[f.id];
          const isActuallyLive = f.isLive && fews1Connected;
          const displayStatus = getDisplayStatus(f.status, f.waterLevel, isActuallyLive, thr);
          const cfg = STATUS_CONFIG[displayStatus] || STATUS_CONFIG["safe"];
          const ed  = editing[f.id];
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
                          fontSize: 10, fontWeight: 700, fontFamily: "var(--mono)",
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
                </div>
              </div>

              <div className="uc-stats-row">
                <div className="uc-stat">
                  <span className="uc-stat-label">Water Level</span>
                  <span className="uc-stat-val" style={{ color: isActuallyLive ? cfg.color : "var(--text-3)" }}>
                    {isActuallyLive ? formatWaterLevel(f.waterLevel, unitPreference) : "—"}
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
                  ) : <span className="uc-stat-val">{localData.installedDate}</span>}
                </div>
                <div className="uc-stat" style={{ flex: 1 }}>
                  <span className="uc-stat-label">Hardware Technician</span>
                  {ed ? (
                    <input className="uc-inline-input" value={ed.hw_technician}
                      onChange={e => setEditing(prev => ({ ...prev, [f.id]: { ...prev[f.id], hw_technician: e.target.value } }))} />
                  ) : <span className="uc-stat-val">{localData.hw_technician}</span>}
                </div>
                <div className="uc-stat" style={{ flex: 1 }}>
                  <span className="uc-stat-label">Software Technician</span>
                  {ed ? (
                    <input className="uc-inline-input" value={ed.sw_technician}
                      onChange={e => setEditing(prev => ({ ...prev, [f.id]: { ...prev[f.id], sw_technician: e.target.value } }))} />
                  ) : <span className="uc-stat-val">{localData.sw_technician}</span>}
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
                ) : <div className="uc-description">{localData.description}</div>}
                {infoError[f.id] && <div className="settings-error" style={{ fontSize: 11, marginTop: 4 }}>{infoError[f.id]}</div>}
              </div>

              {canControl && (
                <div className="uc-thr-section">
                  <div className="uc-thr-label">Alert Thresholds</div>
                  <div className="uc-thr-row">
                    <div className="uc-thr-field">
                      <label className="uc-thr-field-label">⚠ Warning ({unitPreference})</label>
                      <div className="uc-thr-stepper">
                        <button type="button" className="uc-thr-step-btn"
                          disabled={!isActuallyLive || thr.warning <= 100}
                          onClick={() => setThr(prev => ({ ...prev, [f.id]: { ...prev[f.id], warning: prev[f.id].warning - 100 } }))}>
                          −
                        </button>
                        <span className="uc-thr-step-val">{formatWaterLevel(thr.warning, unitPreference)}</span>
                        <button type="button" className="uc-thr-step-btn"
                          disabled={!isActuallyLive || thr.warning >= 300}
                          onClick={() => setThr(prev => ({ ...prev, [f.id]: { ...prev[f.id], warning: prev[f.id].warning + 100 } }))}>
                          +
                        </button>
                      </div>
                    </div>
                    <div className="uc-thr-field">
                      <label className="uc-thr-field-label">🔴 Critical ({unitPreference})</label>
                      <div className="uc-thr-stepper">
                        <button type="button" className="uc-thr-step-btn"
                          disabled={!isActuallyLive || thr.danger <= 200}
                          onClick={() => setThr(prev => ({ ...prev, [f.id]: { ...prev[f.id], danger: prev[f.id].danger - 100 } }))}>
                          −
                        </button>
                        <span className="uc-thr-step-val">{formatWaterLevel(thr.danger, unitPreference)}</span>
                        <button type="button" className="uc-thr-step-btn"
                          disabled={!isActuallyLive || thr.danger >= 600}
                          onClick={() => setThr(prev => ({ ...prev, [f.id]: { ...prev[f.id], danger: prev[f.id].danger + 100 } }))}>
                          +
                        </button>
                      </div>
                    </div>
                    <button className="uc-thr-save" disabled={!isActuallyLive} onClick={() => {
                      const thr = thresholds[f.id];
                      if (!thr.warning || thr.warning < 100 || thr.warning % 100 !== 0) {
                        setThrError(p => ({ ...p, [f.id]: "Warning must be a multiple of 100 and at least 100cm." })); return;
                      }
                      if (!thr.danger || thr.danger > 600 || thr.danger % 100 !== 0) {
                        setThrError(p => ({ ...p, [f.id]: "Danger must be a multiple of 100 and at most 600cm." })); return;
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

        <div style={{ fontSize: 9, fontWeight: 700, color: "var(--text-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 8 }}>
          Manual · {manualFewsOnly.length}
        </div>

        {manualFewsOnly.map(m => (
          <ManualFewsCard
            key={m.id}
            m={m}
            canControl={canControl}
            token={token}
            manualEditing={manualEditing}
            setManualEditing={setManualEditing}
            manualSaving={manualSaving}
            setManualSaving={setManualSaving}
            manualError={manualError}
            setManualError={setManualError}
            onSaved={onManualUnitSaved}
          />
        ))}
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

  useEffect(() => {
    if (!open) return;
    const handleScroll = () => setOpen(false);
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [open]);

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

  useEffect(() => {
    if (!open) return;
    const handleScroll = () => setOpen(false);
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [open]);

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
  const [open, setOpen]       = useState(false);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0 });
  const ref        = useRef();
  const triggerRef = useRef();

  useEffect(() => {
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target) &&
          !(e.target.closest && e.target.closest(".mu-dd-menu-portal"))) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleScroll = () => setOpen(false);
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [open]);

  const toggleOpen = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    }
    setOpen(o => !o);
  };

  const selected = options.find(o => o === value) || value;

  return (
    <div className="mu-dd-wrap" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        className={`mu-dd-trigger ${open ? "mu-dd-open" : ""}`}
        onClick={toggleOpen}
      >
        <span className="mu-dd-label">{selected}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" className="mu-dd-chevron">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && createPortal(
        <div
          className="mu-dd-menu mu-dd-menu-portal"
          style={{ position: "fixed", top: menuPos.top, left: menuPos.left, minWidth: menuPos.width }}
        >
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
        </div>,
        document.body
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
  const [confirmSave, setConfirmSave]         = useState(null);
  const [confirmSaveLoading, setConfirmSaveLoading] = useState(false);
  const [confirmRemove, setConfirmRemove]   = useState(null);
  const [confirmNotif, setConfirmNotif]               = useState(null);
  const [confirmNotifLoading, setConfirmNotifLoading] = useState(false);
  const [confirmUnit, setConfirmUnit]                 = useState(null);
  const [confirmUnitLoading, setConfirmUnitLoading]   = useState(false);

  const isAdmin = userRole === "Admin";

  const handleNotifToggle = async (key, newVal) => {
    setConfirmNotifLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/users/me/notifications`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ [key]: newVal }),
      });
      if (res.ok) {
        onUserUpdate(normalizeUser({ ...user, [key]: newVal }));

        // Push toggled off — actively unsubscribe this browser, not just the DB flag
        if (key === "push_enabled" && newVal === false && 'serviceWorker' in navigator) {
          try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            if (sub) {
              await sub.unsubscribe();
              await authFetch(`${API_BASE}/push/unsubscribe`, {
                method:  "DELETE",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body:    JSON.stringify({ subscription: sub.toJSON() }),
              });
            }
          } catch (e) {
            console.warn('[PUSH] Unsubscribe failed:', e);
          }
        }
      } else {
        setActionError("Failed to update alert preference. Try again.");
      }
    } catch (err) {
      if (err?.message !== "Unauthorized") setActionError("Failed to update alert preference. Try again.");
    }
    setConfirmNotifLoading(false);
    setConfirmNotif(null);
  };

  const handleUnitChange = async (newUnit) => {
    setConfirmUnitLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/users/me/display`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ unit_preference: newUnit }),
      });
      if (res.ok) {
        onUserUpdate(normalizeUser({ ...user, unit_preference: newUnit }));
      } else {
        setActionError("Failed to update measurement unit. Try again.");
      }
    } catch (err) {
      if (err?.message !== "Unauthorized") setActionError("Failed to update measurement unit. Try again.");
    }
    setConfirmUnitLoading(false);
    setConfirmUnit(null);
  };
  
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
    setConfirmSaveLoading(true);
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
        setConfirmSaveLoading(false);
        setConfirmSave(null);
      } else {
        setActionError("Failed to save changes. Try again.");
        setConfirmSaveLoading(false);
        setConfirmSave(null);
      }
    } catch (err) {
      if (err?.message !== "Unauthorized") setActionError("Failed to save changes. Try again.");
      setConfirmSaveLoading(false);
      setConfirmSave(null);
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
      {confirmNotif && <ConfirmModal
        icon={confirmNotif.newVal ? "🔔" : "🔕"}
        iconColor={confirmNotif.newVal ? "var(--green)" : "var(--red)"}
        title={confirmNotif.newVal ? `Turn on ${confirmNotif.label}?` : `Turn off ${confirmNotif.label}?`}
        message={confirmNotif.newVal ? `You'll start receiving alerts for ${confirmNotif.label}.` : `You'll stop receiving alerts for ${confirmNotif.label}.`}
        confirmLabel={confirmNotif.newVal ? "Yes, Turn On" : "Yes, Turn Off"}
        confirmColor={confirmNotif.newVal ? "var(--green)" : "var(--red)"}
        confirmLoading={confirmNotifLoading}
        onConfirm={() => handleNotifToggle(confirmNotif.key, confirmNotif.newVal)}
        onCancel={() => { if (!confirmNotifLoading) setConfirmNotif(null); }} />}
      {confirmUnit && <ConfirmModal
        icon="📏"
        iconColor="var(--blue)"
        title={`Switch display unit to ${confirmUnit}?`}
        message="This changes how water levels appear across the dashboard for your account only."
        confirmLabel="Yes, Switch"
        confirmLoading={confirmUnitLoading}
        onConfirm={() => handleUnitChange(confirmUnit)}
        onCancel={() => { if (!confirmUnitLoading) setConfirmUnit(null); }} />}
      {confirmSave   && <ConfirmModal icon="👤" iconColor="var(--blue)" title={`Save Changes for ${confirmSave.name}?`} message={`Role → ${getDraft(confirmSave).role} · Department → ${getDraft(confirmSave).department}`} confirmLabel="Yes, Save" confirmLoading={confirmSaveLoading} onConfirm={doSave} onCancel={() => { if (!confirmSaveLoading) setConfirmSave(null); }} />}
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
                          options={["MIAD", "OPS", "ITSD"]}
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

        <div className="page-card">
          <div className="page-card-title">Alert Preferences</div>
          <div className="page-card-sub">Control how you receive alerts from FEWS.</div>
          <div className="settings-toggle-table">
            {[
              { key: "push_enabled",   icon: "🔔", label: "Push Notifications",   sub: "Browser/phone alerts for CRITICAL events" },
              { key: "audio_enabled",  icon: "🔊", label: "Alert Sound",           sub: "Play siren audio when an alert is active" },
              { key: "banner_enabled", icon: "🚨", label: "Critical Alert Banner", sub: "Show the scrolling banner during CRITICAL events" },
              { key: "ticker_enabled", icon: "📊", label: "Water Level Ticker",    sub: "Show the rolling 5-hour reading ticker" },
            ].map(({ key, icon, label, sub }) => (
              <div key={key} className="settings-toggle-row">
                <div className="settings-toggle-info">
                  <div className="settings-toggle-label">{icon} {label}</div>
                  <div className="settings-toggle-sub">{sub}</div>
                </div>
                <button
                  className={`settings-toggle ${user[key] ? "stoggle-on" : "stoggle-off"}`}
                  onClick={() => setConfirmNotif({ key, label, newVal: !user[key] })}
                >
                  {user[key] ? "ON" : "OFF"}
                </button>
              </div>
            ))}
          </div>
        </div>        

        <div className="page-card">
          <div className="page-card-title">Display Preferences</div>
          <div className="page-card-sub">How water levels are shown across the dashboard.</div>
          <div className="settings-toggle-table">
            <div className="settings-toggle-row">
              <div className="settings-toggle-info">
                <div className="settings-toggle-label">📏 Measurement Unit</div>
                <div className="settings-toggle-sub">Thresholds and logs always stay in centimeters.</div>
              </div>
              <MuDropdown
                value={user.unit_preference || "cm"}
                options={["cm", "m", "ft", "in"]}
                onChange={val => setConfirmUnit(val)}
              />
            </div>
          </div>
        </div>

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

  const showToast = useCallback((msg, persistent = false) => {
    const id = Date.now() + Math.random();
    setToasts(prev => {
      // Persistent toasts (the "update available" banner) shouldn't stack —
      // replace any existing persistent toast instead of adding another one.
      const base = persistent ? prev.filter(t => !t.persistent) : prev;
      return [...base, { id, msg, leaving: false, persistent }];
    });
    if (!persistent) {
      setTimeout(() => {
        setToasts(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t));
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== id));
        }, 220);
      }, 3500);
    }
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
          <div key={t.id} className={`toast ${t.leaving ? "toast-leaving" : ""} ${t.persistent ? "toast-persistent" : ""}`}>
            <span className="toast-icon">{t.persistent ? "🔄" : "⚠"}</span>
            <span className="toast-msg">{t.msg}</span>
            {t.persistent
              ? <button className="toast-close toast-refresh-btn" onClick={async () => {
                  if ('serviceWorker' in navigator) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map(r => r.unregister()));
                  }
                  if ('caches' in window) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map(k => caches.delete(k)));
                  }
                  window.location.reload(true);
                }}>↺</button>
              : <button className="toast-close" onClick={() => dismiss(t.id)}>✕</button>
            }
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
      if (isTokenExpired(tok)) {
        clearStoredSession();
        return false;
      }
      const parsed = JSON.parse(stored);
      return !!(parsed && typeof parsed.name === "string" && parsed.name && parsed.role);
    } catch { return false; }
  });
  const [showLogoutModal, setShowLogoutModal]         = useState(false);
  const [showProfileDropdown, setShowProfileDropdown] = useState(false);
  const [sidebarOpen, setSidebarOpen]                 = useState(() => !isMobileViewport());
  const [selectedFEWS, setSelectedFEWS]               = useState(null);
  const [activeNav, setActiveNav]                     = useState(() => {
    return sessionStorage.getItem("activeNav") || "Dashboard";
  });
  const markerRefs = useRef({});
  const dashMapRef = useRef(null);
  const mapCardRef = useRef();
  const [copiedId, setCopiedId] = useState(null);
  const avatarBtnRef = useRef();
  const copiedTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    };
  }, []);
  
  const [fews1Live, setFews1Live]                 = useState(null);
  const [fews1Connected, setFews1Connected]       = useState(false);
  const [fews1StatusOnline, setFews1StatusOnline] = useState(false);
  const [fews1DataRecent, setFews1DataRecent]     = useState(false);

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
  const [sirens, setSirens] = useState({ 1: false });
  const [manualFews, setManualFews] = useState(() => {
    try {
      const cached = sessionStorage.getItem("manualFews");
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });

  const fetchManualUnits = useCallback((retriesLeft = 1) => {
    if (!token) return;
    authFetch(`${API_BASE}/manual-units`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null)) // null = failed request, not "no manual units"
      .then(rows => {
        if (Array.isArray(rows)) {
          setManualFews(rows);
          try { sessionStorage.setItem("manualFews", JSON.stringify(rows)); } catch {}
        } else if (retriesLeft > 0) {
          // Bad response (likely a cold backend right after redeploy) — retry once shortly after
          setTimeout(() => fetchManualUnits(retriesLeft - 1), 4000);
        }
        // if retries are exhausted, keep whatever's already in state/sessionStorage
        // rather than clobbering it with an empty list
      })
      .catch(() => {
        if (retriesLeft > 0) setTimeout(() => fetchManualUnits(retriesLeft - 1), 4000);
      });
  }, [token]);

  useEffect(() => {
    fetchManualUnits();
    const id = setInterval(fetchManualUnits, 60000);
    return () => clearInterval(id);
  }, [fetchManualUnits]);
  const pollUnitsNowRef = useRef(null);
  const [sirenLoading, setSirenLoading] = useState({});
  
  const activeNavRef = useRef(activeNav);
  useEffect(() => { activeNavRef.current = activeNav; }, [activeNav]);

  const sirenAudioRef = useRef(null);
  useEffect(() => {
    if (!sirenAudioRef.current) {
      sirenAudioRef.current = new Audio("/siren.mp3");
      sirenAudioRef.current.loop = true;
    }
    if (sirens[1] && user.audio_enabled) {
      sirenAudioRef.current.play().catch(() => {});
    } else {
      sirenAudioRef.current.pause();
      sirenAudioRef.current.currentTime = 0;
    }
  }, [sirens[1], user.audio_enabled]);
  const [thresholds, setThresholds] = useState({ warning: 200, danger: 300 });
  const [fews1Info, setFews1Info] = useState({});
  const { showToast, ToastContainer: AppToastContainer } = useToast();

  const handlePullRefresh = useCallback(() => {
    fetch(`${API_BASE}/data/latest`)
      .then(r => r.json())
      .then(data => { if (data.fews_1) setFews1Live(data.fews_1); })
      .catch(() => {});
    fetch(`${API_BASE}/data/history`)
      .then(r => r.json())
      .then(rows => {
        if (!Array.isArray(rows)) return;
        const GAP_THRESHOLD = 45 * 60 * 1000;
        const rawTimestamps = rows.map(r => new Date(r.timestamp.replace(" ","T").replace(/Z?$/,"Z")).getTime());
        const rawValues     = rows.map(r => r.water_level_cm);
        const rawLabels     = rows.map(r =>
          new Intl.DateTimeFormat("en-PH", {
            timeZone:"Asia/Manila", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false,
          }).format(new Date(r.timestamp.replace(" ","T").replace(/Z?$/,"Z")))
        );
        const positions = [], values = [], exactLabels = [];
        for (let i = 0; i < rawTimestamps.length; i++) {
          if (i > 0 && rawTimestamps[i] - rawTimestamps[i-1] > GAP_THRESHOLD) {
            positions.push(rawTimestamps[i-1]+1000); values.push(null); exactLabels.push("");
          }
          positions.push(rawTimestamps[i]); values.push(rawValues[i]); exactLabels.push(rawLabels[i]);
        }
        setHistoryData({ positions, values, exactLabels });
      })
      .catch(() => {});
    if (pollUnitsNowRef.current) pollUnitsNowRef.current();
  }, []);

  const { PullIndicator } = usePullToRefresh(handlePullRefresh);

  useEffect(() => {
    if (!isLoggedIn) return;
    let currentVersion = null;

    const checkVersion = async () => {
      try {
        const res = await fetch(`${API_BASE}/version`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.deployed_at) return;
        if (currentVersion === null) {
          currentVersion = data.deployed_at;
        } else if (data.deployed_at !== currentVersion) {
          currentVersion = data.deployed_at;

          if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg?.waiting) {
              reg.waiting.postMessage('SKIP_WAITING');
              navigator.serviceWorker.addEventListener('controllerchange', () => {
                window.location.reload();
              }, { once: true });
              showToast("CDRRMO FEWS Dashboard has been updated. Please refresh to get the latest version.", true);
              return;
            }
          }

          showToast("CDRRMO FEWS Dashboard has been updated. Please refresh to get the latest version.", true);
        }
      } catch {
        // ignore
      }
    };

    checkVersion();
    const id = setInterval(checkVersion, 60000);
    return () => clearInterval(id);
  }, [isLoggedIn]);

  useEffect(() => {
    if (!token) return;
    let timeoutId = null;
    let failCount = 0;

    const pollUnits = () => {
        if (activeNavRef.current !== "Dashboard") {
            timeoutId = setTimeout(pollUnits, 15000);
            return;
        }
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
                setSirens(prev => {
                  const next = { ...prev };
                  Object.entries(sirenMap).forEach(([id, val]) => {
                    next[id] = val;
                  });
                  return next;
                });

                const fews1Row = rows.find(r => r.device_id === "fews_1");
                if (fews1Row) {
                    setThresholds({
                        warning: fews1Row.threshold_warning ?? 200,
                        danger:  fews1Row.threshold_danger  ?? 300,
                    });
                    setFews1Info({
                        description:   fews1Row.description,
                        installed_date: fews1Row.installed_date,
                        hw_technician: fews1Row.hw_technician,
                        sw_technician: fews1Row.sw_technician,
                    });
                }
            })
            .catch(() => { failCount += 1; })
            .finally(() => {
                const delay = failCount === 0 ? 15000 : failCount <= 2 ? 30000 : 45000;
                timeoutId = setTimeout(pollUnits, delay);
            });
    };

    pollUnitsNowRef.current = () => {
        if (timeoutId) clearTimeout(timeoutId);
        pollUnits();
    };

    pollUnits();
    return () => {
        if (timeoutId) clearTimeout(timeoutId);
        pollUnitsNowRef.current = null;
    };
}, [token]);

  const [todayStats, setTodayStats] = useState({});

  useEffect(() => {
    let timeoutId = null;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/data/today-range`);
        if (res.ok) {
          const data = await res.json();
          setTodayStats(data);
        }
      } catch {
        // silent — retries next tick
      } finally {
        timeoutId = setTimeout(poll, 60000);
      }
    };
    poll();
    return () => { if (timeoutId) clearTimeout(timeoutId); };
  }, []);

  // ── Poll own profile every 30s to sync alert preferences across devices ──
  useEffect(() => {
    if (!token || !user?.name) return;
    let timeoutId = null;

    const pollProfile = async () => {
      try {
        const res = await authFetch(`${API_BASE}/users`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const rows = await res.json();
          const me = Array.isArray(rows) ? rows.find(u => u.email === user.email) : null;
          if (me) {
            setUser(prev => {
              const merged = normalizeUser({
                ...prev,
                push_enabled:     me.notif_push_enabled,
                audio_enabled:    me.notif_audio_enabled,
                banner_enabled:   me.notif_banner_enabled,
                ticker_enabled:   me.notif_ticker_enabled,
                unit_preference:  me.unit_preference,
              });
              getStorage().setItem("user", JSON.stringify(merged));
              return merged;
            });
          }
        }
      } catch {
        // silent — retries next tick
      } finally {
        timeoutId = setTimeout(pollProfile, 60000);
      }
    };

    pollProfile();
    return () => { if (timeoutId) clearTimeout(timeoutId); };
  }, [token, user.email]);

  const [historyData, setHistoryData] = useState({ positions: [], values: [], exactLabels: [] });
  const [hadDataBefore, setHadDataBefore] = useState(() => {
  return sessionStorage.getItem("fews1_had_data") === "true";
});

  const [chartNow, setChartNow] = useState(() => Date.now());
  const [showTicker, setShowTicker]     = useState(false);
  const [tickerLeaving, setTickerLeaving] = useState(false);
  const [tickerOffset, setTickerOffset]   = useState(0);
  useEffect(() => {
    const id = setInterval(() => setChartNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!historyData?.values?.length) return;

    const WINDOW = 80; // seconds — duration of 2 full loops
    const INTERVAL = 30 * 60; // 30 minutes in seconds

    const tick = () => {
      const now = new Date();
      const totalSecs = now.getMinutes() * 60 + now.getSeconds();
      const secsIntoBoundary = totalSecs % INTERVAL;
      const shouldShow = secsIntoBoundary < WINDOW;

      setShowTicker(prevShow => {
        if (shouldShow && !prevShow) {
          // Just entered the window — set offset ONCE, then never touch it again
          setTickerOffset(secsIntoBoundary);
          setTickerLeaving(false);
        } else if (!shouldShow && prevShow) {
          // Just left the window
          setTickerLeaving(false);
          setTickerOffset(0);
        }
        return shouldShow;
      });
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [historyData?.values?.length]);

  const userNameRef = useRef(user.name);
  useEffect(() => { userNameRef.current = user.name; }, [user.name]);

  const addLog = useCallback(async ({ station, type, message }) => {
    const tok = sessionStorage.getItem("token") || token;
    if (!tok) return;
    try {
      await fetch(`${API_BASE}/logs`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ station, type, message, user_name: userNameRef.current }),
      });
    } catch {
      // Silently ignore
    }
  }, [token]);

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
    sessionStorage.removeItem("manualFews");
    setIsLoggedIn(false);
    setUser(normalizeUser({}));
    setToken("");
    setShowLogoutModal(false);
    setSelectedFEWS(null);
    setSirens({ 1: false });
    setFews1Live(null);
    setFews1Connected(false);
    setFews1DataRecent(false);
    setHistoryData({ positions: [], values: [], exactLabels: [] });
    setHadDataBefore(false);
    setShowProfileDropdown(false);
    setSidebarOpen(!isMobileViewport());
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
        setSidebarOpen(!isMobileViewport());
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
    // fews1StatusOnline is driven purely by /status/fews1 poll — don't touch it here

    if (wasConnectedRef.current === false) {
      offlineTimeRef.current = null;
      setFews1DataRecent(false); // Reset so stale data doesn't show on reconnect
      sessionStorage.removeItem("fews1_offline_time");
      sessionStorage.removeItem("fews1_was_offline");
    } else if (wasConnectedRef.current === null) {
      sessionStorage.setItem("fews1_initial_logged", "true");
    }

    wasConnectedRef.current = true;
  }, []);

  const handleOffline = useCallback(() => {
    setFews1Connected(false);
    setFews1DataRecent(false);
    // Note: fews1StatusOnline is driven by /status/fews1 poll independently
    // so we don't reset it here — the status poll will handle its own timeout

    if (wasConnectedRef.current === true && !offlineTimeRef.current) {
      const offlineTime = Date.now();
      offlineTimeRef.current = offlineTime;
      sessionStorage.setItem("fews1_offline_time", String(offlineTime));
      sessionStorage.setItem("fews1_was_offline", "true");
      sessionStorage.removeItem("fews1_initial_logged");
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
          const isRecent = lastSeen && (Date.now() - lastSeen.getTime()) < 7200000; // 60 mins

        setFews1Live(data.fews_1);
          if (isRecent) {
            setFews1DataRecent(true);
            handleOnline();
            failCount.current = 0;
            // Kick units poll so siren state updates immediately
            if (pollUnitsNowRef.current) pollUnitsNowRef.current();
          } else {
            setFews1DataRecent(false);
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
        const delay = failCount.current === 0 ? 15000
                    : failCount.current === 1 ? 25000
                    : failCount.current === 2 ? 35000
                    : 45000;
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
        const delay = statusFailCount === 0 ? 15000
                    : statusFailCount === 1 ? 25000
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

      const GAP_THRESHOLD = 45 * 60 * 1000;
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
      if (activeNavRef.current !== "Dashboard") {
        historyTimeoutId = setTimeout(scheduledFetch, 45000);
        return;
      }
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
        const delay = historyFailCount.current === 0 ? 45000
                    : historyFailCount.current === 1 ? 60000
                    : historyFailCount.current === 2 ? 90000
                    : 120000;
        historyTimeoutId = setTimeout(scheduledFetch, delay);
      }
    };

    scheduledFetch();
    return () => {
      if (historyTimeoutId) clearTimeout(historyTimeoutId);
    };
  }, []);

  const isHardwareOnline = fews1StatusOnline;

  const allFews = useMemo(() => {
      let fews1 = { ...FEWS1_BASE };
      if (fews1Live) {
        fews1 = {
          ...fews1,
          lat: fews1Live.latitude,
          lng: fews1Live.longitude,
        };
        if (isHardwareOnline) {
          fews1 = {
            ...fews1,
            waterLevel: fews1Live.water_level_cm,
            status:     backendStatusToKey(fews1Live.status),
          };
        }
      }
      const manualMapped = manualFews.map(m => ({
        id:            m.device_id,
        name:          m.name,
        location:      m.location,
        lat:           m.latitude,
        lng:           m.longitude,
        isLive:        false,
        manualStatus:  m.status,
        description:   m.description,
        hw_technician: m.hw_technician,
        installedDate: m.installed_date,
      }));
      return [fews1, ...manualMapped];
    }, [fews1Live, isHardwareOnline, manualFews]);

    const isCritical = useMemo(() => 
      isHardwareOnline && fews1DataRecent && allFews.some(f => f.status === "danger"),
      [allFews, isHardwareOnline, fews1DataRecent]
    );

    const prevCriticalRef = useRef(false);
    useEffect(() => { prevCriticalRef.current = isCritical; }, [isCritical]);

    useEffect(() => {
      if (!isLoggedIn || !user.push_enabled) return;
      const setupPush = async () => {
        try {
          if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
          const reg = await navigator.serviceWorker.ready;
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') return;
          const res  = await fetch(`${API_BASE}/push/vapid-public-key`);
          const { publicKey } = await res.json();
          if (!publicKey) return;
          const urlBase64ToUint8 = (base64String) => {
            const padding = '='.repeat((4 - base64String.length % 4) % 4);
            const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
            const raw     = window.atob(base64);
            return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
          };
          const existing = await reg.pushManager.getSubscription();
          const sub = existing || await reg.pushManager.subscribe({
            userVisibleOnly:      true,
            applicationServerKey: urlBase64ToUint8(publicKey),
          });
          const tok = getStoredToken();
          await fetch(`${API_BASE}/push/subscribe`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
            body:    JSON.stringify({ subscription: sub.toJSON() }),
          });
          console.log('[PUSH] Subscribed successfully');
        } catch (e) {
          console.warn('[PUSH] Setup failed:', e);
        }
      };
      setupPush();
    }, [isLoggedIn, user.push_enabled]);

    const [sirenConfirm, setSirenConfirm] = useState(null);
    const [fullscreenMap, setFullscreenMap] = useState(false);
    const [fsSelectedFEWS, setFsSelectedFEWS] = useState(null);
    const [fsDrawerOpen, setFsDrawerOpen] = useState(() => !isMobileViewport());
    const fsMapRef = useRef(null);

    const closeFullscreen = () => {
      setFullscreenMap(false);
      setFsSelectedFEWS(null);
      setFsDrawerOpen(!isMobileViewport());
    };

    const handleDashCenter = () => {
      setSelectedFEWS(null);
      dashMapRef.current?.flyToBounds(DASH_DEFAULT_BOUNDS, { padding: [20, 20], duration: 0.6 });
    };
    const flyFsToCity = () => {
      const ins = fsInsets(fsDrawerOpen);
      fsMapRef.current?.flyToBounds(CITY_DEFAULT_BOUNDS, {
        paddingTopLeft: [20, 20], paddingBottomRight: [ins.right, ins.bottom], duration: 0.6,
      });
    };
    const handleFsCenter = () => { setFsSelectedFEWS(null); flyFsToCity(); };
    const handleFsBack   = () => { setFsSelectedFEWS(null); flyFsToCity(); };

    const selectFsStation = (id) => {
      const f = allFews.find(x => x.id === id);
      setFsSelectedFEWS(id);
      setFsDrawerOpen(true);
      if (!f || !fsMapRef.current) return;
      const r = 0.002; // ~200m, same close-up as the dashboard map
      const ins = fsInsets(true);
      fsMapRef.current.flyToBounds(
        [[f.lat - r, f.lng - r], [f.lat + r, f.lng + r]],
        { paddingTopLeft: [20, 60], paddingBottomRight: [ins.right, isMobileViewport() ? ins.bottom : 80], duration: 0.6 }
      );
    };

    useEffect(() => {
      if (!fullscreenMap) return;
      const onKey = (e) => {
        if (e.key === "Escape" && sirenConfirm === null) {
          setFullscreenMap(false);
          setFsSelectedFEWS(null);
          setFsDrawerOpen(!isMobileViewport());
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [fullscreenMap, sirenConfirm]);

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
      // Give backend 800ms to write, then sync units state immediately
      setTimeout(() => {
        if (pollUnitsNowRef.current) pollUnitsNowRef.current();
      }, 800);
    } catch (e) {
      console.error("[SIREN] Control failed:", e);
      setSirens(prev => ({ ...prev, [id]: !turningOn }));
      showToast("Siren command failed — check your connection and try again.");
    }

    // Siren log is now handled server-side in /siren/{device_id}

    setTimeout(() => {
      setSirenLoading(prev => ({ ...prev, [id]: false }));
    }, 6000);
  };

  const chartPoints = useMemo(() =>
    (historyData?.values?.length)
      ? historyData.positions.map((ms, i) => ({ x: ms, y: historyData.values[i] }))
      : [],
    [historyData]
  );

  const CHART_WINDOW  = 5 * 60 * 60 * 1000;
  const CHART_PADDING = 10 * 60 * 1000;
  const chartWinEnd   = useMemo(() => Math.ceil(chartNow / 300000) * 300000, [chartNow]);
  const chartWinStart = useMemo(() => chartWinEnd - CHART_WINDOW - CHART_PADDING, [chartWinEnd]);
  const hasEverHadData = historyData?.values?.length > 0 || hadDataBefore;
  const waterChartData = useMemo(() => ({
    datasets: [{
      label: "FEWS 1",
      data: chartPoints,
      spanGaps: false,
      borderColor: "#ffffff",
      backgroundColor: "rgba(255,255,255,0.05)",
      tension: 0,
      pointRadius: 3,
      pointHoverRadius: 6,
      borderWidth: 3,
      pointBackgroundColor: (ctx) => {
        const v = ctx.parsed?.y;
        if (v == null) return "transparent";
        if (v > thresholds.danger)  return "#ef4444";
        if (v > thresholds.warning) return "#f59e0b";
        if (v < getBaselineCutoff(thresholds)) return "#e2e8f0";
        return "#fde047";
      },
      pointBorderColor: (ctx) => {
        const v = ctx.parsed?.y;
        if (v == null) return "transparent";
        if (v > thresholds.danger)  return "#ef4444";
        if (v > thresholds.warning) return "#f59e0b";
        if (v < getBaselineCutoff(thresholds)) return "#e2e8f0";
        return "#fde047";
      },
    }],
  }), [chartPoints, thresholds]);

const waterChartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        backgroundColor: "#202024",
        titleColor: "#fff",
        bodyColor: "#9aa0a8",
        borderColor: "rgba(255,255,255,0.12)",
        borderWidth: 1,
        callbacks: {
          title: (items) => {
            const i = items[0]?.dataIndex;
            return historyData?.exactLabels?.[i] ?? "";
          },
          label: (ctx) => {
            const v = ctx.parsed.y;
            const status = v > thresholds.danger ? "CRITICAL" : v > thresholds.warning ? "WARNING" : v < getBaselineCutoff(thresholds) ? "BASE" : "NORMAL";
            return ` ${formatWaterLevel(v, user.unit_preference)}  [${status}]`;
          },
          labelColor: (ctx) => {
            const v = ctx.parsed.y;
            const color = v > thresholds.danger ? "#ef4444" : v > thresholds.warning ? "#f59e0b" : v < getBaselineCutoff(thresholds) ? "#e2e8f0" : "#fde047";
            return { borderColor: color, backgroundColor: color };
          },
        },
      },
      annotation: {
        annotations: {
          zoneLow:     { type: "box", yMin: 0,                    yMax: Math.min(100, thresholds.warning), backgroundColor: "rgba(226,232,240,0.55)", borderWidth: 0 },
          zoneSafe:    { type: "box", yMin: Math.min(100, thresholds.warning), yMax: thresholds.warning, backgroundColor: "rgba(253,224,71,0.60)",  borderWidth: 0 },
          zoneWarning: { type: "box", yMin: thresholds.warning,   yMax: thresholds.danger,  backgroundColor: "rgba(249,115,22,0.60)", borderWidth: 0 },
          zoneCritical:{ type: "box", yMin: thresholds.danger,    yMax: 700,                backgroundColor: "rgba(239,68,68,0.60)",  borderWidth: 0 },
          zoneCritical:{ type: "box", yMin: thresholds.danger,    yMax: 700,                backgroundColor: "rgba(239,68,68,0.60)",  borderWidth: 0 },
          lineWarning: { type: "line", yMin: thresholds.warning, yMax: thresholds.warning, borderColor: "rgba(249,115,22,0.80)", borderWidth: 2, borderDash: [4, 4], label: { display: false } },
          lineCritical:{ type: "line", yMin: thresholds.danger,  yMax: thresholds.danger,  borderColor: "rgba(239,68,68,0.80)",  borderWidth: 2, borderDash: [4, 4], label: { display: false } },
        },
      },
    },
    scales: {
      y: {
        min: 0, max: 700,
        grid: { color: "rgba(255,255,255,0.05)" },
        ticks: {
          color: (ctx) => {
            const v = ctx.tick.value;
            if (v > thresholds.danger)  return "#ef4444";
            if (v > thresholds.warning) return "#f97316";
            if (v < getBaselineCutoff(thresholds)) return "#e2e8f0";
            return "#fde047";
          },
          font: { size: 10 },
          callback: (v) => formatWaterLevel(v, user.unit_preference),
          stepSize: 50,
        },
      },
      x: {
        type: "linear",
        min: chartWinStart,
        max: chartWinEnd,
        grid: { color: "rgba(255,255,255,0.04)" },
        afterBuildTicks: (axis) => {
          const ticks = [];
          const step = 30 * 60 * 1000;
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
  }), [chartWinStart, chartWinEnd, historyData.exactLabels, thresholds, user.unit_preference]);

  const alertCount = (isHardwareOnline && fews1DataRecent)
    ? allFews.filter(f => f.status === "danger").length
    : 0;
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
      <PullIndicator />
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

      {/* ─── CRITICAL BANNER (desktop only) ─── */}
      <div className={`critical-banner critical-banner-desktop ${isCritical && user.banner_enabled ? "active" : ""}`}>
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
        <div className={`brand ${sidebarOpen ? "brand-open" : ""}`}>
          {sidebarOpen && <img src="/logo1.jpg" alt="CDRRMO FEWS" className="brand-logo" />}
          <div className={`brand-text ${sidebarOpen ? "" : "hidden"}`}>
            <div className="brand-name">CDRRMO Fews</div>
          </div>
          <button
            className="nav-btn brand-toggle"
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
          <img src="/logo1.jpg" alt="CDRRMO FEWS" className="topbar-seal-img topbar-seal-mobile" />
          <div className="topbar-seals" />
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
              <div className="profile-avatar-btn" ref={avatarBtnRef} onMouseDown={e => e.stopPropagation()} onClick={() => setShowProfileDropdown(v => !v)}>
                {user.photo ? <img src={user.photo} alt="avatar" style={{ width:"100%", height:"100%", borderRadius:"50%", objectFit:"cover" }} /> : <DefaultAvatar />}
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

        {/* ─── CRITICAL BANNER (mobile only) ─── */}
        <div className={`critical-banner critical-banner-mobile ${isCritical && user.banner_enabled ? "active" : ""}`}>
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

        {/* ─── DASHBOARD ─── */}
        {activeNav === "Dashboard" && showTicker && user.ticker_enabled && historyData?.values?.length > 0 && (() => {
          const sorted = historyData.positions
            .map((ms, i) => ({ ms, value: historyData.values[i], label: historyData.exactLabels[i] }))
            .filter(d => d.value !== null)
            .sort((a, b) => a.ms - b.ms);
          const doubled = [...sorted, ...sorted];
          const animDuration = sorted.length * 4 * 2;

          const fmtDate = (ms) => {
            const d = new Date(ms);
            return d.toLocaleDateString("en-PH", {
              timeZone: "Asia/Manila",
              month: "short", day: "numeric", year: "numeric",
            });
          };

          /* AFTER — close button sits above the scrolling row, not overlapping it */
          return (
            <div className="ticker-overlay" style={{
              position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 9000,
              background: "rgba(10,10,11,0.72)",
              borderTop: "1px solid rgba(255,255,255,0.09)",
              overflow: "hidden",
              transition: "opacity 1.5s ease",
              opacity: tickerLeaving ? 0 : 1,
              display: "flex",
              flexDirection: "column",
            }}>
              {/* Close button row — sits above the cards, never overlaps */}
              {/* Scrolling cards row */}
              <div style={{
                display: "flex", gap: 14,
                padding: "8px 18px 8px",
                animation: `tickerSlide ${animDuration}s linear 1 forwards`,
                animationDelay: `-${tickerOffset}s`,
                width: "max-content",
              }}>
                {doubled.map((d, i) => {
                  const statusKey = d.value > thresholds.danger ? "CRITICAL" : d.value > thresholds.warning ? "WARNING" : d.value < getBaselineCutoff(thresholds) ? "BASE" : "NORMAL";
                  const color = statusKey === "CRITICAL" ? "#ef4444" : statusKey === "WARNING" ? "#f59e0b" : statusKey === "BASE" ? "#e2e8f0" : "#fde047";
                  const borderColor = statusKey === "CRITICAL" ? "rgba(239,68,68,0.2)" : statusKey === "WARNING" ? "rgba(245,158,11,0.2)" : statusKey === "BASE" ? "rgba(226,232,240,0.2)" : "rgba(253,224,71,0.2)";
                  return (
                    <div key={i} className="ticker-card" style={{
                        background: `${color}0d`, border: `1px solid ${borderColor}`,
                        borderRadius: 12, flexShrink: 0,
                      }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 10 }}>
                        <span className="ticker-card-name" style={{ fontWeight: 700, color: "#e2e8f0" }}>FEWS 1</span>
                        <span className="ticker-badge" style={{ color, background: `${color}26`, border: `1px solid ${color}59`, borderRadius: 4, padding: "2px 9px", fontFamily: "var(--mono)", fontWeight: 700 }}>{statusKey}</span>
                      </div>
                      <div className="ticker-card-level" style={{ color, fontFamily: "var(--mono)", lineHeight: 1, marginBottom: 10 }}>{formatWaterLevel(d.value, user.unit_preference)}</div>
                      <div className="ticker-card-meta" style={{ color: "#e2e8f0" }}>Bridge of Progress · {d.label} · {fmtDate(d.ms)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {activeNav === "Dashboard" && (
          <div className="dashboard-body">
            <main className="content">
              <div className="card card-map" ref={mapCardRef} style={{ position: "relative" }}>
                <div className="card-header">
                  <h2>FEWS Locations</h2>
                  <span className="card-tag">Batangas City</span>
                </div>
                <div className="map-wrap">
                  <div className="map-ctrl-group">
                    <button className="map-ctrl-btn" onClick={handleDashCenter} title="Center map" aria-label="Center map">
                      <CenterIcon />
                    </button>
                    <button className="map-ctrl-btn" onClick={() => setFullscreenMap(true)} title="Fullscreen map" aria-label="Fullscreen map">
                      <ExpandIcon />
                    </button>
                  </div>
                  <MapContainer
                    bounds={DASH_DEFAULT_BOUNDS}
                    boundsOptions={{ padding: [20, 20] }}
                    style={{ height:"100%", width:"100%", borderRadius:"10px" }}
                    scrollWheelZoom={true}>
                    <TileLayer
                      className={CARTO_KEY ? "fews-tiles" : undefined}
                      attribution={MAP_ATTRIBUTION}
                      url={MAP_TILE_URL} />
                    <MapRefSetter mapRef={dashMapRef} />
                    <MapResizeWatcher />
                    <FlyToStation fews={selectedStation} />
                    <OpenPopup fews={selectedStation} markerRefs={markerRefs} />
                    {allFews.map(f => {
                      const isManualServiceable = !f.isLive && f.manualStatus === "serviceable";
                      const isActuallyLive = f.isLive && isHardwareOnline;
                      const displayStatus  = f.isLive ? getDisplayStatus(f.status, f.waterLevel, isActuallyLive, thresholds) : f.status;
                      const cfg            = STATUS_CONFIG[displayStatus] || STATUS_CONFIG["safe"];
                      const isSel          = selectedFEWS === f.id;
                      const markerColor    = f.isLive
                        ? (isActuallyLive ? cfg.color : "#64748b")
                        : (isManualServiceable ? "#38bdf8" : "#64748b");
                      const isBaseLive = isActuallyLive && displayStatus === "base";
                      const popupTextColor = markerColor;
                      const markerBorderColor = isBaseLive ? "#94a3b8" : "white";
                      const showPulse = isActuallyLive || isManualServiceable;
                      const icon = L.divIcon({
                        className: "",
                        html: `<div style="position:relative;width:${isSel?"18px":"14px"};height:${isSel?"18px":"14px"}">
                          <div style="position:absolute;inset:0;border-radius:50%;background:${markerColor};border:2px solid ${markerBorderColor};box-shadow:0 0 ${isSel?"12px":"8px"} ${markerColor};z-index:2"></div>
                          ${showPulse ? `<div class="radar-pulse" style="width:${isSel?"18px":"14px"};height:${isSel?"18px":"14px"};background:${markerColor};top:0;left:0;"></div>` : ""}
                        </div>`,
                        iconSize: [isSel?18:14, isSel?18:14],
                        iconAnchor: [isSel?9:7, isSel?9:7],
                      });
                      return (
                        <Marker key={f.id} position={[f.lat, f.lng]} icon={icon}
                          ref={el => { markerRefs.current[f.id] = el; }}
                          eventHandlers={{ click: () => setSelectedFEWS(selectedFEWS === f.id ? null : f.id) }}>
                          <Popup minWidth={180} maxWidth={260} autoPan={false}>
                            <div style={{ fontFamily:"sans-serif", padding:"2px 0" }}>
                              {f.isLive ? (
                                <>
                                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                                    <strong style={{ fontSize:"clamp(13px, 1.1vw, 16px)", color:"#e8eaed" }}>{f.name}</strong>
                                    <span style={{ fontSize:"clamp(9px, 0.8vw, 11px)", color: isHardwareOnline ? "#22c55e" : "#94a3b8", fontWeight:700 }}>
                                      {isHardwareOnline ? "● LIVE" : "◌ WAITING"}
                                    </span>
                                  </div>
                                  <div style={{ fontSize:"clamp(10px, 0.9vw, 12px)", color:"#e8eaed", marginBottom:3 }}>
                                    {f.location}
                                  </div>
                                  <div style={{ display:"flex", alignItems:"baseline", gap:4, marginBottom:3 }}>
                                    <span style={{ fontSize:"clamp(22px, 1.8vw, 28px)", fontWeight:800, lineHeight:1, color: isHardwareOnline ? popupTextColor : "#94a3b8" }}>
                                      {isHardwareOnline ? convertCm(f.waterLevel, user.unit_preference)?.toFixed(UNIT_DECIMALS[user.unit_preference] ?? 0) : "—"}
                                    </span>
                                    {isHardwareOnline && (
                                      <span style={{ fontSize:"clamp(11px, 0.9vw, 13px)", fontWeight:600, color: popupTextColor }}>{user.unit_preference}</span>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <>
                                  <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
                                    <strong style={{ fontSize:"clamp(13px, 1.1vw, 16px)", color:"#e8eaed" }}>{f.name}</strong>
                                    <span style={{ fontSize:"clamp(9px, 0.8vw, 11px)", color: isManualServiceable ? "#38bdf8" : "#94a3b8", fontWeight:700 }}>
                                      {isManualServiceable ? "● MANUAL" : "◌ MANUAL"}
                                    </span>
                                  </div>
                                  <div style={{ fontSize:"clamp(10px, 0.9vw, 12px)", color:"#e8eaed", marginBottom:3 }}>
                                    {f.location}
                                  </div>
                                  <div>
                                    <span style={{ fontSize:"clamp(11px, 0.95vw, 14px)", fontWeight:700, lineHeight:1, color: markerColor }}>
                                      {isManualServiceable ? "SERVICEABLE" : "UNSERVICEABLE"}
                                    </span>
                                  </div>
                                </>
                              )}
                              <button onClick={() => {
                                navigator.clipboard.writeText(`${f.lat}, ${f.lng}`);
                                setCopiedId(f.id);
                                if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
                                copiedTimerRef.current = setTimeout(() => {
                                  setCopiedId(null);
                                  copiedTimerRef.current = null;
                                }, 1500);
                              }} style={{ marginTop:"4px", padding:"3px 8px", background:"rgba(255,255,255,0.08)", color:"#e8eaed", border:"1px solid rgba(255,255,255,0.14)", outline:"none", boxShadow:"none", borderRadius:"4px", cursor:"pointer", fontWeight:"700", fontSize:"clamp(10px, 0.85vw, 12px)", width:"100%", transition:"background 0.2s" }}>
                                {copiedId===f.id ? "Copied!" : "Copy Coordinates"}
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

                  {hasEverHadData && fews1Connected && (
                    <div className="wl-legend-row">
                      <span className="wl-legend"><span className="wl-legend-dot" style={{ background: "#ffffff", border: "1px solid rgba(255,255,255,0.4)" }} />Baseline</span>
                      <span className="wl-legend"><span className="wl-legend-dot" style={{ background: "#fde047" }} />Normal</span>
                      <span className="wl-legend"><span className="wl-legend-dot" style={{ background: "#f97316" }} />Warning</span>
                      <span className="wl-legend"><span className="wl-legend-dot" style={{ background: "#ef4444" }} />Critical</span>
                    </div>
                  )}

                    <span className="card-tag">
                      {hasEverHadData
                        ? (fews1Connected
                            ? <><span className="wl-full">Last 5 hrs</span><span className="wl-abbr">5 hrs</span></>
                            : "Last known data")
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
                  base: {
                    color:  "#e2e8f0",
                    bg:     "rgba(226,232,240,0.12)",
                    border: "rgba(226,232,240,0.30)",
                    sqBg:   "rgba(226,232,240,0.16)",
                    sqBor:  "rgba(226,232,240,0.45)",
                    label:  "BASE",
                    icon:   "✓",
                    anim:   false,
                  },
                  safe: {
                    color:  "#fde047",
                    bg:     "rgba(253,224,71,0.14)",
                    border: "rgba(253,224,71,0.35)",
                    sqBg:   "rgba(253,224,71,0.18)",
                    sqBor:  "rgba(253,224,71,0.50)",
                    label:  "ALL CLEAR",
                    icon:   "✓",
                    anim:   false,
                  },
                  warning: {
                    color:  "#fb923c",
                    bg:     "rgba(249,115,22,0.60)",
                    border: "rgba(249,115,22,0.70)",
                    sqBg:   "rgba(249,115,22,0.65)",
                    sqBor:  "rgba(249,115,22,0.80)",
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
                    color:    "#c0c5cc",
                    bg:       "rgba(122,128,138,0.30)",
                    border:   "rgba(122,128,138,0.50)",
                    sqBg:     "rgba(122,128,138,0.36)",
                    sqBor:    "rgba(122,128,138,0.60)",
                    label:    "OFFLINE",
                    icon:     "◌",
                    anim:     false,
                    iconFont: "sans-serif",
                  },
                };

                const fews1 = allFews.find(f => f.id === 1);
                const isFews1ActuallyLive = fews1 && fews1.isLive && isHardwareOnline;
                const worstStatus = isFews1ActuallyLive
                  ? getDisplayStatus(fews1.status, fews1.waterLevel, isFews1ActuallyLive, thresholds)
                  : "offline";

                const cfg = ALARM_CFG[worstStatus];

                // Build dynamic sub message based on affected stations
                const buildSub = () => {
                  if (worstStatus === "offline") return "FEWS 1 is offline.";
                  if (worstStatus === "base")    return "Water level is at baseline, well below normal levels.";
                  if (worstStatus === "safe")    return "No critical advisories at this time.";
                  if (worstStatus === "warning") return "Water level is rising for FEWS 1.";
                  return "Immediate action required for FEWS 1.";
                };

                return (
                  <div className="card card-battery">
                    <div className="card-header">
                      <h2>Alarm Status</h2>
                      <span className="card-tag">Fews 1</span>
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
                      <div className="alarm-icon-wrap" style={{ width: "clamp(38px, 3.2vw, 64px)", height: "clamp(38px, 3.2vw, 64px)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <div className="alarm-icon" style={{
                          width: "100%", height: "100%",
                          borderRadius: 8,
                          border: `2px solid ${cfg.sqBor}`,
                          background: cfg.sqBg,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: worstStatus === "danger" ? "clamp(14px, 1.4vw, 28px)" : "clamp(17px, 1.7vw, 32px)",
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
                      <div className="alarm-label" style={{
                        fontSize: "clamp(14px, 1.5vw, 26px)",
                        fontWeight: 800,
                        color: cfg.color,
                        fontFamily: "var(--mono)",
                        letterSpacing: "0.10em",
                        animation: cfg.anim ? "blink 1.2s infinite" : "none",
                      }}>
                        {cfg.label}
                      </div>

                      {/* Dynamic sub message */}
                      <div className="alarm-sub" style={{
                        fontSize: "clamp(10px, 0.95vw, 15px)",
                        color: cfg.color,
                        textAlign: "center",
                        lineHeight: 1.5,
                        opacity: 0.75,
                        maxWidth: "clamp(160px, 20vw, 260px)",
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
                {(() => {
                  const liveFews   = allFews.filter(f => f.isLive);
                  const manualFews = allFews.filter(f => !f.isLive);

                  const renderItem = (f) => {
                    const isSel = selectedFEWS === f.id;
                    const isActuallyLive = f.isLive && isHardwareOnline;
                    const displayStatus = f.isLive ? getDisplayStatus(f.status, f.waterLevel, isActuallyLive, thresholds) : f.status;
                    const cfg   = STATUS_CONFIG[displayStatus] || STATUS_CONFIG["safe"];
                    return (
                      <button key={f.id} className={`rsb-item ${isSel ? "selected" : ""}`}
                        onClick={() => {
                          const newSel = isSel ? null : f.id;
                          setSelectedFEWS(newSel);
                          if (newSel && window.innerWidth <= 768 && mapCardRef.current) {
                            const scrollParent = mapCardRef.current.closest(".main");
                            if (scrollParent) {
                              scrollParent.scrollTo({ top: 0, behavior: "smooth" });
                            } else {
                              mapCardRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
                            }
                          }
                        }}
                        style={{ "--status-color": f.isLive ? cfg.color : "#7e92b4" }}>
                        <div className="rsb-dot" style={{
                          background: f.isLive
                            ? (isActuallyLive ? cfg.color : "#334155")
                            : (f.manualStatus === "serviceable" ? "var(--blue)" : "#334155")
                        }} />
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
                        {f.isLive ? (
                          <div className="rsb-badge" style={{
                            color: isActuallyLive ? cfg.color : "var(--text-3)",
                            background: isActuallyLive ? cfg.bg : "rgba(255,255,255,0.04)"
                          }}>
                            {isActuallyLive ? cfg.label : "—"}
                          </div>
                        ) : (
                          <div className="rsb-badge rsb-badge-manual-size" style={{
                            color: f.manualStatus === "serviceable" ? "var(--blue)" : "var(--text-3)",
                            background: f.manualStatus === "serviceable" ? "rgba(56,189,248,0.12)" : "rgba(255,255,255,0.04)"
                          }}>
                            {f.manualStatus === "serviceable" ? "SERVICEABLE" : "UNSERVICEABLE"}
                          </div>
                        )}
                      </button>
                    );
                  };

                  return (
                    <>
                      {liveFews.length > 0 && (
                        <div className="rsb-section">
                          <div className="rsb-section-label">Live · {liveFews.length}</div>
                          <div className="rsb-section-items">{liveFews.map(renderItem)}</div>
                        </div>
                      )}
                      {manualFews.length > 0 && (
                        <div className="rsb-section">
                          <div className="rsb-section-label">Manual · {manualFews.length}</div>
                          <div className="rsb-section-items">{manualFews.map(renderItem)}</div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
              {selectedFEWS && (() => {
                const f       = allFews.find(s => s.id === selectedFEWS);

                if (!f.isLive) {
                  const isServiceable = f.manualStatus === "serviceable";
                  return (
                    <div className="rsb-detail">
                      <div className="rsb-detail-title" style={{ display:"flex", alignItems:"center", gap:6 }}>
                        {f.name}
                        <span style={{ fontSize:9, fontWeight:700, fontFamily:"var(--mono)", color: isServiceable ? "var(--blue)" : "var(--text-3)", display:"inline-flex", alignItems:"center", gap:4 }}>
                          {isServiceable ? (
                            "● MANUAL"
                          ) : (
                            <>
                              <span style={{ width:6, height:6, borderRadius:"50%", border:"1.3px solid var(--text-3)", display:"inline-block", flexShrink:0 }} />
                              MANUAL
                            </>
                          )}
                        </span>
                      </div>
                      <div className="rsb-stat">
                        <span>Status</span>
                        <strong style={{ color: isServiceable ? "var(--blue)" : "var(--text-3)" }}>
                          {isServiceable ? "SERVICEABLE" : "UNSERVICEABLE"}
                        </strong>
                      </div>
                      <div className="rsb-stat"><span>Location</span><strong>{f.location || "—"}</strong></div>
                      <div className="rsb-stat">
                        <span>Coordinates</span>
                        <strong style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{fmtCoord(f.lat)}, {fmtCoord(f.lng)}</strong>
                      </div>
                    </div>
                  );
                }

                const sirenOn = sirens[f.id];
                const isActuallyLive = f.isLive && isHardwareOnline;
                const displayStatus = getDisplayStatus(f.status, f.waterLevel, isActuallyLive, thresholds);
                const cfg     = STATUS_CONFIG[displayStatus] || STATUS_CONFIG["safe"];
                const canSiren = can(user.role, "sirenControl");
                return (
                  <div className="rsb-detail" style={{ "--status-color": isActuallyLive ? cfg.color : "var(--text-3)" }}>
                    <div className="rsb-detail-title" style={{ display:"flex", alignItems:"center", gap:6 }}>
                      {f.name}
                      <span style={{ fontSize:9, fontWeight:700, fontFamily:"var(--mono)",
                        color: isActuallyLive ? "var(--green)" : "var(--text-3)" }}>
                        {isActuallyLive ? "● LIVE" : "◌ WAITING"}
                      </span>
                    </div>
                    <div className="rsb-stat"><span>Water Level</span><strong style={{ color: isActuallyLive ? cfg.color : "var(--text-3)" }}>{isActuallyLive ? formatWaterLevel(f.waterLevel, user.unit_preference) : "—"}</strong></div>
                    <div className="rsb-stat"><span>Status</span><strong style={{ color: isActuallyLive ? cfg.color : "var(--text-3)" }}>{isActuallyLive ? cfg.label : "WAITING"}</strong></div>
                    <div className="rsb-stat">
                      <span>Last sync</span>
                      <strong style={{ color: !isActuallyLive ? "var(--text-3)" : "var(--text-1)" }}>
                        {lastUpdatedStr ? lastUpdatedStr : "—"}
                      </strong>
                    </div>
                    <div className="rsb-stat">
                      <span>Today's highest</span>
                      <strong>{todayStats[`fews_${f.id}`]?.high != null ? formatWaterLevel(todayStats[`fews_${f.id}`].high, user.unit_preference) : "—"}</strong>
                    </div>
                    <div className="rsb-stat">
                      <span>Today's lowest</span>
                      <strong>{todayStats[`fews_${f.id}`]?.low != null ? formatWaterLevel(todayStats[`fews_${f.id}`].low, user.unit_preference) : "—"}</strong>
                    </div>
                    <div className="rsb-stat">
                      <span>Warning at</span>
                      <strong style={{ color: "var(--amber)" }}>{formatWaterLevel(thresholds.warning, user.unit_preference)}</strong>
                    </div>
                    <div className="rsb-stat">
                      <span>Critical at</span>
                      <strong style={{ color: "var(--red)" }}>{formatWaterLevel(thresholds.danger, user.unit_preference)}</strong>
                    </div>
                    <div className="rsb-stat">
                      <span>Coordinates</span>
                      <strong style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{f.lat}, {f.lng}</strong>
                    </div>
                    {canSiren && (
                      <div className="rsb-siren">
                        <div className="rsb-siren-label">Siren Control</div>
                        <div className="rsb-siren-row">
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: sirenOn && isActuallyLive ? "var(--red)" : (isActuallyLive ? "var(--text-2)" : "var(--text-3)") }}>
                            {sirenOn && isActuallyLive ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                            )}
                            {sirenOn && isActuallyLive ? "Active" : "Off"}
                          </span>
                          <button
                            type="button"
                            className={`siren-btn ${sirenOn && isActuallyLive ? "siren-on" : "siren-off"}`}
                            onClick={() => toggleSiren(f.id)}
                            disabled={!isActuallyLive || sirenLoading[f.id]}
                          >
                            {sirenLoading[f.id]
                              ? <span className="btn-spinner" style={{ width: 10, height: 10, borderWidth: 1.5, borderTopColor: sirenOn && isActuallyLive ? "#fff" : "var(--text-2)", borderColor: sirenOn && isActuallyLive ? "rgba(255,255,255,0.25)" : "rgba(126,146,180,0.25)" }} />
                              : sirenOn && isActuallyLive ? "SILENCE" : "MANUAL ON"}
                          </button>
                        </div>
                        <div className="rsb-siren-note">
                          {!isActuallyLive ? "Available if fews is live" : sirenOn ? "Tap to silence" : "Tap to manually activate"}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </aside>
          </div>
        )}

          {/* ── FULLSCREEN MAP MODAL ── */}
          {fullscreenMap && (
            <div className="map-fullscreen-overlay">
              <div className="map-fullscreen-box">
                <div className={`map-fullscreen-inner ${fsDrawerOpen ? "fs-drawer-open" : ""}`}>
                  <MapContainer
                    bounds={CITY_DEFAULT_BOUNDS}
                    boundsOptions={{ paddingTopLeft: [20, 20], paddingBottomRight: [(fsDrawerOpen && !isMobileViewport()) ? FS_DRAWER_PAD : 20, 20] }}
                    style={{ height:"100%", width:"100%" }}
                    scrollWheelZoom={true}
                    minZoom={3}>
                    <TileLayer className={CARTO_KEY ? "fews-tiles" : undefined} attribution={MAP_ATTRIBUTION} url={MAP_TILE_URL} />
                    <MapRefSetter mapRef={fsMapRef} />
                    {allFews.map(f => {
                      const isManualServiceable = !f.isLive && f.manualStatus === "serviceable";
                      const isActuallyLive = f.isLive && isHardwareOnline;
                      const displayStatus = f.isLive ? getDisplayStatus(f.status, f.waterLevel, isActuallyLive, thresholds) : f.status;
                      const cfg = STATUS_CONFIG[displayStatus] || STATUS_CONFIG["safe"];
                      const markerColor = f.isLive
                        ? (isActuallyLive ? cfg.color : "#64748b")
                        : (isManualServiceable ? "#38bdf8" : "#64748b");
                      const markerBorderColor = (isActuallyLive && displayStatus === "base") ? "#94a3b8" : "white";
                      const showPulse = isActuallyLive || isManualServiceable;
                      const isFsSel = fsSelectedFEWS === f.id;
                      const statusWord = f.isLive
                        ? (isActuallyLive ? "LIVE" : "WAITING")
                        : (isManualServiceable ? "SERVICEABLE" : "UNSERVICEABLE");
                      const statusColor = f.isLive
                        ? (isActuallyLive ? "#22c55e" : "#94a3b8")
                        : (isManualServiceable ? "#38bdf8" : "#9aa0a8");
                      const icon = makeFsLabelIcon({
                        name: f.name, statusWord, statusColor,
                        markerColor, markerBorderColor, showPulse, isSel: isFsSel,
                      });
                      return (
                        <Marker key={f.id} position={[f.lat, f.lng]} icon={icon}
                          zIndexOffset={isFsSel ? 1000 : 0}
                          eventHandlers={{ click: () => selectFsStation(f.id) }} />
                      );
                    })}
                  </MapContainer>

                  {/* Status pill — bottom left, next to the buttons */}
                  <div className="map-fs-pill">
                    <span className="map-fs-pill-dot" style={{ background: alertCount > 0 ? "#ef4444" : "#22c55e" }} />
                    {allFews.filter(f => f.isLive && isHardwareOnline).length} live
                    {" · "}{allFews.filter(f => !f.isLive).length} manual
                    {" · "}{alertCount} alert{alertCount === 1 ? "" : "s"}
                  </div>

                  <FsDrawer
                    open={fsDrawerOpen}
                    onToggle={() => setFsDrawerOpen(o => !o)}
                    stations={allFews}
                    selectedId={fsSelectedFEWS}
                    onSelect={selectFsStation}
                    onBack={handleFsBack}
                    isHardwareOnline={isHardwareOnline}
                    thresholds={thresholds}
                    unitPref={user.unit_preference}
                    todayStats={todayStats}
                    lastUpdatedStr={lastUpdatedStr}
                    fews1Info={fews1Info}
                    sirens={sirens}
                    sirenLoading={sirenLoading}
                    canSiren={can(user.role, "sirenControl")}
                    onToggleSiren={toggleSiren}
                  />

                  {/* Map controls — bottom left */}
                  <div className="map-ctrl-group map-ctrl-group-fs">
                    <button className="map-ctrl-btn" onClick={handleFsCenter} title="Center map" aria-label="Center map">
                      <CenterIcon />
                    </button>
                    <button className="map-ctrl-btn" onClick={closeFullscreen} title="Exit fullscreen" aria-label="Exit fullscreen">
                      <CollapseIcon />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

        {activeNav === "Statistics"  && <StatisticsPage userRole={user.role} token={token} manualFews={manualFews} />}
        {activeNav === "UnitControl" && <UnitControlPage allFews={allFews} manualFews={manualFews} fews1Connected={isHardwareOnline} userRole={user.role} userName={user.name} unitPreference={user.unit_preference} addLog={addLog} token={token} onThresholdSaved={(t) => setThresholds(t)} onManualUnitSaved={(updated) => setManualFews(prev => prev.map(m => m.device_id === updated.device_id ? updated : m))} />}
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