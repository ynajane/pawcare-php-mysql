import {useUnsavedChanges} from './useUnsavedChanges.jsx';
import LiveControl from './LiveControl.jsx';
import { useEffect, useRef, useState } from 'react';
import { sameIntakeVisit } from '../intakeVisit.js';
import { useSubmissionReview } from './SubmissionReview.jsx';

const OTHER = 'Other (please specify)';
const REJECT_REASONS = ['Veterinarian is unavailable on that date','Requested time slot is no longer available','Clinic is closed on that date','Service is not offered for this pet','Booking details are incomplete or incorrect','Duplicate request',OTHER];
const CANCEL_REASONS = ['Owner asked to cancel','Owner could not be reached','Veterinarian is unavailable','Pet no longer needs the visit','Duplicate booking','Clinic closed or emergency',OTHER];
// A written reason must be words: at least 5 letters, no digit-only or symbol-only text, and no digits.
export function reasonDetailError(text) {
  const value = String(text || '').trim();
  if (!value) return 'Describe the reason.';
  if (value.length > 500) return 'Use no more than 500 characters.';
  if (/\d/.test(value)) return 'Do not use numbers. Describe the reason in words.';
  if ((value.match(/\p{L}/gu) || []).length < 5) return 'Use at least 5 letters to describe the reason.';
  if (!/^[\p{L}\s.,'’()\-/;:!?&]+$/u.test(value)) return 'Use letters and basic punctuation only.';
  return '';
}

export default function CancellationDialog({visit,currentVisit,onClose,onSubmit,error,reject=false}) {
  const action = reject ? "Reject request" : "Cancel appointment";
  const reviewTitle = reject ? "Review rejection" : "Review cancellation";
  const options = reject ? REJECT_REASONS : CANCEL_REASONS;
  const dialog = useRef(null);
  const [choice,setChoice] = useState(''), [detail,setDetail] = useState(''), [saving,setSaving] = useState(false);
  const other = choice === OTHER;
  const detailError = other ? reasonDetailError(detail) : '';
  const reason = !choice ? '' : other ? detail.trim() : choice;
  const valid = !!choice && !detailError;
  const pending = useRef(false);
  const unsaved=useUnsavedChanges({value:choice+detail,saving,onClose});
  const stale = !currentVisit || !sameIntakeVisit(visit,currentVisit);
  const review = useSubmissionReview([reason,visit,currentVisit]);
  useEffect(()=>{dialog.current.showModal();},[]);
  return <dialog ref={dialog} className="submission-review" aria-label={action} onCancel={e=>{e.preventDefault();if(!pending.current)unsaved.close();}}>
    {review.card}{unsaved.card}
    <form onSubmit={async e=>{
      e.preventDefault();
      if(pending.current || stale || !valid)return;
      if(!await review.ask({title:reviewTitle,confirmLabel:action,description:reject ? 'The owner will see this reason. Rejection releases the reserved time.' : 'This cancels the saved visit and releases its reserved time.',fields:[['Visit',`${visit.date} ${visit.time}`],['Reason',reason.trim()]]}))return;
      pending.current=true;setSaving(true);
      try {await onSubmit(reason.trim());} finally {pending.current=false;setSaving(false);}
    }}>
      <h3>{action}</h3>
      <label>{reject ? "Rejection reason" : "Cancellation reason"}
        <LiveControl as="select" required value={choice} disabled={saving} onChange={e=>setChoice(e.target.value)}>
          <option value="">Choose a reason…</option>{options.map(o=><option key={o} value={o}>{o}</option>)}
        </LiveControl></label>
      {other && <label>Reason details<LiveControl as="textarea" required maxLength={500} rows={3} value={detail} error={detail.trim() ? detailError : ''} disabled={saving} placeholder="Explain in words, no numbers" onChange={e=>setDetail(e.target.value)} /></label>}
      {(error || stale) && <p role="alert" className="err">{stale ? 'The visit changed. Close this form and reopen its current action.' : error}</p>}
      <div className="row end"><button type="button" className="btn ghost" disabled={saving} onClick={unsaved.close}>Keep appointment</button>
        <button className="btn danger" disabled={saving || stale || !valid}>{saving ? 'Saving…' : reviewTitle}</button></div>
    </form>
  </dialog>;
}
