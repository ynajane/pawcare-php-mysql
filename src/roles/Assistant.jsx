import VisitNextStep from '../components/VisitNextStep.jsx';
import Prices from './owner/Prices.jsx';
import { approvalVisit } from "../appointmentStatus.js";
import CancellationDialog from '../components/CancellationDialog.jsx';
import { VaccineEstimate } from "../components/VaccineBooking.jsx";
import AdmissionsPage, { AdmissionsSummary } from './AdmissionsPage.jsx';
import { PaginatedList } from "../components/Pagination.jsx";
import FrontDeskApprovals from "./FrontDeskApprovals.jsx";
import ExistingPatientCheckInModal from "./ExistingPatientCheckInModal.jsx";
import { assistantQueue, pendingVisitApprovals, registrationsWithoutVisit, dailyCollections, pendingCheckout, money } from "../assistantWorkflow.js";
import CareFollowUps from "./CareFollowUps.jsx";
import CheckoutInbox from "./CheckoutInbox.jsx";
import { currentVaccinationDue, vaccinationAppointment, vaccinationBooking, vaccinationStatus } from "../ownerVaccination.js";
import { today, plus } from "../booking.js";
import { setPrefill, SearchField } from "./owner/ui.jsx";
import "./assistant-desk.css";
import { useEffect, useRef, useState } from "react";
import {
  CalendarDays, AlertTriangle, PawPrint, ConciergeBell, Thermometer, Scale, UserCheck, Receipt, ArrowRight, X, Phone, Syringe,
  ClipboardCheck, Hourglass, Stethoscope, BellRing,
} from "lucide-react";
import { moveAppt, Badge, ICON, I } from "../lib.jsx";
import InClinicRegistration from "./InClinicRegistration.jsx";
import BillingModal from "./BillingModal.jsx";
import ClinicCalendar from "./ClinicCalendar.jsx";
import CheckInModal from "./CheckInModal.jsx";
import PetApprovalModal from "./PetApprovalModal.jsx";
import PetRequestsPage from "./PetRequestsPage.jsx";
import PetCardModal from "./PetCardModal.jsx";
import ClientsAndPatientsPage from "./ClientsAndPatientsPage.jsx";
import DailySalesPage from "./DailySalesPage.jsx";
import ConsultationsPage from "./ConsultationsPage.jsx";
import LogCallModal from "./LogCallModal.jsx";

// Owner ids can be "o1" or "o_1" depending on where the record came from.
const sameOwner = (o, id) => !!id && (o.id === id || o.id === id.replace(/^o(\d+)/, "o_$1") || o.id?.replace(/^o_(\d+)/, "o$1") === id);
const tempTone = s => (s === "normal" ? "" : s === "high_fever" || s === "hypothermia" ? "er" : "wa");

function Dash({ db, setDb, me, go, say, navigation, onNavigationHandled }) {
  const TODAY = today();
  const confirmingRef = useRef(new Set());
  const [confirming, setConfirming] = useState({});
  const [actionError, setActionError] = useState("");
  const [queueStage, setQueueStage] = useState("arrivals");
  const [showWalkIn, setShowWalkIn] = useState(false);
  const [showExistingWalkIn, setShowExistingWalkIn] = useState(false);
  const [billingAppt, setBillingAppt] = useState(null);
  const [checkInAppt, setCheckInAppt] = useState(null);
  const [reviewReq, setReviewReq] = useState(null);
  const [rejecting,setRejecting] = useState(null);
  const [cardPetId, setCardPetId] = useState(null);
  const [cardAppt, setCardAppt] = useState(null);
  const [logCallTarget, setLogCallTarget] = useState(null);
  const [search, setSearch] = useState("");

  const pendingReqs = registrationsWithoutVisit(db);
  const queue = assistantQueue(db.appts, TODAY);
  const q = queue[queueStage];
  const waiting = queue.waiting, inConsult = queue.consultation;
  const calls = currentVaccinationDue(db.vacc).filter(v => v.nextDue <= plus(30));
  const collections = dailyCollections(db.appts, TODAY);
  const todayPaid = collections.paid, todayRevenue = collections.total;
  const unbilledCompleted = pendingCheckout(db.appts, TODAY).visits;

  const requests = pendingVisitApprovals(db.appts, TODAY);
  const needle = search.trim().toLowerCase();
  const matches = a => {
    if (!needle) return true;
    const pet = db.pets.find(p => p.id === a.petId) || {};
    const owner = db.owners.find(o => o.id === a.ownerId || sameOwner(o, pet.ownerId)) || {};
    return [pet.name, a.petName, pet.species, pet.breed, owner.name, a.ownerName, owner.phone, a.reason, a.status, a.time].join(" ").toLowerCase().includes(needle);
  };
  const flow = q.filter(matches);
  const jump = (id, stage) => { if (stage) setQueueStage(stage); requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  // "/" jumps to the patient search, like most inbox tools.
  useEffect(() => {
    const onKey = e => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.querySelector(".scrim")) return;
      e.preventDefault(); document.getElementById("desk-search")?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const hour = new Date().getHours(), greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = String(me.name || "").replace(/^Dr\.?\s+/i, "").split(" ")[0];
  const tiles = [
    ["req", ClipboardCheck, requests.length, "Requests to approve", requests.length ? "wa" : "", () => jump("desk-approvals")],
    ["arr", CalendarDays, queue.arrivals.length, "Expected arrivals", "", () => jump("desk-flow", "arrivals")],
    ["wait", Hourglass, waiting.length, "Waiting for the vet", waiting.length ? "info" : "", () => jump("desk-flow", "waiting")],
    ["live", Stethoscope, inConsult.length, "In consultation", "", () => jump("desk-flow", "consultation")],
    ["pay", Receipt, unbilledCompleted.length, "Ready for checkout", unbilledCompleted.length ? "wa" : "", () => jump("desk-checkout")],
    ["rem", BellRing, calls.length, "Vaccine reminders", calls.length ? "info" : "", () => jump("desk-reminders")],
  ];
  const attention = [
    requests.length && `${requests.length} request${requests.length > 1 ? "s" : ""} to approve`,
    queue.overdue.length && `${queue.overdue.length} past-due visit${queue.overdue.length > 1 ? "s" : ""}`,
    unbilledCompleted.length && `${unbilledCompleted.length} checkout${unbilledCompleted.length > 1 ? "s" : ""} waiting`,
  ].filter(Boolean);

  const openCard = (petId, appt = null) => { setCardPetId(petId); setCardAppt(appt); };
  const closeCard = () => { setCardPetId(null); setCardAppt(null); };

  const confirmVisit = async a => {
    if (confirmingRef.current.has(a.id)) return;
    confirmingRef.current.add(a.id);
    setActionError(""); setConfirming(p => ({...p,[a.id]:true}));
    try {
      const saved = await moveAppt(setDb, a.id, "Scheduled", me, setActionError, a.expectedRegistration ? a : approvalVisit(db,a));
      if (saved) {setQueueStage("arrivals");say("Appointment approved. Find it in Expected arrivals and upcoming visits above.");}
      return saved;
    } finally {
      confirmingRef.current.delete(a.id);
      setConfirming(p => ({...p,[a.id]:false}));
    }
  };

  useEffect(()=>{
    if(!navigation?.apptId)return;
    const visit=(db.appts || []).find(a=>a.id===navigation.apptId);
    if(!visit)setActionError('This visit is unavailable. Refresh clinic records before retrying.');
    else if(navigation.action==='checkout' && visit.status==='Completed' && visit.admissionStatus!=='Admitted')setBillingAppt(visit);
    else if(navigation.action==='intake' && ['Scheduled','Checked-in','In consultation'].includes(visit.status))setCheckInAppt(visit);
    else setActionError('This visit changed. Review its current next step before continuing.');
    onNavigationHandled?.();
  },[navigation]);

  return (
    <>
      <header className="desk-head">
        <div className="desk-welcome">
          <span className="desk-date">{new Date().toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })}</span>
          <h2>{greeting}{firstName ? `, ${firstName}` : ""}</h2>
          <p>{attention.length ? `You have ${attention.join(", ")}.` : "Nothing is waiting on you right now. New requests and checkouts will appear here."}</p>
        </div>
        <div className="desk-quick" role="group" aria-label="Quick actions">
          <button className="btn gold" onClick={() => setShowWalkIn(true)}><ConciergeBell size={16} aria-hidden="true" />Register new walk-in</button>
          <button className="btn" onClick={() => setShowExistingWalkIn(true)} title="Quick check-in for patients who are already registered"><UserCheck size={16} aria-hidden="true" />Existing patient check-in</button>
          <button className="btn ghost" onClick={() => go("cal")}><CalendarDays size={16} aria-hidden="true" />Calendar</button>
          {pendingReqs.length > 0 && <button className="btn ghost" onClick={() => go("pet-requests")}><PawPrint size={16} aria-hidden="true" />Pets without a visit ({pendingReqs.length})</button>}
        </div>
      </header>

      <nav className="desk-tiles" aria-label="Today at a glance">
        {tiles.map(([key, Ic, n, label, tone, fn]) => <button key={key} type="button" className={`desk-tile ${tone}`} onClick={fn}><span className="desk-tile-ic"><Ic size={20} aria-hidden="true" /></span><b>{n}</b><span>{label}</span></button>)}
        <button type="button" className="desk-tile money" onClick={() => go("sales")}><span className="desk-tile-ic"><Receipt size={20} aria-hidden="true" /></span><b>{money(todayRevenue)}</b><span>Collected today ({todayPaid.length} paid)</span></button>
      </nav>

      {queue.overdue.length > 0 && queueStage !== "overdue" && <section className="desk-alert" role="alert">
        <AlertTriangle size={20} aria-hidden="true" />
        <div><b>{queue.overdue.length} visit{queue.overdue.length > 1 ? "s" : ""} from earlier days {queue.overdue.length > 1 ? "were" : "was"} never checked in.</b><span>Close each one so the calendar and owners see the right status.</span></div>
        <button type="button" className="btn sm gold" onClick={() => jump("desk-flow", "overdue")}>Review past-due visits</button>
      </section>}


      {rejecting && <CancellationDialog reject visit={rejecting} currentVisit={db.appts.find(a=>a.id===rejecting.id)} error={actionError} onClose={()=>setRejecting(null)} onSubmit={async cancelReason=>{if(await moveAppt(setDb,rejecting.id,"Rejected",me,setActionError,rejecting,{cancelReason})){setRejecting(null);say("Appointment request rejected.");}}} />}

      <div className="desk-grid">
        <div className="desk-main">
          <div id="desk-approvals">
            <FrontDeskApprovals onReject={a=>{setActionError("");setRejecting(a);}} db={db} onReviewPet={setReviewReq} onOpenCard={openCard} onCalendar={() => go("cal")} onConfirm={confirmVisit} confirming={confirming} error={actionError} />
          </div>
        <section className="card desk-flow" id="desk-flow">
          <div className="sf-section-hd">
            <h3>Patient flow ({flow.length}{needle ? ` of ${q.length}` : ""})</h3>
            <span className="sf-sub">{TODAY}</span>
          </div>
          <div className="desk-search"><SearchField id="desk-search" label="Find a patient or owner" value={search} onChange={setSearch} placeholder="Pet name, owner, phone or reason (press / to search)" result={`${flow.length} of ${q.length} in this stage match`} /></div>

          <div className="desk-stages" role="group" aria-label="Patient flow stages">
            {[["arrivals","Expected arrivals"],["waiting","Waiting for vet"],["consultation","In consultation"],["completed","Completed"],["missed","Missed"],...(queue.overdue.length ? [["overdue","Past due"]] : [])].map(([key,label]) => <button key={key} type="button" className={`desk-stage${queueStage === key ? " on" : ""}${key === "overdue" ? " warn" : ""}`} aria-pressed={queueStage === key} onClick={() => setQueueStage(key)}>{label}<b>{queue[key].length}</b></button>)}
          </div>
          {queueStage === "waiting" && <p className="sf-sub">Emergency and priority patients appear first. The veterinarian decides the clinical response.</p>}
          {flow.length ? (
            <PaginatedList label="Patient flow" resetKey={[queueStage, search]} className="sf-grid">
              {flow.map(a => {
                const pet = db.pets.find(p => p.id === a.petId) || {};
                const owner = db.owners.find(o => o.id === a.ownerId || sameOwner(o, pet.ownerId)) || {};
                const isPaid = a.billingStatus === "Paid";
                const iv = a.intakeVitals;
                const rowCls = iv?.triageLevel === "Emergency" ? "is-emergency" : a.status === "Checked-in" ? "is-wait" : a.status === "In consultation" ? "is-live" : "";
                return (
                  <div className={`sf-row ${rowCls}`} key={a.id}>
                    <div className="sf-row-main">
                      <span className="sf-time">{a.date !== TODAY && <small>{a.date}<br /></small>}{a.time}</span>
                      <div className="sf-body">
                        <div className="sf-name">
                          <button type="button" className="sf-link" onClick={() => openCard(pet.id || a.petId, a)} title="Open the digital vaccination card and manage this visit">{pet.name || a.petName || "Patient"}</button>
                          <span className="meta">
                            {pet.species ? `${pet.species}${pet.breed ? ` (${pet.breed})` : ""}` : ""}
                            {owner.name ? `, owner ${owner.name}` : a.ownerName ? `, owner ${a.ownerName}` : ""}
                          </span>
                          {iv?.triageLevel && iv.triageLevel !== "Routine" && (
                            <span className={`sf-pill ${iv.triageLevel === "Emergency" ? "er" : "wa"}`}><AlertTriangle size={12} aria-hidden="true" />{iv.triageLevel}</span>
                          )}
                        </div>
                        <VisitNextStep visit={a} />
                        <div className="sf-reason">{a.reason}</div><VaccineEstimate appointment={a} compact />
                        {iv && (
                          <div className="sf-chips">
                            <span className={`sf-chip ${tempTone(iv.tempAnalysis?.status)}`}><Thermometer size={12} aria-hidden="true" />{iv.temp}&deg;C, {iv.tempAnalysis?.label || "Assessment not recorded"}</span>
                            <span className={`sf-chip ${iv.weightAnalysis?.status === "ideal" ? "" : "wa"}`}><Scale size={12} aria-hidden="true" />{iv.weight} kg, {iv.weightAnalysis?.label || "Assessment not recorded"}</span>
                            {iv.weightAnalysis?.trend && <span className="sf-chip mu">{iv.weightAnalysis.trend}</span>}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="sf-row-act">
                      <Badge v={a.status} />
                      <button className="btn sm ghost" onClick={() => openCard(pet.id || a.petId, a)}>Digital card</button>
                      {a.date < TODAY && a.status === "Pending Approval" && <button className="btn sm danger" onClick={() => {setActionError("");setRejecting(a);}}>Decline request</button>}
                      {a.date < TODAY && a.status === "Scheduled" && <>
                        <button className="btn sm danger" disabled={!!confirming[a.id]} onClick={async () => {if(confirmingRef.current.has(a.id))return;confirmingRef.current.add(a.id);setConfirming(p=>({...p,[a.id]:true}));try{if(await moveAppt(setDb,a.id,"No-show",me,setActionError,a))say("Marked as a missed visit.");}finally{confirmingRef.current.delete(a.id);setConfirming(p=>({...p,[a.id]:false}));}}}>{confirming[a.id] ? "Saving…" : "Mark no-show"}</button>
                        <button className="btn sm ghost" onClick={() => go("cal")} title="Open the calendar to book a new date">Rebook</button>
                      </>}
                      {a.date >= TODAY && a.status === "Pending Approval" && (
                        <button className="btn sm" disabled={!!confirming[a.id]} onClick={() => confirmVisit(a)}>{confirming[a.id] ? "Approving…" : "Approve"}</button>
                      )}
                      {a.date >= TODAY && a.status === "Scheduled" && (
                        <button className="btn sm gold" title="Arrival check-in and vitals intake" onClick={() => setCheckInAppt(a)}>Check in</button>
                      )}
                      {a.status === "Checked-in" && (
                        <button className="btn sm ghost" title="Review or adjust intake vitals" onClick={() => setCheckInAppt(a)}>Edit vitals</button>
                      )}
                      {a.status === "Completed" && a.admissionStatus!=="Admitted" && (
                        <button className={`btn sm ${isPaid ? "ghost" : "gold"}`} onClick={() => setBillingAppt(a)} title="Create the invoice and settle the bill">
                          {isPaid ? "View invoice" : "Bill and check out"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </PaginatedList>
          ) : (
            <div className="empty sm">{queueStage === "overdue" ? "No past-due visits. Everything from earlier days is closed." : (needle ? "No patients in this stage match your search." : "No patients in this stage today.")}</div>
          )}
        </section>

        </div>
        <aside className="desk-side" aria-label="Side tasks">
      <div className="sf-banner">
        <div className="sf-banner-main">
          <span className="sf-banner-ic"><Receipt size={22} aria-hidden="true" /></span>
          <div>
            <div className="sf-title-row">
              <b>Today&rsquo;s collections: {money(todayRevenue)}</b>
              <span className="sf-pill ok">{todayPaid.length} settled</span>
              {unbilledCompleted.length > 0 && <span className="sf-pill wa">{unbilledCompleted.length} ready for checkout</span>}
            </div>
            <small>Collections by payment date in Philippine time. {collections.undated.length > 0 && <>{collections.undated.length} undated payment(s) excluded; review in daily sales. </>}{collections.missingAmounts > 0 && <>{collections.missingAmounts} payment(s) missing an amount; excluded from totals.</>}</small>
          </div>
        </div>
        <button className="btn ghost sm" onClick={() => go("sales")}>Open daily sales<ArrowRight size={15} aria-hidden="true" /></button>
      </div>

          <div id="desk-checkout">
      <CheckoutInbox me={me} db={db} blocked={Boolean(billingAppt || showWalkIn || showExistingWalkIn || checkInAppt || reviewReq || rejecting || cardPetId || logCallTarget)} onOpen={task => {
        const visit=db.appts.find(a=>a.id===task.appointmentId);
        if(!visit || visit.status!=='Completed' || visit.billingStatus==='Paid' || visit.admissionStatus==='Admitted')return false;
        setBillingAppt(visit);
        return true;
      }} />

          </div>
          <div id="desk-reminders">
        <section className="card">
          <div className="sf-section-hd">
            <h3>Vaccine reminders ({calls.length})</h3>
            <span className="sf-sub">Due within 30 days</span>
          </div>

          {calls.length ? (
            <PaginatedList label="Vaccine reminders" resetKey={null} className="sf-grid">
              {calls.map(v => {
                const p = db.pets.find(x => x.id === v.petId) || {};
                const o = db.owners.find(x => sameOwner(x, p.ownerId)) || {};
                const hasAppt = vaccinationAppointment(v, db.appts || []);
                return (
                  <div className="sf-row" key={v.id}>
                    <div className="sf-body">
                      <div className="sf-name">
                        <button type="button" className="sf-link" onClick={() => openCard(p.id || v.petId)} title="Open the digital vaccination card">{p.name || "Patient"}</button>
                        <span className="meta">{p.species || ""}{o.name ? ` (${o.name})` : ""}</span>
                      </div>
                      <div className="sf-sub">
                        <Syringe size={12} aria-hidden="true" style={{ verticalAlign: "-1px" }} /> {v.vaccine}, due <b>{v.nextDue}</b>
                        {hasAppt && <span style={{ marginLeft: 8, color: "#15803d", fontWeight: 700 }}>✓ Appt: {hasAppt.date} {hasAppt.time || ""}</span>}
                      </div>
                      <div className="sf-sub"><Phone size={12} aria-hidden="true" style={{ verticalAlign: "-1px" }} /> {o.phone || "No phone on file"}</div>
                    </div>
                    <div className="sf-row-act">
                      <Badge v={hasAppt ? hasAppt.status : vaccinationStatus(v, calls)} />
                      <button className="btn sm ghost" onClick={() => openCard(p.id || v.petId)}>Card</button>
                      {hasAppt ? (
                        <button className="btn sm ghost" style={{ color: "#15803d", borderColor: "#86efac", background: "#f0fdf4" }} onClick={() => go("cal")} title="View scheduled appointment in calendar">
                          {hasAppt.status}
                        </button>
                      ) : (
                        <button className="btn sm gold" title="Book the booster visit in the clinic calendar" onClick={() => { setPrefill(vaccinationBooking(v)); go("cal"); say(`Booking booster for ${p.name || "patient"} (${v.vaccine}).`); }}>Book booster</button>
                      )}
                      <button className="btn ghost sm" onClick={() => setLogCallTarget({ v, p, o })} title="Record a call outcome and review saved call history">Log call</button>
                    </div>
                  </div>
                );
              })}
            </PaginatedList>
          ) : (
            <div className="empty sm">No certified booster recalls due within 30 days.</div>
          )}
        </section>
          </div>
          <AdmissionsSummary me={me} go={go} />
          <CareFollowUps db={db} go={go} />
        </aside>
      </div>

      {showWalkIn && (
        <InClinicRegistration
          db={db} setDb={setDb} me={me}
          onClose={() => setShowWalkIn(false)}
          onRegistered={(pet, owner, appointment) => { setShowWalkIn(false); say(`Walk-in registered: ${owner.name} and ${pet.name}. Record vitals to complete check-in.`); if (appointment) setCheckInAppt(appointment); }}
        />
      )}

      {billingAppt && (
        <BillingModal
          appt={billingAppt} db={db} setDb={setDb} me={me}
          onClose={() => setBillingAppt(null)}
          onPaid={amt => say(`Payment of ₱${amt} recorded.`)}
        />
      )}

      {checkInAppt && (
        <CheckInModal
          appt={checkInAppt} db={db} setDb={setDb} me={me}
          onClose={() => setCheckInAppt(null)}
          onCheckedIn={() => { setCheckInAppt(null); say("Patient checked in and moved to the doctor queue."); }}
        />
      )}

      {reviewReq && (
        <PetApprovalModal
          request={reviewReq} db={db} setDb={setDb} me={me}
          onClose={() => setReviewReq(null)}
          onProcessed={(action, newPet, cardId) => {
            setReviewReq(null);
            say(action === "appointment-approved" ? "Appointment approved, registration verified and slot confirmed." : action === "approved" ? "Registration verified. Internal patient reference ready for treatment." : "Pet registration request declined.");
          }}
        />
      )}

      {cardPetId && (
        <PetCardModal
          petId={cardPetId} appt={cardAppt} db={db} setDb={setDb} me={me}
          onClose={closeCard}
          onBook={() => { closeCard(); go("cal"); }}
          onCheckIn={a => { closeCard(); setCheckInAppt(a); }}
          onBill={a => { closeCard(); setBillingAppt(a); }}
        />
      )}

      {showExistingWalkIn && (
        <ExistingPatientCheckInModal
          db={db} setDb={setDb} me={me} say={say}
          onClose={() => setShowExistingWalkIn(false)}
          onCheckIn={appt => { setShowExistingWalkIn(false); setCheckInAppt(appt); }}
        />
      )}

      {logCallTarget && (
        <LogCallModal
          target={logCallTarget}
          onClose={() => setLogCallTarget(null)}
          onLogged={() => setLogCallTarget(null)}
          me={me}
          db={db}
          setDb={setDb}
          say={say}
        />
      )}
    </>
  );
}

export const assistant = {
  portal: "Front Desk & Operations",
  Dash,
  menu: [
    { k: "home", l: "Front Desk", i: "bell", dash: 1, sub: "Visit approvals, pet registrations, arrivals and clinic operations." },
    { k: 'admissions', l: 'Admitted Pets', i: 'hospital', Page: AdmissionsPage, sub: 'Follow veterinarian care plans, record measured observations and share owner updates.' },
    { k: "prices", l: "Services & Prices", i: "file", Page: props => <Prices {...props} staff />, sub: "Browse clinic services, products, offers and current prices." },
    { k: "sales", l: "Daily Sales & Billing", i: "receipt", Page: DailySalesPage, sub: "Daily collections register, paid invoices, and sales breakdown." },
    { k: "pet-requests", l: "Online Pet Requests", i: "paw", Page: PetRequestsPage, sub: "Review and approve online pet registrations with automated vaccination cards." },
    { k: "cal", l: "Appointments & Calendar", i: "calendar", Page: ClinicCalendar, sub: "Unified calendar schedules, slot booking, and appointments management." },
    { k: "clients-patients", l: "Clients & Patients Masterlist", i: "users", Page: ClientsAndPatientsPage, sub: "Unified masterlist of pet owners, animal patient profiles, and official vaccination cards." },
    { k: "records", l: "Consultations & EMR", i: "file", Page: ConsultationsPage, sub: "Certified veterinary consultation notes, EMR, and prescription handoff." },
    { k: "pets", hide: true, Page: ClientsAndPatientsPage },
    { k: "owners", hide: true, Page: ClientsAndPatientsPage },
  ],
};
