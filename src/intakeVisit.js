import {vitalValueError, TEMP_MIN, TEMP_MAX} from './vitalValidation.js';
export function intakeReasonError(reason) {
  if(typeof reason!=='string' || !reason.trim() || reason.length>500) return 'Enter a visit reason of no more than 500 characters.';
  if(!/\p{L}/u.test(reason)) return 'Describe the visit reason using words, such as vomiting or routine checkup.';
  return '';
}
// Initial arrivals must use their reserved clinic day; ongoing intake can cross midnight.
export function checkInDateError(visit, clinicDate) {
  if (!['Checked-in','In consultation'].includes(visit?.status) && visit?.date !== clinicDate) {
    return `Check-in is only available on the scheduled day (${visit?.date || 'date missing'}). Today in Manila is ${clinicDate}. Reschedule the appointment first if the day is incorrect.`;
  }
  return null;
}

// A pending request whose slot has already started can no longer be approved; reschedule or reject it.
export function approvalExpiredError(visit, clock) {
  const {date,time} = clock || {};
  if (!visit?.date || !date) return null;
  if (visit.date < date || (visit.date === date && /^\d{2}:\d{2}$/.test(visit.time || '') && visit.time < time))
    return `This requested time (${visit.date} ${visit.time || ''}) has already passed. Reschedule it or reject the request.`.replace('  ',' ');
  return null;
}

// Both the browser and the locked database row use this intake-edit baseline.
export function intakeVisitSnapshot(visit) {
  if (!visit) return null;
  return {id:visit.id,petId:visit.petId ?? visit.pet_id,vetId:visit.vetId ?? visit.vet_id,
    date:visit.date,time:visit.time,reason:visit.reason,status:visit.status,
    intakeVitals:visit.intakeVitals ?? visit.intake_vitals ?? null};
}
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])) : value;
export const sameIntakeVisit = (a,b) => JSON.stringify(ordered(intakeVisitSnapshot(a))) === JSON.stringify(ordered(intakeVisitSnapshot(b)));

export function savedIntakeVisit(response, expected) {
  const visit = intakeVisitSnapshot(response?.appointment);
  const vitals = visit?.intakeVitals;
  if (!response?.success || !visit?.id || visit.id !== expected.id || visit.petId !== expected.petId || visit.status !== (expected.status==='In consultation'?'In consultation':'Checked-in')
      || !Number.isFinite(vitals?.weight) || !Number.isFinite(vitals?.temp) || !visit.date) {
    throw new Error('The server did not confirm the saved intake. Refresh clinic records before continuing.');
  }
  const bookingKind = response.appointment.bookingKind ?? response.appointment.booking_kind;
  return {...visit,...(bookingKind ? {bookingKind} : {})};
}

export function intakeFieldsError(v, reason) {
  if (!v || typeof v !== 'object' || Array.isArray(v)
    || typeof v.weight !== 'number' || !Number.isFinite(v.weight) || v.weight < 0.05 || v.weight > 120
    || typeof v.temp !== 'number' || !Number.isFinite(v.temp) || v.temp < TEMP_MIN || v.temp > TEMP_MAX) return `Record a valid measured weight (0.05–120 kg) and temperature (${TEMP_MIN}–${TEMP_MAX}°C).`;
  const measurementError=vitalValueError(v.weight,'weight') || vitalValueError(v.temp,'temp');
  if(measurementError) return measurementError;
  if (v.triageLevel !== undefined && !['Routine','Priority','Emergency'].includes(v.triageLevel)) return 'Choose Routine, Priority or Emergency triage.';
  if (v.fasted !== undefined && typeof v.fasted !== 'boolean') return 'Fasted must be Yes or No.';
  if (v.notes !== undefined && (typeof v.notes !== 'string' || v.notes.length > 2000)) return 'Intake notes cannot exceed 2,000 characters.';
  if (intakeReasonError(reason)) return intakeReasonError(reason);
  return null;
}
