import { TEMP_MIN, TEMP_MAX } from '../vitalValidation.js';
import {admissionReasons,carePlanTemplates,monitoringTemplates} from '../admissionTemplates.js';
import { useFormValidation } from '../components/useFormValidation.jsx';
import { medicineEventTime, admissionErrors, manilaInputValue, OBSERVATION_MAX_DAYS } from '../formValidation.js';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import ClinicDialog from '../components/ClinicDialog.jsx';
import { useSubmissionReview } from '../components/SubmissionReview.jsx';
import './admissions.css';

export default function AdmissionForm({mode,admission,visits = [],consultationContext,me,onClose,onSaved}) {
  const context = useRef(consultationContext).current;
  const sources = useRef(visits).current, revision = useRef(admission?.revision).current;
  const [form,setForm] = useState({reasonChoice:'',planTemplate:'',observationTemplate:'',planConfirmed:false,apptId:consultationContext ? visits[0]?.id || '' : '',clinicalNote:'',carePlan:'',ownerUpdate:'',temp:'',weight:'',dischargeInstructions:'',nextObservationAt:'',observationInstructions:'',completeObservation:false,consentConfirmed:false,consentName:'',consentMethod:'',emergencyName:'',emergencyPhone:'',emergencyRelationship:''});
  const [alternateContact,setAlternateContact] = useState(false);
  const [error,setError] = useState(''), [saving,setSaving] = useState(false), [discard,setDiscard] = useState(false);
  const pending = useRef(false), request = useRef(null);
  const create = mode === 'create', discharge = mode === 'discharge', release = mode === 'release', consent=mode==='consent';
  const validation = useFormValidation(admissionErrors({...form,alternateContact},{mode,vet:me.role==='vet',visits:sources}));
  const visit = sources.find(row => row.id === form.apptId);
  const dirty = Object.entries(form).some(([key,value]) => key !== 'apptId' && value !== '' && value !== false);
  const review = useSubmissionReview([form,visit,admission?.revision,admission?.status,admission?.billingStatus]);
  const set = (key,value) => setForm(previous => ({...previous,[key]:value,...(['carePlan','observationInstructions','planTemplate','observationTemplate'].includes(key)?{planConfirmed:false}:{})}));
  const template=(key,value,field,templates)=>setForm(previous=>({...previous,[key]:value,[field]:templates[value] || '',planConfirmed:false}));
  const close = () => { if (!pending.current) dirty ? setDiscard(true) : onClose(); };
  useEffect(() => {
    if (!dirty) return;
    const leave = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload',leave);
    return () => window.removeEventListener('beforeunload',leave);
  },[dirty]);
  const submit = async event => {
    event.preventDefault();
    event.stopPropagation();
    if (pending.current) return;
    setError('');
    if (!validation.validate(event)) return;
    if (create && !visit) return setError('Choose an assigned visit. Refresh visits if it is missing.');
    const body = {clinicalNote:consent ? 'Admission consent received.' : discharge && !form.clinicalNote.trim() ? 'Discharge approved by the veterinarian. Home-care instructions shared with the owner.' : form.clinicalNote.trim(),ownerUpdate:form.ownerUpdate.trim(),measurements:{},
      ...(create ? {reasonChoice:form.reasonChoice,apptId:visit.id,expectedVisit:visit} : {revision}),
      ...(me.role === 'vet' && !discharge && !release ? {carePlan:form.carePlan.trim(),planTemplate:form.planTemplate,observationTemplate:form.observationTemplate,planConfirmed:form.planConfirmed} : {}),
      ...(discharge ? {dischargeInstructions:form.dischargeInstructions.trim()} : {})};
    if (me.role === 'vet' && !discharge && !release) {
      if (create || form.nextObservationAt || form.observationInstructions) Object.assign(body,{nextObservationAt:new Date(medicineEventTime(form.nextObservationAt)).toISOString(),observationInstructions:form.observationInstructions.trim()});

    }
    if(consent || me.role==='assistant' && form.consentConfirmed) for(const key of ['consentConfirmed','consentName','consentMethod','emergencyName','emergencyPhone','emergencyRelationship']) body[key]=typeof form[key]==='string'?form[key].trim():form[key];
    if (mode==='update' && form.completeObservation) body.completeObservation = true;
    for (const key of ['temp','weight']) if (form[key] !== '') body.measurements[key] = Number(form[key]);
    if (!body.clinicalNote || (create && (!body.carePlan || !body.ownerUpdate)) || (discharge && !body.dischargeInstructions)) return setError('Complete the required notes and instructions.');
    const fields = [['Pet',create ? `${visit.petName} · ${visit.ownerName}` : admission.petName],['Clinic-only note',body.clinicalNote],
      ...(create ? [['Admission reason',form.reasonChoice]] : []),
      ...(body.planTemplate ? [['Care plan template',body.planTemplate]] : []),
      ...(body.observationTemplate ? [['Monitoring template',body.observationTemplate]] : []),
      ...(body.carePlan ? [['Veterinarian care plan',body.carePlan]] : []),
      ['Measured observations',Object.entries(body.measurements).map(([key,value]) => `${key === 'temp' ? 'Temperature' : 'Weight'}: ${value} ${key === 'temp' ? '°C' : 'kg'}`).join('\n') || 'None entered'],
      ...(body.nextObservationAt ? [['Next observation (Manila)',new Date(body.nextObservationAt).toLocaleString('en-PH',{timeZone:'Asia/Manila'})],['Observation task',body.observationInstructions]] : []),
      ...(body.completeObservation ? [['Completed observation','I performed the scheduled check now. The saved time will be recorded by the clinic server.']] : []),
      ...(body.consentConfirmed ? [['Admission consent',`${body.consentName} · ${body.consentMethod} · confirmed as received by clinic staff`],['Contact',body.emergencyName ? `${body.emergencyName} · ${body.emergencyPhone} · ${body.emergencyRelationship}` : 'Use the owner’s saved contact details']] : []),
      ['Message visible to owner',body.ownerUpdate || 'No new owner message'],
      ...(discharge ? [['Home-care instructions visible to owner',body.dischargeInstructions]] : []),
      ...(release ? [['Admission status',admission.status],['Payment',admission.billingStatus],['Saved home-care instructions',admission.dischargeInstructions || 'None recorded']] : [])];
    if (!await review.ask({title:create ? 'Review pet admission' : release ? 'Review pet release' : discharge ? 'Review discharge' : 'Review admission update',confirmLabel:create ? 'Admit pet' : release ? 'Confirm release to owner' : discharge ? 'Approve discharge' : 'Save update',
      description:release ? 'Confirm the pet was released to the owner after veterinarian approval and saved payment.' : discharge ? 'Approve discharge and share home-care instructions. Reception must record final payment before releasing the pet.' : 'Check the clinical notes and the exact message that will be shared with the owner.',fields})) return;
    const signature = JSON.stringify(body);
    if (request.current?.signature !== signature) request.current = {signature,id:crypto.randomUUID()};
    pending.current = true; setSaving(true);
    try {
      const result = await api.post(create ? '/api/admissions' : `/api/admissions/${admission.id}/${mode}`,{...body,requestId:request.current.id});
      if (!result.success || !result.admission?.id || !Number.isInteger(result.admission.revision) || (create ? result.admission.id !== request.current.id : result.admission.id !== admission.id)) throw Error('The server did not confirm this save. Keep your entries and retry to check the result.');
      if (release && (result.admission.apptId !== admission.apptId || result.admission.status !== 'Discharged' || result.admission.billingStatus !== 'Paid'
          || result.admission.revision <= revision || typeof result.admission.dischargedAt !== 'string' || !Number.isFinite(Date.parse(result.admission.dischargedAt)))) {
        throw Error('The server did not confirm this release. Keep your entries and retry to check the result.');
      }
      onSaved(result.admission);
    } catch (e) { setError(e.message); pending.current = false; setSaving(false); }
  };
  const title = consent ? `Owner consent · ${admission.petName}` : create ? context ? `Admit ${context.petName}` : 'Admit a pet' : release ? `Release ${admission.petName} to owner` : discharge ? `Discharge ${admission.petName}` : `${admission.petName} · ${me.role === 'vet' ? 'Veterinarian update' : 'Care observation'}`;
  return <ClinicDialog label={title} onClose={close}>
    <section className="card admission-form">
      {review.card}<h2>{title}</h2>
      <p>{release ? 'Check the saved payment and home-care instructions, then confirm the pet was released to the owner.' : discharge ? 'The veterinarian approves discharge after finalizing the consultation. Enter the summary and instructions for going home.' : 'Record care that was actually observed or provided. Owner messages are shared only when you explicitly enter them.'}</p>
      {create && context && <section className="admission-consultation-context" aria-label="Consultation linked to admission">
        <b>{context.petName}</b><p>Owner: {context.ownerName} · Visit: {visit.date} at {visit.time}</p>
        <p>This admission is linked to the consultation you have open. Your visit notes remain open and must be finalized separately.</p>
        {context.diagnosis && <><h3>Current assessment (clinic only)</h3><p className="admission-context-notes">{context.diagnosis}</p></>}
        {context.treatment && <><h3>Current consultation plan (clinic only)</h3><p className="admission-context-notes">{context.treatment}</p>
          <button type="button" className="btn sm ghost" disabled={saving || context.treatment.length>3000} onClick={()=>set('carePlan',context.treatment)}>Use consultation plan for admission</button>
          {context.treatment.length>3000 && <p>Summarize this plan in the admission instructions below (up to 3,000 characters).</p>}</>}
      </section>}
      <form {...validation.formProps} onSubmit={submit}>
        <fieldset disabled={saving}>
          {create && !context && <label>Clinical visit *<select required {...validation.field('apptId')} value={form.apptId} onChange={event => set('apptId',event.target.value)}>
            <option value="">Choose a visit</option>{sources.map(row => <option key={row.id} value={row.id}>{row.petName} · {row.ownerName} · {row.date} {row.time} · {row.status}</option>)}
          </select>{validation.feedback('apptId')}</label>}
          {create && <label>Reason for admission *<select required {...validation.field('reasonChoice')} value={form.reasonChoice} onChange={e=>{const value=e.target.value;setForm(previous=>({...previous,reasonChoice:value,clinicalNote:value==='Other'?'':value}));}}><option value="">Choose an admission reason</option>{admissionReasons.map(v=><option key={v}>{v}</option>)}</select>{validation.feedback('reasonChoice')}</label>}
          {(!create || form.reasonChoice==='Other') && !consent && <label>{create ? 'Other reason for admission (clinic only)' : release ? 'Release confirmation (clinic only)' : discharge ? 'Discharge summary (clinic only, optional)' : 'Observations / care provided (clinic only)'} {discharge ? '' : '*'}
            <textarea required={!discharge} rows={3} maxLength={3000} {...validation.field('clinicalNote')} value={form.clinicalNote} onChange={event => set('clinicalNote',event.target.value)} />{validation.feedback('clinicalNote')}</label>}
          {me.role==='vet' && !discharge && !release && <label>Care plan template<select {...validation.field('planTemplate')} value={form.planTemplate} onChange={e=>template('planTemplate',e.target.value,'carePlan',carePlanTemplates)}><option value="">Choose a starting template (optional)</option>{Object.keys(carePlanTemplates).map(v=><option key={v}>{v}</option>)}<option value="Custom">Custom plan</option></select>{validation.feedback('planTemplate')}</label>}
          {me.role === 'vet' && !discharge && !release && <label>{create ? 'Care plan and monitoring instructions *' : 'Updated care plan (optional; leave blank to keep the current plan)'}
            <textarea required={create} rows={3} maxLength={3000} {...validation.field('carePlan')} value={form.carePlan} onChange={event => set('carePlan',event.target.value)} />{validation.feedback('carePlan')}</label>}
          {me.role === 'vet' && !discharge && !release && <fieldset><legend>Next observation · veterinarian schedule</legend>
            <p>{create ? 'Set the first check for the assistant to follow.' : 'Leave both fields blank to keep the saved task. To schedule another check after completion, enter a new time and instructions.'} Times are in Manila (UTC+08:00).</p>
            <label>Next observation (Manila) {create && '*'}<input type="datetime-local" required={create} min={manilaInputValue()} max={manilaInputValue(Date.now()+OBSERVATION_MAX_DAYS*86400000)} {...validation.field('nextObservationAt')} value={form.nextObservationAt} disabled={form.completeObservation} onChange={e=>set('nextObservationAt',e.target.value)} />{validation.feedback('nextObservationAt')}</label>
            <label>Monitoring template<select {...validation.field('observationTemplate')} value={form.observationTemplate} onChange={e=>template('observationTemplate',e.target.value,'observationInstructions',monitoringTemplates)}><option value="">Choose a starting template (optional)</option>{Object.keys(monitoringTemplates).map(v=><option key={v}>{v}</option>)}<option value="Custom">Custom instructions</option></select>{validation.feedback('observationTemplate')}</label>
            <label>What staff should check {create && '*'}<textarea maxLength={1000} required={create} rows={2} {...validation.field('observationInstructions')} value={form.observationInstructions} disabled={form.completeObservation} onChange={e=>set('observationInstructions',e.target.value)} />{validation.feedback('observationInstructions')}</label>
          </fieldset>}
          {me.role==='vet' && !discharge && !release && <><p>Templates provide documentation prompts. Review and edit the plan for this patient; medicine orders are saved separately.</p><label className="admission-check"><input type="checkbox" {...validation.field('planConfirmed')} checked={form.planConfirmed} onChange={e=>set('planConfirmed',e.target.checked)} />I reviewed this patient’s care plan and monitoring instructions.</label>{validation.feedback('planConfirmed')}{create && <p>After admission, the assistant records owner consent; the owner’s saved contact details are used unless an alternate contact is provided in the care record.</p>}</>}
          {mode==='update' && admission.nextObservationAt && !admission.observationCompletedAt && <section className="admission-plan"><h3>Scheduled observation</h3><p>{new Date(admission.nextObservationAt).toLocaleString('en-PH',{timeZone:'Asia/Manila'})} · {admission.observationInstructions}</p>
            <label className="admission-check"><input type="checkbox" checked={form.completeObservation} disabled={!!form.nextObservationAt || !!form.observationInstructions} onChange={e=>set('completeObservation',e.target.checked)} />I performed this scheduled check now. Record findings above.</label><p>Save completion first; the veterinarian can then schedule the next check. A general care update does not complete this task.</p></section>}
          {me.role === 'assistant' && (consent || mode==='update') && <fieldset><legend>Owner consent</legend>
            <p>Record consent received for this admission and care plan. This records staff confirmation, not an electronic owner signature. {admission?.consent && 'New confirmation replaces the displayed consent and alternate contact; the previous record stays in the care timeline.'}</p>
            <label className="admission-check"><input type="checkbox" required={consent} {...validation.field('consentConfirmed')} checked={form.consentConfirmed} onChange={e=>set('consentConfirmed',e.target.checked)} />I received consent from the owner or authorized representative {consent && '*'}</label>{validation.feedback('consentConfirmed')}
            {(consent || form.consentConfirmed) && <>
              <label>Consenting person *<input required maxLength={150} {...validation.field('consentName')} value={form.consentName} onChange={e=>set('consentName',e.target.value)} />{validation.feedback('consentName')}</label>
              <label>Consent received *<select required {...validation.field('consentMethod')} value={form.consentMethod} onChange={e=>set('consentMethod',e.target.value)}><option value="">Choose method</option>{['In person','Phone','Written'].map(v=><option key={v}>{v}</option>)}</select>{validation.feedback('consentMethod')}</label>
              <p>Primary contact: {admission?.ownerName || 'Pet owner'}{admission?.ownerPhone ? ` · ${admission.ownerPhone}` : ' · use the owner’s contact details in their profile'}. An alternate contact is optional.</p>
              <label className="admission-check"><input type="checkbox" checked={alternateContact} onChange={e=>{setAlternateContact(e.target.checked);if(!e.target.checked)setForm(previous=>({...previous,emergencyName:'',emergencyPhone:'',emergencyRelationship:''}));}} />Add an alternate contact</label>
              {alternateContact && <><label>Alternate contact name *<input required maxLength={150} {...validation.field('emergencyName')} value={form.emergencyName} onChange={e=>set('emergencyName',e.target.value)} />{validation.feedback('emergencyName')}</label>
              <label>Alternate phone *<input type="tel" required maxLength={40} {...validation.field('emergencyPhone')} value={form.emergencyPhone} onChange={e=>set('emergencyPhone',e.target.value)} />{validation.feedback('emergencyPhone')}</label>
              <label>Relationship to owner *<input required maxLength={100} {...validation.field('emergencyRelationship')} value={form.emergencyRelationship} onChange={e=>set('emergencyRelationship',e.target.value)} />{validation.feedback('emergencyRelationship')}</label></>}
            </>}
          </fieldset>}
          {!discharge && !release && !consent && <div className="admission-measurements">
            <label>Measured temperature (°C)<input type="number" min={TEMP_MIN} max={TEMP_MAX} step="0.1" {...validation.field('temp')} value={form.temp} onChange={event => set('temp',event.target.value)} />{validation.feedback('temp')}</label>
            <label>Measured weight (kg)<input type="number" min="0.05" max="120" step="0.01" {...validation.field('weight')} value={form.weight} onChange={event => set('weight',event.target.value)} />{validation.feedback('weight')}</label>
          </div>}
          {!consent && <label>Message visible to owner {create ? '*' : '(optional)'}<textarea required={create} rows={3} maxLength={2000} {...validation.field('ownerUpdate')} value={form.ownerUpdate} onChange={event => set('ownerUpdate',event.target.value)} placeholder="A clear update about the pet’s care and next steps" />{validation.feedback('ownerUpdate')}</label>}
          {discharge && <label>Discharge and home-care instructions visible to owner *<textarea required rows={4} maxLength={3000} {...validation.field('dischargeInstructions')} value={form.dischargeInstructions} onChange={event => set('dischargeInstructions',event.target.value)} />{validation.feedback('dischargeInstructions')}</label>}
          {error && <p role="alert" className="err">{error} Your entries remain in this form.</p>}
          <div className="row end"><button type="button" className="btn ghost" onClick={close}>Cancel</button><button className="btn gold">{saving ? 'Saving…' : 'Review and save'}</button></div>
        </fieldset>
      </form>
    </section>
    {discard && <ClinicDialog label="Discard unsaved admission entries?" onClose={() => setDiscard(false)}><section className="card admission-form"><h3>Discard unsaved admission entries?</h3><p>These entries have not been saved to the clinic.</p><div className="row end"><button className="btn gold" data-dialog-autofocus onClick={() => setDiscard(false)}>Keep editing</button><button className="btn ghost" onClick={onClose}>Discard entries</button></div></section></ClinicDialog>}
  </ClinicDialog>;
}

