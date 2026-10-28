import {saveLoginCooldown} from '../loginCooldown.js';
import {useResendTimer} from "../useResendTimer.js";
import { useState, useEffect, useRef } from "react";
import AuthShell, { AuthBrand } from "./AuthShell.jsx";
import { validateCode } from "../validate.js";
import { useLive } from "../roles/owner/ui.jsx";
import { auth, OFFLINE_MSG } from "../authApi.js";
import OtpBoxInput from "./OtpBoxInput.jsx";
import {
  Mail,
  CheckCircle2,
  Smartphone,
  ArrowRight,
  RotateCcw,
  ExternalLink,
  ShieldCheck,
  Copy,
  Check,
  Sparkles,
  ArrowLeft
} from "lucide-react";
import "./auth.css";
import "./brand.css";
import "./auth-flow.css";

/* ---------- 1. "Check your email" after registering ---------- */
export function CheckEmail({ email, receipt, go }) {
  const [accepted,setAccepted]=useState(receipt?.delivery === "accepted");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState(receipt?.delivery === "failed" ? receipt.message : "");
  const [cool, setCool] = useResendTimer(receipt?.retryAfter ?? 0);
  const sending = useRef(false);
  const [copied, setCopied] = useState(false);

  const copyEmail = async () => {
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setErr("Could not copy. Select the email address to copy it.");
    }
  };

  const resend = async () => {
    if (sending.current || cool > 0) return;
    sending.current = true;
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const result=await auth.resendVerification(email);
      setAccepted(result.delivery === "accepted");
      setMsg(result.message);
      setErr("");
      setCool(result.retryAfter ?? 60);
    } catch (x) {
      setErr(x.offline ? OFFLINE_MSG : x.message || "Please try again.");
      setCool(x.retryAfter || (x.status===429 || x.status===503 ? 60 : 0));
    }
    sending.current=false;
    setBusy(false);
  };

  const domain = (email || "").split("@")[1]?.toLowerCase() || "";
  const isGmail = domain.includes("gmail");
  const isOutlook = domain.includes("outlook") || domain.includes("hotmail");
  const isYahoo = domain.includes("yahoo");

  return (
    <AuthShell title={<>One step closer to <em>connected care.</em></>} description="Verify your email, then your mobile number to finish setting up your account.">

      <div className="login-card auth-verify-card">
          <AuthBrand />
        {/* Step Tracker */}
        <div className="verify-steps">
          <span className="verify-step-pill done">
            <CheckCircle2 size={13} /> 1. Registered
          </span>
          <span className="verify-step-sep">›</span>
          <span className="verify-step-pill active">
            <Mail size={13} /> 2. Verify Email
          </span>
          <span className="verify-step-sep">›</span>
          <span className="verify-step-pill">
            <Smartphone size={13} /> 3. Mobile Code
          </span>
        </div>

        {/* Animated Envelope Graphic */}
        <div className="envelope-badge-wrap">
          <div className="envelope-pulse-bg" />
          <div className="envelope-icon-box">
            <Mail size={32} />
          </div>
          <div className="envelope-paw-tag"><CheckCircle2 size={15} aria-hidden="true" /></div>
        </div>

        <h2>Check your inbox</h2>
        <p className="card-subtitle">
          {accepted ? "The email provider accepted your verification email. Check your inbox and spam folder." : "Your account is saved. Request a verification email to activate it."}
        </p>

        {/* User Email Pill with Copy */}
        <div className="user-email-pill" title="Click to copy email address">
          <span>{email || "your email address"}</span>
          <button type="button" onClick={copyEmail} aria-label="Copy email address">
            {copied ? <Check size={14} color="#059669" /> : <Copy size={14} />}
          </button>
        </div>

        {/* 1-Click Webmail Quick Launchers */}
        <div className="webmail-shortcuts" aria-label="Quick email access">
          {isOutlook && (
            <a
              href="https://outlook.live.com"
              target="_blank"
              rel="noopener noreferrer"
              className="webmail-btn"
              style={{ borderColor: "#0078d4", color: "#005a9e" }}
            >
              <ExternalLink size={14} /> Open Outlook
            </a>
          )}
          {isYahoo && (
            <a
              href="https://mail.yahoo.com"
              target="_blank"
              rel="noopener noreferrer"
              className="webmail-btn"
              style={{ borderColor: "#6001d2", color: "#5000b8" }}
            >
              <ExternalLink size={14} /> Open Yahoo Mail
            </a>
          )}
          {!isOutlook && !isYahoo && !isGmail && (
            <>
              <a href="https://mail.google.com" target="_blank" rel="noopener noreferrer" className="webmail-btn">
                <ExternalLink size={13} /> Gmail
              </a>
              <a href="https://outlook.live.com" target="_blank" rel="noopener noreferrer" className="webmail-btn">
                <ExternalLink size={13} /> Outlook
              </a>
              <a href="https://mail.yahoo.com" target="_blank" rel="noopener noreferrer" className="webmail-btn">
                <ExternalLink size={13} /> Yahoo
              </a>
            </>
          )}
        </div>

        {/* Status / Error alerts */}
        {msg && <p className="okm" role="status" style={{ margin: "10px 0" }}>{msg}</p>}
        {err && <p className="err" role="alert" style={{ margin: "10px 0" }}>{err}</p>}

        {/* Tips Guidance Box */}
        <div className="verify-tips-box">
          <b><Sparkles size={14} color="#f59e0b" /> What to expect:</b>
          <ul>
            <li>Click the <b>“Verify My Account”</b> button inside the email.</li>
            <li>Can’t find it? Check your <b>Spam or Junk</b> folder.</li>
            <li>The email link stays valid for <b>24 hours</b>.</li>
          </ul>
        </div>

        {/* Resend Action */}
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "14px" }}>
          <button
            type="button"
            className="btn ghost wide"
            disabled={cool > 0 || busy}
            onClick={resend}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
          >
            <RotateCcw size={15} />
            {busy ? "Sending..." : cool > 0 ? `Resend email in ${cool}s` : "Resend verification email"}
          </button>

          <button
            type="button"
            className="btn gold wide"
            onClick={() => go("login")}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
          >
            Back to Log in <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </AuthShell>
  );
}

/* ---------- 2. Mobile code (OTP) with 6 Boxes ---------- */
export function Otp({ onDone, onBack, enabled = true }) {
  const f = useLive({ code: "" }, validateCode);
  const [phone, setPhone] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [n, setN] = useResendTimer(60);
  const verifying = useRef(false);
  const sending = useRef(false);
  const [sendingCode,setSendingCode]=useState(false);

  const fail = (x) => setErr(x.offline ? OFFLINE_MSG : x.message || "Something went wrong. Please try again.");

  const send = async () => {
    if(sending.current || verifying.current)return;
    sending.current=true;setSendingCode(true);setReady(false);
    setErr("");setInfo("");
    try {
      const result=await auth.otpSend();
      setReady(true);setN(result.retryAfter ?? 60);
      setInfo(result.message || "The SMS provider accepted your verification code.");
    } catch(x) {fail(x);setN(x.retryAfter || (x.status===429 || x.status===503?60:0));}
    finally {sending.current=false;setSendingCode(false);}
  };

  const started = useRef(false);
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    (async () => {
      try {
        const i = await auth.otpInfo();
        if (i.mobileVerified) return onDone(); // already verified
        if (i.phone) setPhone(i.phone);
        setN(i.retryAfter || 0);
        if(i.hasActiveOtp)setReady(true);
        else if(i.retryAfter>0)setErr("The SMS code is unavailable. Retry when the resend timer ends.");
        else await send();
      } catch (x) {
        fail(x);
        setN(0);
      }
    })();
  }, [enabled]); // eslint-disable-line

  const handleVerify = async (codeToVerify) => {
    const code = (codeToVerify || f.v.code || "").trim();
    if (!enabled || !ready || code.length !== 6 || verifying.current) return;
    verifying.current = true;
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      await auth.otpVerify(code);
      await onDone();
      return;
    } catch (x) {
      fail(x);
    }
    verifying.current = false;
    setBusy(false);
  };

  const submit = async (e) => {
    e && e.preventDefault();
    handleVerify(f.v.code);
  };

  // Mask phone for security: e.g. "+63 917 123 4567" -> "+63 917 ••• ••67"
  const maskPhone = (raw) => {
    if (!raw) return "your registered mobile number";
    const s = String(raw).trim();
    if (s.length < 7) return s;
    return s.slice(0, 6) + " ••• ••" + s.slice(-2);
  };

  return (
    <AuthShell title={<>A little protection for <em>the ones you love.</em></>} description="Confirm your registered mobile number to securely activate your account.">

      <form className="login-card auth-verify-card" onSubmit={submit} noValidate>
          <AuthBrand />
        {/* Step Tracker */}
        <div className="verify-steps">
          <span className="verify-step-pill done">
            <CheckCircle2 size={13} /> 1. Email Verified
          </span>
          <span className="verify-step-sep">›</span>
          <span className="verify-step-pill active">
            <Smartphone size={13} /> 2. Mobile OTP
          </span>
          <span className="verify-step-sep">›</span>
          <span className="verify-step-pill">
            <Sparkles size={13} /> 3. Log in
          </span>
        </div>

        {/* Security Badge */}
        <div className="envelope-badge-wrap">
          <div className="envelope-pulse-bg" />
          <div className="envelope-icon-box" style={{ background: "linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%)" }}>
            <ShieldCheck size={34} />
          </div>
          <div className="envelope-paw-tag"><Smartphone size={15} aria-hidden="true" /></div>
        </div>

        <h2>Enter 6-digit code</h2>
        <p className="card-subtitle">
          {ready ? <>Code sent to <b>{maskPhone(phone)}</b>. It stays valid for 10 minutes.</> : "Use the 6-digit SMS code sent to your registered mobile number."}
        </p>

        {/* 6 Individual OTP Boxes */}
        <OtpBoxInput
          value={f.v.code}
          onChange={(newCode) => {
            f.set("code", newCode);
            setErr("");
          }}
          hasError={!!err}
          disabled={!enabled || !ready || busy}
          autoFocus={true}
          onComplete={(fullCode) => {
            // Automatically attempt verification when all 6 digits are typed!
            handleVerify(fullCode);
          }}
        />

        {info && <p className="okm" role="status" style={{ margin: "10px 0" }}>{info}</p>}
        {err && <p className="err" role="alert" style={{ margin: "10px 0" }}>{err}</p>}

        <button
          type="submit"
          className="btn gold wide"
          disabled={busy || !ready || f.v.code.length < 6}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", margin: "18px 0 10px" }}
        >
          {busy ? "Verifying code..." : "Verify mobile number"} <ArrowRight size={17} />
        </button>

        <div className="auth-links" style={{ justifyContent: "space-between", marginTop: "14px" }}>
          <button type="button" className="lnk" onClick={onBack} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <ArrowLeft size={14} /> Back to log in
          </button>

          <button
            type="button"
            className="lnk"
            disabled={!enabled || n > 0 || busy || sendingCode}
            onClick={() => send(false)}
            style={{ fontWeight: 600, color: n > 0 ? "#94a3b8" : "#2563eb" }}
          >
            {sendingCode ? "Sending…" : n > 0 ? `Resend SMS in ${n}s` : "Resend SMS code"}
          </button>
        </div>
      </form>
    </AuthShell>
  );
}

/* ---------- 3. Confirm unlock link, then return to login for cooldown ---------- */
export function Unlock({ token, onDone }) {
  const [err,setErr]=useState('');
  const [busy,setBusy]=useState(false);
  const started=useRef(false);
  const check=async()=>{
    setErr('');setBusy(true);
    try {
      const result=await auth.unlock(token);
      if(result.status!=='ok' || !result.cooldownUntil)throw Error('That unlock link is invalid or expired.');
      saveLoginCooldown(result.cooldownUntil);
      onDone('Unlock link confirmed. Wait for the 2-minute cooldown below, then log in.');
    } catch(error) {
      setErr(error.message || 'Could not confirm the unlock link. Please try again.');
    } finally {setBusy(false);}
  };
  useEffect(()=>{if(!started.current){started.current=true;check();}},[]); // eslint-disable-line
  return <AuthShell title={<>Your account, <em>protected.</em></>} description="Confirm your unlock link to start the short login cooldown.">
    <div className="login-card auth-verify-card">
      <AuthBrand />
      <h2>Confirming your unlock link</h2>
      {err ? <p className="err" role="alert">{err}</p> : <p role="status">Checking your link…</p>}
      {err && <button type="button" className="btn gold wide" disabled={busy} onClick={check}>Retry link</button>}
      <button type="button" className="btn ghost wide" disabled={busy} onClick={()=>onDone('')}>Return to Log in</button>
    </div>
  </AuthShell>;
}
