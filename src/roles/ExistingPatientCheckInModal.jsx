import ClinicDialog from '../components/ClinicDialog.jsx';
import { SearchField } from "./owner/ui.jsx";
import {useUnsavedChanges} from '../components/useUnsavedChanges.jsx';
import PetApprovalModal from './PetApprovalModal.jsx';
import {useFormValidation} from '../components/useFormValidation.jsx';
import {walkInReasonError,savedWalkInArrival,walkInReviewContext} from '../walkInRegistration.js';
import { VaccinePicker, useBookingCatalog } from '../components/VaccineBooking.jsx';
import { vaccineChoiceError, vaccineReason, vaccinePriceLabel } from '../vaccineBooking.js';
import { useSubmissionReview } from "../components/SubmissionReview.jsx";
import { useRef, useState } from "react";
import { UserCheck, X, ArrowRight } from "lucide-react";
import { today, nowHM } from "../booking.js";
import { addLog } from "../lib.jsx";
import { api } from "../api.js";
const sameOwner = (o, id) => !!id && (o.id === id || o.id === id.replace(/^o(\d+)/, "o_$1") || o.id?.replace(/^o_(\d+)/, "o$1") === id);

/* Walk-in for a patient who is already on file: creates today's appointment, then hands off to check-in (vitals). */
export default function ExistingPatientCheckInModal({ db, setDb, me, onClose, onCheckIn, say = () => {}, initialPetId = "" }) {
  const TODAY = today();
  const inFlight = useRef(false);
  const [registrationReview,setRegistrationReview]=useState(null);
  const [saveError, setSaveError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedPetId, setSelectedPetId] = useState(initialPetId);
  const [service,setService]=useState("checkup");
  const [vaccineId,setVaccineId]=useState("");
  const catalog=useBookingCatalog()?.data?.catalog || [];
  const [reason, setReason] = useState("Walk-in consultation and routine exam");
  const doctors = (db.vets || []).map(v => [v.id, v.name]);
  const [vetId, setVetId] = useState(doctors[0]?.[0] || "");
  const [busy, setBusy] = useState(false);
  const unsaved=useUnsavedChanges({value:{selectedPetId,vetId,service,vaccineId,reason},saving:busy,onClose});

  const term = search.trim().toLowerCase();
  const filteredPets = (db.pets || []).filter(p => {
    if (!term) return true;
    const owner = (db.owners || []).find(o => sameOwner(o, p.ownerId)) || {};
    return [p.name, p.species, p.breed, owner.name].some(x => (x || "").toLowerCase().includes(term));
  });
  const selectedPet = (db.pets || []).find(p => p.id === selectedPetId);
  const selectedOwner = selectedPet ? (db.owners || []).find(o => sameOwner(o, selectedPet.ownerId)) : null;

  // Do not allow the same patient to be queued twice on the same day.
  const activeVisits = (db.appts || []).filter(a => a.petId === selectedPetId && a.date === TODAY && !["Cancelled", "Completed", "Rejected", "No-show"].includes(a.status));
  const alreadyToday = activeVisits.length > 0;

  const validation=useFormValidation({
    patient:!selectedPet || !selectedOwner ? 'Choose a patient with a saved owner record.' : selectedPet.registrationStatus==='Declined' ? 'The owner must correct and resubmit this registration.' : selectedPet.registrationStatus==='Pending' ? 'Review and approve registration before saving an arrival or intake.' : '',
    vetId:!alreadyToday && !doctors.some(([id])=>id===vetId) ? 'Choose an available veterinarian.' : '',
    reason:!alreadyToday && service!=='vaccination' ? walkInReasonError(reason) : '',
    vaccineId:!alreadyToday && service==='vaccination' ? vaccineChoiceError(vaccineId,selectedPet?.species) : '',
  });
  const review = useSubmissionReview(walkInReviewContext({pet:selectedPet,owner:selectedOwner,vetId,reason,service,vaccineId,activeVisits,doctors,estimate:service==='vaccination' ? vaccinePriceLabel(vaccineId,catalog) : '',date:TODAY}));

  const handleSubmit = async e => {
    e.preventDefault();
    if (inFlight.current) return;
    setSaveError("");
    if (!validation.validate(e)) return;
    if (!selectedPet || !selectedOwner) { setSaveError("Choose a patient with a saved owner record."); return; }
    if (alreadyToday) { setSaveError("Open today's existing visit below to continue intake."); return; }
    if (!doctors.some(([id]) => id === vetId)) { setSaveError("Choose an available veterinarian."); return; }
    const vaccineError=service === 'vaccination' ? vaccineChoiceError(vaccineId,selectedPet.species) : '';
    if(vaccineError){setSaveError(vaccineError);return;}
    const visitReason=service === 'vaccination' ? vaccineReason(vaccineId) : reason.trim();
    if (visitReason.length < 3 || visitReason.length > 300) { setSaveError("Enter a visit reason between 3 and 300 characters."); return; }
    if (!await review.ask({title:"Review walk-in arrival",confirmLabel:"Save arrival",description:"Confirm the patient and assigned veterinarian. You will record measured intake next before the patient joins the doctor queue.",fields:[
        ["Patient",selectedPet.name],
        ["Owner",selectedOwner.name],
        ["Veterinarian",doctors.find(([id])=>id===vetId)?.[1]],
        ["Date",today()],
        ["Reason",visitReason],
        ...(service === "vaccination" ? [["Estimated vaccine price",vaccinePriceLabel(vaccineId,catalog)]] : [])]}))return;
    inFlight.current = true;
    setBusy(true);
    const payload = {
      petId: selectedPetId, vetId, date: today(), bookingKind: "walk-in",
      time: nowHM(),
      reason: visitReason, service,
      ...(service === "vaccination" ? {vaccineId} : {}),
      status: "Scheduled", billingStatus: "Unbilled", amount: 600,
      actorName: me?.name || "Assistant", actorRole: me?.role || "assistant",
    };
    let newAppt;
    try {
      const res = await api.post("/api/appointments", payload);
      newAppt = savedWalkInArrival(res,payload);
    } catch (error) {
      inFlight.current = false;
      setBusy(false);
      setSaveError(error.message);
      return;
    }
    setDb(prev => ({
      ...prev,
      appts: [newAppt, ...(prev.appts || []).filter(a => a.id !== newAppt.id)],
      log: addLog(prev, me, `Registered walk-in for existing pet ${selectedPet.name} (owner ${selectedOwner?.name || "client"}).`),
    }));
    say(`${selectedPet.name} arrival saved. Record vitals to join the doctor queue.`);
    onClose();
    onCheckIn(newAppt);
  };

  if(registrationReview)return <PetApprovalModal request={registrationReview} db={db} setDb={setDb} me={me} onClose={()=>setRegistrationReview(null)} onProcessed={()=>{setRegistrationReview(null);setSaveError('');}} />;
  return (
    <ClinicDialog label="Existing patient arrival" onClose={unsaved.close}>
      {unsaved.card}
      <div className="modal" aria-labelledby="exw-title" style={{ width: "min(560px, 100%)", maxHeight: "90vh", overflowY: "auto" }}>
        <div className="sf-modal-hd">
          <h3 id="exw-title"><UserCheck size={20} aria-hidden="true" />Existing patient check-in</h3>
          <button type="button" className="sf-x" onClick={unsaved.close} disabled={busy} aria-label="Close"><X size={18} aria-hidden="true" /></button>
        </div>

        <ol className="sf-steps" aria-label="Check-in steps">
          <li className="on">1. Verify patient & save arrival</li><li>2. Record vitals</li><li>3. Doctor queue</li>
        </ol>

        <form {...validation.formProps} onSubmit={handleSubmit}><fieldset disabled={busy} style={{border:0,padding:0,margin:0}}>
          {review.card}
          <SearchField id="exw-search" label="Search patient or owner" value={search} onChange={setSearch} lettersOnly placeholder="Pet name, breed or owner name" />

          <div className="sf-field">
            <label htmlFor="exw-pet">Patient *</label>
            <select {...validation.field('patient')} id="exw-pet" value={selectedPetId} onChange={e => { setSelectedPetId(e.target.value); setVaccineId(""); setSaveError(""); }} disabled={busy} required>
              <option value="">{filteredPets.length ? "Choose a patient" : "No matching patients"}</option>
              {[...filteredPets,...(selectedPet && !filteredPets.includes(selectedPet) ? [selectedPet] : [])].map(p => {
                const o = (db.owners || []).find(x => sameOwner(x, p.ownerId)) || {};
                return <option key={p.id} value={p.id}>{p.name} ({p.species}, {p.breed || "Breed not recorded"}) - {o.name || "Client"}</option>;
              })}
            </select>{validation.feedback('patient')}
          </div>

          {selectedPet && (
            <div className="sf-note">
              <b>{selectedPet.name}</b> ({selectedPet.breed || selectedPet.species}{selectedPet.weight ? `, last weight ${selectedPet.weight} kg` : ""}). Owner: <b>{selectedOwner?.name || "Client"}</b> ({selectedOwner?.phone || "no phone"}).
              {selectedPet.allergies?.length > 0 && <> Allergies: <b>{selectedPet.allergies.join(", ")}</b>.</>}
            </div>
          )}
          {selectedPet?.registrationStatus==='Pending' && <section className="sf-note"><b>Registration needs review</b><p>Review the saved pet details before continuing. A pending appointment is reviewed together with its registration.</p><button type="button" className="btn sm gold" disabled={busy || !(db.petRequests || []).some(r=>r.petId===selectedPet.id && r.status==='Pending')} onClick={()=>setRegistrationReview(db.petRequests.find(r=>r.petId===selectedPet.id && r.status==='Pending'))}>Review registration</button></section>}
          {alreadyToday && <section className="sf-note" aria-label="Today's existing visits">
            <b>Today's existing visit{activeVisits.length > 1 ? "s" : ""}</b>
            <p>Continue with the saved visit and assigned veterinarian.</p>
            {activeVisits.map(visit => {
              const canIntake = ["Scheduled", "Checked-in"].includes(visit.status) && !["Pending","Declined"].includes(selectedPet.registrationStatus);
              const vet = (db.vets || []).find(v => v.id === visit.vetId);
              return <div key={visit.id} style={{marginBottom:12}}>
                <div>{visit.time || "Time not recorded"} · {visit.status} · {vet?.name || "Veterinarian not found"}</div>
                <p style={{whiteSpace:"pre-wrap"}}>{visit.reason || "Visit reason not recorded"}</p>
                {canIntake ? <button type="button" className="btn gold sm" onClick={() => {
                  const current = (db.appts || []).find(a => a.id === visit.id);
                  if (!current || !["Scheduled", "Checked-in"].includes(current.status)) return;
                  onClose(); onCheckIn(current);
                }}>{visit.status === "Checked-in" ? "Review saved intake" : "Record vitals for this visit"}</button>
                  : <p>{visit.status === "In consultation" ? "The veterinarian is already seeing this patient." : "Open the visit in the calendar to check its status."}</p>}
              </div>;
            })}
          </section>}

          {!alreadyToday && <>

          <div className="sf-field"><label htmlFor="exw-service">Purpose of visit *</label><select id="exw-service" value={service} disabled={busy} onChange={e=>{setService(e.target.value);setVaccineId('');setReason({checkup:'Walk-in consultation and routine exam',deworming:'Routine deworming',grooming:'Grooming and sanitary care'}[e.target.value] || 'Vaccination consultation');}}><option value="checkup">Consultation</option><option value="vaccination">Vaccination</option><option value="deworming">Deworming</option><option value="grooming">Grooming</option></select></div>
          {service === 'vaccination' && <VaccinePicker plain id="exw-vaccine" error={validation.errors.vaccineId} value={vaccineId} onChange={value=>{setVaccineId(value);validation.changed('vaccineId');}} species={selectedPet?.species} petSelected={!!selectedPet} disabled={busy} />}
          {service !== 'vaccination' && <div className="sf-field">
            <label htmlFor="exw-reason">Reason for visit *</label>
            <input {...validation.field('reason')} id="exw-reason" type="text" required minLength={3} maxLength={300} disabled={busy} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Cough, routine check-up" />{validation.feedback('reason')}
          </div>}

          <div className="sf-field">
            <label htmlFor="exw-vet">Veterinarian *</label>
            <select {...validation.field('vetId')} id="exw-vet" required disabled={busy} value={vetId} onChange={e => setVetId(e.target.value)}>
              <option value="">Choose a veterinarian</option>
              {doctors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>{validation.feedback('vetId')}
          </div>

          </>}
          {saveError && <p className="err" role="alert">{saveError}</p>}
          <div className="row end" style={{flexWrap:"wrap"}}>
            <button type="button" className="btn ghost" disabled={busy} onClick={unsaved.close}>Cancel</button>
            {!alreadyToday && <button type="submit" className="btn gold" disabled={busy}>{busy ? "Saving arrival…" : "Review arrival"}<ArrowRight size={16} aria-hidden="true" /></button>}
          </div>
        </fieldset></form>
      </div>
    </ClinicDialog>
  );
}

