import {useState} from 'react';
import {useClinicRead} from '../useClinicRead.js';
import AdmissionForm from './AdmissionForm.jsx';

export default function CheckoutRelease({id,apptId,me,onReleased}) {
  const read = useClinicRead(`/api/admissions/${id}`,3000);
  const [open,setOpen] = useState(false);
  const [released,setReleased] = useState(null);
  // Release is terminal. A confirmed save remains authoritative if refresh fails.
  const admission = released || read.data?.admission;
  const matchesVisit = admission?.id === id && admission.apptId === apptId;
  return <section className="admission-plan no-print" aria-label="Pet release after payment">
    <h3>Pet discharge</h3>
    {read.error && <p role="alert">{matchesVisit && admission.status === 'Discharged' ? 'Release is saved, but the latest admission updates could not refresh.' : 'Payment is saved, but the pet’s release status could not refresh.'} {read.error} <button className="btn sm" onClick={() => read.load()}>Retry release status</button></p>}
    {matchesVisit && admission.status === 'Discharged' ? <p role="status"><b>Discharged</b> · Release to the owner has been recorded.</p>
      : read.error ? null
      : !admission ? <p role="status">Checking the pet’s release status…</p>
      : !matchesVisit ? <p role="alert">The admission does not match this visit. Open Admitted Pets to check the stay.</p>
      : admission.status === 'Ready for discharge' ? <>
        <p role="status">Payment saved. Status remains Ready for discharge until reception confirms the pet was released to the owner.</p>
        {admission.dischargeInstructions && <><h4>Home-care instructions</h4><p style={{whiteSpace:'pre-wrap'}}>{admission.dischargeInstructions}</p></>}
        <button className="btn gold" disabled={admission.billingStatus !== 'Paid'} onClick={() => setOpen(true)}>Confirm release to owner</button>
        {admission.billingStatus !== 'Paid' && <p>Waiting for the saved payment to appear in the admission record.</p>}
      </> : <p>Care is ongoing. The veterinarian must approve discharge before release.</p>}
    {open && matchesVisit && <AdmissionForm mode="release" admission={admission} me={me} onClose={() => setOpen(false)} onSaved={row => {
      setOpen(false);
      setReleased(row);
      read.load();
      onReleased(row);
    }} />}
  </section>;
}
