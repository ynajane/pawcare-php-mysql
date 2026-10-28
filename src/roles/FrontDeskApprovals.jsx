import {VaccineEstimate} from '../components/VaccineBooking.jsx';
import {PaginatedList} from '../components/Pagination.jsx';
import {useState} from 'react';
import {CalendarCheck,CalendarDays,PawPrint} from 'lucide-react';
import {pendingVisitApprovals,registrationsWithoutVisit} from '../assistantWorkflow.js';
import {chronologicalAppointments} from '../appointmentOrder.js';
import {fmt12,today,nowHM} from '../booking.js';
import ClinicDialog from '../components/ClinicDialog.jsx';
import {ExternalHistorySummary} from '../components/ExternalHistory.jsx';
import {approvalVisit} from '../appointmentStatus.js';
import {sameIntakeVisit,approvalExpiredError} from '../intakeVisit.js';
import {useFormValidation} from '../components/useFormValidation.jsx';

export function RequestReview({snapshot,db,onClose,onConfirm,onReject,confirming,error}) {
  const [checked,setChecked]=useState(false);
  const {visit,patient,registration,owner,vet}=snapshot;
  const current=db.appts.find(a=>a.id===visit.id), liveRegistration=registration && db.petRequests.find(r=>r.id===registration.id);
  const stale=!current || !sameIntakeVisit(current,visit) || registration && (!liveRegistration || liveRegistration.revision!==registration.revision || liveRegistration.status!==registration.status);
  const expired=!!approvalExpiredError(visit,{date:today(),time:nowHM()}), declined=registration?.status==='Declined';
  const validation=useFormValidation({checked:checked?'':'Confirm you reviewed the patient details and requested visit.'});
  return <ClinicDialog label="View appointment request details" onClose={confirming?()=>{}:onClose}><section className="card admission-form"> <h2>Appointment request details</h2>
    <p><b>{patient?.name || 'Patient'}</b> · {visit.date} at {visit.time?fmt12(visit.time):'Time not recorded'} · {vet?.name || 'Veterinarian not recorded'}</p>
    <h3>Requested visit</h3><dl className="op-dl">{[['Service',visit.service || 'Consultation'],['Reason / symptoms',visit.reason],['Owner notes',visit.notes || 'None'],['Owner',owner?.name],['Contact',owner?.phone || owner?.email],['Registration',registration?.status || patient?.registrationStatus || 'Verified']].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v || 'Not recorded'}</dd></div>)}</dl><VaccineEstimate appointment={visit} />
    <h3>Submitted patient details</h3>{patient?.photo && <img src={patient.photo} alt={`${patient.name} registration`} width="100" height="100" style={{objectFit:'cover'}} />}
    <dl className="op-dl">{[['Species',patient?.speciesOther || patient?.species],['Breed',patient?.breed],['Sex',patient?.sex],['Birth date',patient?.birth],['Reported weight',`${patient?.weight ?? 'Unknown'} kg · ${registration?'owner registration report':'see measured history in patient record'}`],['Spayed / neutered',patient?.neutered],['Color',patient?.color],['Registration notes',patient?.notes]].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v || 'Not recorded'}</dd></div>)}</dl>
    <ExternalHistorySummary patient={patient} />
    <p>{registration?'One approval verifies this pet’s registration and confirms the available appointment slot. Each new pet is reviewed separately.':'This pet is already verified. Approval confirms this visit and its available slot.'} Administered vaccinations are added to the card by the attending veterinarian.</p>
    {expired && <p className="err" role="alert">This requested date or time has passed. Reschedule it in Appointments and calendar or reject it with instructions for the owner.</p>}
    {declined && <p className="err" role="alert">The owner must correct and resubmit the registration before this visit can be approved.</p>}
    {stale && <p className="err" role="alert">The request changed. Close and reopen the latest details before approving.</p>}
    {error && <p className="err" role="alert">{error}</p>}
    <form {...validation.formProps} onSubmit={async e=>{e.preventDefault();if(!validation.validate(e)||stale||expired||declined||confirming)return;if(await onConfirm(visit))onClose();}}>
      <label className="admission-check"><input type="checkbox" {...validation.field('checked')} checked={checked} onChange={e=>setChecked(e.target.checked)} />I checked the pet details and requested visit.</label>{validation.feedback('checked')}
      <div className="row end"><button type="button" className="btn ghost" disabled={confirming} onClick={onClose}>Close</button><button type="button" className="btn danger" disabled={confirming||stale} onClick={()=>{onClose();onReject(visit);}}>Reject request</button><button className="btn gold" disabled={confirming||stale||expired||declined}>{confirming?'Approving…':registration?'Approve appointment & registration':'Approve visit'}</button></div>
    </form>
  </section></ClinicDialog>;
}
export default function FrontDeskApprovals({db,onReviewPet,onOpenCard,onCalendar,onConfirm,onReject,confirming,error}) {
  const [view,setView]=useState('visits'),[review,setReview]=useState(null);
  const visits=pendingVisitApprovals(db.appts), pets=registrationsWithoutVisit(db);
  const arrivals=db.appts.filter(a=>a.status==='Scheduled' && a.date>=today()).sort(chronologicalAppointments);
  const open=a=>{
    const pet=db.pets.find(p=>p.id===a.petId),registration=db.petRequests.find(r=>r.petId===a.petId && r.status!=='Approved');
    setReview({visit:approvalVisit(db,a),patient:registration || pet,registration,owner:db.owners.find(o=>o.id===(pet?.ownerId || a.ownerId)),vet:db.vets.find(v=>v.id===a.vetId)});
  };
  return <>
    <section className="card sf-approvals" aria-labelledby="approval-heading">
      <div className="sf-section-hd"><div><span className="sf-eyebrow">Reception inbox · review first</span><h2 id="approval-heading">Pending Appointment Requests <span className="sf-pill">{visits.length}</span></h2><p>Open the complete request before approving. Pet registration and booking are reviewed together, including each additional pet.</p></div><button className="btn ghost sm" onClick={onCalendar}><CalendarDays size={16} aria-hidden="true" />Open calendar</button></div>
      <div className="sf-approval-tabs" aria-label="Approval categories"><button className="btn sm" aria-pressed={view==='visits'} onClick={()=>setView('visits')}><CalendarCheck size={17} aria-hidden="true" />Visit requests ({visits.length})</button><button className="btn sm" aria-pressed={view==='pets'} onClick={()=>setView('pets')}><PawPrint size={17} aria-hidden="true" />Pets without a visit ({pets.length})</button></div>
      {error && !review && <p className="err" role="alert">{error}</p>}
      <PaginatedList className="sf-approval-list" label="Clinic approvals" resetKey={view}>
        {view==='visits'?visits.length?visits.map(a=>{
          const p=db.pets.find(p=>p.id===a.petId),o=db.owners.find(o=>o.id===(p?.ownerId || a.ownerId));
          return <article className="sf-approval-item" key={a.id}><div className="sf-approval-date"><CalendarDays size={18} aria-hidden="true" /><b>{a.date}</b><span>{a.time?fmt12(a.time):'Time not recorded'}</span></div><div className="sf-body"><h3>{p?.name || a.petName || 'Patient'}</h3><p>{a.reason || a.service}</p><p>{db.vets.find(v=>v.id===a.vetId)?.name || 'Veterinarian not recorded'}</p>{a.notes&&<p>{a.notes}</p>}<p>{o?.name || 'Owner'} · {o?.phone || o?.email || 'No contact on file'}</p><p>{p?.registrationStatus==='Pending'?'New pet · registration reviewed with this booking':'Verified patient'}</p>{a.date<today()&&<p className="err">Past requested date · needs rescheduling or a decision</p>}</div><div className="sf-approval-actions"><span className="sf-pill wa">Pending Approval</span><button className="btn gold sm" onClick={()=>open(a)}>View request details</button></div></article>;
        }):<div className="sf-approval-empty"><b>No visit requests awaiting approval</b><span>New bookings appear here before the clinic confirms them.</span></div>
        :pets.length?pets.map(p=><article className="sf-approval-item" key={p.id}><div className="sf-body"><h3>{p.name}</h3><p>{p.species} · {p.breed || 'Breed not recorded'}</p><p>No pending booking. Verify these details here, or review them together when the owner requests a visit.</p></div><button className="btn sm" onClick={()=>onReviewPet(p)}>Review registration details</button></article>):<div className="sf-approval-empty"><b>No registrations without a visit</b><span>Booked pets are reviewed in Visit requests.</span></div>}
      </PaginatedList>
    </section>
    <section className="card sf-approvals" aria-label="Confirmed upcoming visits"><div className="sf-section-hd"><div><span className="sf-eyebrow">Confirmed · nearest date first</span><h2>Expected arrivals and upcoming visits ({arrivals.length})</h2><p>Approved appointments stay visible here. Today’s arrivals can proceed to check-in from the patient record.</p></div><button className="btn sm ghost" onClick={onCalendar}>Appointments and calendar</button></div>
      <PaginatedList className="sf-approval-list" label="Confirmed upcoming visits">{arrivals.map(a=>{const p=db.pets.find(p=>p.id===a.petId);return <article className="sf-approval-item" key={a.id}><div className="sf-approval-date"><b>{a.date}</b><span>{a.time?fmt12(a.time):'Time not recorded'}</span></div><div className="sf-body"><h3>{p?.name || 'Patient'}</h3><p>{a.reason || a.service}</p><p>{db.owners.find(o=>o.id===p?.ownerId)?.name || 'Owner'} · Scheduled</p></div><button className="btn sm" onClick={()=>onOpenCard(a.petId,a)}>View patient / check-in</button></article>;})}</PaginatedList>{!arrivals.length&&<p>No confirmed upcoming visits.</p>}
    </section>
    {review&&<RequestReview snapshot={review} db={db} onClose={()=>setReview(null)} onConfirm={onConfirm} onReject={onReject} confirming={!!confirming[review.visit.id]} error={error} />}
  </>;
}
