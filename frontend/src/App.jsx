import "./App.css";
import { useState, useEffect, useRef, useMemo } from "react";
import { Line, Bar } from "react-chartjs-2";
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
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";
import Login from "./Login";

ChartJS.register(
  CategoryScale, LinearScale, PointElement,
  LineElement, BarElement, Title, Tooltip, Legend
);

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

// FEWS 1 base data
const FEWS1_BASE = {
  id: 1, name: "FEWS 1", location: "Bolbok",
  lat: 13.7703472, lng: 121.0525449,
  status: "safe", battery: 0, waterLevel: 0,
  description: "Deployed along the upper tributary of Sta. Rita River. Monitors early upstream surge from heavy rainfall in the Mataas na Gulod watershed.",
  installedDate: "March 12, 2023", technician: "Engr. Ramon Salazar",
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

const FEWS_COLORS = ["#22c55e"];

const NAV_ITEMS = [
  { key: "Dashboard",   icon: "▦", label: "Dashboard"    },
  { key: "UnitControl", icon: "⏻", label: "Unit Control" },
  { key: "Logs",        icon: "≡", label: "Logs"         },
  { key: "Settings",    icon: "⚙", label: "Settings"     },
];

const PAGE_TITLES = {
  Dashboard:   { title: "Flood Monitoring Dashboard", sub: "Live overview" },
  UnitControl: { title: "Unit Control",               sub: "Manage FEWS units" },
  Logs:        { title: "Logs",                       sub: "System activity log" },
  Settings:    { title: "Settings",                   sub: "System configuration" },
};

const MONTHS     = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS_SHORT = ["Su","Mo","Tu","We","Th","Fr","Sa"];

// ─── LOGS DATA ────────────────────────────────────────────────────────────────

function _pad(n) { return String(n).padStart(2, "0"); }
function _fmtDate(d) {
  const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${mo[d.getMonth()]} ${_pad(d.getDate())}, ${d.getFullYear()}`;
}
function _fmtTime(d) { return `${_pad(d.getHours())}:${_pad(d.getMinutes())}:${_pad(d.getSeconds())}`; }
function _makeId(i)  { return Math.random().toString(36).slice(2, 9) + i; }

const RAW_LOG_EVENTS = [
  { minsAgo: 15,   station: "FEWS 1", type: "info",    msg: "Periodic reading: water level — status WAITING FOR DATA" },
  { minsAgo: 20,   station: "System", type: "system",  msg: "FEWS 1 station sync pending — awaiting first data transmission" },
  { minsAgo: 330,  station: "System", type: "system",  msg: "CDRRMO Flood Warning Dashboard initialized — all services online" },
];

const _logNow = new Date();
const MOCK_LOGS = RAW_LOG_EVENTS.map((e, i) => {
  const d = new Date(_logNow.getTime() - e.minsAgo * 60 * 1000);
  return {
    id:      _makeId(i),
    date:    _fmtDate(d),
    time:    _fmtTime(d),
    rawDate: d,
    station: e.station,
    type:    e.type,
    msg:     e.msg,
  };
}).sort((a, b) => b.rawDate - a.rawDate);

const LOG_TYPE_CFG = {
  info:    { label: "INFO",    color: "#94a3b8", bg: "rgba(148,163,184,0.10)" },
  warning: { label: "WARNING", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  danger:  { label: "DANGER",  color: "#ef4444", bg: "rgba(239,68,68,0.12)"  },
  system:  { label: "SYSTEM",  color: "#38bdf8", bg: "rgba(56,189,248,0.12)" },
};

const LOG_ALL_STATIONS = ["System", "FEWS 1"];
const LOG_ALL_TYPES    = ["info", "warning", "danger", "system"];
const ROWS_PER_PAGE    = 30;

// ─── EXPORT HELPERS ───────────────────────────────────────────────────────────

function exportToXLSX(rows) {
  const header = ["Date", "Time", "Station", "Type", "Message"];
  const data   = [header, ...rows.map(r => [r.date, r.time, r.station, r.type.toUpperCase(), r.msg])];
  const doIt = () => {
    const wb = window.XLSX.utils.book_new();
    const ws = window.XLSX.utils.aoa_to_sheet(data);
    ws["!cols"] = [{ wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 9 }, { wch: 80 }];
    window.XLSX.utils.book_append_sheet(wb, ws, "FEWS Logs");
    window.XLSX.writeFile(wb, `FEWS_Logs_${Date.now()}.xlsx`);
  };
  if (window.XLSX) { doIt(); return; }
  const s = document.createElement("script");
  s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  s.onload = doIt;
  document.head.appendChild(s);
}

function exportToPDF(rows) {
  const load = (src) => new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
  const doIt = () => {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    doc.setFontSize(14);
    doc.setTextColor(30, 41, 59);
    doc.text("CDRRMO — FEWS System Logs", 40, 40);
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(`Exported: ${new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })}  ·  ${rows.length} entries`, 40, 56);
    doc.autoTable({
      startY: 70,
      head: [["Date", "Time", "Station", "Type", "Message"]],
      body: rows.map(r => [r.date, r.time, r.station, r.type.toUpperCase(), r.msg]),
      styles: { fontSize: 8, cellPadding: 5 },
      headStyles: { fillColor: [17, 29, 53], textColor: [226, 232, 240], fontStyle: "bold" },
      alternateRowStyles: { fillColor: [245, 248, 252] },
      columnStyles: {
        0: { cellWidth: 80 }, 1: { cellWidth: 55 },
        2: { cellWidth: 55 }, 3: { cellWidth: 55 }, 4: { cellWidth: "auto" },
      },
      theme: "grid",
    });
    doc.save(`FEWS_Logs_${Date.now()}.pdf`);
  };
  if (window.jspdf?.jsPDF) { doIt(); return; }
  load("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js")
    .then(() => load("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js"))
    .then(doIt);
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
                  <span className="cdp-year" style={{ fontSize: 12, color: "var(--text-2)" }}>{yearPage} – {yearPage + 15}</span>
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
  const map = useMap();
  useEffect(() => {
    if (fews) map.flyTo([fews.lat, fews.lng], 16, { duration: 1 });
  }, [fews]);
  return null;
}

function OpenPopup({ fews, markerRefs }) {
  useEffect(() => {
    if (!fews) return;
    const t = setTimeout(() => {
      const markerRef = markerRefs.current[fews.id];
      if (markerRef) markerRef.openPopup();
    }, 900);
    return () => clearTimeout(t);
  }, [fews]);
  return null;
}

// ─── MODALS ───────────────────────────────────────────────────────────────────

function ConfirmModal({ icon, iconColor, title, message, confirmLabel, confirmColor, onConfirm, onCancel }) {
  return (
    <div className="modal-overlay">
      <div className="modal-box">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {icon && <div className="modal-icon" style={{ color: iconColor, marginBottom: 0 }}>{icon}</div>}
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-msg">{message}</div>
        <div className="modal-actions">
          <button className="modal-btn modal-cancel" onClick={onCancel}>Cancel</button>
          <button className="modal-btn" style={{ background: confirmColor || "var(--blue)", color: confirmColor ? "#fff" : "#000" }} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangeEmailModal({ onClose }) {
  const [email, setEmail]     = useState("");
  const [confirm, setConfirm] = useState("");
  const [saved, setSaved]     = useState(false);
  const handle = () => {
    if (!email || email !== confirm) return;
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 1200);
  };
  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ alignItems: "stretch", gap: 14 }}>
        <div className="modal-title" style={{ textAlign: "left" }}>Change Email</div>
        <div className="modal-msg" style={{ textAlign: "left", marginBottom: 0 }}>Enter your new email address.</div>
        <div className="settings-field">
          <label className="settings-label">New Email</label>
          <input className="settings-input" type="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div className="settings-field">
          <label className="settings-label">Confirm Email</label>
          <input className="settings-input" type="email" placeholder="you@example.com" value={confirm} onChange={e => setConfirm(e.target.value)} />
        </div>
        {email && confirm && email !== confirm && <div className="settings-error">Emails do not match.</div>}
        <div className="modal-actions" style={{ marginTop: 4 }}>
          <button className="modal-btn modal-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-confirm" onClick={handle}>{saved ? "✓ Saved" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function ChangePasswordModal({ onClose }) {
  const [pw, setPw]       = useState({ current: "", next: "", confirm: "" });
  const [saved, setSaved] = useState(false);
  const handle = () => {
    if (!pw.current || !pw.next || pw.next !== pw.confirm) return;
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 1200);
  };
  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ alignItems: "stretch", gap: 14 }}>
        <div className="modal-title" style={{ textAlign: "left" }}>Change Password</div>
        <div className="modal-msg" style={{ textAlign: "left", marginBottom: 0 }}>Update your login credentials.</div>
        <div className="settings-field">
          <label className="settings-label">Current Password</label>
          <input className="settings-input" type="password" placeholder="••••••••" value={pw.current} onChange={e => setPw(p => ({...p, current: e.target.value}))} />
        </div>
        <div className="settings-field">
          <label className="settings-label">New Password</label>
          <input className="settings-input" type="password" placeholder="••••••••" value={pw.next} onChange={e => setPw(p => ({...p, next: e.target.value}))} />
        </div>
        <div className="settings-field">
          <label className="settings-label">Confirm New Password</label>
          <input className="settings-input" type="password" placeholder="••••••••" value={pw.confirm} onChange={e => setPw(p => ({...p, confirm: e.target.value}))} />
        </div>
        {pw.next && pw.confirm && pw.next !== pw.confirm && <div className="settings-error">Passwords do not match.</div>}
        <div className="modal-actions" style={{ marginTop: 4 }}>
          <button className="modal-btn modal-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-confirm" onClick={handle}>{saved ? "✓ Updated" : "Update"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── PROFILE DROPDOWN ─────────────────────────────────────────────────────────

function ProfileDropdown({ user, onSave, onClose }) {
  const ref                   = useRef();
  const fileRef               = useRef();
  const [editing, setEditing] = useState(false);
  const [name, setName]       = useState(user.name);
  const [dob, setDob]         = useState(user.dob || "");
  const [photo, setPhoto]     = useState(user.photo || null);
  const [saved, setSaved]     = useState(false);

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

  const handleSave = () => {
    const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
    onSave({ ...user, name, dob, photo, initials });
    setSaved(true);
    setTimeout(() => { setSaved(false); setEditing(false); }, 1200);
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
          <div className="settings-field">
            <label className="settings-label">Date of Birth</label>
            <CustomDatePicker value={dob} onChange={setDob} />
          </div>
          <div className="pd-edit-actions">
            <button className="pd-btn" onClick={() => setEditing(false)}>Cancel</button>
            <button className="pd-save-btn" onClick={handleSave}>{saved ? "✓ Saved" : "Save"}</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── UNIT CONTROL PAGE ────────────────────────────────────────────────────────

function UnitControlPage({ allFews, fews1Connected }) {
  const [fewsData, setFewsData]   = useState(allFews.map(f => ({ ...f })));
  const [units, setUnits]         = useState(Object.fromEntries(allFews.map(f => [f.id, true])));
  const [thresholds, setThr]      = useState(Object.fromEntries(allFews.map(f => [f.id, { warning: 2.5, danger: 4.0 }])));
  const [thrSaved, setThrSaved]   = useState({});
  const [editing, setEditing]     = useState({});
  const [infoSaved, setInfoSaved] = useState({});
  const [pendingToggle, setPendingToggle] = useState(null);

  const requestToggle = (f) => setPendingToggle({ fews: f, turningOn: !units[f.id] });
  const confirmToggle = () => {
    setUnits(prev => ({ ...prev, [pendingToggle.fews.id]: !prev[pendingToggle.fews.id] }));
    setPendingToggle(null);
  };

  const saveThr = (id) => {
    setThrSaved(prev => ({ ...prev, [id]: true }));
    setTimeout(() => setThrSaved(prev => ({ ...prev, [id]: false })), 2000);
  };

  const startEdit  = (id) => {
    const f = fewsData.find(x => x.id === id);
    setEditing(prev => ({ ...prev, [id]: { installedDate: f.installedDate, technician: f.technician, description: f.description } }));
  };
  const saveInfo   = (id) => {
    setFewsData(prev => prev.map(f => f.id === id ? { ...f, ...editing[id] } : f));
    setEditing(prev => { const n = {...prev}; delete n[id]; return n; });
    setInfoSaved(prev => ({ ...prev, [id]: true }));
    setTimeout(() => setInfoSaved(prev => ({ ...prev, [id]: false })), 2000);
  };
  const cancelEdit = (id) => setEditing(prev => { const n = {...prev}; delete n[id]; return n; });

  return (
    <>
      {pendingToggle && (
        <ConfirmModal
          icon="⏻"
          iconColor={pendingToggle.turningOn ? "var(--green)" : "var(--red)"}
          title={`${pendingToggle.turningOn ? "Power On" : "Power Off"} ${pendingToggle.fews.name}?`}
          message={pendingToggle.turningOn
            ? `${pendingToggle.fews.name} - ${pendingToggle.fews.location} will resume monitoring and data transmission.`
            : `${pendingToggle.fews.name} - ${pendingToggle.fews.location} will stop all monitoring.`
          }
          confirmLabel={pendingToggle.turningOn ? "Yes, Power On" : "Yes, Power Off"}
          confirmColor={pendingToggle.turningOn ? "var(--green)" : "var(--red)"}
          onConfirm={confirmToggle}
          onCancel={() => setPendingToggle(null)}
        />
      )}
      <div className="page-body">
        {fewsData.map(f => {
          const cfg = STATUS_CONFIG[f.status] || STATUS_CONFIG["safe"];
          const on  = units[f.id];
          const thr = thresholds[f.id];
          const ed  = editing[f.id];
          const isActuallyLive = f.isLive && fews1Connected;
          return (
            <div key={f.id} className={`uc-card ${!on ? "uc-card-offline" : ""}`} style={{ "--status-color": cfg.color }}>
              <div className="uc-card-header">
                <div className="uc-card-left">
                  <div className="uc-status-dot" style={{ background: on ? cfg.color : "#334155" }} />
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div className="uc-card-name">{f.name}</div>
                      {f.isLive && (
                        <span style={{
                          fontSize: 9, fontWeight: 700, fontFamily: "var(--mono)",
                          background: isActuallyLive ? "rgba(34,197,94,0.15)" : "rgba(148,163,184,0.12)",
                          color: isActuallyLive ? "var(--green)" : "var(--text-3)",
                          border: `1px solid ${isActuallyLive ? "rgba(34,197,94,0.3)" : "rgba(148,163,184,0.2)"}`,
                          borderRadius: 999,
                          padding: "2px 7px", letterSpacing: "0.07em"
                        }}>
                          {isActuallyLive ? "● LIVE" : "◌ WAITING"}
                        </span>
                      )}
                    </div>
                    <div className="uc-card-loc">📍 {f.location}, Batangas City</div>
                  </div>
                </div>
                <div className="uc-card-right">
                  <div className="uc-badge" style={{ color: on ? cfg.color : "var(--text-3)", background: on ? cfg.bg : "rgba(255,255,255,0.04)" }}>
                    {on ? cfg.label : "OFFLINE"}
                  </div>
                  <button className={`uc-power-btn ${on ? "uc-power-on" : "uc-power-off"}`} onClick={() => requestToggle(f)} title={on ? "Power Off" : "Power On"}>⏻</button>
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
                  <span className="uc-stat-label">Battery</span>
                  <span className="uc-stat-val" style={{ color: isActuallyLive ? (f.battery > 50 ? "var(--green)" : "var(--amber)") : "var(--text-3)" }}>
                    {isActuallyLive ? `${f.battery}%` : "—"}
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
                  {!ed ? (
                    <button className="uc-edit-btn" onClick={() => startEdit(f.id)}>✎ Edit</button>
                  ) : (
                    <div style={{ display:"flex", gap:6 }}>
                      <button className="uc-edit-btn" onClick={() => cancelEdit(f.id)}>Cancel</button>
                      <button className="uc-save-info-btn" onClick={() => saveInfo(f.id)}>{infoSaved[f.id] ? "✓ Saved" : "Save"}</button>
                    </div>
                  )}
                </div>
                {ed ? (
                  <textarea className="uc-desc-textarea" rows={3} value={ed.description}
                    onChange={e => setEditing(prev => ({ ...prev, [f.id]: { ...prev[f.id], description: e.target.value } }))} />
                ) : <div className="uc-description">{f.description}</div>}
              </div>

              <div className="uc-thr-section">
                <div className="uc-thr-label">Alert Thresholds</div>
                <div className="uc-thr-row">
                  <div className="uc-thr-field">
                    <label className="uc-thr-field-label">⚠ Warning (cm)</label>
                    <input className="settings-input" type="number" step="1" value={thr.warning}
                      onChange={e => setThr(prev => ({ ...prev, [f.id]: { ...prev[f.id], warning: parseFloat(e.target.value) } }))} />
                  </div>
                  <div className="uc-thr-field">
                    <label className="uc-thr-field-label">🔴 Danger (cm)</label>
                    <input className="settings-input" type="number" step="1" value={thr.danger}
                      onChange={e => setThr(prev => ({ ...prev, [f.id]: { ...prev[f.id], danger: parseFloat(e.target.value) } }))} />
                  </div>
                  <button className="uc-thr-save" onClick={() => saveThr(f.id)}>{thrSaved[f.id] ? "✓ Saved" : "Save"}</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ─── FILTER DROPDOWN ─────────────────────────────────────────────────────────

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
        className={`fdd-trigger ${isFiltered ? "fdd-trigger-active" : ""}`}
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
  else if (from && to) displayLabel = `${fmt(from)} – ${fmt(to)}`;

  return (
    <div className="fdd-wrap drf-wrap" ref={ref}>
      <button type="button" className={`fdd-trigger ${hasFilter ? "fdd-trigger-active" : ""}`}
        onClick={() => setOpen(o => !o)} style={{ minWidth: 148 }}>
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
            <span className="drf-hint">{!hasFilter && "Pick a day"}{isSingle && "Pick another for range"}{from && to && !isSingle && `${fmt(from)} – ${fmt(to)}`}</span>
            {hasFilter && <button className="cdp-clear" type="button" onClick={() => onChange({ from: "", to: "" })}>Clear</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── LOGS PAGE ────────────────────────────────────────────────────────────────

function ExportMenu({ filtered, exporting, setExporting }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  const handleExport = (format) => {
    setOpen(false); setExporting(format);
    setTimeout(() => {
      if (format === "xlsx") exportToXLSX(filtered);
      else exportToPDF(filtered);
      setTimeout(() => setExporting(null), 1200);
    }, 80);
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

function LogsPage() {
  const [search, setSearch]               = useState("");
  const [filterStation, setFilterStation] = useState("All");
  const [filterType, setFilterType]       = useState("All");
  const [filterDateRange, setFilterDateRange] = useState({ from: "", to: "" });
  const [page, setPage]                   = useState(1);
  const [exporting, setExporting]         = useState(null);

  const stationOptions = useMemo(() => [{ value: "All", label: "All Stations" }, ...LOG_ALL_STATIONS.map(s => ({ value: s, label: s }))], []);
  const typeOptions    = useMemo(() => [{ value: "All", label: "All Types" }, ...LOG_ALL_TYPES.map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))], []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return MOCK_LOGS.filter(l => {
      if (filterStation !== "All" && l.station !== filterStation) return false;
      if (filterType    !== "All" && l.type    !== filterType)    return false;
      if (filterDateRange.from) { const f = new Date(filterDateRange.from + "T00:00:00"); if (l.rawDate < f) return false; }
      if (filterDateRange.to)   { const t = new Date(filterDateRange.to   + "T23:59:59"); if (l.rawDate > t) return false; }
      if (q && !l.msg.toLowerCase().includes(q) && !l.station.toLowerCase().includes(q) && !l.type.includes(q)) return false;
      return true;
    });
  }, [search, filterStation, filterType, filterDateRange]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ROWS_PER_PAGE));
  const safePage   = Math.min(page, totalPages);
  const pageRows   = filtered.slice((safePage - 1) * ROWS_PER_PAGE, safePage * ROWS_PER_PAGE);
  const counts     = useMemo(() => { const c = { info:0, warning:0, danger:0, system:0 }; filtered.forEach(l => { c[l.type] = (c[l.type]||0)+1; }); return c; }, [filtered]);
  const hasFilters = search || filterStation !== "All" || filterType !== "All" || filterDateRange.from || filterDateRange.to;

  return (
    <div className="page-body logs-page-body">
      <div className="page-card" style={{ gap: 12 }}>
        <div className="logs-filters-row">
          <div className="logs-search-wrap">
            <span className="logs-search-icon">🔍</span>
            <input className="logs-search-input" placeholder="Search logs…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
            {search && <button className="logs-search-clear" onClick={() => { setSearch(""); setPage(1); }}>✕</button>}
          </div>
          <FilterDropdown label="All Stations" options={stationOptions} value={filterStation} onChange={v => { setFilterStation(v); setPage(1); }} />
          <FilterDropdown label="All Types"    options={typeOptions}    value={filterType}    onChange={v => { setFilterType(v);    setPage(1); }} />
          <DateRangeFilter from={filterDateRange.from} to={filterDateRange.to} onChange={v => { setFilterDateRange(v); setPage(1); }} />
          {hasFilters && <button className="logs-reset-icon-btn" onClick={() => { setSearch(""); setFilterStation("All"); setFilterType("All"); setFilterDateRange({ from:"", to:"" }); setPage(1); }} title="Reset">↺</button>}
          <ExportMenu filtered={filtered} exporting={exporting} setExporting={setExporting} />
        </div>
        <div className="logs-stat-bar">
          {Object.entries(LOG_TYPE_CFG).map(([t, cfg]) => (
            <div key={t} className="logs-stat-item" style={{ "--sc": cfg.color, "--sb": cfg.bg }}>
              <span className="logs-stat-count" style={{ color: cfg.color }}>{counts[t] ?? 0}</span>
              <span className="logs-stat-label">{cfg.label}</span>
            </div>
          ))}
          <div className="logs-stat-divider" />
          <div className="logs-stat-item logs-stat-total">
            <span className="logs-stat-count">{filtered.length}</span>
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
          {pageRows.length === 0 ? (
            <div className="logs-empty">
              <div style={{ fontSize:28, marginBottom:8 }}>🔍</div>
              <div style={{ color:"var(--text-2)", fontWeight:600 }}>No logs match your filters</div>
            </div>
          ) : pageRows.map((l, i) => {
            const cfg = LOG_TYPE_CFG[l.type];
            return (
              <div key={l.id} className={`logs-row ${i%2===1 ? "logs-row-alt":""}`}>
                <span className="logs-col-date"><span className="logs-date-day">{l.date}</span><span className="logs-date-time">{l.time}</span></span>
                <span className="logs-col-station"><span className="logs-station-tag">{l.station}</span></span>
                <span className="logs-col-type"><span className="logs-type-badge" style={{ color:cfg.color, background:cfg.bg, border:`1px solid ${cfg.color}30` }}>{cfg.label}</span></span>
                <span className="logs-col-msg" style={{ color: l.type==="danger"?"var(--red)":l.type==="warning"?"var(--amber)":"var(--text-2)" }}>{l.msg}</span>
              </div>
            );
          })}
        </div>
        <div className="logs-pagination">
          <span className="logs-page-info">Showing {filtered.length===0?0:(safePage-1)*ROWS_PER_PAGE+1}–{Math.min(safePage*ROWS_PER_PAGE,filtered.length)} of {filtered.length} entries</span>
          <div className="logs-page-btns">
            <button className="logs-page-btn" disabled={safePage===1} onClick={() => setPage(1)}>«</button>
            <button className="logs-page-btn" disabled={safePage===1} onClick={() => setPage(p=>p-1)}>‹</button>
            {Array.from({length:totalPages},(_,i)=>i+1).filter(p=>p===1||p===totalPages||Math.abs(p-safePage)<=1)
              .reduce((acc,p,i,arr)=>{if(i>0&&p-arr[i-1]>1)acc.push("…");acc.push(p);return acc;},[])
              .map((p,i)=>p==="…"?<span key={"el"+i} className="logs-page-ellipsis">…</span>:<button key={p} className={`logs-page-btn ${p===safePage?"logs-page-active":""}`} onClick={()=>setPage(p)}>{p}</button>)}
            <button className="logs-page-btn" disabled={safePage===totalPages} onClick={() => setPage(p=>p+1)}>›</button>
            <button className="logs-page-btn" disabled={safePage===totalPages} onClick={() => setPage(totalPages)}>»</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SETTINGS PAGE ────────────────────────────────────────────────────────────

function SettingsPage() {
  const [showEmail, setShowEmail]       = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [notifs, setNotifs]             = useState({ autoSiren: true, sms: true, email: false });
  const [users, setUsers] = useState([
    { id:1, name:"Carlo Dela Cruz", role:"Admin",    department:"Operations",   email:"carlo@cdrrmo.gov.ph" },
    { id:2, name:"Maria Santos",    role:"Operator", department:"Field Unit A", email:"maria@cdrrmo.gov.ph" },
    { id:3, name:"Jose Reyes",      role:"Operator", department:"Field Unit B", email:"jose@cdrrmo.gov.ph"  },
    { id:4, name:"Ana Villanueva",  role:"Viewer",   department:"Command Post", email:"ana@cdrrmo.gov.ph"   },
  ]);
  const [drafts, setDrafts]           = useState({});
  const [confirmSave, setConfirmSave] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const [savedIds, setSavedIds]       = useState({});

  const getDraft    = (u) => drafts[u.id] || { role: u.role, department: u.department };
  const handleDraft = (id, key, val) => setDrafts(prev => ({ ...prev, [id]: { ...getDraft(users.find(u => u.id === id)), [key]: val } }));
  const doSave = () => {
    const u = confirmSave; const d = getDraft(u);
    setUsers(prev => prev.map(x => x.id === u.id ? { ...x, ...d } : x));
    setDrafts(prev => { const n={...prev}; delete n[u.id]; return n; });
    setSavedIds(prev => ({ ...prev, [u.id]: true }));
    setTimeout(() => setSavedIds(prev => ({ ...prev, [u.id]: false })), 2000);
    setConfirmSave(null);
  };
  const doRemove = () => { setUsers(prev => prev.filter(x => x.id !== confirmRemove.id)); setConfirmRemove(null); };

  return (
    <>
      {showEmail    && <ChangeEmailModal    onClose={() => setShowEmail(false)} />}
      {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} />}
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
          </div>
        </div>
        <div className="page-card">
          <div className="page-card-title">Manage Users</div>
          <div className="page-card-sub">Update roles and departments for all system users.</div>
          <div className="mu-list">
            {users.map(u => {
              const d = getDraft(u); const changed = d.role !== u.role || d.department !== u.department;
              return (
                <div key={u.id} className="mu-row">
                  <div className="mu-avatar">{u.name.split(" ").map(w=>w[0]).join("").slice(0,2)}</div>
                  <div className="mu-info"><div className="mu-name">{u.name}</div><div className="mu-email">{u.email}</div></div>
                  <div className="mu-controls">
                    <select className="mu-select" value={d.role} onChange={e => handleDraft(u.id, "role", e.target.value)}>
                      <option>Admin</option><option>Operator</option><option>Viewer</option>
                    </select>
                    <select className="mu-select" value={d.department} onChange={e => handleDraft(u.id, "department", e.target.value)}>
                      <option>Operations</option><option>Field Unit A</option><option>Field Unit B</option><option>Command Post</option><option>Admin Office</option>
                    </select>
                    <button className="mu-save-btn" disabled={!changed} onClick={() => setConfirmSave(u)}>{savedIds[u.id] ? "✓" : "Save"}</button>
                    <button className="mu-remove-btn" onClick={() => setConfirmRemove(u)}>✕</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="page-card">
          <div className="page-card-title">Notification Preferences</div>
          <div className="page-card-sub">Choose how the system alerts operators during flood events.</div>
          {[
            { key:"autoSiren", label:"Auto-trigger siren on CRITICAL", sub:"Siren activates automatically when danger threshold is crossed" },
            { key:"sms",       label:"SMS Notifications",              sub:"Send SMS alerts to registered operators" },
            { key:"email",     label:"Email Notifications",            sub:"Send email alerts to registered operators" },
          ].map(item => (
            <div key={item.key} className="settings-toggle-row">
              <div className="settings-toggle-info"><div className="settings-toggle-label">{item.label}</div><div className="settings-toggle-sub">{item.sub}</div></div>
              <button className={`settings-toggle ${notifs[item.key] ? "stoggle-on" : "stoggle-off"}`} onClick={() => setNotifs(n => ({ ...n, [item.key]: !n[item.key] }))}>{notifs[item.key] ? "ON" : "OFF"}</button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

export default function App() {
  const [isLoggedIn, setIsLoggedIn]                   = useState(false);
  const [showLogoutModal, setShowLogoutModal]         = useState(false);
  const [showProfileDropdown, setShowProfileDropdown] = useState(false);
  const [sidebarOpen, setSidebarOpen]                 = useState(true);
  const [selectedFEWS, setSelectedFEWS]               = useState(null);
  const [activeNav, setActiveNav]                     = useState("Dashboard");
  const markerRefs = useRef({});
  const [copiedId, setCopiedId] = useState(null);

  const [fews1Live, setFews1Live]           = useState(null);
  const [fews1Connected, setFews1Connected] = useState(false);
  const [lastUpdated, setLastUpdated]       = useState(null);

  const [user, setUser] = useState({
    name: "Carlo Dela Cruz", role: "Admin", department: "Operations",
    initials: "CD", dob: "", photo: null,
  });

  const [sirens, setSirens] = useState({ 1: false });
  const toggleSiren = (id) => setSirens(prev => ({ ...prev, [id]: !prev[id] }));

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/data/latest`);
        if (!res.ok) throw new Error("non-200");
        const data = await res.json();
        if (data.fews_1) {
          setFews1Live(data.fews_1);
          setFews1Connected(true);
          setLastUpdated(new Date());
        }
      } catch {
        setFews1Connected(false);
      }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, []);

  const allFews = useMemo(() => {
    let fews1 = { ...FEWS1_BASE };
    if (fews1Live) {
      fews1 = {
        ...fews1,
        waterLevel: fews1Live.water_level_cm,
        status:     backendStatusToKey(fews1Live.status),
        battery:    fews1Live.battery_pct,
        lat:        fews1Live.latitude,
        lng:        fews1Live.longitude,
      };
    }
    return [fews1];
  }, [fews1Live]);

  if (!isLoggedIn) return <Login onLogin={() => setIsLoggedIn(true)} />;

  const phNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }));
  phNow.setMinutes(Math.floor(phNow.getMinutes() / 5) * 5, 0, 0);
  const timeLabels = Array.from({ length: 13 }, (_, i) => {
    const t  = new Date(phNow.getTime() - (12 - i) * 5 * 60 * 1000);
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    return i === 12 ? "Now" : `${hh}:${mm}`;
  });

  const waterChartData = {
    labels: timeLabels,
    datasets: allFews.map((f, i) => ({
      label: f.name,
      data: Array.from({ length: 13 }, (_, j) => {
        if (!fews1Connected) return null;
        const base = f.waterLevel || 0;
        return +(base * (0.3 + j * 0.054) + Math.random() * 0.2).toFixed(2);
      }),
      borderColor: FEWS_COLORS[i],
      backgroundColor: FEWS_COLORS[i].replace(")", ",0.08)").replace("rgb", "rgba"),
      tension: 0.4, pointRadius: 3, pointHoverRadius: 6, borderWidth: 2,
    })),
  };

  const waterChartOptions = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: true, labels: { color: "#94a3b8", font: { size: 9 }, boxWidth: 10 } },
      tooltip: { backgroundColor: "#1e293b", titleColor: "#fff", bodyColor: "#94a3b8", borderColor: "#334155", borderWidth: 1 },
    },
    scales: {
      y: { beginAtZero: true, grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: "#64748b", font: { size: 10 } } },
      x: { grid: { color: "rgba(255,255,255,0.04)" }, ticks: { color: "#64748b", maxRotation: 0, minRotation: 0, font: { size: 9 } } },
    },
  };

  const batteryData = {
    labels: allFews.map(f => f.name),
    datasets: [{ label: "Battery %", data: allFews.map(f => fews1Connected ? f.battery : null),
      backgroundColor: allFews.map(f => f.battery > 80 ? "#22c55e" : f.battery > 50 ? "#f59e0b" : "#ef4444"),
      borderRadius: 6 }],
  };

  const batteryOptions = {
    indexAxis: "y", responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { backgroundColor: "#1e293b", titleColor: "#fff", bodyColor: "#94a3b8", borderColor: "#334155", borderWidth: 1 } },
    scales: {
      x: { max: 100, grid: { color: "rgba(255,255,255,0.05)" }, ticks: { color: "#64748b", font: { size: 9 }, callback: v => `${v}%` } },
      y: { grid: { display: false }, ticks: { color: "#94a3b8", font: { size: 10 } } },
    },
  };

  const alertCount      = allFews.filter(f => f.status !== "safe").length;
  const selectedStation = allFews.find(f => f.id === selectedFEWS) || null;
  const pageInfo        = PAGE_TITLES[activeNav];

  const lastUpdatedStr = lastUpdated
    ? lastUpdated.toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour:"2-digit", minute:"2-digit", second:"2-digit" })
    : null;

  return (
    <div className="app-shell">
      {showLogoutModal && (
        <ConfirmModal title="Logout" message="Are you sure you want to log out of the CDRRMO dashboard?"
          confirmLabel="Yes, Logout" confirmColor="var(--red)"
          onConfirm={() => { setShowLogoutModal(false); setIsLoggedIn(false); }}
          onCancel={() => setShowLogoutModal(false)} />
      )}

      {/* ─── SIDEBAR ─── */}
      <aside className={`sidebar ${sidebarOpen ? "" : "collapsed"}`}>
        <div className="brand">
          <div className="brand-icon">🌊</div>
          <div className={`brand-text ${sidebarOpen ? "" : "hidden"}`}>
            <div className="brand-name">CDRRMO</div>
            <div className="brand-tag">Flood Warning System</div>
          </div>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map(item => (
            <button key={item.key} className={`nav-btn ${activeNav === item.key ? "active" : ""}`} onClick={() => setActiveNav(item.key)}>
              <span className="nav-icon">{item.icon}</span>
              <span className={`nav-label ${sidebarOpen ? "" : "hidden"}`}>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className="logout-btn" onClick={() => setShowLogoutModal(true)}>
            <span className="nav-icon">→</span>
            <span className={`nav-label ${sidebarOpen ? "" : "hidden"}`}>Logout</span>
          </button>
        </div>
      </aside>

      {/* ─── MAIN ─── */}
      <div className="main">
        <header className="topbar">
          <div className="top-left">
            <button onClick={() => setSidebarOpen(o => !o)} className="hamburger">
              <span></span><span></span><span></span>
            </button>
            <div className="title-block">
              <h1>{pageInfo.title}</h1>
              <div className="subtitle">
                {activeNav === "Dashboard"
                  ? pageInfo.sub
                  : pageInfo.sub}
              </div>
            </div>
          </div>
          <div className="top-right">
            {alertCount > 0 && (
              <div className="alert-badge">
                <span className="alert-dot" />
                {alertCount} Alert{alertCount > 1 ? "s" : ""}
              </div>
            )}
            <div className={`connection ${fews1Connected ? "online" : "waiting"}`}>
              <span className={fews1Connected ? "pulse-dot" : "wait-dot"} />
              {fews1Connected ? "System Online" : "Waiting for Data"}
            </div>
            <div className="profile-wrap">
              <div className="profile-avatar-btn" onClick={() => setShowProfileDropdown(v => !v)}>
                {user.photo ? <img src={user.photo} alt="avatar" style={{ width:"100%", height:"100%", borderRadius:"50%", objectFit:"cover" }} /> : user.initials}
              </div>
              {showProfileDropdown && createPortal(
                <div style={{ position:"fixed", top:"64px", right:"16px", zIndex:99999 }}>
                  <ProfileDropdown user={user} onSave={u => setUser(u)} onClose={() => setShowProfileDropdown(false)} />
                </div>, document.body
              )}
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
                      const cfg   = STATUS_CONFIG[f.status] || STATUS_CONFIG["safe"];
                      const isSel = selectedFEWS === f.id;
                      const icon  = L.divIcon({
                        className: "",
                        html: `<div style="width:${isSel?"18px":"14px"};height:${isSel?"18px":"14px"};border-radius:50%;background:${cfg.color};border:2px solid white;box-shadow:0 0 ${isSel?"12px":"8px"} ${cfg.color};transition:all 0.3s;"></div>`,
                        iconSize: [isSel?18:14, isSel?18:14],
                        iconAnchor: [isSel?9:7, isSel?9:7],
                      });
                      return (
                        <Marker key={f.id} position={[f.lat, f.lng]} icon={icon}
                          ref={el => { markerRefs.current[f.id] = el; }}
                          eventHandlers={{ click: () => setSelectedFEWS(selectedFEWS === f.id ? null : f.id) }}>
                          <Popup minWidth={180}>
                            <div style={{ fontFamily:"sans-serif", fontSize:"11px", lineHeight:"1.8" }}>
                              <strong style={{ fontSize:"12px" }}>{f.name} - {f.location}</strong>
                              {f.isLive && (
                                <span style={{ marginLeft:6, fontSize:9, color: fews1Connected ? "#22c55e" : "#94a3b8", fontWeight:700 }}>
                                  {fews1Connected ? "● LIVE" : "◌ WAITING"}
                                </span>
                              )}
                              <br />
                              <span style={{ color: cfg.color, fontWeight:700 }}>{cfg.label}</span>
                              {" · "}Water: {fews1Connected ? `${f.waterLevel}cm` : "—"} · Battery: {f.battery}%<br />
                              <button onClick={() => {
                                navigator.clipboard.writeText(`${f.lat}, ${f.lng}`);
                                setCopiedId(f.id);
                                setTimeout(() => setCopiedId(null), 1500);
                              }} style={{ marginTop:"7px", padding:"3px 8px", background: copiedId===f.id?"#22c55e":cfg.color, color:"#000", border:"none", borderRadius:"4px", cursor:"pointer", fontWeight:"700", fontSize:"10px", width:"100%", transition:"background 0.2s" }}>
                                {copiedId===f.id ? "✓ Copied!" : "📋 Copy Coordinates"}
                              </button>
                            </div>
                          </Popup>
                        </Marker>
                      );
                    })}
                  </MapContainer>
                </div>
              </div>

              {/* Water level chart — show waiting state when no data */}
              <div className="card card-water">
                <div className="card-header">
                  <h2>Water Level</h2>
                  <span className="card-tag">{fews1Connected ? "Last 1 Hour" : "Waiting for data"}</span>
                </div>
                {fews1Connected ? (
                  <div className="chart-wrap"><Line data={waterChartData} options={waterChartOptions} /></div>
                ) : (
                  <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8 }}>
                    <div style={{ fontSize:24 }}>📡</div>
                    <div style={{ color:"var(--text-3)", fontSize:12, fontWeight:600 }}>Waiting for FEWS 1 to come online</div>
                    <div style={{ color:"var(--text-3)", fontSize:10, fontFamily:"var(--mono)" }}>Data will appear once the sensor starts transmitting</div>
                  </div>
                )}
              </div>

              {/* Battery chart — show waiting state when no data */}
              <div className="card card-battery">
                <div className="card-header">
                  <h2>Battery Level</h2>
                  <span className="card-tag">{fews1Connected ? "FEWS 1" : "Waiting for data"}</span>
                </div>
                {fews1Connected ? (
                  <div className="chart-wrap"><Bar data={batteryData} options={batteryOptions} /></div>
                ) : (
                  <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8 }}>
                    <div style={{ fontSize:24 }}>🔋</div>
                    <div style={{ color:"var(--text-3)", fontSize:12, fontWeight:600 }}>No battery data yet</div>
                    <div style={{ color:"var(--text-3)", fontSize:10, fontFamily:"var(--mono)" }}>Data will appear once the system starts transmitting</div>
                  </div>
                )}
              </div>
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
                  const isActuallyLive = f.isLive && fews1Connected;
                  return (
                    <button key={f.id} className={`rsb-item ${isSel ? "selected" : ""}`}
                      onClick={() => setSelectedFEWS(isSel ? null : f.id)}
                      style={{ "--status-color": cfg.color }}>
                      <div className="rsb-dot" style={{ background: isActuallyLive ? cfg.color : "#334155" }} />
                      <div className="rsb-info">
                        <div className="rsb-name" style={{ display:"flex", alignItems:"center", gap:5 }}>
                          {f.name}
                          {f.isLive && (
                            <span style={{
                              fontSize: 8, fontWeight: 700,
                              color: isActuallyLive ? "var(--green)" : "var(--text-3)",
                              fontFamily: "var(--mono)"
                            }}>
                              {isActuallyLive ? "LIVE" : "WAITING"}
                            </span>
                          )}
                        </div>
                        <div className="rsb-loc">{f.location || "-"}</div>
                      </div>
                      <div className="rsb-badge" style={{ color: cfg.color, background: cfg.bg }}>
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
                const isActuallyLive = f.isLive && fews1Connected;
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
                    <div className="rsb-stat">
                      <span>Water Level</span>
                      <strong style={{ color: isActuallyLive ? cfg.color : "var(--text-3)" }}>
                        {isActuallyLive ? `${f.waterLevel}cm` : "—"}
                      </strong>
                    </div>
                    <div className="rsb-stat">
                      <span>Battery</span>
                      <strong>{isActuallyLive ? `${f.battery}%` : "—"}</strong>
                    </div>
                    <div className="rsb-stat">
                      <span>Status</span>
                      <strong style={{ color: isActuallyLive ? cfg.color : "var(--text-3)" }}>
                        {isActuallyLive ? cfg.label : "WAITING"}
                      </strong>
                    </div>
                    <div className="rsb-stat">
                      <span>Last sync</span>
                      <strong>{isActuallyLive && lastUpdatedStr ? lastUpdatedStr : "—"}</strong>
                    </div>
                    <div className="rsb-siren">
                      <div className="rsb-siren-label">Siren Control</div>
                      <div className="rsb-siren-row">
                        <span style={{ color: isActuallyLive ? "var(--text-2)" : "var(--text-3)" }}>{sirenOn ? "🔊 Active" : "🔇 Off"}</span>
                        <button
                          className={`siren-btn ${sirenOn ? "siren-on" : "siren-off"}`}
                          onClick={() => isActuallyLive && toggleSiren(f.id)}
                          disabled={!isActuallyLive}
                          style={{ opacity: isActuallyLive ? 1 : 0.3, cursor: isActuallyLive ? "pointer" : "not-allowed" }}
                        >
                          {sirenOn ? "SILENCE" : "MANUAL ON"}
                        </button>
                      </div>
                      <div className="rsb-siren-note">
                        {!isActuallyLive ? "Available once station is live" : sirenOn ? "Tap to silence" : "Tap to manually activate"}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </aside>
          </div>
        )}

        {activeNav === "UnitControl" && <UnitControlPage allFews={allFews} fews1Connected={fews1Connected} />}
        {activeNav === "Logs"        && <LogsPage />}
        {activeNav === "Settings"    && <SettingsPage />}
      </div>
    </div>
  );
}