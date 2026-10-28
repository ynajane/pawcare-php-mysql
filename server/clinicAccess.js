import { ensureAppointmentStatusSchema } from './database/appointmentStatusSchema.js';
import { checkInDateError, intakeFieldsError } from '../src/intakeVisit.js';
import { clinicClock, minutes, validDate } from './scheduling.js';
import { query } from './db.js';

const fail = (res, status, error) => res.status(status).json({ error });
export const assignedTo = (appointment, user) => [user.vetId, user.id].filter(Boolean).includes(appointment.vet_id);

// Fail closed: adding an endpoint requires choosing its role and record boundary.
export async function clinicAccess(req, res, next) {
  const { role } = req.user;
  const path = req.path.replace(/\/$/, '') || '/';
  const key = `${req.method} ${path}`;
  if (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body))) return fail(res, 400, 'Invalid request body.');
  req.body ||= {};
  Object.assign(req.body, { actorName: req.user.name, actorRole: role, userName: req.user.name, userRole: role, recordedBy: req.user.name });
  const allow = (...roles) => roles.includes(role);
  const denied = () => fail(res, 403, 'Your role cannot perform this action.');
  const petAccess = async id => {
    const result = await query('SELECT id, owner_id FROM pets WHERE id = $1', [id]);
    const pet = result.rows[0];
    return pet && (role !== 'owner' || pet.owner_id === req.user.ownerId);
  };
  const selectDoctor = async id => {
    if (typeof id !== 'string' || !id) return null;
    const row = (await query("SELECT id, vet_id FROM users WHERE role = 'vet' AND COALESCE(to_jsonb(users)->>'is_active', 'true') <> 'false' AND (vet_id = $1 OR id = $1)", [id])).rows[0];
    return row ? row.vet_id || row.id : null;
  };
  const appointment = async id => (await query('SELECT * FROM appointments WHERE id = $1', [id])).rows[0];
  try {
    await ensureAppointmentStatusSchema();
    if(path==='/clinic-letterhead')return req.method==='GET' && allow('owner','vet','assistant','admin')?next():denied();
    if(path==='/clinic-document-profile')return (['GET','PUT'].includes(req.method) && allow('admin'))?next():denied();
    if(/^\/pets\/[^/]+\/vet-card(?:\/pdf)?$/.test(path))return req.method==='GET' && allow('owner','vet','assistant','admin')?next():denied();
    if (key === 'GET /admissions/eligible') return allow('vet') ? next() : denied();
    if (path === '/admissions' || /^\/admissions\/[^/]+(?:\/(update|consent|discharge|release|order|stop-medication|medication|correct-medication|discharge-summary))?$/.test(path)) {
      if (req.method === 'GET' && ! /\/(update|consent|discharge|release|order|stop-medication|medication|correct-medication)$/.test(path)) return allow('owner','vet','assistant','admin') ? next() : denied();
      if (req.method === 'POST') return ((/\/(release|consent)$/.test(path)) ? allow('assistant') : path === '/admissions' || /\/(discharge|order|stop-medication|correct-medication)$/.test(path) ? allow('vet') : /\/(update|medication)$/.test(path) && allow('vet','assistant')) ? next() : denied();
      return denied();
    }
    if (path === '/clinical/note-options') {
      return (req.method === 'GET' && allow('vet','admin') || req.method === 'PUT' && allow('admin')) ? next() : denied();
    }
    if (req.method === 'PUT' && /^\/pets\/[^/]+\/allergies$/.test(path)) return allow('assistant', 'vet') ? next() : denied();
    if (req.method === 'PUT' && /^\/(?:owners|pets)\/[^/]+\/details$/.test(path)) return allow('assistant', 'admin') ? next() : denied();
    if (/^\/admin\/catalog(?:\/[^/]+)?$/.test(path)) return ((req.method === 'GET' || req.method === 'POST' || req.method === 'PUT') && allow('admin')) ? next() : denied();
    if ((req.method === 'GET' && ['/admin/staff','/admin/staff/email-availability','/admin/audit'].includes(path)) || (req.method === 'POST' && /^\/admin\/(?:staff\/[^/]+\/access|invitations\/[^/]+\/revoke)$/.test(path)) || (req.method === 'PUT' && /^\/admin\/staff\/[^/]+$/.test(path))) return allow('admin') ? next() : denied();
    if (path === '/checkout-inbox' && req.method === 'GET' || /^\/checkout-inbox\/[^/]+\/(claim|renew|release)$/.test(path) && req.method === 'POST') return allow('assistant') ? next() : denied();
    if (key === 'GET /reminders/calls') return allow('assistant', 'admin') ? next() : denied();
    if (key === 'GET /reminders/status') return allow('assistant', 'admin') ? next() : denied();
    if (key === 'GET /appointments/availability') return allow('owner', 'assistant') ? next() : denied();
    if (['GET /state','GET /state/summary','GET /state/history'].includes(key) || key === 'GET /services/prices') return next();
    if (/^\/owners\/[^/]+\/account-link\/(review|confirm)$/.test(path)) return req.method==='POST' && allow('assistant') ? next() : denied();
    if (key === 'GET /logs') return allow('admin') ? next() : denied();
    // Account edits use the validated, session-scoped account router.
    if (key === 'POST /owner/contact') return fail(res, 410, 'Use account profile settings to update your contact details.');
    if (key === 'POST /owner/pets') return fail(res, 410, 'Submit a pet registration request for clinic review.');
    if (/^\/pets\/[^/]+\/reference-history$/.test(path)) return req.method==='PUT' && allow('owner') ? next() : denied();
    if (key === 'POST /pet-requests') {
      if (!allow('owner')) return denied();
      req.body.ownerId = req.user.ownerId;
      return next();
    }
    if (/^\/appointments\/[^/]+\/handoff$/.test(path) && req.method === 'POST') return allow('vet') ? next() : denied();
    let match;
    if ((match = path.match(/^\/pet-requests\/([^/]+)(?:\/(approve|decline))?$/))) {
      if (!((['DELETE','PUT'].includes(req.method) && !match[2] && allow('owner')) || (req.method === 'POST' && match[2] && allow('assistant')))) return denied();
      const row = (await query('SELECT * FROM pet_requests WHERE id = $1', [decodeURIComponent(match[1])])).rows[0];
      if (!row || (role === 'owner' && row.owner_id !== req.user.ownerId)) return fail(res, 404, 'Pet request not found.');
      if (row.status === 'Approved' || (match[2] && row.status !== 'Pending')) return fail(res, 409, 'This request has already been processed.');
      return next();
    }
    if (/^\/pets\/[^/]+\/vitals(?:\/[^/]+\/correct)?$/.test(path)) return (req.method==='GET' && allow('owner','vet','assistant','admin') || req.method==='POST' && path.endsWith('/correct') && allow('vet','assistant')) ? next() : denied();
    if (key === 'POST /walk-in') {
      if (!allow('assistant')) return denied();
      if (req.body.addToQueue) {
        req.body.vetId = await selectDoctor(req.body.vetId);
        if (!req.body.vetId) return fail(res, 400, 'Choose a current veterinarian for the arrival.');
      }
      return next();
    }
    if (key === 'POST /owners' || key === 'POST /pets') return allow('assistant') ? fail(res, 410, 'Use reviewed in-clinic registration to create an owner or patient.') : denied();
    if (key === 'POST /vaccinations') return allow('vet') ? fail(res, 410, 'Certify administered vaccines through the assigned visit’s SOAP finalization.') : denied();
    if ((match = path.match(/^\/(?:owner\/)?pets\/([^/]+)\/(photo|weights)$/)) && req.method === 'POST') {
      if (!allow(...(match[2] === 'weights' ? ['assistant','vet'] : ['owner', 'assistant']))) return denied();
      const id = decodeURIComponent(match[1]);
      let permitted = await petAccess(id);
      if (!permitted && match[2] === 'photo') {
        const row = (await query('SELECT owner_id FROM pet_requests WHERE id = $1 OR pet_id = $1', [id])).rows[0];
        permitted = row && (role !== 'owner' || row.owner_id === req.user.ownerId);
      }
      return permitted ? next() : fail(res, 404, 'Pet not found.');
    }
    if (key === 'POST /appointments') {
      if (!allow('owner', 'assistant')) return denied();
      if (!await petAccess(req.body.petId)) return fail(res, 404, 'Pet not found.');
      req.body.vetId = await selectDoctor(req.body.vetId);
      if (!req.body.vetId) return fail(res, 400, 'Choose a current veterinarian.');
      // Owners choose a service, never a price.
      if (role === 'owner') delete req.body.amount;
      return next();
    }
    if ((match = path.match(/^\/appointments\/([^/]+)\/close$/))) {
      if (req.method !== 'POST' || !allow('vet', 'admin')) return denied();
      const row = await appointment(decodeURIComponent(match[1]));
      if (!row) return fail(res, 404, 'Appointment not found.');
      if (role === 'vet' && !assignedTo(row, req.user)) return denied();
      return next();
    }
    if ((match = path.match(/^\/appointments\/([^/]+)(?:\/(status|billing))?$/))) {
      const action = match[2];
      const roles = action === 'billing' && req.method === 'POST' ? ['assistant'] : action === 'status' && req.method === 'PATCH' ? ['owner', 'assistant', 'vet'] : !action && req.method === 'PUT' ? ['owner', 'assistant'] : [];
      if (!allow(...roles)) return denied();
      const row = await appointment(decodeURIComponent(match[1]));
      if (!row || (role === 'owner' && !await petAccess(row.pet_id))) return fail(res, 404, 'Appointment not found.');
      if (role === 'vet' && !assignedTo(row, req.user)) return denied();
      if (!action) {
        if (!['Pending Approval', 'Scheduled'].includes(row.status)) return fail(res, 409, 'Only upcoming appointments can be edited.');
        if (req.body.petId && !await petAccess(req.body.petId)) return fail(res, 404, 'Pet not found.');
        if (req.body.status && !['Pending Approval', 'Scheduled'].includes(req.body.status)) return fail(res, 403, 'Use the authorized visit workflow to change status.');
        if (req.body.vetId !== undefined) {
          req.body.vetId = await selectDoctor(req.body.vetId);
          if (!req.body.vetId) return fail(res, 400, 'Choose a current veterinarian.');
        }
        req.body.status = 'Pending Approval';
      }
      return next();
    }
    if (key === 'POST /consultations') {
      if (!allow('vet')) return denied();
      req.body.vetId = req.user.vetId || req.user.id;
      const rows = await query("SELECT * FROM appointments WHERE pet_id = $1 AND vet_id = ANY($2::varchar[]) AND status IN ('Checked-in', 'In consultation')", [req.body.petId, [req.user.vetId, req.user.id].filter(Boolean)]);
      if (!rows.rows.some(a => key !== 'POST /consultations' || a.id === req.body.apptId)) return fail(res, 403, 'An assigned active visit is required.');
      return next();
    }
    if ((match = path.match(/^\/vaccinations\/([^/]+)$/)) && req.method === 'DELETE') {
      if (!allow('assistant')) return denied();
      const row = (await query('SELECT done FROM vaccinations WHERE id = $1', [decodeURIComponent(match[1])])).rows[0];
      if (!row) return fail(res, 404, 'Vaccination not found.');
      if (row.done) return fail(res, 403, 'Administered vaccination records cannot be deleted.');
      return next();
    }
    if (req.method === 'POST' && ['/reminders/send', '/reminders/log-call'].includes(path)) return allow('assistant') ? next() : denied();
    return denied();
  } catch (error) {
    console.error('Clinic authorization failed:', error.message);
    return fail(res, 500, 'Unable to check access. Please try again.');
  }
}

export function validateStatusChange(row, body, user) {
  const transitions = {
    'Pending Approval': ['Scheduled', 'Cancelled', 'Rejected'],
    Scheduled: ['Checked-in', 'Cancelled', 'No-show'],
    'Checked-in': ['In consultation'],
  };
  const allowed = { owner: ['Cancelled'], assistant: ['Scheduled', 'Checked-in', 'Cancelled', 'Rejected', 'No-show'], vet: ['Checked-in','In consultation'] };
  const remeasure=['assistant','vet'].includes(user.role)&&['Checked-in','In consultation'].includes(row.status)&&body.status===row.status&&body.intakeVitals!==undefined;
  if (!remeasure && !(allowed[user.role] || []).includes(body.status)) return 'Your role cannot set this visit status.';
  if (!remeasure && !(transitions[row.status] || []).includes(body.status)) return 'The visit has changed. Refresh and use its current next action.';
  if (user.role === 'vet' && !assignedTo(row, user)) return 'This visit is assigned to another veterinarian.';
  if (body.date !== undefined || body.time !== undefined) return 'Use rescheduling to change the appointment date or time.';
  if (body.billingStatus !== undefined) return 'Billing changes require the checkout workflow.';
  if (!['assistant','vet'].includes(user.role) && ['intakeVitals','reason'].some(k=>body[k]!==undefined)) return 'Only authorized clinical staff can record intake.';
  if (body.reason !== undefined && (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500)) return 'Enter a visit reason of no more than 500 characters.';
  if (body.intakeVitals !== undefined && !['Checked-in','In consultation'].includes(body.status)) return 'Vitals must be recorded during check-in.';
  if (body.status === 'Checked-in' || body.intakeVitals !== undefined) {
    const dateError = checkInDateError(row, clinicClock().date);
    if (dateError) return dateError;
    const error = intakeFieldsError(body.intakeVitals, body.reason === undefined ? row.reason : body.reason);
    if (error) return error;
  }
  if (['Cancelled','Rejected'].includes(body.status) && (typeof body.cancelReason !== 'string' || !body.cancelReason.trim() || body.cancelReason.length > 500)) return 'Enter a cancellation or rejection reason of no more than 500 characters.';
  if (['Cancelled','Rejected'].includes(body.status) && (body.cancelReason.match(/\p{L}/gu) || []).length < 5) return 'Describe the cancellation or rejection reason in words.';
  if (body.cancelReason !== undefined && !['Cancelled','Rejected'].includes(body.status)) return 'Reasons belong to cancelled or rejected visits.';
  if (body.status === 'No-show') {
    const now = clinicClock();
    if (!validDate(row.date) || !Number.isFinite(minutes(row.time))) return 'Correct the saved appointment date and time before marking a no-show.';
    if (row.date > now.date || (row.date === now.date && minutes(row.time) > minutes(now.time))) return 'A visit cannot be marked no-show before its scheduled date and time in Manila.';
  }
  return null;
}
