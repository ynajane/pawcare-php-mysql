import AdmissionDischargeSummary from './AdmissionDischargeSummary.jsx';
import AdmissionForm from './AdmissionForm.jsx';
import { Hospital } from 'lucide-react';
import { useState } from 'react';
import { useClinicRead } from '../useClinicRead.js';
import './admissions.css';
import AdmissionMedicineForm from './AdmissionMedicineForm.jsx';

const time = value => value ? new Date(value).toLocaleString('en-PH',{timeZone:'Asia/Manila',dateStyle:'medium',timeStyle:'short'}) : '—';
const Status = ({admission}) => <span className={`admission-status ${admission.status === 'Discharged' ? 'discharged' : admission.status === 'Ready for discharge' ? 'ready' : ''}`}>{admission.status}</span>;

export function AdmissionsSummary({me,go}) {
  const read = useClinicRead('/api/admissions',5000);
  if (read.error) return <section className="card admission-summary" role="alert">Pet admission updates could not refresh. <button className="btn sm" onClick={() => go('admissions')}>Open admissions</button></section>;
  if (!read.data?.total) return null;
  return <section className="card admission-summary" aria-label="Admitted pets">
    <div><h3>{me.role === 'owner' ? 'Your pet’s stay at the clinic' : 'Pets under admission'} ({read.data.total})</h3>
      <p>{read.data.admissions.slice(0,3).map(row => row.petName).join(', ')}{read.data.total > 3 ? ' and more' : ''}</p></div>
    <button className="btn gold" onClick={() => go('admissions')}>{me.role === 'owner' ? 'View pet updates' : 'Monitor admitted pets'}</button>
  </section>;
}


function NewAdmission({me,onSaved}) {
  const [open,setOpen] = useState(false);
  const read = useClinicRead('/api/admissions/eligible',5000);
  return <>
    {read.error && <p role="alert">{read.error} <button className="btn sm" onClick={() => read.load()}>Retry visit list</button></p>}
    <button className="btn ghost" disabled={!read.data?.visits.length || !!read.error} onClick={() => setOpen(true)}>Choose a visit to admit</button>
    {!read.error && read.data && !read.data.visits.length && <p>No other visits are available for admission. Start the patient’s visit from the Clinical Queue.</p>}
    {open && <AdmissionForm mode="create" me={me} visits={read.data?.visits || []} onClose={() => setOpen(false)} onSaved={row => {setOpen(false);read.load();onSaved(row);}} />}
  </>;
}

function AdmissionDetail({id,me,go,onBack,onChanged}) {
  const [print,setPrint] = useState(false);
  const [pages,setPages] = useState([null]), [mode,setMode] = useState(null), [medicine,setMedicine] = useState(null);
  const cursor = pages.at(-1);
  const read = useClinicRead(`/api/admissions/${id}${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`,3000);
  const owner = me.role === 'owner', admission = read.data?.admission;
  const saved = row => {setMode(null);setMedicine(null);setPages([null]);read.load(`/api/admissions/${id}`);onChanged(row);};
  return <section className="card admission-detail">
    <button className="btn sm ghost" onClick={onBack}>Back to admissions</button>
    {read.error && <p role="alert" className="err">{read.error} <button className="btn sm" onClick={() => read.load()}>Retry admission</button></p>}
    {!read.data && !read.error && <p role="status">Loading admission…</p>}
    {admission && !read.error && <>
      <header className="admission-heading"><div><h2>{admission.petName}</h2><p>{admission.vetName}{!owner && ` · Owner: ${admission.ownerName}`}</p></div><Status admission={admission} /></header>
      <p>Admitted: {time(admission.admittedAt)}{admission.dischargeApprovedAt && ` · Discharge approved: ${time(admission.dischargeApprovedAt)}`}{admission.dischargedAt && ` · Discharged: ${time(admission.dischargedAt)}`}</p>
      {owner ? <p>These are saved updates shared by the clinic. Checked at {time(read.data.checkedAt)}. Times are shown in Manila time.</p> : <>
        <section className="admission-plan"><h3>Reason for admission</h3><p>{admission.reason}</p><h3>Veterinarian care plan</h3><p>{admission.carePlan}</p><h3>Next observation · Manila time</h3>
          {admission.nextObservationAt ? <><p><b>{admission.observationCompletedAt ? 'Completed' : admission.status!=='Admitted' ? 'Care closed' : Date.parse(admission.nextObservationAt)<Date.parse(read.data.checkedAt) ? 'Overdue — notify the veterinarian' : 'Scheduled'}: {time(admission.nextObservationAt)}</b></p><p>{admission.observationInstructions}</p>{admission.observationCompletedAt && <p>Completion recorded: {time(admission.observationCompletedAt)}. The veterinarian sets the next check.</p>}</> : <p>No observation time recorded. Ask the veterinarian to set the next check.</p>}
          <p>Assistants follow the saved plan, record findings and actual medicine events, and contact the veterinarian if the pet’s condition changes. Only the veterinarian changes the plan or approves discharge.</p></section>
        {admission.status === 'Admitted' && ['vet','assistant'].includes(me.role) && <div className="admission-actions"><button className="btn gold" onClick={() => setMode('update')}>{me.role === 'vet' ? 'Add veterinarian update' : 'Record care observation'}</button>
          {me.role === 'vet' && <button className="btn" disabled={admission.visitStatus !== 'Completed'} onClick={() => setMode('discharge')}>Approve discharge</button>}
          {me.role === 'vet' && admission.visitStatus !== 'Completed' && <button className="btn gold" onClick={()=>go('home',{apptId:admission.apptId,action:'notes'})}>Finish visit notes</button>}
          {me.role === 'vet' && admission.visitStatus !== 'Completed' && <p>Finalize the visit record before approving discharge.</p>}
        </div>}
      </>}
      <section className="admission-plan" aria-label="Admission owner consent"><h3>Owner consent</h3>
        {admission.consent ? <><p>Consent received from {admission.consent.name} · {admission.consent.method}</p><p>Recorded by {admission.consent.recordedBy} · {time(admission.consent.recordedAt)} (staff confirmation)</p>{admission.consent.emergencyName ? <p>Alternate contact: {admission.consent.emergencyName} · {admission.consent.emergencyPhone} · {admission.consent.emergencyRelationship}</p> : <p>Primary contact: the pet owner{!owner && admission.ownerPhone ? ` · ${admission.ownerPhone}` : ''}.</p>}{owner && <p>Contact the clinic if these details need correction.</p>}</> : <p>Not recorded for this stay. {owner ? 'Contact the clinic to confirm consent details.' : 'Assistant task: record consent received; use the owner’s saved contact details or add an alternate. Consent documents the owner’s authorization; it is not a signature in the owner app.'}</p>}
        {!owner && me.role==='assistant' && admission.status!=='Discharged' && <button className="btn gold" onClick={()=>setMode('consent')}>{admission.consent?'Update owner consent':'Record owner consent'}</button>}
      </section>
      <section className="admission-plan" aria-label="Discharge and checkout progress"><h3>Discharge and checkout</h3>
        <p>{admission.status === 'Admitted' ? 'Care is ongoing. Final checkout waits for veterinarian discharge approval.' : admission.status === 'Ready for discharge' ? admission.billingStatus === 'Paid' ? 'Payment saved. Reception can now confirm release to the owner.' : 'Discharge approved. Reception must finalize the bill and record payment before release.' : 'This stay is closed. Its care history and discharge instructions are retained.'}</p>
        <p>Payment: {admission.billingStatus || 'Unbilled'}</p>
        {admission.status!=='Admitted' && <div className="admission-actions">
          {admission.status === 'Ready for discharge' && me.role === 'assistant' && <>
            {admission.billingStatus !== 'Paid' && go && <button className="btn" onClick={()=>go('home',{apptId:admission.apptId,action:'checkout'})}>Open this visit’s checkout</button>}
            <button className="btn gold" disabled={admission.billingStatus !== 'Paid'} onClick={()=>setMode('release')}>Confirm release to owner</button></>}
          <button className="btn" onClick={()=>setPrint(true)}>View / print discharge summary</button>
        </div>}
      </section>
      {!owner && <section className="admission-plan" aria-label="Medicine orders"><h3>Veterinarian medicine orders</h3>
        <p>Orders describe what should be given. The care timeline records what actually happened. Take-home prescriptions and clinic supplies are separate.</p>
        {admission.status === 'Admitted' && me.role === 'vet' && <button className="btn gold" onClick={()=>setMedicine({action:'order'})}>Add medicine order</button>}
        {!read.data.medicationOrders?.length && <p>No medicine orders recorded for this stay.</p>}
        {read.data.medicationOrders?.map(order=><article key={order.id} className="admission-medicine-order"><h4>{order.medicine} {order.stopped_at && <small>· Stopped {time(order.stopped_at)}</small>}</h4><p>{order.dose} · {order.route} · {order.frequency}</p><p>{order.instructions}</p><p>Ordered by {order.ordered_by} · {time(order.ordered_at)}</p>{order.catalog_id && <p>Clinic supply limit: {order.supply_limit} whole items/packages. Actual usage is recorded with each given dose.</p>}
          {!order.stopped_at && admission.status === 'Admitted' && ['vet','assistant'].includes(me.role) && <div className="admission-actions"><button className="btn" onClick={()=>setMedicine({action:'medication',order})}>Record medicine event</button>{me.role === 'vet' && <button className="btn ghost" onClick={()=>setMedicine({action:'stop-medication',order})}>Stop order</button>}</div>}
        </article>)}
      </section>}
      {admission.dischargeInstructions && <section className="admission-plan"><h3>Discharge and home-care instructions</h3><p>{admission.dischargeInstructions}</p></section>}
      <h3>{owner ? 'Updates from the clinic' : 'Care timeline'} <small>· newest first</small></h3>
      {!read.data.updates.length && <p>{owner ? 'The clinic has not shared an update on this page yet.' : 'No updates on this page.'}</p>}
      <ol className="admission-timeline">{read.data.updates.map(update => <li key={update.id}>
        <h4>{!owner && update.careDetails?.consent ? 'Owner consent' : update.kind} <small>{time(update.at)}</small></h4><p className="admission-by">{update.by} · {update.role === 'vet' ? 'Veterinarian' : 'Veterinary assistant'}</p>
        {!owner && <><p>{update.clinicalNote}</p>{update.medication?.medicine && <p><b>{update.medication.medicine}</b>{update.medication.dose && ` · ${update.medication.dose} · ${update.medication.route}`}{update.medication.result && ` · ${update.medication.result} · ${time(update.medication.occurredAt)}`}{update.medication.billableQuantity > 0 && ` · Clinic supplies used: ${update.medication.billableQuantity} whole items/packages`}</p>}{update.voided && <p><b>Entered in error — original entry retained; excluded from charges.</b></p>}{update.medication?.voids && <p>Corrects medicine entry: {update.medication.voids}</p>}{admission.status === 'Admitted' && me.role === 'vet' && update.kind === 'Medicine administration' && !update.voided && <button className="btn sm ghost" onClick={()=>setMedicine({action:'correct-medication',event:update})}>Mark as entered in error</button>}{update.careDetails?.nextObservationAt && <p><b>Observation scheduled:</b> {time(update.careDetails.nextObservationAt)} · {update.careDetails.observationInstructions}</p>}
          {update.careDetails?.completedObservation && <p><b>Observation completed:</b> {time(update.careDetails.completedObservation.completedAt)} · Scheduled for {time(update.careDetails.completedObservation.dueAt)} · {update.careDetails.completedObservation.instructions}</p>}
          {update.careDetails?.consent && <p><b>Consent recorded:</b> {update.careDetails.consent.name} · {update.careDetails.consent.method}{update.careDetails.consent.emergencyName ? ` · Alternate contact: ${update.careDetails.consent.emergencyName}, ${update.careDetails.consent.emergencyPhone}, ${update.careDetails.consent.emergencyRelationship}` : ' · Contact: pet owner'}</p>}
          {update.careDetails?.reasonChoice && <p><b>Admission reason:</b> {update.careDetails.reasonChoice}</p>}
          {update.careDetails?.planTemplate && <p><b>Care plan template:</b> {update.careDetails.planTemplate}</p>}
          {update.careDetails?.observationTemplate && <p><b>Monitoring template:</b> {update.careDetails.observationTemplate}</p>}
          {update.carePlan && <p><b>Care plan:</b> {update.carePlan}</p>}
          {Object.keys(update.measurements || {}).length > 0 && <p>Measured: {Object.entries(update.measurements).map(([key,value]) => `${key === 'temp' ? 'Temperature' : 'Weight'} ${value} ${key === 'temp' ? '°C' : 'kg'}`).join(' · ')}</p>}</>}
        {update.ownerUpdate && <div className="admission-owner-update">{!owner && <b>Shared with owner</b>}<p>{update.ownerUpdate}</p></div>}
        {!owner && !update.ownerUpdate && <small>Clinic-only update</small>}
      </li>)}</ol>
      <div className="admission-actions"><button className="btn sm ghost" disabled={pages.length === 1} onClick={() => setPages(previous => previous.slice(0,-1))}>Newer updates</button><button className="btn sm ghost" disabled={!read.data.nextCursor} onClick={() => setPages(previous => [...previous,read.data.nextCursor])}>Older updates</button></div>
      <p className="admission-footnote">Care history is retained after discharge. Vet approval → final payment → confirmed release. Prescribed, administered and take-home medicines remain separate records.</p>
    </>}
    {print && <AdmissionDischargeSummary id={id} onClose={()=>setPrint(false)} />}
    {medicine && admission && <AdmissionMedicineForm {...medicine} admission={admission} onClose={()=>setMedicine(null)} onSaved={saved} />}
    {mode && admission && <AdmissionForm mode={mode} admission={admission} me={me} onClose={() => setMode(null)} onSaved={saved} />}
  </section>;
}

export default function AdmissionsPage({me,go,say = () => {}}) {
  const [status,setStatus] = useState('Active'), [offset,setOffset] = useState(0), [selected,setSelected] = useState(null);
  const read = useClinicRead(`/api/admissions?status=${status}&offset=${offset}`,3000);
  const data = read.data?.status === status && read.data?.offset === offset ? read.data : null;
  const changed = row => {read.load();say(row.status === 'Discharged' ? 'Release saved. The admission history is retained.' : 'Admission update saved.');};
  if (selected) return <AdmissionDetail key={selected} id={selected} me={me} go={go} onBack={() => setSelected(null)} onChanged={changed} />;
  const owner = me.role === 'owner';
  return <div className="admissions-page">
    <section className="card admission-overview">
      <div className="admission-overview-heading"><span className="admission-icon"><Hospital size={26} aria-hidden="true" /></span><div>
        <h2>{owner ? 'Your pet’s stay at the clinic' : 'Admission and daily care'}</h2>
        <p>{owner ? 'Read saved updates from the clinic and follow your pet’s progress through discharge.' : me.role === 'vet' ? 'Choose an active visit to admit. Monitor care, finalize visit notes and approve discharge here.' : 'Record daily care and medicine events, share owner updates, and coordinate release after payment.'}</p>
      </div></div>
      <ol className="admission-workflow" aria-label="Admission workflow">
        <li><span>1</span><div><b>Vet admits</b><small>Reason and monitoring plan</small></div></li>
        <li><span>2</span><div><b>Clinic provides care</b><small>Observations and actual medicine events</small></div></li>
        <li><span>3</span><div><b>Vet approves discharge</b><small>Final visit record and home-care instructions</small></div></li>
        <li><span>4</span><div><b>Payment and release</b><small>Reception confirms the pet went home</small></div></li>
      </ol>
      {me.role === 'vet' && <div className="admission-actions">
        <button className="btn gold" onClick={()=>go('home')}>Open Clinical Queue</button>
        <NewAdmission me={me} onSaved={row => {changed(row);setSelected(row.id);}} />
      </div>}
    </section>
    <section className="card admission-roster" aria-label="Admission list" aria-busy={read.loading}>
      <div className="admission-list-toolbar"><div className="admission-filters" role="group" aria-label="Admission status">{['Active','Admitted','Ready for discharge','Discharged'].map(value => <button key={value} className={`btn ${status === value ? 'gold' : 'ghost'}`} aria-pressed={status === value} onClick={() => {setStatus(value);setOffset(0);}}>{value === 'Active' ? 'All active stays' : value}</button>)}</div>
        <button className="btn sm ghost" disabled={read.loading} onClick={() => read.load()}>{read.loading && data ? 'Refreshing…' : 'Refresh updates'}</button></div>
      {read.error && <p role="alert" className="err">{read.error} {data && 'Showing the last loaded admissions.'} <button className="btn sm ghost" onClick={()=>read.load()}>Retry admissions</button></p>}
      {!data && !read.error && <><p role="status">Loading admissions…</p><div className="admission-list admission-loading" aria-hidden="true">{[1,2,3].map(i=><div key={i}><span /><span /><span /></div>)}</div></>}
      {data && <>
        <div className="admission-list-meta"><b>{data.total} {status === 'Active' ? 'active' : status.toLowerCase()} {data.total === 1 ? 'stay' : 'stays'}</b><small>Updated {time(data.checkedAt)}</small></div>
        {!data.admissions.length && <div className="admission-empty"><Hospital size={32} aria-hidden="true" /><h3>{status === 'Active' ? 'No active admissions' : `No ${status.toLowerCase()} stays`}</h3>
          <p>{owner ? 'When the clinic admits your pet, shared updates will appear here.' : me.role === 'vet' ? 'Start the patient’s visit in the Clinical Queue, then choose that visit here or use the Admission action in the open visit notes.' : 'Patients appear here after a veterinarian saves an admission. You can then record care and share updates.'}</p></div>}
        <div className="admission-list">{data.admissions.map(row => <article key={row.id}>
          <div className="admission-heading"><h3>{row.petName}</h3><Status admission={row} /></div>
          {!owner && <p className="admission-card-owner">Owner: {row.ownerName}</p>}
          <p className="admission-card-meta">{row.vetName}<br />Admitted {time(row.admittedAt)}</p>
          {!owner && <p className="admission-preview"><b>Reason: </b>{row.reason}</p>}
          {row.latestUpdate ? <div className="admission-owner-update"><small>{owner ? 'Latest clinic update' : 'Latest shared owner update'}</small><p className="admission-preview">{row.latestUpdate}</p></div> : <p className="admission-footnote">No owner update shared yet.</p>}
          <p className="admission-next-step"><b>Next: </b>{!owner && !row.consent && row.status!=='Discharged' && 'Assistant: record owner consent. '}{!owner && row.status==='Admitted' && row.nextObservationAt && !row.observationCompletedAt ? `Observation ${Date.parse(row.nextObservationAt)<Date.parse(data.checkedAt) ? 'overdue' : 'due'} ${time(row.nextObservationAt)}. ` : ''}{row.status === 'Admitted' ? owner ? 'Ongoing care and clinic updates.' : 'Continue care; vet approval is required for discharge.' : row.status === 'Ready for discharge' ? row.billingStatus === 'Paid' ? 'Reception confirms release to the owner.' : 'Reception records final payment before release.' : 'View the retained care history and home instructions.'}</p>
          <button className="btn" onClick={() => setSelected(row.id)}>{owner ? 'View pet updates' : 'Open care record'}</button>
        </article>)}</div>
        {data.total>50 && <div className="admission-actions"><button className="btn sm ghost" disabled={!offset} onClick={() => setOffset(previous => Math.max(0,previous-50))}>Previous stays</button><button className="btn sm ghost" disabled={offset+50 >= data.total} onClick={() => setOffset(previous => previous+50)}>More stays</button></div>}
      </>}
    </section>
  </div>;
}
