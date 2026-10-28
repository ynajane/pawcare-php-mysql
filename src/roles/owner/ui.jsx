import ClinicDialog from '../../components/ClinicDialog.jsx';
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import "./owner.css";

/* Hand-off between pages (e.g. "Book a visit" on a pet card opens the form with that pet selected). */
export const prefill = { data: null };
// A shortcut may only carry plain values. Anything else (such as a click event) would break the booking form.
const PREFILL_TEXT = ['petId', 'service', 'reason', 'date', 'followUpId', 'vaccineName', 'vaccineDueDate'];
export const setPrefill = d => {
  if (!d || typeof d !== 'object') { prefill.data = null; return; }
  const safe = Object.fromEntries(PREFILL_TEXT.filter(key => typeof d[key] === 'string' && d[key]).map(key => [key, d[key]]));
  if (d.fromVaccineCard === true) safe.fromVaccineCard = true;
  prefill.data = safe.petId || safe.service || safe.reason || safe.date ? safe : null;
};

export const pad = n => String(n).padStart(2, "0");
export const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const fmt12 = t => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}`; };
export const petAge = birth => {
  if (!birth) return "";
  const b = new Date(birth + "T00:00:00"), n = new Date();
  let m = (n.getFullYear() - b.getFullYear()) * 12 + n.getMonth() - b.getMonth();
  if (n.getDate() < b.getDate()) m--;
  if (m < 1) return "under 1 month";
  return m < 12 ? `${m} mo` : `${Math.floor(m / 12)} yr${Math.floor(m / 12) > 1 ? "s" : ""}${m % 12 ? ` ${m % 12} mo` : ""}`;
};

/* Live validation: errors are recalculated on every keystroke.
   An error shows as soon as a field has text, or once it was touched / the form was submitted. */
export function useLive(init, validate) {
  const [v, setV] = useState(init), [t, setT] = useState({}), [sub, setSub] = useState(false);
  const errs = validate(v);
  const set = (k, val) => { setV(p => ({ ...p, [k]: val })); setT(p => ({ ...p, [k]: true })); };
  const patch = o => { setV(p => ({ ...p, ...o })); setT(p => ({ ...p, ...Object.fromEntries(Object.keys(o).map(k => [k, true])) })); };
  const quiet = o => setV(p => ({ ...p, ...o }));   // change values without marking them as touched (no instant errors)
  const blur = k => setT(p => ({ ...p, [k]: true }));
  const filled = k => String(v[k] ?? "").trim() !== "";
  const show = (k, eager = true) => ((t[k] || sub || (eager && filled(k))) ? errs[k] || "" : "");
  const ok = k => !!t[k] && filled(k) && !errs[k];
  return { v, set, patch, quiet, blur, errs, show, ok, valid: !Object.keys(errs).length, submit: event => {
    setSub(true);
    const form=event?.currentTarget;
    if(form && Object.keys(errs).length) requestAnimationFrame(()=>form.querySelector('[aria-invalid="true"]:not(:disabled)')?.focus());
  }, count: Object.keys(errs).length, submitted: sub };
}

/* One field = label + control + live error / hint + optional character counter.
   The wrapper carries is-error / is-valid so the whole field (border, icon, message) reacts while typing. */
export function Field({ id, label, req, type = "text", value, onChange, onBlur, error, valid, hint, options = [], max, rows = 3, disabled, min, maxDate, step, autoComplete, readOnly, filter, filterMsg, inputMode, maxLen, placeholder, emptyLabel = "" }) {
  const [blk, setBlk] = useState(""), tm = useRef();
  /* filter = keystroke guard: characters that don’t belong are removed as they are typed or pasted */
  const change = e => {
    const raw = e.target.value, val = filter ? filter(raw) : raw;
    if (filter && raw.replace(/\s/g, "") !== val.replace(/\s/g, "")) { setBlk(filterMsg || "That character isn’t allowed here"); clearTimeout(tm.current); tm.current = setTimeout(() => setBlk(""), 2200); } else if (blk) setBlk("");
    onChange && onChange(val);
  };
  useEffect(() => () => clearTimeout(tm.current), []);
  const bad = !!(error || blk), good = !bad && !!valid && !readOnly;
  const common = { id, name:id, required:!!req, value: value ?? "", onChange: change, onBlur, disabled, readOnly, placeholder, "aria-invalid": bad, "aria-describedby": `${id}-m`, className: good ? "ow-valid" : "" };
  const len = String(value ?? "").length, limit = type === "textarea" ? max : maxLen;
  let ctl;
  if (type === "select") ctl = <select {...common}><option value="">{emptyLabel}</option>{options.map(([a, b, dis]) => <option key={a} value={a} disabled={dis}>{b}</option>)}</select>;
  else if (type === "textarea") ctl = <textarea {...common} rows={rows} />;
  else ctl = <input {...common} type={type} min={min} max={maxDate} step={step} autoComplete={autoComplete} inputMode={inputMode} maxLength={maxLen} />;
  return (
    <div className={`fld${bad ? " is-error" : good ? " is-valid" : ""}${readOnly ? " is-readonly" : ""}`}>
      <label htmlFor={id}>{label}{req && <i> *</i>}{limit && (type === "textarea" || len > 0) && <span className={`ow-count${len > limit ? " over" : len >= limit * 0.9 ? " near" : ""}`}>{len}/{limit}</span>}</label>
      {ctl}
      <span id={`${id}-m`} className={bad ? "err" : "ow-hint"} aria-live="polite">{blk || error || hint || ""}</span>
    </div>
  );
}

/* Characters a search box accepts. Anything else is dropped as it is typed, with a short message. */
export const searchText = s => tidy(s.replace(/[^A-Za-zÀ-ÿ0-9 .,'’#&/@:()+_\-]/g, ""));

/* Search box with live checks: typing guard, length limit, counter, clear button and a result hint. */
export function SearchField({ id, label, value, onChange, placeholder, max = 60, hint, result, lettersOnly = false }) {
  const [blk, setBlk] = useState(""), tm = useRef(), ref = useRef();
  useEffect(() => () => clearTimeout(tm.current), []);
  // lettersOnly: names only. Numbers and special characters are dropped as they are typed.
  const clean = s => lettersOnly ? tidy(s.replace(/[^A-Za-zÀ-ÿ ]/g, "")) : searchText(s);
  const change = e => {
    const raw = e.target.value, val = clean(raw).slice(0, max);
    if (raw.replace(/\s/g, "") !== val.replace(/\s/g, "")) {
      setBlk(clean(raw).length > max ? `Keep your search under ${max} characters` : lettersOnly ? "Only letters can be searched. No numbers or special characters." : "Only letters, numbers and basic punctuation can be searched");
      clearTimeout(tm.current); tm.current = setTimeout(() => setBlk(""), 2400);
    } else if (blk) setBlk("");
    onChange(val);
  };
  const clear = () => { onChange(""); setBlk(""); ref.current?.focus(); };
  const len = value.length, bad = !!blk;
  return (
    <div className={`fld ow-search${bad ? " is-error" : ""}`}>
      <label htmlFor={id}>{label}{len > 0 && <span className={`ow-count${len >= max ? " over" : len >= max * 0.9 ? " near" : ""}`}>{len}/{max}</span>}</label>
      <div className="ow-search-box">
        <Icon n="search" size={17} />
        <input ref={ref} id={id} name={id} type="text" inputMode="search" autoComplete="off" value={value} onChange={change} onKeyDown={e => { if (e.key === "Enter") e.preventDefault(); }} placeholder={placeholder} maxLength={max + 20} aria-invalid={bad} aria-describedby={`${id}-m`} />
        {len > 0 && <button type="button" className="ow-search-x" onClick={clear} aria-label={`Clear ${label.toLowerCase()}`}>×</button>}
      </div>
      <span id={`${id}-m`} className={bad ? "err" : "ow-hint"} aria-live="polite">{blk || (len > 0 && result) || hint || ""}</span>
    </div>
  );
}

/* Tap-to-add suggestion chips for free-text boxes. */
export function Suggest({ items, onPick, label = "Suggestions:" }) {
  return <div className="ow-chips"><small>{label}</small>{items.map(s => <button type="button" key={s} className="ow-chip" onClick={() => onPick(s)}>{s}</button>)}</div>;
}

export function Modal({ title, onClose, children, className = "", portalTo, closeButton = false }) {
  const dialog = <ClinicDialog label={title} onClose={onClose}><div className={`modal ${className}`}>
    {closeButton ? <div className="ow-account-heading"><h3>{title}</h3><button type="button" className="ow-account-close" onClick={onClose} aria-label="Close dialog">×</button></div> : <h3>{title}</h3>}
    {children}
  </div></ClinicDialog>;
  return portalTo ? createPortal(dialog, portalTo) : dialog;
}

/* Append a suggestion to a note without exceeding the limit or repeating it. */
export const addNote = (cur, s, max) => {
  const c = String(cur || "").trim();
  if (c.toLowerCase().includes(s.toLowerCase())) return c;
  const n = c ? `${c}${/[.!?]$/.test(c) ? "" : "."} ${s}` : s;
  return n.length > max ? c : n;
};

/* ---- typing guards and matching rules ---- */
const tidy = s => s.replace(/^\s+/, "").replace(/\s{2,}/g, " ");
export const onlyLetters = s => tidy(s.replace(/[^A-Za-zÀ-ÿ .'\-]/g, ""));          // no digits, no other symbols
export const onlyDigitsPlus = s => s.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "").slice(0, 13); // phone
export const noSpaces = s => s.replace(/\s/g, "");
export const onlyDecimal = s => { let t = s.replace(/[^\d.]/g, ""); const i = t.indexOf("."); if (i >= 0) t = t.slice(0, i + 1) + t.slice(i + 1).replace(/\./g, ""); const [a, b] = t.split("."); return b === undefined ? a.slice(0, 3) : `${a.slice(0, 3)}.${b.slice(0, 2)}`; };
export const LETTERS_RE = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .'\-]*$/;      // must start with a letter
export const hasLetter = s => /[A-Za-zÀ-ÿ]/.test(s);                  // free text can’t be only numbers/symbols
export const DECIMAL_RE = /^(\d{1,3}(\.\d{1,2})?|\.\d{1,2})$/;

/* ---- pictures, hand-off between pages ---- */
export const pick = { petId: null };            // "open this pet's vaccination card"
export const ymdLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function Avatar({ src, fallback, size = 40, round = true }) {
  return <span className="ow-ava" style={{ width: size, height: size, borderRadius: round ? "50%" : 18, fontSize: size * 0.45 }}>{src ? <img src={src} alt="" /> : fallback}</span>;
}

/* Crop to a centred square and shrink to 256 px so it stays small in storage. */
export const toSquare = (file, px = 256) => new Promise((ok, no) => {
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const s = Math.min(img.width, img.height);
    if (s < 64) return no(new Error("small"));
    const c = document.createElement("canvas"); c.width = c.height = px;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, px, px);
    g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, px, px);
    ok(c.toDataURL("image/jpeg", 0.85));
  };
  img.onerror = () => { URL.revokeObjectURL(url); no(new Error("bad")); };
  img.src = url;
});

/* Live-validated picture picker: type, size and readability are checked the moment a file is chosen. */
export function PhotoUpload({ src, fallback, onSave, onRemove, size = 84, round = true, label = "Upload picture", onBusyChange }) {
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false), ref = useRef(), flight=useRef(false);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(()=>{
    if(!busy)return;
    const leave=event=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',leave);
    return()=>window.removeEventListener('beforeunload',leave);
  },[busy]);
  const choose = async e => {
    const file = e.target.files && e.target.files[0]; e.target.value = "";
    if (!file || flight.current) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return setErr("Only JPG, PNG or WEBP pictures are allowed");
    if (file.size > 5 * 1024 * 1024) return setErr("That picture is too big. The limit is 5 MB");
    flight.current=true; setErr(""); setBusy(true);
    let photo;
    try { photo = await toSquare(file); }
    catch (x) { setErr(x.message === "small" ? "Picture is too small. Use at least 64 × 64 pixels" : "We couldn’t read that picture. Try another one"); setBusy(false); flight.current=false; return; }
    try { await onSave(photo); }
    catch (x) { setErr(x.message || "Your picture could not be saved. Please try again."); }
    flight.current=false; setBusy(false);
  };
  const remove = async () => {
    if(flight.current)return;
    flight.current=true; setErr(""); setBusy(true);
    try { await onRemove(); }
    catch (x) { setErr(x.message || "Your picture could not be removed. Please try again."); }
    flight.current=false; setBusy(false);
  };
  return (
    <div className="ow-photo">
      <Avatar src={src} fallback={fallback} size={size} round={round} />
      <div>
        <input ref={ref} type="file" accept="image/jpeg,image/png,image/webp" onChange={choose} hidden aria-label={label} />
        <button type="button" className="btn ghost sm" onClick={() => ref.current.click()} disabled={busy}>{busy ? "Working…" : src ? "Change picture" : label}</button>{" "}
        {src && <button type="button" className="btn danger sm" onClick={remove} disabled={busy}>Remove</button>}
        <span className={err ? "err" : "ow-hint"} aria-live="polite">{err || "JPG, PNG or WEBP, up to 5 MB"}</span>
      </div>
    </div>
  );
}

/* ---- inline SVG icons (no emojis) ---- */
/* Small inline SVG icons for the owner pages (stroke icons, they take the text colour). */
const PATHS = {
  paw: <><circle cx="5.5" cy="11" r="1.8" /><circle cx="9.5" cy="6.5" r="1.8" /><circle cx="14.5" cy="6.5" r="1.8" /><circle cx="18.5" cy="11" r="1.8" /><path d="M12 12.2c-3 0-5.4 2.8-5.4 5 0 1.6 1.4 2.3 2.9 2.3 1 0 1.6-.5 2.5-.5s1.5.5 2.5.5c1.5 0 2.9-.7 2.9-2.3 0-2.2-2.4-5-5.4-5z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  alert: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8v.5" /></>,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  trash: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
  syringe: <path d="M15 4l5 5M13 6l5 5-7 7-5-5zM6 14l-3 3M9 17l-3 3" />,
  camera: <><path d="M4 8h3l1.5-2h7L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
  print: <><path d="M7 9V4h10v5M7 17H5v-7h14v7h-2" /><rect x="7" y="14" width="10" height="6" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></>,
  chevron: <path d="M9 6l6 6-6 6" />,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>,
};
export const Icon = ({ n, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}>{PATHS[n]}</svg>
);