import ClinicDialog from '../components/ClinicDialog.jsx';
import { SearchField } from "./owner/ui.jsx";
import {useUnsavedChanges} from '../components/useUnsavedChanges.jsx';
import NoteOptionsPage from "./NoteOptionsPage.jsx";
import CatalogPage from "./CatalogPage.jsx";
import AuditActivity from "../components/AuditActivity.jsx";
import { auditActivity } from "../auditActivity.js";
import { PaginatedList } from "../components/Pagination.jsx";
import { useSubmissionReview } from "../components/SubmissionReview.jsx";
import AdminStaff, { useAdminStaff, AdminAudit } from "./AdminStaff.jsx";
import { currentVaccinationDue } from "../vaccinationDue.js";
import { useEffect, useRef, useState } from "react";
import {
  Send,
  Copy,
  Check,
  Mail,
  UserPlus,
  Stethoscope,
  ConciergeBell,
  X,
  AlertCircle,
  Lock,
  AlertTriangle,
  Calendar,
  UserX,
  CreditCard,
  Clock,
  CheckCircle2,
  ShieldAlert
} from "lucide-react";
import "./assistant-desk.css";
import { M, by, TODAY, plus, ROLES, VETS, uid, addLog, Badge } from "../lib.jsx";
import { auth } from "../authApi.js";
import { pn, emOk, tc } from "../validate.js";
import ClinicCalendar from "./ClinicCalendar.jsx";
import DailySalesPage from "./DailySalesPage.jsx";
import ClientsAndPatientsPage from "./ClientsAndPatientsPage.jsx";
import ConsultationsPage from "./ConsultationsPage.jsx";
import { staffRoleLabel } from "../staffRoles.js";

function Bars({ title, data }) {
  const max = Math.max(1, ...Object.values(data));
  return (
    <section className="card">
      <h3 style={{ margin: "0 0 12px" }}>{title}</h3>
      {Object.entries(data).map(([k, n]) => (
        <div className="bar2" key={k} style={{ display: "grid", gridTemplateColumns: "minmax(0,130px) minmax(0,1fr) 30px", gap: "10px", alignItems: "center", margin: "8px 0" }}>
          <span style={{ fontSize: "calc(13px * var(--fs, 1))", fontWeight: "600", color: "#334155" }}>{k}</span>
          <i style={{ display: "block", height: "12px", background: "var(--butter, #f5c542)", borderRadius: "99px", width: `${(n / max) * 100}%` }} />
          <b style={{ fontSize: "calc(13px * var(--fs, 1))", textAlign: "right" }}>{n}</b>
        </div>
      ))}
    </section>
  );
}

export function StaffModal({ db, setDb, me, onClose, onCreated }) {
  const [f, setF] = useState({
    name: "",
    email: "",
    role: "assistant"
  });
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState({ name: false, email: false });
  const [numWarn, setNumWarn] = useState("");
  const [err, setErr] = useState("");
  const [success, setSuccess] = useState(null);
  const [copied, setCopied] = useState(false);
  const unsaved=useUnsavedChanges({value:f,saving:loading,active:!success,onClose});
  const inviting = useRef(false);
  const [emailCheck,setEmailCheck]=useState({email:'',status:'idle'});
  const [emailRetry,setEmailRetry]=useState(0);
  const normalizedEmail=f.email.trim().toLowerCase();
  useEffect(()=>{
    if(!emOk(normalizedEmail) || normalizedEmail.length>255)return;
    let active=true;
    const timer=setTimeout(async()=>{
      try {
        const result=await auth.staffEmailAvailability(normalizedEmail);
        if(typeof result.available!=='boolean')throw Error('Unable to check this email. Please retry.');
        if(active)setEmailCheck({email:normalizedEmail,status:result.available?'available':'registered',pending:result.pendingInvitation===true});
      } catch(error) {
        if(active)setEmailCheck({email:normalizedEmail,status:'error',message:error.message});
      }
    },350);
    return ()=>{active=false;clearTimeout(timer);};
  },[normalizedEmail,emailRetry]);
  // A result belongs only to the exact address checked; never reuse old success.
  const availability=emailCheck.email===normalizedEmail?emailCheck:{status:'checking'};


  const review = useSubmissionReview(f);

  const validateName = (name) => {
    const s = String(name || "").trim();
    if (!s) return "Staff full name is required.";
    if (/\d/.test(name)) return "Numbers are not allowed in names. Please enter letters only.";
    if (s.length < 2) return "Full name must be at least 2 characters.";
    if (s.length > 50) return "Full name cannot exceed 50 characters.";
    return pn(s);
  };

  const validateEmail = (email) => {
    const s = String(email || "").trim();
    if (!s) return "Staff email address is required.";
    return emOk(s) && s.length<=255 ? "" : "Enter a valid email address (user@domain.com).";
  };

  const nameError = touched.name ? validateName(f.name) : "";
  const emailError = touched.email ? validateEmail(f.email) || (availability.status==='registered'?'This email is already registered. Use a different email for a new staff account.':'') : "";
  const emailReady=!validateEmail(f.email) && availability.status==='available';

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (inviting.current) return;

    setTouched({ name: true, email: true });
    const nErr = validateName(f.name);
    if (nErr) return setErr(nErr);
    const emErr = validateEmail(f.email);
    if (emErr) return setErr(emErr);
    if (!emailReady) return setErr("Check email availability before reviewing the invitation.");
    if (f.role === "admin" && !f.confirmAdmin) return setErr("Tick the box to confirm this person should have full administrator access.");

    const formattedName = tc(f.name.trim());

    if (!await review.ask({title:"Review staff invitation",confirmLabel:"Send invitation",description:"Check the email and role. This sends an invitation allowing the recipient to create a staff account with the selected access.",fields:[
        ["Staff name",formattedName],
        ["Email",f.email.trim().toLowerCase()],
        ["Role",staffRoleLabel(f.role)],...(f.role === "admin" ? [["Access","Full administrator access: staff accounts, prices, reports and the audit trail"]] : [])]}))return;
    inviting.current = true;
    setLoading(true);
    try {
      // The recipient may have registered while the invitation was being reviewed.
      let latest;
      try {latest=await auth.staffEmailAvailability(normalizedEmail);}
      catch(error){setEmailCheck({email:normalizedEmail,status:'error',message:error.message});throw error;}
      if(latest.available!==true){
        setEmailCheck({email:normalizedEmail,status:latest.available===false?'registered':'error'});
        throw Error(latest.available===false?'This email is already registered. Use a different email.':'Unable to confirm email availability. Please retry.');
      }
      const res = await auth.inviteStaff({
        email: f.email.trim().toLowerCase(),
        name: formattedName,
        role: f.role,
        ...(f.role === "admin" ? { confirmAdmin: true } : {})
      });

      if (res.status === "ok") {
        setSuccess(res);
        onCreated?.();
        setDb(p => ({
          ...p,
          log: addLog(p, me, `Administrator ${me.name} created staff invitation for ${formattedName} (${f.role}).`)
        }));
      } else {
        setErr(res.error || "Failed to dispatch staff invitation.");
      }
    } catch (err) {
      if(/email.*(?:already|exists|registered)/i.test(err.message||''))setEmailCheck({email:normalizedEmail,status:'registered'});
      setErr(err.message || "Failed to connect to clinic server.");
    } finally {
      inviting.current = false;
      setLoading(false);
    }
  };

  const copyLink = async () => {
    if (!success?.inviteLink) return;
    try { await navigator.clipboard.writeText(success.inviteLink); } catch { setErr("Unable to copy. Select and copy the link below."); return; }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const roleName = staffRoleLabel(f.role);

  return (
    <ClinicDialog label="Staff invitation" onClose={unsaved.close}>
      {unsaved.card}
      <div className="modal" aria-labelledby="staff-invite-title" style={{ width: "min(540px, 100%)", borderRadius: "18px", padding: "26px", overflowWrap: "anywhere" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <div>
            <h3 id="staff-invite-title" style={{ margin: "0 0 4px", fontSize: "calc(19px * var(--fs, 1))", color: "var(--navy, #0f172a)", fontWeight: 700 }}>
              Invite Staff Member
            </h3>
            <p style={{ margin: 0, fontSize: "calc(13px * var(--fs, 1))", color: "#64748b" }}>
              Invite staff to set their password and verify their mobile number
            </p>
          </div>
          <button className="btn ghost sm" onClick={unsaved.close} style={{ padding: "6px" }} aria-label="Close" disabled={loading}>
            <X size={18} />
          </button>
        </div>

        {success ? (
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <div style={{ width: "52px", height: "52px", borderRadius: "50%", background: "#dcfce7", color: "#16a34a", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <Check size={28} strokeWidth={2.5} />
            </div>
            <h4 style={{ margin: "0 0 8px", fontSize: "calc(17px * var(--fs, 1))", color: "#14532d", fontWeight: 700 }}>
              Invitation Created
            </h4>
            <p style={{ margin: "0 0 18px", color: "#475569", fontSize: "calc(13px * var(--fs, 1))", lineHeight: 1.5 }}>
              {success.delivery === "accepted" ? <>The email provider accepted the invitation for <b>{f.email}</b>.</> : <>Email delivery is unconfirmed. Use the secure activation link below and check the configured email service.</>}<br />
              The activation link lets staff set their password and verify their phone number by SMS.
            </p>

            <div style={{ background: "#f8fafc", padding: "12px 14px", borderRadius: "10px", border: "1px solid #e2e8f0", marginBottom: "20px", textAlign: "left" }}>
              <span style={{ fontSize: "calc(11px * var(--fs, 1))", fontWeight: 600, color: "#64748b", textTransform: "uppercase", display: "block", marginBottom: "4px" }}>
                Direct Activation Link
              </span>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <input
                  type="text"
                  readOnly
                  value={success.inviteLink}
                  style={{ flex: 1, minWidth: 0, fontSize: "calc(12px * var(--fs, 1))", padding: "8px 10px", background: "#ffffff", borderRadius: "8px", border: "1px solid #cbd5e1" }}
                />
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={copyLink}
                  style={{ display: "flex", alignItems: "center", gap: "4px", padding: "8px 12px" }}
                >
                  {copied ? <Check size={14} color="#16a34a" /> : <Copy size={14} />}
                  <span>{copied ? "Copied!" : "Copy"}</span>
                </button>
              </div>
            </div>

            {err && <p role="alert">{err}</p>}
            <div className="row end">
              <button className="btn gold" onClick={unsaved.close}>Done</button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit}>
            {review.card}
            <fieldset disabled={loading} style={{border: 0, padding: 0, margin: 0, minWidth: 0}}>
            {err && (
              <div role="alert" style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: "10px", padding: "10px 14px", fontSize: "calc(13px * var(--fs, 1))", marginBottom: "16px", display: "flex", alignItems: "center", gap: "8px" }}>
                <AlertCircle size={16} style={{ flexShrink: 0 }} />
                <span>{err}</span>
              </div>
            )}

            <div className="fld">
              <label htmlFor="staff-invite-role">Staff Role<i> *</i></label>
              <select id="staff-invite-role" value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>
                <option value="assistant">Vet Assistant (Front Desk &amp; Operations)</option>
                <option value="vet">Veterinarian (Clinical Queue &amp; EMR)</option>
                <option value="admin">Clinic Administrator (Full access)</option>
              </select>
              {f.role === "admin" && <div role="note" style={{ marginTop: 8, background: "#f5f3ff", border: "1px solid #ddd6fe", color: "#4c1d95", borderRadius: 10, padding: "10px 12px", fontSize: "calc(12.5px * var(--fs, 1))", lineHeight: 1.6 }}>
                <b>Full administrator access.</b> An administrator can invite and deactivate staff, change prices, and see every record and the audit trail. Invite only a person you trust. The invitation expires in 7 days and every step is logged.
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8, fontWeight: 600 }}><input type="checkbox" name="confirmAdmin" checked={!!f.confirmAdmin} onChange={e => setF({ ...f, confirmAdmin: e.target.checked })} style={{ width: "auto", marginTop: 3 }} />I confirm this person should have full administrator access.</label>
              </div>}
            </div>

            <div className="fld">
              <label htmlFor="staff-invite-name">Full Name<i> *</i></label>
              <input
                id="staff-invite-name"
                type="text"
                placeholder={f.role === "vet" ? "e.g. Roberto Santos" : f.role === "admin" ? "e.g. Maria Dela Cruz" : "e.g. Liza Ramos"}
                value={f.name}
                className={nameError || numWarn ? "bad" : touched.name && !validateName(f.name) ? "ok" : ""}
                aria-invalid={!!(nameError || numWarn)} aria-describedby="staff-invite-name-msg" maxLength={50}
                onChange={e => {
                  setTouched(p=>({...p,name:true}));
                  const raw = e.target.value;
                  if (/\d/.test(raw)) {
                    setNumWarn("Numbers are not allowed in names. Only letters, spaces, hyphens, and apostrophes are accepted.");
                  } else {
                    setNumWarn("");
                  }
                  const filtered = raw.replace(/[0-9]/g, "");
                  setF({ ...f, name: filtered });
                }}
                onBlur={() => {
                  setTouched(p => ({ ...p, name: true }));
                  if (f.name.trim()) setF(p => ({ ...p, name: tc(p.name.trim()) }));
                }}
                required
              />
              {(nameError || numWarn) ? (
                <span id="staff-invite-name-msg" role="alert" className="err" style={{ display: "block", marginTop: "4px", fontSize: "calc(12px * var(--fs, 1))", color: "#dc2626" }}>
                  {numWarn || nameError}
                </span>
              ) : touched.name && !validateName(f.name) ? (
                <span id="staff-invite-name-msg" style={{ display: "block", marginTop: "4px", fontSize: "calc(12px * var(--fs, 1))", color: "#16a34a", fontWeight: 600 }}>
                  Valid name format (letters only, 2-50 characters)
                </span>
              ) : (
                <span id="staff-invite-name-msg" style={{ fontSize: "calc(11px * var(--fs, 1))", color: "#64748b", marginTop: "3px", display: "block" }}>
                  Letters only, minimum 2 to 50 characters. No numbers allowed.
                </span>
              )}
            </div>

            <div className="fld">
              <label htmlFor="staff-invite-email">Staff Email Address<i> *</i></label>
              <input
                id="staff-invite-email"
                type="email"
                placeholder="staff@pawcare.com"
                value={f.email}
                className={emailError || availability.status==='error' ? "bad" : emailReady ? "ok" : ""}
                aria-invalid={!!emailError || availability.status==='error'}
                aria-describedby="staff-email-feedback"
                maxLength={255}
                onChange={e => {setTouched(p=>({...p,email:true}));setEmailCheck({email:'',status:'idle'});setF({ ...f, email: e.target.value.trim() });setErr('');}}
                onBlur={() => setTouched(p => ({ ...p, email: true }))}
                required
              />
              <div id="staff-email-feedback" className={`staff-email-feedback ${emailError || availability.status==='error'?'is-error':emailReady?'is-ready':''}`} aria-live="polite" aria-atomic="true">
                {emailError || (!validateEmail(f.email) ? availability.status==='error' ? <>{availability.message || 'Unable to check this email.'} <button type="button" className="staff-check-retry" onClick={()=>{setEmailCheck({email:'',status:'idle'});setEmailRetry(n=>n+1);}}>Retry email check</button></> : emailReady ? availability.pending ? 'Available for staff setup. Sending replaces the previous invitation link.' : 'Email is available for a new staff account.' : 'Checking whether this email is registered…' : 'Enter an unregistered email. We’ll check it before you send an invitation.')}
              </div>
            </div>

            <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "10px", padding: "10px 14px", fontSize: "calc(12px * var(--fs, 1))", color: "#1e40af", marginTop: "14px", marginBottom: "18px", lineHeight: 1.5 }}>
              <b>Security Protocol:</b> Only Pet Owners can self-register online. Staff logins are strictly authorized by you (the Administrator). The invited staff member will set their own password and verify their phone number by SMS when opening the invitation link.
            </div>

            <div className="row end" style={{ gap: "10px", flexWrap: "wrap" }}>
              <button type="button" className="btn ghost" onClick={unsaved.close}>Cancel</button>
              <button
                type="submit"
                className="btn gold"
                disabled={loading || !emailReady || !!validateName(f.name)}
                style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "10px 18px", fontWeight: 600 }}
              >
                <Send size={15} />
                <span>{loading ? "Sending Invitation..." : `Review ${roleName} Invitation`}</span>
              </button>
            </div>
            </fieldset>
          </form>
        )}
      </div>
    </ClinicDialog>
  );
}

function Dash({ db, setDb, me, go, say }) {
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [logSearch, setLogSearch] = useState("");
  const staff = useAdminStaff();
  const unpaid = db.appts.filter(a=>a.status === "Completed" && a.billingStatus !== "Paid");
  const unfinished = db.appts.filter(a=>["Checked-in","In consultation"].includes(a.status) && a.date <= TODAY);
  const locked = (staff.data?.staff || []).filter(u=>u.active && u.locked);
  const inactiveIds = (staff.data?.staff || []).filter(u=>!u.active).flatMap(u=>[u.id,u.vetId].filter(Boolean));
  const inactiveCare = unfinished.filter(a=>inactiveIds.includes(a.vetId));
  const reassign = db.appts.filter(a=>a.date >= TODAY && ["Pending Approval","Scheduled"].includes(a.status) && inactiveIds.includes(a.vetId));

  const attention = locked.length + reassign.length + inactiveCare.length + unpaid.length;
  const logs = (db.log || []).filter(l => {
    const text = (l.msg || l.action || "").toLowerCase();
    const actor = auditActivity(l).actor.toLowerCase();
    const role = (l.role || (l.user ? l.user.role : "") || "").toLowerCase();
    const q = (logSearch || "").trim().toLowerCase();
    return !q || text.includes(q) || actor.includes(q) || role.includes(q);
  });

  return (
    <>
      <header className="desk-head">
        <div className="desk-welcome">
          <span className="desk-date">{new Date().toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })}</span>
          <h2>Administrator Console</h2>
          <p>{attention ? `${attention} item${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} your attention: ${[locked.length && `${locked.length} locked account${locked.length > 1 ? "s" : ""}`, reassign.length && `${reassign.length} visit${reassign.length > 1 ? "s" : ""} to reassign`, inactiveCare.length && `${inactiveCare.length} unfinished with inactive staff`, unpaid.length && `${unpaid.length} unpaid completed visit${unpaid.length > 1 ? "s" : ""}`].filter(Boolean).join(", ")}.` : "No clinic exceptions right now. Staff access, sales and records are in good shape."}</p>
        </div>
        <div className="desk-quick" role="group" aria-label="Quick actions">
          <button className="btn gold" onClick={() => setShowStaffModal(true)}><UserPlus size={16} aria-hidden="true" />Invite staff</button>
          <button className="btn" onClick={() => go("users")}>Manage staff access</button>
          <button className="btn ghost" onClick={() => go("catalog")}>Services &amp; products</button>
          <button className="btn ghost" onClick={() => go("reports")}>Reports</button>
        </div>
      </header>

      <nav className="desk-tiles" aria-label="Clinic at a glance">
        {[
          [UserPlus, db.owners.length, "Registered owners", "", "clients-patients"],
          [Stethoscope, db.pets.length, "Animal patients", "", "clients-patients"],
          [ShieldAlert, staff.data?.accountCount ?? "—", "Registered accounts", locked.length ? "wa" : "", "users"],
          [Calendar, db.appts.filter(a => a.date === TODAY).length, "Today's appointments", "", "cal"],
          [AlertTriangle, currentVaccinationDue(db.vacc).filter(v => v.nextDue < TODAY).length, "Booster recalls overdue", currentVaccinationDue(db.vacc).some(v => v.nextDue < TODAY) ? "wa" : "", "records"],
          [CreditCard, unpaid.length, "Completed, unpaid", unpaid.length ? "wa" : "", "sales"],
        ].map(([Ic, n, label, tone, page]) => <button key={label} type="button" className={`desk-tile ${tone}`} onClick={() => go(page)}><span className="desk-tile-ic"><Ic size={20} aria-hidden="true" /></span><b>{n}</b><span>{label}</span></button>)}
      </nav>


      {/* Operational Triage: Needs Attention Board */}
      <section className="card admin-exceptions" style={{ marginTop: 16, padding: "24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px", marginBottom: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div style={{
              width: "36px",
              height: "36px",
              borderRadius: "10px",
              background: (locked.length + reassign.length + inactiveCare.length + unpaid.length + unfinished.length) > 0 ? "#fef3c7" : "#dcfce7",
              color: (locked.length + reassign.length + inactiveCare.length + unpaid.length + unfinished.length) > 0 ? "#b45309" : "#15803d",
              display: "flex",
              alignItems: "center",
              justifyContent: "center"
            }}>
              {(locked.length + reassign.length + inactiveCare.length + unpaid.length + unfinished.length) > 0 ? (
                <ShieldAlert size={20} />
              ) : (
                <CheckCircle2 size={20} />
              )}
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: "calc(17px * var(--fs, 1))", color: "var(--navy, #0f172a)", fontWeight: 700 }}>
                Clinic Exceptions &amp; Operational Attention
              </h3>
              <p style={{ margin: "2px 0 0", fontSize: "calc(12.5px * var(--fs, 1))", color: "#64748b" }}>
                Active administrative triage: review clinical blocks, unbilled records, and doctor handoffs.
              </p>
            </div>
          </div>

          <span style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 12px",
            borderRadius: "99px",
            fontSize: "calc(12px * var(--fs, 1))",
            fontWeight: 700,
            background: (locked.length + reassign.length + inactiveCare.length + unpaid.length + unfinished.length) > 0 ? "#fff1f2" : "#f0fdf4",
            color: (locked.length + reassign.length + inactiveCare.length + unpaid.length + unfinished.length) > 0 ? "#be123c" : "#15803d",
            border: `1px solid ${(locked.length + reassign.length + inactiveCare.length + unpaid.length + unfinished.length) > 0 ? "#fecdd3" : "#86efac"}`
          }}>
            {(locked.length + reassign.length + inactiveCare.length + unpaid.length + unfinished.length) > 0 ? (
              <>
                <AlertTriangle size={13} />
                <span>{(locked.length + reassign.length + inactiveCare.length + unpaid.length + unfinished.length)} Action Item(s) Pending</span>
              </>
            ) : (
              <>
                <CheckCircle2 size={13} />
                <span>All Operations On Track (0 Exceptions)</span>
              </>
            )}
          </span>
        </div>

        {staff.error && (
          <div role="alert" style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: "10px", padding: "10px 14px", fontSize: "calc(13px * var(--fs, 1))", marginBottom: "14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>{staff.error}</span>
            <button className="btn ghost sm" onClick={() => staff.load()} style={{ fontSize: "calc(12px * var(--fs, 1))" }}>Retry Staff Sync</button>
          </div>
        )}

        {/* Actionable Exception Items */}
        <div className="admin-exception-grid" style={{ display: "grid", gap: "10px" }}>
          {/* 1. Locked Staff */}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            borderRadius: "12px",
            background: locked.length > 0 ? "#fff1f2" : "#f8fafc",
            border: `1px solid ${locked.length > 0 ? "#fecdd3" : "#e2e8f0"}`,
            flexWrap: "wrap",
            gap: "10px"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: 1 }}>
              <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: locked.length > 0 ? "#ffe4e6" : "#f1f5f9", color: locked.length > 0 ? "#e11d48" : "#64748b", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Lock size={16} />
              </div>
              <div>
                <b style={{ color: locked.length > 0 ? "#9f1239" : "#1e293b", fontSize: "calc(13.5px * var(--fs, 1))" }}>
                  {staff.data ? locked.length : "—"} Active Staff Account(s) Locked
                </b>
                <p style={{ margin: "2px 0 0", fontSize: "calc(12px * var(--fs, 1))", color: "#64748b" }}>
                  Failed password limits or security lockouts. Review the incident reason and restore portal access.
                </p>
              </div>
            </div>
            <button
              type="button"
              className={locked.length > 0 ? "btn sm gold" : "btn ghost sm"}
              onClick={() => go("users")}
              style={{ whiteSpace: "nowrap" }}
            >
              Review Staff Access
            </button>
          </div>

          {/* 2. Scheduled Visits for Inactive Doctors */}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            borderRadius: "12px",
            background: reassign.length > 0 ? "#fffbeb" : "#f8fafc",
            border: `1px solid ${reassign.length > 0 ? "#fde68a" : "#e2e8f0"}`,
            flexWrap: "wrap",
            gap: "10px"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: 1 }}>
              <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: reassign.length > 0 ? "#fef3c7" : "#f1f5f9", color: reassign.length > 0 ? "#d97706" : "#64748b", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Calendar size={16} />
              </div>
              <div>
                <b style={{ color: reassign.length > 0 ? "#92400e" : "#1e293b", fontSize: "calc(13.5px * var(--fs, 1))" }}>
                  {staff.data ? reassign.length : "—"} Upcoming Visit(s) Assigned to Inactive Doctors
                </b>
                <p style={{ margin: "2px 0 0", fontSize: "calc(12px * var(--fs, 1))", color: "#64748b" }}>
                  The assigned veterinarian is inactive. Ask front desk / reception to reassign patient slots to active doctors.
                </p>
              </div>
            </div>
            <button
              type="button"
              className={reassign.length > 0 ? "btn sm gold" : "btn ghost sm"}
              onClick={() => go("cal")}
              style={{ whiteSpace: "nowrap" }}
            >
              Review Calendar Slots
            </button>
          </div>

          {/* 3. Arrived Patients with Inactive Caregiver */}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            borderRadius: "12px",
            background: inactiveCare.length > 0 ? "#fff1f2" : "#f8fafc",
            border: `1px solid ${inactiveCare.length > 0 ? "#fecdd3" : "#e2e8f0"}`,
            flexWrap: "wrap",
            gap: "10px"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: 1 }}>
              <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: inactiveCare.length > 0 ? "#ffe4e6" : "#f1f5f9", color: inactiveCare.length > 0 ? "#e11d48" : "#64748b", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <UserX size={16} />
              </div>
              <div>
                <b style={{ color: inactiveCare.length > 0 ? "#9f1239" : "#1e293b", fontSize: "calc(13.5px * var(--fs, 1))" }}>
                  {staff.data ? inactiveCare.length : "—"} Arrived Visit(s) Assigned to Inactive Doctors
                </b>
                <p style={{ margin: "2px 0 0", fontSize: "calc(12px * var(--fs, 1))", color: "#64748b" }}>
                  Reactivate the responsible doctor to complete a clinical handoff, or reassign in clinic queues.
                </p>
              </div>
            </div>
            <button
              type="button"
              className={inactiveCare.length > 0 ? "btn sm" : "btn ghost sm"}
              onClick={() => go("users")}
              style={{ whiteSpace: "nowrap" }}
            >
              Manage Staff Status
            </button>
          </div>

          {/* 4. Unpaid Completed Consultations */}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            borderRadius: "12px",
            background: unpaid.length > 0 ? "#fffbeb" : "#f8fafc",
            border: `1px solid ${unpaid.length > 0 ? "#fde68a" : "#e2e8f0"}`,
            flexWrap: "wrap",
            gap: "10px"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: 1 }}>
              <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: unpaid.length > 0 ? "#fef3c7" : "#f1f5f9", color: unpaid.length > 0 ? "#d97706" : "#64748b", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <CreditCard size={16} />
              </div>
              <div>
                <b style={{ color: unpaid.length > 0 ? "#92400e" : "#1e293b", fontSize: "calc(13.5px * var(--fs, 1))" }}>
                  {unpaid.length} Completed Visit(s) Unpaid
                </b>
                <p style={{ margin: "2px 0 0", fontSize: "calc(12px * var(--fs, 1))", color: "#64748b" }}>
                  Doctor has signed off consultations; front desk checkout is awaiting payment and invoice finalisation.
                </p>
              </div>
            </div>
            <button
              type="button"
              className={unpaid.length > 0 ? "btn sm gold" : "btn ghost sm"}
              onClick={() => go("sales")}
              style={{ whiteSpace: "nowrap" }}
            >
              Resolve in Sales
            </button>
          </div>

          {/* 5. In-Progress Unfinished Consultations */}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "12px 16px",
            borderRadius: "12px",
            background: unfinished.length > 0 ? "#eff6ff" : "#f8fafc",
            border: `1px solid ${unfinished.length > 0 ? "#bfdbfe" : "#e2e8f0"}`,
            flexWrap: "wrap",
            gap: "10px"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0, flex: 1 }}>
              <div style={{ width: "32px", height: "32px", borderRadius: "8px", background: unfinished.length > 0 ? "#dbeafe" : "#f1f5f9", color: unfinished.length > 0 ? "#2563eb" : "#64748b", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Clock size={16} />
              </div>
              <div>
                <b style={{ color: unfinished.length > 0 ? "#1e40af" : "#1e293b", fontSize: "calc(13.5px * var(--fs, 1))" }}>
                  {unfinished.length} Arrived Visit(s) in Progress
                </b>
                <p style={{ margin: "2px 0 0", fontSize: "calc(12px * var(--fs, 1))", color: "#64748b" }}>
                  Patients checked-in or undergoing medical examination. Awaiting attending veterinarian SOAP finalization.
                </p>
              </div>
            </div>
            <button
              type="button"
              className={unfinished.length > 0 ? "btn sm" : "btn ghost sm"}
              onClick={() => go("records")}
              style={{ whiteSpace: "nowrap" }}
            >
              Review Clinical EMR
            </button>
          </div>
        </div>
      </section>
      <div className="two admin-breakdowns" style={{ marginTop: "16px" }}>
        <Bars title="Appointments by Status" data={db.totals?.appointment_status || by(db.appts, "status")} />
        {staff.data ? (
          <Bars title="Staff accounts by role" data={Object.fromEntries(Object.entries(by(staff.data.staff, "role")).map(([role, n]) => [staffRoleLabel(role), n]))} />
        ) : (
          <section className="card" style={{ padding: "20px", minHeight: "180px", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", color: "#94a3b8" }}>
            <span style={{ fontSize: "calc(13px * var(--fs, 1))", fontWeight: 600 }}>Staff accounts by role</span>
            <span style={{ fontSize: "calc(12px * var(--fs, 1))", marginTop: "4px" }}>Loading breakdown…</span>
          </section>
        )}
      </div>

      {/* Security & Activity Audit Log */}
      <section className="card admin-recent-activity" style={{ marginTop: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px", flexWrap: "wrap", gap: "10px" }}>
          <div>
            <h3 style={{ margin: "0 0 4px" }}>Recent clinic activity</h3><button type="button" className="btn sm ghost" onClick={()=>go("audit")}>Open full audit trail</button>
            <p style={{ margin: 0, fontSize: "calc(13px * var(--fs, 1))", color: "#64748b" }}>
              Latest 100 saved entries. Open System Audit Trail to search older activity.
            </p>
          </div>
          <div className="desk-search-inline"><SearchField id="recent-activity-search" label="Search recent activity" value={logSearch} onChange={setLogSearch} placeholder="Person, action or role" result={`${logs.length} entr${logs.length === 1 ? "y" : "ies"} match`} /></div>
        </div>

        {logs.length ? (
          <PaginatedList label="Recent activity" resetKey={logSearch} className="audit-entry-list">{logs.map(l=><AuditActivity key={l.id} entry={l}/>)}</PaginatedList>
        ) : (
          <div className="empty sm">No activity matching your search.</div>
        )}
      </section>

      {showStaffModal && (
        <StaffModal
          db={db}
          setDb={setDb}
          me={me}
          onClose={() => setShowStaffModal(false)}
          onCreated={() => staff.load()}
        />
      )}
    </>
  );
}

function StaffPage(props) {
  const [inviting,setInviting] = useState(false),[revision,setRevision]=useState(0);
  return <><AdminStaff key={revision} onInvite={()=>setInviting(true)} />{inviting && <StaffModal {...props} onCreated={()=>setRevision(r=>r+1)} onClose={()=>{setInviting(false);setRevision(r=>r+1);}} />}</>;
}

export const admin = {
  portal: "Clinic Administrator Console",
  Dash,
  menu: [
    { k: "home", l: "Clinic Overview", i: "hospital", dash: 1, sub: "Clinic-wide analytics, audit trail, and staff provisioning." },
    { k:"users", l:"Staff Access & Invitations", i:"shield", Page:StaffPage, sub:"Invite veterinarians, assistants and administrators, review access, and resolve locked accounts." },
    { k: "sales", l: "Sales & Financial Audit", i: "receipt", Page: DailySalesPage, sub: "Review settled payments and paid invoices; reception collects payments." },
    { k: "cal", l: "Master Calendar", i: "calendar", Page: ClinicCalendar, sub: "Clinic appointment calendar (read-only administrative oversight)." },
    { k: "clients-patients", l: "Clients & Patients Masterlist", i: "users", Page: ClientsAndPatientsPage, sub: "Unified masterlist of pet owners, animal patient profiles, and official vaccination cards." },
    { k: "records", l: "Consultations & EMR", i: "file", Page: ConsultationsPage, sub: "Certified veterinary consultation notes, EMR, and prescription handoff." },
    { k:"catalog", l:"Services & Products", i:"receipt", Page:CatalogPage, sub:"Add, edit, search and retire the services and products the clinic sells and prescribes." },
    { k:"note-options", l:"Clinical Note Choices", i:"file", Page:NoteOptionsPage, sub:"Manage optional diagnosis and treatment entries for consultations." },
    { k:"audit", l:"System Audit Trail", i:"shield", Page:AdminAudit, sub:"Search saved activity and review older entries." },
    { k: "reports", l: "Reports & Audits", i: "chart", rep: 1, sub: "Filter, audit, and print clinic summaries." },
    { k: "owners", hide: true, Page: ClientsAndPatientsPage },
    { k: "pets", hide: true, Page: ClientsAndPatientsPage },
    { k: "appts", hide: true, Page: ClinicCalendar },
  ],
};
