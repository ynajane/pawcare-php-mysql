import {useUnsavedChanges} from '../../components/useUnsavedChanges.jsx';
import VisitNextStep from '../../components/VisitNextStep.jsx';
import {chronologicalAppointments,upcomingAppointments} from '../../appointmentOrder.js';
import BookingReason from '../../components/BookingReason.jsx';
import {bookingReasonErrors,bookingReason} from '../../bookingReason.js';
import { VaccinePicker, VaccineEstimate, useBookingCatalog } from '../../components/VaccineBooking.jsx';
import { vaccineIdFromReason, vaccineReason, vaccinePriceLabel } from '../../vaccineBooking.js';
import { PaginatedTable } from "../../components/Pagination.jsx";
import { bookingDayConflict, validateOwnerBooking } from "../../ownerBooking.js";
import { CalendarDays, Plus, Syringe } from "lucide-react";
import { useSubmissionReview } from "../../components/SubmissionReview.jsx";
import { confirmedBooking, confirmedCancellation } from "../../receptionSaves.js";
import { intakeVisitSnapshot } from "../../intakeVisit.js";
import { currentVaccinationDue, vaccinationAppointment, vaccinationBooking, vaccinationStatus } from "../../ownerVaccination.js";
import { api } from "../../api.js";
import { today as bookingToday, lastDay } from "../../booking.js";
import { useAvailability } from "../../useAvailability.js";
import { openFollowUps } from "../../clinicalWorkflow.js";
import { useState, useEffect, useRef } from "react";
import { Badge, I, ICON, scope, petName, uid, addLog } from "../../lib.jsx";
import ApptDetails from "./ApptDetails.jsx";
import { useLive, Field, SearchField, Suggest, Modal, addNote, prefill, fmt12, ymdLocal } from "./ui.jsx";
import { SERVICES, MAX_DAYS, ServicePicker, SlotPicker, inferService, serviceOf, holidayName, durOf, durText, addMin, splitReason } from "./services.jsx";

const liveDoctors = db => (db.vets || []).map(v => [v.id, v.name]);
const isTouch = () => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
const OPEN = ["Pending Approval", "Scheduled"], BUSY = ["Cancelled", "Rejected", "No-show"];
const NOTE_IDEAS = ["My pet is nervous around other animals.", "Please call me before the visit.", "My pet hasn’t eaten today.", "My pet is on medication.", "Bringing vaccine card."];
const CANCEL_WHY = ["Schedule conflict", "My pet is feeling better", "Booked by mistake", "Need a different date", "Other"];
const STATUS_NOTE = { 'Pending Approval': "Waiting for the clinic to confirm", Scheduled: "Approved. Please arrive 10 minutes early", "Checked-in": "You’re checked in. The vet will call you in", "In consultation": "The vet is seeing your pet now", Completed: "Done. See Visit History for notes", Cancelled: "This visit was cancelled", "No-show": "Marked as missed", Rejected: "The clinic declined this request. Open it to read the reason" };
const mkRules = (db, me, editing) => v => ({...bookingReasonErrors(v.service,v.reasonChoice,v.otherReason),...validateOwnerBooking(v, {
  pets: scope(db, me, "pets").filter(p=>!p.registrationStatus || p.registrationStatus==="Verified"), vets: db.vets || [], appointments: db.appts, records: db.records, editing
})});

function BookForm({ db, setDb, me, say, editing, start, onClose, onExisting }) {
  const TODAY = bookingToday(), LAST = lastDay();
  const pets = scope(db, me, "pets").filter(p=>!p.registrationStatus || p.registrationStatus==="Verified"), owner = db.owners.find(o => o.id === me.ownerId) || {};
  const prev = editing ? serviceOf(editing) : "", requested = editing ? prev : start?.service || (start?.reason ? inferService(start.reason) : ""),
    // Surgery and dental are no longer booked directly; an old shortcut opens a check-up instead.
    svc0 = !editing && SERVICES[requested]?.retired ? "checkup" : requested;
  const catalog = useBookingCatalog()?.data?.catalog || [];
  const initialReason = editing?.reason || start?.reason || start?.vaccineName || "";
  const [choice0,other0]=splitReason(svc0,initialReason);
  const f = useLive({ reasonChoice:choice0, otherReason:other0, vaccineId: svc0 === "vaccination" ? vaccineIdFromReason(initialReason) || (initialReason ? "vet-review" : "") : "", followUpId: editing?.followUpId || start?.followUpId || "", service: svc0, petId: editing ? editing.petId : (start && start.petId) || (pets.length === 1 ? pets[0].id : ""), vetId: editing ? editing.vetId : "", date: editing ? editing.date : (start && start.date) || "", time: editing ? editing.time : "", notes: editing ? editing.notes || "" : "" }, mkRules(db, me, editing));
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, []);
  const bookingFlight = useRef(false);
  const bookingId = useRef("a_" + crypto.randomUUID());
  const [changingDate, setChangingDate] = useState(!start?.date || !!editing);
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState("");
  const { v } = f, S = SERVICES[v.service];
  const unsaved=useUnsavedChanges({value:v,saving,onClose});
  const conflict = bookingDayConflict(db.appts, v.petId, v.date, editing?.id);
  const followUp = db.records.find(r => r.id === v.followUpId && r.petId === v.petId);
  const availability = useAvailability({ ...v, excludeId: editing?.id });
  const times = conflict ? [] : availability.slots, vetName = (liveDoctors(db).find(x => x[0] === v.vetId) || [])[1];
  const ready = S && v.vetId && v.date;
  const nextDay = null;
  const timeHint = conflict ? "This pet already has a visit that day. Review it or choose another date." : availability.error || (availability.loading && !times.length ? "Checking available times…" : "") || (!S ? "Choose a service first" : !ready ? "Choose a veterinarian and date to see open times" : times.length ? `${times.length} open time${times.length > 1 ? "s" : ""} for ${S.label.toLowerCase()} (${durText(S.dur)}) with ${vetName}` : holidayName(v.date) ? `Closed for ${holidayName(v.date)}.` : `No open times for ${S.label.toLowerCase()} (${durText(S.dur)}) that day.`);
  const review = useSubmissionReview([v, editing, db.appts.find(a => a.id === editing?.id), db.vets, pets]);
  const moved = editing && editing.status === "Scheduled" && (editing.date !== v.date || editing.time !== v.time || editing.vetId !== v.vetId || editing.petId !== v.petId || editing.service !== v.service || (v.service === "vaccination" && editing.reason !== vaccineReason(v.vaccineId, v.vaccineId === "vet-review" ? initialReason : "")));
  const submit = async e => {
    e.preventDefault(); if (bookingFlight.current) return; f.submit(e); if (!f.valid) return;
    setSaveError("");
    if (!times.includes(v.time)) { say("Choose an available time from the refreshed list."); availability.refresh(); return; }
    if (!scope(db, me, "pets").some(p => p.id === v.petId)) { say("You can only book for your own pets"); return onClose(); }
    if (editing) { const cur = db.appts.find(a => a.id === editing.id); if (!cur || !OPEN.includes(cur.status)) { say("This visit can no longer be changed"); return onClose(); } }
    const reason = v.service === "vaccination" ? vaccineReason(v.vaccineId, v.vaccineId === "vet-review" ? initialReason : "") : (v.service === svc0 && v.reasonChoice===choice0 && v.otherReason===other0 && initialReason ? initialReason : bookingReason(v.service,v.reasonChoice,v.otherReason)), notes = (v.notes || "").trim();
    const apptId = editing ? editing.id : bookingId.current;

    const payload = {
      id: apptId,
      ...(editing ? {expectedVisit:intakeVisitSnapshot(editing)} : {}),
      followUpId: v.followUpId || null,
      petId: v.petId,
      vetId: v.vetId,
      date: v.date,
      time: v.time,
      reason,
      service: v.service,
      ...(v.service === "vaccination" ? {vaccineId:v.vaccineId} : {reasonChoice:v.reasonChoice,otherReason:v.otherReason}),
      status: moved ? "Pending Approval" : (editing ? editing.status : "Pending Approval"),
      notes,
      actorName: me.name,
      actorRole: "owner"
    };

    if (!await review.ask({title:editing ? "Review appointment changes" : "Review your booking", confirmLabel:editing ? "Save appointment changes" : "Confirm booking",
      description:editing ? "Check the patient, veterinarian and schedule. Changed assignments return to reception for confirmation." : "Check these details before sending your booking to reception for confirmation.",
      fields:[
        ["Patient",petName(db,v.petId)],
        ["Veterinarian",vetName],
        ["Service",S.label],
        ["Date and time",`${v.date} at ${fmt12(v.time)}`],
        ["Reason",reason],
        ...(v.service === "vaccination" ? [["Estimated vaccine price",vaccinePriceLabel(v.vaccineId,catalog)]] : []),
        ["Note for the clinic",notes],
        ["Follow-up request",followUp ? `${followUp.followUpDate}: ${followUp.followUpReason}` : "Regular visit"]]
    })) return;
    let saved;
    bookingFlight.current = true;
    setSaving(true);
    try {
      const res = editing ? await api.put(`/api/appointments/${editing.id}`, payload) : await api.post("/api/appointments", payload);
      saved = confirmedBooking(res, payload);
    } catch (err) {
      setSaveError(err.message);
      bookingFlight.current = false;
      setSaving(false);
      availability.refresh();
      return;
    }
    setDb(p => ({...p,
      appts: editing ? p.appts.map(a => a.id === editing.id ? {...a,...saved} : a)
        : [...p.appts.filter(a => a.id !== saved.id), saved],
      log: addLog(p, me, `${editing ? "Updated" : "Booked"} visit for ${petName(p, saved.petId)} on ${saved.date} ${saved.time}`)
    }));

    say(editing ? (moved ? "Updated. The clinic will re-confirm your new time" : "Appointment updated") : "Booked! The clinic will confirm your visit");
    onClose();
  };
  return (
    <Modal title={editing ? "Edit appointment" : "Book a visit"} onClose={unsaved.close}>
      {unsaved.card}
      <form className="ow-book-form" onSubmit={submit} noValidate>
        {review.card}
        {pets.find(p=>p.id===v.petId)?.registrationStatus==='Pending' && <p className="ow-note info">Your pet is pending verification. This sends an appointment request; the clinic will review registration before confirming the visit.</p>}
        <fieldset disabled={saving} style={{border:0,padding:0,margin:0,minWidth:0}}>
        {start && (start.fromVaccineCard || start.vaccineName) && (
          <div className="ow-banner ok" style={{ marginBottom: 12 }}>
            <span>
              <Syringe size={18} aria-hidden="true" /> <b>Vaccine booster:</b> Booking for <b>{start.vaccineName || start.reason}</b>. {start.vaccineDueDate && <>Vet-approved due date: <b>{start.vaccineDueDate}</b>. </>}Choose an available visit date, veterinarian and time. The due date does not reserve a visit.
            </span>
          </div>
        )}
        {!pets.length && <p className="ow-note">You have no pets on your account yet. Add your pet from My Pets, then request an appointment immediately.</p>}
        {moved && <p className="ow-note">Changing the service, date, time or veterinarian sends this visit back to “Pending Approval” so the clinic can re-confirm it.</p>}
        {!changingDate && !f.show("date") ? <section className="ow-book-date" aria-label="Selected visit date">
          <CalendarDays size={24} aria-hidden="true" />
          <div><small>Your selected visit date</small><strong>{new Date(v.date + "T00:00:00").toLocaleDateString("en-PH", {weekday:"long",month:"long",day:"numeric",year:"numeric"})}</strong><span>Complete the details to request this visit.</span></div>
          <button type="button" className="btn ghost sm" onClick={() => setChangingDate(true)}>Change date</button>
        </section> : <Field id="date" label="Date" req type="date" min={TODAY} maxDate={LAST} value={v.date} onChange={x => f.patch({ date: x, time: "" })} onBlur={() => f.blur("date")} error={f.show("date")} valid={f.ok("date")} hint={holidayName(v.date) ? `${holidayName(v.date)} is a holiday. The clinic is closed` : `Pick a day within the next ${MAX_DAYS} days (closed on Philippine holidays)`} />}
        <p className="ow-book-policy"><CalendarDays size={16} aria-hidden="true" />One visit per pet, per day. To change plans, edit your existing visit. Different pets can have separate bookings.</p>
        {conflict && <section className="ow-book-conflict" role="alert"><b>A visit is already on this pet’s calendar</b><p>{conflict.date} · {conflict.time ? fmt12(conflict.time) : "Time not recorded"} · {conflict.status}</p><p>{conflict.reason}</p><button type="button" className="btn ghost sm" onClick={() => onExisting(conflict)}>View existing visit</button></section>}
        <ServicePicker value={v.service} onChange={x => { if (x === v.service) return; f.set("service", x); f.quiet({ time: "", vaccineId: "",reasonChoice:"",otherReason:"" }); }} error={f.show("service")} />
        <div className="ow-book-patient">
        <Field id="petId" label="Pet" req type="select" disabled={!!editing?.followUpId} value={v.petId} onChange={x => f.patch({petId:x, followUpId:"", vaccineId:""})} onBlur={() => f.blur("petId")} options={pets.map(p => [p.id, `${p.name} (${p.species})${p.registrationStatus==='Pending' ? ' · Pending verification' : ''}`])} error={f.show("petId")} valid={f.ok("petId")} hint="Which pet is coming in?" />
        <Field id="vetId" label="Veterinarian" req type="select" value={v.vetId} onChange={x => f.patch({ vetId: x, time: "" })} onBlur={() => f.blur("vetId")} options={liveDoctors(db)} error={f.show("vetId")} valid={f.ok("vetId")} hint="Times below update for the vet you pick" />
        </div>

        <BookingReason service={v.service} choice={v.reasonChoice} other={v.otherReason} onChoice={x=>f.set('reasonChoice',x)} onOther={x=>f.set('otherReason',x)} errors={{reasonChoice:f.show('reasonChoice'),otherReason:f.show('otherReason')}}/>
        {v.service === "vaccination" && <VaccinePicker value={v.vaccineId} onChange={x=>f.set("vaccineId",x)} species={pets.find(p=>p.id===v.petId)?.species} petSelected={!!v.petId} error={f.show("vaccineId")} />}
        {availability.error && <button type="button" className="btn ghost" onClick={availability.refresh}>Retry availability</button>}
        <SlotPicker times={times} value={v.time} onChange={x => f.set("time", x)} error={f.show("time")} hint={timeHint} dur={S ? S.dur : 30} suggest={nextDay} onSuggest={() => f.patch({ date: nextDay, time: "" })} />
        {S && v.time && times.includes(v.time) && <p className="ow-note info">{S.label}: {fmt12(v.time)} to {fmt12(addMin(v.time, S.dur))} with {vetName}</p>}
        <Field id="followUpId" label="Follow-up request (optional)" type="select" emptyLabel="Regular visit" disabled={!!editing?.followUpId} value={v.followUpId} onChange={x => f.set("followUpId", x)} onBlur={() => f.blur("followUpId")} options={db.records.filter(r => r.id === v.followUpId || openFollowUps(db,v.petId).some(x => x.id === r.id)).filter(r => r.petId === v.petId).map(r => [r.id, `${r.followUpDate} · ${r.followUpReason}`])} error={f.show("followUpId")} hint="Link this visit to a follow-up your vet requested" />
        {followUp && <section className="ow-note" aria-label="Selected follow-up instructions"><b>{followUp.careStatus} · Target: {followUp.followUpDate}</b><p style={{whiteSpace:"pre-wrap"}}>{followUp.followUpReason}</p><small>The target is a recommended date. Select an available visit time above.</small></section>}
        <Field id="notes" label="Note for the clinic (optional)" type="textarea" rows={2} max={200} value={v.notes} onChange={x => f.set("notes", x)} onBlur={() => f.blur("notes")} error={f.show("notes")} hint="Symptoms, behavior or anything the clinic should know" />
        <Suggest items={NOTE_IDEAS} onPick={s => f.set("notes", addNote(v.notes, s, 200))} />
        <p className="ow-hint" style={{ marginTop: 10 }}>The clinic will reach you at {owner.phone || "your number on file"}. You can update it in My Profile.</p>
        {saveError && <p className="err" role="alert">{saveError}</p>}
        {f.submitted && !f.valid && <p className="err" role="alert">Please fix {f.count} field{f.count > 1 ? "s" : ""} above.</p>}
        <div className="row end"><button type="button" className="btn ghost" disabled={saving} onClick={unsaved.close}>Close</button><button className="btn" disabled={!pets.length || saving || !!conflict}>{saving ? "Saving…" : editing ? "Review changes" : "Review booking"}</button></div>
        </fieldset>
      </form>
    </Modal>
  );
}

function CancelDialog({ a, db, setDb, me, say, onClose }) {
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState("");
  const f = useLive({ why: "", other: "" }, v => { const e = {}; if (!v.why) e.why = "Please tell us why"; else if (v.why === "Other") { const o = v.other.trim(); if (o.length < 3) e.other = "Add a short reason (3+ characters)"; else if (o.length > 120) e.other = "Keep it under 120 characters"; else if (!/[A-Za-zÀ-ÿ]/.test(o)) e.other = "Use words, not only numbers or symbols"; } return e; });
  const go = async e => {
    e.preventDefault(); if (inFlight.current) return; f.submit(e); if (!f.valid) return;
    const cur = db.appts.find(x => x.id === a.id), mine = scope(db, me, "pets").some(p => p.id === a.petId);
    if (!cur || !mine || !OPEN.includes(cur.status)) { say("This visit can no longer be cancelled"); return onClose(); }
    const why = f.v.why === "Other" ? f.v.other.trim() : f.v.why;
    inFlight.current = true; setSaving(true); setSaveError("");
    let saved;
    try {
      saved = confirmedCancellation(await api.patch(`/api/appointments/${a.id}/status`, { status: "Cancelled", cancelReason: why, expectedVisit: intakeVisitSnapshot(cur) }), cur);
    } catch (err) {
      inFlight.current = false; setSaving(false); setSaveError(err.message);
      return;
    }
    setDb(p => ({ ...p, appts: p.appts.map(x => x.id === a.id ? { ...x, ...saved } : x), log: addLog(p, me, `${petName(p, a.petId)}: ${a.status} → Cancelled (${why})`) }));
    say("Appointment cancelled"); onClose();
  };
  return (
    <Modal title="Cancel this visit?" onClose={() => { if (!inFlight.current) onClose(); }}>
      <form onSubmit={go} noValidate>
        <fieldset disabled={saving} style={{border:0,padding:0,margin:0,minWidth:0}}>
        <p>{petName(db, a.petId)} · {a.date} at {fmt12(a.time)}</p>
        <Field id="why" label="Reason for cancelling" req type="select" value={f.v.why} onChange={x => f.set("why", x)} onBlur={() => f.blur("why")} options={CANCEL_WHY.map(r => [r, r])} error={f.show("why")} valid={f.ok("why")} hint="This helps the clinic plan its day" />
        {f.v.why === "Other" && <Field id="other" label="Tell us more" req type="textarea" rows={2} max={120} value={f.v.other} onChange={x => f.set("other", x)} onBlur={() => f.blur("other")} error={f.show("other")} valid={f.ok("other")} hint="A few words is enough" />}
        {saveError && <p className="err" role="alert">{saveError}</p>}
        <div className="row end"><button type="button" className="btn ghost" disabled={saving} onClick={onClose}>Keep visit</button><button className="btn danger" disabled={saving}>{saving ? "Cancelling…" : "Cancel visit"}</button></div>
        </fieldset>
      </form>
    </Modal>
  );
}

/* ---------- Calendar beside the list: visits, vaccines given and vaccines due ---------- */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const KIND = { visit: ["Visit", "k-visit"], done: ["Past visit", "k-done"], given: ["Vaccine given", "k-given"], due: ["Vaccine due", "k-due"], over: ["Overdue vaccine", "k-over"] };

/* { "YYYY-MM-DD": [event, ...] } for the calendar dots and the vaccine notes under the list. */
function buildEvents(db, me, pet, svc, q) {
  const TODAY = bookingToday();
  const ev = {}, add = (d, x) => { if (d) (ev[d] = ev[d] || []).push(x); }, needle = q.trim().toLowerCase();
  scope(db, me, "appts").filter(a => !["Cancelled","Rejected"].includes(a.status) && (!pet || a.petId === pet) && (!svc || serviceOf(a) === svc)).forEach(a => {
    const vet = (liveDoctors(db).find(v => v[0] === a.vetId) || [])[1] || "", text = `${petName(db, a.petId)}: ${a.reason}`;
    if (needle && ![text, vet, a.status, a.date].join(" ").toLowerCase().includes(needle)) return;
    add(a.date, { time:a.time,kind: ["Completed", "No-show"].includes(a.status) || a.date < TODAY ? "done" : "visit", text, appt: a });
  });
  const current = currentVaccinationDue(scope(db, me, "vacc"));
  if (!svc) scope(db, me, "vacc").filter(v => !pet || v.petId === pet).forEach(v => {
    const nm = petName(db, v.petId);
    if (needle && !`${nm} ${v.vaccine}`.toLowerCase().includes(needle)) return;
    if (v.done) add(v.date, { kind: "given", text: `${nm}: ${v.vaccine} given`, sub: v.notes || "", vacc: v });
    if (current.some(x => x.id === v.id)) add(v.nextDue, { kind: vaccinationStatus(v, current) === "Overdue" ? "over" : "due", text: `${nm}: ${v.vaccine} due`, sub: vaccinationStatus(v, current), vacc: v });
  });
  Object.values(ev).forEach(events=>events.sort(chronologicalAppointments));
  return ev;
}

/* Small month grid. Click a day to filter the list to it, click it again to clear. */
function MiniCalendar({ ev, day, setDay }) {
  const TODAY = bookingToday();
  const t = new Date(), [cur, setCur] = useState({ y: t.getFullYear(), m: t.getMonth() });
  const first = new Date(cur.y, cur.m, 1), cells = Array.from({ length: 42 }, (_, i) => new Date(cur.y, cur.m, 1 - first.getDay() + i));
  const move = n => { const d = new Date(cur.y, cur.m + n, 1); setCur({ y: d.getFullYear(), m: d.getMonth() }); };
  return (
    <div className="ow-cal">
      <div className="ow-calhd">
        <button className="btn ghost sm" onClick={() => move(-1)} aria-label="Previous month">‹</button>
        <h2 aria-live="polite">{MONTHS[cur.m]} {cur.y}</h2>
        <button className="btn ghost sm ow-cal-today" onClick={() => { setCur({ y: t.getFullYear(), m: t.getMonth() }); setDay(TODAY); }}>Today</button>
        <button className="btn ghost sm" onClick={() => move(1)} aria-label="Next month">›</button>
      </div>
      <div className="ow-grid" role="grid" aria-label="Calendar">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => <div key={d} className="ow-dow">{d}</div>)}
        {cells.map(d => {
          const k = ymdLocal(d), items = ev[k] || [], out = d.getMonth() !== cur.m, past = k < TODAY, hol = holidayName(k);
          return <button key={k} className={`ow-day${out ? " out" : ""}${past ? " past" : ""}${hol ? " hol" : ""}${k === TODAY ? " today" : ""}${k === day ? " sel" : ""}`} aria-pressed={k === day}
            onClick={() => { setDay(k === day ? "" : k); if (out) setCur({ y: d.getFullYear(), m: d.getMonth() }); }}
            aria-label={`${d.toDateString()}, ${items.length} event(s)${hol ? `, ${hol}, clinic closed` : ""}`} title={hol || undefined}>
            <b>{d.getDate()}</b>
            <div className="ow-evs">{items.slice(0, 4).map((x, i) => <div key={i} className={`ow-ev ${KIND[x.kind][1]}`} title={x.text}><i className="ow-dot" /><span>{x.text}</span></div>)}</div>
          </button>;
        })}
      </div>
      <div className="ow-legend">{Object.values(KIND).map(([l, c]) => <span key={l} className={`ow-ev ${c}`}><i className="ow-dot" />{l}</span>)}<span className="ow-holkey"><i />Holiday (closed)</span></div>
    </div>
  );
}

export default function OwnerAppts({ db, setDb, me, say }) {
  const TODAY = bookingToday();
  const [modal, setModal] = useState(() => prefill.data ? { book: true, start: prefill.data } : null), [q, setQ] = useState(""), [view, setView] = useState("upcoming"), [pet, setPet] = useState(""), [svc, setSvc] = useState(""), [day, setDay] = useState("");
  useEffect(() => { prefill.data = null; }, []);
  const pets = scope(db, me, "pets").filter(p=>!p.registrationStatus || p.registrationStatus==="Verified");
  const selectedVisit = scope(db, me, "appts").find(a => a.id === (modal?.view?.id || modal?.cancel?.id));
  let list = scope(db, me, "appts").slice();
  const live = a => OPEN.includes(a.status) || ["Checked-in", "In consultation"].includes(a.status);
  if (day) list = list.filter(a => a.date === day && !["Cancelled","Rejected"].includes(a.status));
  else if (view === "upcoming") list = list.filter(a => live(a) && a.date >= TODAY);
  else if (view === "past") list = list.filter(a => a.status === "Completed" || a.status === "No-show" || (live(a) && a.date < TODAY));
  else if (view === "rejected") list = list.filter(a => a.status === "Rejected");
  else if (view === "cancelled") list = list.filter(a => a.status === "Cancelled");
  if (pet) list = list.filter(a => a.petId === pet);
  if (svc) list = list.filter(a => serviceOf(a) === svc);
  if (q.trim()) list = list.filter(a => [petName(db, a.petId), a.reason, (SERVICES[serviceOf(a)] || {}).label, a.status, a.date, (liveDoctors(db).find(v => v[0] === a.vetId) || [])[1]].join(" ").toLowerCase().includes(q.trim().toLowerCase()));
  list.sort(day ? chronologicalAppointments : view==='past' ? (a,b)=>chronologicalAppointments(b,a) : (a,b)=>upcomingAppointments(a,b,TODAY));
  const ev = buildEvents(db, me, pet, svc, q), hol = day ? holidayName(day) : "", dayVacc = day ? (ev[day] || []).filter(x => x.vacc) : [];
  const dayNice = day ? new Date(day + "T00:00:00").toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : "";
  const waiting = scope(db, me, "appts").filter(a => a.status === "Pending Approval" && a.date >= TODAY).length;
  return (<>
    {scope(db,me,"appts").some(a=>a.status==="Rejected" && a.date>=TODAY) && <p className="ow-note" role="status">The clinic declined an appointment request. <button className="btn ghost sm" onClick={()=>{setDay("");setView("rejected");}}>View reason</button></p>}
    <div className="ow-appt-toolbar">
      <div className="ow-tb-search">
        <SearchField id="ap-q" label="Search" value={q} onChange={setQ} placeholder="Pet, service, vet, date or status" result={`${list.length} visit${list.length === 1 ? "" : "s"} match`} />
      </div>
      <div style={{ flex: "1 1 150px", minWidth: 0 }}>
        <label className="ow-lbl" htmlFor="ap-view">Show</label>
        <select id="ap-view" value={view} onChange={e => setView(e.target.value)} disabled={!!day} title={day ? "Clear the selected day to change this" : ""} style={{ width: "100%" }}><option value="upcoming">Upcoming visits</option><option value="past">Past visits</option><option value="cancelled">Cancelled</option><option value="rejected">Rejected requests</option><option value="all">All visits</option></select>
      </div>
      <div style={{ flex: "1 1 150px", minWidth: 0 }}>
        <label className="ow-lbl" htmlFor="ap-pet">Pet</label>
        <select id="ap-pet" value={pet} onChange={e => setPet(e.target.value)} style={{ width: "100%" }}><option value="">All my pets</option>{pets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </div>
      <div style={{ flex: "1 1 150px", minWidth: 0 }}>
        <label className="ow-lbl" htmlFor="ap-svc">Service</label>
        <select id="ap-svc" value={svc} onChange={e => setSvc(e.target.value)} style={{ width: "100%" }}><option value="">All services</option>{Object.entries(SERVICES).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}</select>
      </div>
      <button className="btn" onClick={() => setModal({ book: true, start: {petId: pet || "", service: svc || "", date: day >= TODAY && day <= lastDay() && !hol ? day : ""} })} disabled={!pets.length} title={pets.length ? "" : "Add your pet first from My Pets"}><Plus size={17} aria-hidden="true" />Book a visit</button>
    </div>
    {waiting > 0 && <div className="ow-banner wa"><span>{waiting} visit(s) waiting for the clinic to confirm. You can still edit or cancel them.</span></div>}

    <style>{`.ap-split{display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr);gap:16px;align-items:start}
@media(max-width:1180px){.ap-split{grid-template-columns:1fr}.ap-split .ow-cal{max-width:520px}}
/* Narrow calendar column: the month gets its own line, then previous / Today / next share one bar, so nothing overlaps. */
.ap-split .ow-calhd{flex-wrap:wrap;gap:8px 6px}.ap-split .ow-calhd h2{flex:1 1 100%;order:-1;min-width:0;font-size:calc(19px*var(--fs,1));white-space:nowrap}.ap-split .ow-calhd .ow-cal-today{flex:1 1 auto}
.ap-split .tw{overflow-x:visible}.ap-split table{width:100%;table-layout:auto}
.ap-split td,.ap-split th{vertical-align:top}.ap-when{white-space:nowrap}.ap-when b,.ap-visit b{display:block;font-weight:700;color:var(--navy)}
.ap-visit{min-width:170px}.ap-status{min-width:180px;max-width:260px}.ap-status .visit-next-step{margin:6px 0 0;padding:6px 8px;font-size:calc(11.5px*var(--fs,1));line-height:1.4}
.ap-status .badge{display:inline-block;white-space:nowrap;margin-bottom:4px}
.ap-actions{display:flex;flex-wrap:nowrap;gap:6px;justify-content:flex-end}td.act{white-space:nowrap;vertical-align:middle}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:640px){
.ap-split .tw{background:none;border:0;box-shadow:none;overflow:visible}
.ap-rt thead{display:none}.ap-rt,.ap-rt tbody,.ap-rt tr,.ap-rt td{display:block;width:100%;min-width:0}
.ap-rt tr{margin:0 0 12px;padding:8px 0;background:#fff;border:1px solid #e3e9f7;border-radius:18px}
.ap-rt td{padding:7px 16px;border:0;text-align:left;max-width:none}
.ap-rt td::before{content:attr(data-label);display:block;margin-bottom:3px;color:#64748b;font-weight:700;font-size:calc(11px*var(--fs,1));text-transform:uppercase;letter-spacing:.05em}
.ap-rt td.act{padding-top:4px}.ap-rt td.act::before{content:none}.ap-actions{justify-content:flex-start}
.ap-rt td.ap-status,.ap-rt td.ap-visit{max-width:none}
}
.ap-split .ow-cal{padding:12px}.ap-split .ow-day{min-height:50px;align-items:center;padding:4px}
.ap-split .ow-day .ow-hol,.ap-split .ow-ev span,.ap-split .ow-more{display:none}
.ap-split .ow-evs{display:flex;flex-wrap:wrap;gap:2px;justify-content:center}`}</style>

    <div className="ap-split">
      <MiniCalendar ev={ev} day={day} setDay={setDay} />
      <div style={{ minWidth: 0 }}>
        {!pets.length && (
          <div className="ow-note info" style={{ marginBottom: 12 }}>
            <b>Get started:</b> You haven’t added a pet yet. Please go to <b>My Pets</b> to add your pet, or you can view the clinic calendar and schedules below.
          </div>
        )}
        {day && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0, flex: "1 1 auto" }}>{dayNice}{day === TODAY ? " (today)" : ""}</h3>
          {day >= TODAY && !hol && <button className="btn sm" disabled={!pets.length} onClick={() => setModal({ book: true, start: { petId: pet || "", reason: "", date: day } })}><Plus size={16} aria-hidden="true" />Book on this day</button>}
          <button className="btn ghost sm" onClick={() => setDay("")}>Show all</button>
        </div>}

        {/* 1. Vaccines & Scheduled Care on this day (Displayed directly below the date) */}
        {dayVacc.length > 0 && (
          <div className="ow-dayp" style={{ marginBottom: 16 }}>
            <h4 style={{ margin: "0 0 10px", fontSize: "0.95rem", color: "var(--navy)", fontWeight: 800 }}>
              <Syringe size={17} aria-hidden="true" /> Vaccines &amp; care on this day
            </h4>
            {dayVacc.map((x, i) => {
              const matchedAppt = ["due", "over"].includes(x.kind) ? vaccinationAppointment(x.vacc, scope(db, me, "appts")) : null;
              return (
                <div className="ow-evrow" key={i} style={{ alignItems: "center" }}>
                  <span className={`ow-ev ${KIND[x.kind][1]}`}>
                    <i className="ow-dot" />{KIND[x.kind][0]}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b>{x.text}</b>
                    {x.sub && <small style={{ display: "block", color: "var(--mu)" }}>{x.sub}</small>}
                    {matchedAppt && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginTop: 3, fontSize: "0.78rem", color: "#15803d", fontWeight: 700 }}>
                        ✓ {matchedAppt.status}: {matchedAppt.date} at {fmt12(matchedAppt.time)}
                      </span>
                    )}
                  </div>
                  {matchedAppt ? (
                    <button
                      type="button"
                      className="btn ghost sm"
                      style={{ whiteSpace: "nowrap" }}
                      onClick={() => setModal({ view: matchedAppt })}
                    >
                      View appointment
                    </button>
                  ) : (
                    (x.kind === "due" || x.kind === "over") && (
                      <button
                        type="button"
                        className="btn sm"
                        disabled={!pets.length}
                        style={{ whiteSpace: "nowrap" }}
                        onClick={() => setModal({
                          book: true,
                          start: vaccinationBooking(x.vacc)
                        })}
                      >
                        Book visit by time
                      </button>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}

        {hol && <p className="ow-note">Holiday: {hol}. The clinic is closed, so visits can’t be booked on this day.</p>}
        {list.length > 0 && <p className="ow-hint">Click any visit to view full clinical details. Open visits can be rescheduled or cancelled.</p>}

        {/* 2. Appointments on this day or Empty State (Displayed after vaccines) */}
        {(list.length ? (
          <div className="tw">
            <PaginatedTable label="My appointments" className="ap-rt" resetKey={[q,view,pet,svc,day]}>
              <thead>
                <tr><th>When</th><th>Pet</th><th>Visit</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {list.map(a => {
                  const p = db.pets.find(x => x.id === a.petId) || {}, open = OPEN.includes(a.status) && a.date >= TODAY;
                  return (
                    <tr key={a.id} className="vh-r" tabIndex={0} style={{ cursor: "pointer" }} title="Click to see details" onClick={() => setModal({ view: a })} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setModal({ view: a }); } }}>
                      <td data-label="When" className="ap-when"><b>{a.date}</b><small className="ow-sub">{fmt12(a.time)}{a.service && SERVICES[a.service] ? ` – ${fmt12(addMin(a.time, durOf(a)))}` : ""}</small></td>
                      <td data-label="Pet"><span className="who"><span className="av"><I e={ICON[p.species]} size={16} /></span>{p.name}</span></td>
                      <td data-label="Visit" className="ap-visit"><b>{a.reason}</b><small className="ow-sub">With {(liveDoctors(db).find(v => v[0] === a.vetId) || [])[1] || "a veterinarian"}</small><VaccineEstimate appointment={a} compact />{a.service && SERVICES[a.service] && <small className="ow-sub">{SERVICES[a.service].label} · {durText(durOf(a))}</small>}{a.notes && <small className="ow-sub">Note: {a.notes}</small>}{a.cancelReason && <small className="ow-sub">{a.status === "Rejected" ? "Rejected" : "Cancelled"}: {a.cancelReason}</small>}</td>
                      <td data-label="Status" className="ap-status"><Badge v={a.status} /><small className="ow-sub">{STATUS_NOTE[a.status]}</small><VisitNextStep visit={a} /></td>
                      <td className="act" data-label="">{open && <div className="ap-actions"><button className="btn ghost sm" onClick={e => { e.stopPropagation(); setModal({ book: true, editing: a }); }}>Edit</button> <button className="btn danger sm" onClick={e => { e.stopPropagation(); setModal({ cancel: a }); }}>Cancel</button></div>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </PaginatedTable>
          </div>
        ) : (
          <div className="empty" style={{ padding: "28px 16px" }}>
            <div><CalendarDays size={34} aria-hidden="true" /></div>
            <p style={{ margin: "8px 0 0", color: "var(--mu)", fontWeight: 600 }}>
              {day ? "No visits on this day." : "No visits to show here."}
            </p>
          </div>
        ))}
      </div>
    </div>
    {modal && modal.book && <BookForm db={db} setDb={setDb} me={me} say={say} editing={modal.editing} start={modal.start} onExisting={visit => setModal({view:visit})} onClose={() => setModal(null)} />}
    {modal && modal.view && selectedVisit && <ApptDetails a={selectedVisit} db={db} note={STATUS_NOTE[selectedVisit.status]} onClose={() => setModal(null)} onEdit={() => setModal({ book: true, editing: selectedVisit })} onCancel={() => setModal({ cancel: selectedVisit })} />}
    {modal && modal.cancel && selectedVisit && <CancelDialog a={selectedVisit} db={db} setDb={setDb} me={me} say={say} onClose={() => setModal(null)} />}
  </>);
}
