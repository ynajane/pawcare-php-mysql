import { readFileSync } from 'node:fs';
import { query } from './db.js';
import { approveRegistration } from './approveRegistration.js';
import { lockRegistrationOwner, registrationError } from './petRegistration.js';
import { assertAvailable, minutes, inferBookingService, clinicClock } from './scheduling.js';
import { sameIntakeVisit, approvalExpiredError } from '../src/intakeVisit.js';
import { validateStatusChange } from './clinicAccess.js';
import { requestedVaccineReason } from './vaccineBooking.js';
import { vaccineIdFromReason } from '../src/vaccineBooking.js';

let ready;
export function ensureAppointmentApprovalSchema() {
  return ready ||= (async () => {
    const exists = (await query("SELECT to_regclass(format('%I.pawcare_schema_migrations', current_schema())) AS migrations")).rows[0]?.migrations;
    if (!exists || !(await query("SELECT version FROM pawcare_schema_migrations WHERE version='appointment-approval-v1'")).rows.length)
      await query(readFileSync(new URL('./database/appointment-approval.sql', import.meta.url), 'utf8'));
  })().catch(error => { ready = undefined; throw error; });
}

// Caller holds the schedule lock and appointment row lock inside one transaction.
export async function approveAppointment(client, current, body, user) {
  if (user.role !== 'assistant') throw registrationError('Only assistants can approve appointment requests.',409);
  // A retry of an acknowledged-lost approval returns its saved result without any writes.
  const replay = current.status === 'Scheduled' && !!current.approved_at;
  const baseline = replay ? {...current,status:'Pending Approval'} : current;
  // State uses normalized 24-hour times; legacy database times may include AM/PM.
  const start = minutes(baseline.time);
  const normalized = {...baseline,time:Number.isFinite(start) ? `${String(Math.floor(start/60)).padStart(2,'0')}:${String(start%60).padStart(2,'0')}` : baseline.time};
  if (body.expectedVisit !== undefined && !sameIntakeVisit(normalized,body.expectedVisit))
    throw registrationError('This visit has changed. Refresh clinic records and reopen its current action.',409);
  const invalid = validateStatusChange(baseline,body,user);
  if (invalid) throw registrationError(invalid,409);
  const passed = !replay && approvalExpiredError(normalized,clinicClock());
  if (passed) throw registrationError(passed,409);
  if (replay) {
    let registration;
    if (body.expectedRegistration) {
      const request = (await client.query("SELECT * FROM pet_requests WHERE id = $1 AND pet_id=$2 AND status='Approved'",[body.expectedRegistration.id,current.pet_id])).rows[0];
      if (request) {
        const pet = (await client.query('SELECT * FROM pets WHERE id = $1',[current.pet_id])).rows[0];
        const vaccs = (await client.query('SELECT * FROM vaccinations WHERE pet_id=$1',[current.pet_id])).rows;
        registration = {request,pet,vaccs};
      }
    }
    return {appointment:current,...(registration ? {registration} : {})};
  }

  const patient = (await client.query('SELECT owner_id FROM pets WHERE id=$1',[current.pet_id])).rows[0];
  if (!patient) throw registrationError('Patient not found.',404);
  // Match registration edits/declines: lock owner before request and patient.
  await lockRegistrationOwner(client,patient.owner_id);
  const pet = (await client.query('SELECT * FROM pets WHERE id = $1 FOR UPDATE',[current.pet_id])).rows[0];
  if (!pet || pet.owner_id !== patient.owner_id) throw registrationError('This patient changed. Refresh before approving.',409);
  const reason = body.reason === undefined ? current.reason : body.reason.trim();
  if (body.reason !== undefined && inferBookingService(reason) === 'vaccination' && vaccineIdFromReason(reason))
    requestedVaccineReason({service:'vaccination',reason,species:pet.species});
  const doctor = (await client.query("SELECT id, vet_id FROM users WHERE role = 'vet' AND (id=$1 OR vet_id=$1) AND COALESCE(to_jsonb(users)->>'is_active','true') <> 'false'",[current.vet_id])).rows[0];
  if (!doctor) throw registrationError('The assigned veterinarian is inactive. Reassign this request before approval.',409);
  if (current.booking_kind !== 'walk-in') {
    const service = current.service || inferBookingService(current.reason);
    // Preserve the 30-minute occupancy contract for bookings without service metadata.
    await assertAvailable(client,{petId:current.pet_id,vetId:current.vet_id,date:current.date,time:normalized.time,service},current.id,current.duration_minutes || 30);
  }

  let registration;
  if (pet.registration_status && pet.registration_status !== 'Verified') {
    const requests = (await client.query('SELECT * FROM pet_requests WHERE pet_id=$1 FOR UPDATE',[pet.id])).rows;
    const request = requests[0];
    if (requests.length !== 1 || request.owner_id !== pet.owner_id || request.status !== 'Pending' || pet.registration_status !== 'Pending')
      throw registrationError('Correct and resubmit this pet registration before approving the visit.',409);
    if (body.expectedRegistration?.id !== request.id || body.expectedRegistration?.revision !== request.revision)
      throw registrationError('Review the latest linked pet registration before approving this appointment.',409);
    registration = await approveRegistration(client,request.id,user,body.expectedRegistration.revision);
  }
  const saved = (await client.query(`UPDATE appointments SET status='Scheduled',approved_at=clock_timestamp(),approved_by=$2,approved_by_user_id=$3,reason=$4 WHERE id=$1 RETURNING *`,[current.id,user.name,user.id,reason])).rows[0];
  await client.query('INSERT INTO audit_logs (user_name,user_role,action) VALUES ($1,$2,$3)',[user.name,user.role,`Approved appointment ${current.id}${registration ? ` and linked pet registration ${registration.request.id}` : ''}`]);
  return {appointment:saved,...(registration ? {registration} : {})};
}
