import { after, beforeEach, mock, test } from 'node:test';
import { confirmedConsultation } from '../../src/consultationSave.js';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { sha256 } from '../security.js';
import { applyClinicState, emptyClinicState } from '../../src/clinicState.js';

let db, calls, failSql, rollbacks;
const roles = ['owner', 'assistant', 'vet', 'admin'];
const users = Object.fromEntries(roles.map(role => [sha256(`session-${role}`), { id: `u_${role}`, role, first_name: 'Synthetic', last_name: role, owner_id: 'o1', vet_id: role === 'vet' ? 'v1' : null, mobile_verified: true, email_verified_at: '2026-10-24' }]));
const fakeQuery = async (sql, params = []) => {
  sql = sql.replace(/\s+/g, ' ').trim();
  calls.push({ sql, params });
  if (failSql && failSql.test(sql)) throw Error('synthetic database failure');
  const rows = value => ({ rows: structuredClone(value), rowCount: value.length });
  // Duplicate-prevention lookups: one pet per owner, one open visit per pet, one payment reference per invoice, one dose per pet per day.
  if (sql.startsWith('SELECT id, owner_id, name, species, birth FROM pets WHERE owner_id = $1')) return rows(db.pets.filter(p => p.owner_id === params[0]));
  if (sql.startsWith('SELECT id, date, status FROM appointments WHERE pet_id=$1 AND id<>$2')) return rows(db.appts.filter(a => a.pet_id === params[0] && a.id !== params[1] && ['Checked-in', 'In consultation'].includes(a.status)));
  if (sql.includes("billing_status = 'Paid' AND LOWER(TRIM(payment_details->>'reference'))")) return rows([]);
  if (sql.startsWith('SELECT id FROM vaccinations WHERE pet_id = $1 AND done AND LOWER(vaccine)')) return rows(db.vaccs.filter(v => v.pet_id === params[0] && v.done && String(v.vaccine).toLowerCase() === String(params[1]).toLowerCase() && String(v.date).slice(0, 10) === String(params[2]).slice(0, 10)));
  if (sql.includes('FROM sessions s')) return rows(users[params[0]] ? [users[params[0]]] : []);
  if(sql==="SELECT version FROM pawcare_schema_migrations WHERE version='patient-reference-history-v1'")return rows([{version:'patient-reference-history-v1'}]);
  if(sql==="SELECT version FROM pawcare_schema_migrations WHERE version='digital-vet-card-v1'")return rows([{version:'digital-vet-card-v1'}]);
  if(sql==="SELECT version FROM pawcare_schema_migrations WHERE version='vaccination-card-fields-v1'")return rows([{version:'vaccination-card-fields-v1'}]);
  if (sql==="SELECT version FROM pawcare_schema_migrations WHERE version='owner-pet-onboarding-v1'") return rows([{version:'owner-pet-onboarding-v1'}]);
  if (sql.startsWith('SELECT *,submission_payload=')) return rows([]);
  if (sql==='SELECT owner_id FROM pets WHERE id=$1') return rows(db.pets.filter(p=>p.id===params[0]));
  if (sql==='SELECT registration_status FROM pets WHERE id=$1') return rows(db.pets.filter(p=>p.id===params[0]).map(p=>({registration_status:p.registration_status || 'Verified'})));
  if (sql==="SELECT id FROM pets WHERE id=$1 AND registration_status<>'Verified'") return rows(db.pets.filter(p=>p.id===params[0] && p.registration_status && p.registration_status!=='Verified'));
  if (sql.startsWith('SELECT to_regclass')) return rows([]);
  if (sql.startsWith('-- Add document publication') || sql.startsWith('-- Preserve source records') || sql.startsWith('-- Add audit metadata') || sql.startsWith('-- Rename legacy states') || sql.startsWith('-- Preserve owner-submitted') || sql.startsWith('-- Durable reception') || sql.startsWith('-- Idempotent migration') || sql.startsWith('SELECT pg_advisory_xact_lock')) return rows([]);
  if (sql.startsWith("SELECT version FROM pawcare_schema_migrations WHERE version='admission-care-v1'")) return rows([{version:'admission-care-v1'}]);
  if (sql.startsWith('-- Admission is separate') || sql.startsWith('-- Extend existing stays')) return rows([]);
  if (sql.startsWith('SELECT id,appt_id,status FROM admissions WHERE appt_id')) return rows((db.admissions || []).filter(row => params[0].includes(row.appt_id)));
  if (sql.includes('FROM admissions WHERE appt_id') || sql.includes('FROM admission_updates e JOIN admissions')) return rows([]);
  if (sql.startsWith('ALTER TABLE')) return rows([]);
  if(sql==='SELECT * FROM clinic_document_profile WHERE id=true')return rows([]);
  if(sql==='SELECT * FROM pets WHERE id=$1 FOR UPDATE')return rows(db.pets.filter(p=>p.id===params[0]));
  if(sql.startsWith('SELECT name,address,phone,email FROM owners'))return rows(db.owners.filter(o=>o.id===params[0]));
  if(sql.startsWith("SELECT id,vet_id,first_name,last_name FROM users WHERE role='vet'"))return rows([{id:'u_vet',vet_id:'v1',first_name:'Synthetic',last_name:'Vet'}]);
  if(sql.startsWith('SELECT * FROM vaccinations WHERE pet_id=$1 AND done=true'))return rows(db.vaccs.filter(v=>v.pet_id===params[0] && v.done));
  if(sql.startsWith('SELECT m.* FROM vital_measurements'))return rows([]);
  if(sql.startsWith('INSERT INTO digital_vet_cards')){
    const old=db.cards.find(c=>c.pet_id===params[0]);
    if(old?.content_hash===params[1])return rows([]);
    const row={pet_id:params[0],document_reference:'DVC-'+params[0],revision:(old?.revision || 0)+1,issued_at:'2026-10-24T00:00:00Z',refreshed_at:'2026-10-24T00:00:00Z',content_hash:params[1],snapshot:JSON.parse(params[2])};
    db.cards=db.cards.filter(c=>c.pet_id!==params[0]);db.cards.push(row);return rows([row]);
  }
  if(sql.startsWith('SELECT * FROM digital_vet_cards WHERE pet_id='))return rows(db.cards.filter(c=>c.pet_id===params[0]));

  if(sql.startsWith('UPDATE vaccinations SET appt_id='))return rows([]);
  if (sql.startsWith('SELECT')) {
    if (sql.startsWith('SELECT id FROM owners WHERE id = $1')) return rows(db.owners.filter(o=>o.id===params[0]));
    if (sql.startsWith('SELECT name FROM pets WHERE owner_id')) return rows(db.pets.filter(p=>p.owner_id===params[0]));
    if (sql.startsWith('SELECT name,status FROM pet_requests')) return rows(db.requests.filter(r=>r.owner_id===params[0] && r.status!=='Approved' && r.id!==params[1]));
    if (sql.startsWith("SELECT id, vet_id FROM users")) return rows(['v1', 'u_vet'].includes(params[0]) ? [{ id: 'u_vet', vet_id: 'v1' }] : []);
    if (sql.includes("FROM users WHERE role = 'vet'")) return rows([{ id: 'u_vet', vet_id: 'v1', first_name: 'Synthetic', last_name: 'Vet' }]);
    if (sql.includes('FROM owners o')) {
      if (params.length) assert.match(sql, /WHERE o\./);
      return rows(params.length ? db.owners.filter(o => params[0] === o.id || Array.isArray(params[0]) && db.appts.some(a => params[0].includes(a.vet_id) && db.pets.some(p => p.id === a.pet_id && p.owner_id === o.id))) : db.owners);
    }
    if (sql.includes('FROM pets WHERE id = $1')) return rows(db.pets.filter(p => p.id === params[0] && (!sql.includes('AND owner_id') || p.owner_id === params[1])));
    if (sql.includes('FROM pet_requests WHERE id = $1')) return rows(db.requests.filter(r => r.id === params[0] || sql.includes('OR pet_id') && r.pet_id === params[0]));
    if (sql.includes('FROM appointments WHERE id = $1')) return rows(db.appts.filter(a => a.id === params[0]));
    if (sql.includes('FROM appointments WHERE date = $1')) return rows(db.appts.filter(a => a.date === params[0] && ((Array.isArray(params[1]) ? params[1].includes(a.vet_id) : a.vet_id === params[1]) || a.pet_id === params[2])));
    if (sql.includes('FROM appointments WHERE pet_id = $1')) return rows(db.appts.filter(a => a.pet_id === params[0] && params[1].includes(a.vet_id) && ['Checked-in', 'In consultation'].includes(a.status)));
    if (sql.includes('FROM checkout_tasks WHERE appointment_id')) return rows(db.tasks.filter(t=>t.appointment_id===params[0]));
    if (sql.includes('FROM consultations WHERE appt_id')) return rows(db.consults.filter(c => c.appt_id === params[0]));
    if (sql.includes('FROM vaccinations WHERE id')) return rows(db.vaccs.filter(v => v.id === params[0]));
    const scopedPet = id => !params.length || db.pets.some(p => p.id === id && (Array.isArray(params[0]) ? db.appts.some(a => a.pet_id === p.id && params[0].includes(a.vet_id)) : p.owner_id === params[0]));
    if (sql.startsWith('SELECT * FROM pets')) return rows(db.pets.filter(p => scopedPet(p.id)));
    if (sql.startsWith('SELECT * FROM pet_weights')) return rows([]);
    if (sql.startsWith('SELECT * FROM appointments')) return rows(db.appts.filter(a => Array.isArray(params[0]) ? params[0].includes(a.vet_id) : scopedPet(a.pet_id)));
    if (sql.startsWith('SELECT * FROM vaccinations')) return rows(db.vaccs.filter(v => scopedPet(v.pet_id)));
    if (sql.startsWith('SELECT * FROM consultations')) return rows(db.consults.filter(c => scopedPet(c.pet_id)));
    if (sql.startsWith('SELECT * FROM pet_requests')) return rows(db.requests.filter(r => !params.length || r.owner_id === params[0]));
    if (sql.startsWith('SELECT * FROM audit_logs')) return rows(db.logs);
  }
  if (sql.startsWith('INSERT INTO checkout_tasks')) { if (!db.tasks.some(t=>t.appointment_id===params[0])) db.tasks.push({appointment_id:params[0],status:'pending'}); return rows([]); }
  if (sql.startsWith('UPDATE checkout_tasks')) { const t=db.tasks.find(t=>t.appointment_id===params[0]);t.status='completed';t.completed_by=params[1];return rows([t]); }
  if (sql.startsWith('INSERT INTO audit_logs')) { const row = { user_name: params[0], user_role: params[1], action: params[2] }; db.logs.push(row); return rows([row]); }
  if (sql.startsWith('INSERT INTO appointments')) { const row = { id: params[0], pet_id: params[1], vet_id: params[2], date: params[3], time: params[4], reason: params[5], status: 'Pending Approval', amount: params[6], service:params[7],duration_minutes:params[8],booking_kind:params[9],notes:params[10],billing_status:'Unbilled' }; db.appts.push(row); return rows([row]); }
  if (sql.startsWith('INSERT INTO consultations')) { const row = Object.fromEntries(['id', 'pet_id', 'vet_id', 'appt_id', 'date', 'symptoms', 'objective', 'diagnosis', 'treatment', 'prescription'].map((k, i) => [k, params[i]])); db.consults.push(row); return rows([row]); }
  if (sql.startsWith('UPDATE consultations SET backdate_reason=')) {const row=db.consults.find(c=>c.id===params[0]);row.backdate_reason=params[1];return rows([row]);}
  if (sql.startsWith('UPDATE consultations SET care_status')) { const row = db.consults.find(c => c.id === params[3]); Object.assign(row, {care_status:params[0], follow_up_date:params[1], follow_up_reason:params[2]}); return rows([row]); }
  if (sql.startsWith('UPDATE consultations SET performed_services')) { const row = db.consults.find(c => c.id === params[1]); row.performed_services=JSON.parse(params[0]); return rows([row]); }
  if (sql.startsWith('UPDATE consultations SET prescription_items')) { const row = db.consults.find(c => c.id === params[1]); row.prescription_items=JSON.parse(params[0]); return rows([row]); }
  if (sql.startsWith('INSERT INTO vaccinations')) { const row = { id: params[0], pet_id: params[1], card_id: params[2], vaccine: params[3], brand: params[4], batch: params[5], done: true, vet_id: params[9], recorded_by: params[10] }; db.vaccs.push(row); return rows([row]); }
  if (sql.startsWith('INSERT INTO pets(id,owner_id,name')) { const row=Object.fromEntries(['id','owner_id','name','species','species_other','breed','sex','birth','weight','color','neutered','notes','photo','dental_occlusion'].map((k,i)=>[k,params[i]]));row.registration_status='Pending';db.pets.push(row);return rows([row]); }
  if (sql.startsWith('UPDATE pet_requests SET prior_vaccines=')) {const row=db.requests.find(r=>r.id===params[0]);Object.assign(row,{prior_vaccines:JSON.parse(params[1]),external_clinic_notes:params[2]});return rows([row]);}
  if (sql.startsWith('UPDATE pet_requests SET pet_id=')) {const r=db.requests.find(r=>r.id===params[0]);r.pet_id=params[1];return rows([]);}
  if (sql.startsWith('UPDATE pet_requests SET submission_payload=')) {db.requests.find(r=>r.id===params[0]).submission_payload=JSON.parse(params[1]);return rows([]);}
  if (sql.startsWith('UPDATE owners SET first_pet_registered_at=')) {db.owners.find(o=>o.id===params[0]).first_pet_registered_at='2026-10-25T00:00:00Z';return rows([]);}
  if (sql.startsWith('INSERT INTO pet_requests')) { const row = { id: params[12], owner_id: params[13], name: params[0], status: 'Pending',revision:0 }; db.requests.push(row); return rows([row]); }
  if (sql.startsWith('UPDATE appointments')) {
    if (sql.startsWith("UPDATE appointments SET status='Scheduled',approved_at")) {
      const row=db.appts.find(a=>a.id===params[0]);Object.assign(row,{status:'Scheduled',approved_at:new Date().toISOString(),approved_by:params[1],approved_by_user_id:params[2],reason:params[3]});return rows([row]);
    }
    if (sql.startsWith('UPDATE appointments SET approved_at=NULL')) {
      const row=db.appts.find(a=>a.id===params[0]);Object.assign(row,{approved_at:null,approved_by:null,approved_by_user_id:null});return rows([row]);
    }
    if (sql.startsWith('UPDATE appointments SET date=$2,time=$3')) {
      const row=db.appts.find(a=>a.id===params[0]);Object.assign(row,{date:params[1],time:params[2],status:'Pending Approval',approved_at:null,approved_by:null,approved_by_user_id:null});return rows([row]);
    }
    if (sql.startsWith('UPDATE appointments SET pet_id=$2')) {
      const row=db.appts.find(a=>a.id===params[0]);
      for(const [i,key] of ['id','pet_id','vet_id','date','time','reason','amount','service','duration_minutes','booking_kind','notes','status'].entries())row[key]=params[i];
      return rows([row]);
    }
    if (sql.includes("status = 'Completed'")) { const row = db.appts.find(a => a.id === params[0]); row.status = 'Completed'; row.billing_status = 'Unpaid'; if(params[1]) row.invoice_items=JSON.parse(params[1]); return rows([row]); }
    if (sql.includes('paid_at')) { const row = db.appts.find(a => a.id === params[4]); Object.assign(row, { amount: params[0], payment_method: params[1], invoice_items: JSON.parse(params[2]), payment_details: JSON.parse(params[3]), billing_status: 'Paid', paid_at:'2026-10-24T10:30:00Z' }); return rows([row]); }
    const row = db.appts.find(a => a.id === params.at(-1));
    if(sql.includes("booking_kind = 'walk-in'"))row.booking_kind='walk-in';
    row.status = params[0];
    for (const field of ['intake_vitals','cancel_reason','reason','date','time']) {
      const position=sql.match(new RegExp(`${field} = \\$([0-9]+)`));
      if(position)row[field]=field==='intake_vitals' ? JSON.parse(params[Number(position[1])-1]) : params[Number(position[1])-1];
    }
    return rows([row]);
  }
  if (sql.startsWith('UPDATE pets') || sql.startsWith('INSERT INTO pet_weights') || sql.startsWith('DELETE FROM vaccinations')) return rows([]);
  throw Error(`Unexpected query: ${sql}`);
};
mock.module('../db.js', { namedExports: { query: fakeQuery, withTransaction: async cb => { const snapshot = structuredClone(db); try { return await cb({ query: fakeQuery }); } catch (error) { db = snapshot; rollbacks++; throw error; } } } });
mock.module('../services.js', { namedExports: { serverOutbox: [], sendMail: async () => { throw Error('Unexpected email'); }, sendSms: async () => { throw Error('Unexpected SMS'); } } });
const { clinicRouter } = await import('../routes/clinic.js');
const { clinicClock, shiftDate } = await import('../scheduling.js');
const { holidayName } = await import('../../src/booking.js');
const futureDate = () => { let d = shiftDate(clinicClock().date,1); while (holidayName(d)) d=shiftDate(d,1); return d; };
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use('/api', clinicRouter);
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
after(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  calls = []; failSql = null; rollbacks = 0;
  db = { owners: [{ id: 'o1', name: 'Own owner' }, { id: 'o2', name: 'Other owner' }], pets: [{ id: 'p1', owner_id: 'o1', name: 'Own pet', weight: 5, vaccination_card_id: 'VACC-SYNTHETIC' }, { id: 'p2', owner_id: 'o2', name: 'Other pet', weight: 7 }], appts: [{ id: 'a1', pet_id: 'p1', vet_id: 'v1', date: clinicClock().date, time: '09:00', reason:'Examination', status: 'Pending Approval', amount: 600, billing_status: 'Unbilled' }, { id: 'a2', pet_id: 'p2', vet_id: 'v2', date: clinicClock().date, time: '10:00', status: 'Pending Approval' }], requests: [{ id: 'r1', owner_id: 'o1', name:'Request One', status: 'Pending',revision:0 }, { id: 'r2', owner_id: 'o2', name:'Request Two',status: 'Pending',revision:0 }], consults: [], vaccs: [], logs: [], tasks: [], cards: [] };
});
const request = async (role, method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: `Bearer session-${role}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, data: await res.json() };
};
const endpoints = [['GET','/admin/staff'],['GET','/admin/audit'],['POST','/admin/staff/u_vet/access'],['POST','/admin/invitations/inv1/revoke'],['GET', '/checkout-inbox'], ['POST', '/checkout-inbox/a1/claim'], ['POST', '/checkout-inbox/a1/renew'], ['POST', '/checkout-inbox/a1/release'], ['GET', '/appointments/availability'], ['GET', '/reminders/status'], ['GET','/reminders/calls'], ['GET', '/state'], ['GET', '/logs'], ['GET', '/services/prices'], ['POST', '/owners'], ['POST', '/pets'], ['POST', '/owner/contact'], ['POST', '/owner/pets'], ['POST', '/pets/p1/weights'], ['POST', '/pets/p1/photo'], ['POST', '/owner/pets/p1/photo'], ['POST', '/pet-requests'], ['PUT', '/pet-requests/r1'], ['DELETE', '/pet-requests/r1'], ['POST', '/pet-requests/r1/approve'], ['POST', '/pet-requests/r1/decline'], ['POST', '/appointments'], ['PUT', '/appointments/a1'], ['PATCH', '/appointments/a1/status'], ['DELETE', '/appointments/a1'], ['POST', '/appointments/a1/billing'], ['POST', '/walk-in'], ['POST', '/vaccinations'], ['DELETE', '/vaccinations/v1'], ['POST', '/consultations'], ['POST', '/logs'], ['POST', '/reminders/send'], ['POST', '/reminders/log-call']];
endpoints.push(['GET','/admissions/00000000-0000-0000-0000-000000000000/discharge-summary'],['GET','/admissions'],['GET','/admissions/eligible'],['GET','/admissions/00000000-0000-0000-0000-000000000000'],['POST','/admissions'],['POST','/admissions/00000000-0000-0000-0000-000000000000/update'],['POST','/admissions/00000000-0000-0000-0000-000000000000/discharge']);
for(const action of ['release','order','stop-medication','medication','correct-medication']) endpoints.push(['POST',`/admissions/00000000-0000-0000-0000-000000000000/${action}`]);
test('all clinic endpoints reject anonymous access before any database query', async () => {
  for (const [method, path] of endpoints) assert.equal((await request(null, method, path, method === 'GET' ? undefined : {})).status, 401, path);
  assert.equal(calls.length, 0);
});
test('expired and unverified sessions cannot load clinic data', async () => {
  assert.equal((await request('expired', 'GET', '/state')).status, 401);
  const user = users[sha256('session-owner')]; user.mobile_verified = false;
  try { assert.equal((await request('owner', 'GET', '/state')).status, 403); } finally { user.mobile_verified = true; }
});
for (const role of roles) test(`${role} state uses the proper record scope and audit visibility`, async () => {
  const { status, data } = await request(role, 'GET', '/state'); assert.equal(status, 200);
  const scoped = ['owner', 'vet'].includes(role);
  assert.deepEqual(data.data.pets.map(p => p.id), scoped ? ['p1'] : ['p1', 'p2']);
  assert.deepEqual(data.data.appts.map(a => a.id), scoped ? ['a1'] : ['a1', 'a2']);
  const apptQuery = calls.find(c => c.sql.startsWith('SELECT * FROM appointments'));
  if (scoped) { assert.match(apptQuery.sql, /WHERE/); assert.ok(apptQuery.params.length); }
  assert.equal(calls.some(c => c.sql.startsWith('SELECT * FROM audit_logs')), role === 'admin');
  assert.deepEqual(data.data.log, []);
});
test('state links the exact admission to its visit without exposing another scoped visit',async () => {
  db.admissions = [{id:'stay-one',appt_id:'a1',status:'Ready for discharge'},{id:'stay-two',appt_id:'a2',status:'Discharged'}];
  for (const role of roles) {
    const result = await request(role,'GET','/state');
    assert.equal(result.status,200);
    const own = result.data.data.appts.find(a => a.id === 'a1');
    assert.equal(own.admissionId,'stay-one');
    assert.equal(own.admissionStatus,'Ready for discharge');
    assert.equal(JSON.stringify(result.data).includes('stay-two'),['assistant','admin'].includes(role));
  }
});
for (const role of roles) test(`${role} cannot spoof actorRole to gain another role's privileges`, async () => {
  const forbidden = role === 'admin' ? endpoints.filter(([m,path]) => m !== 'GET' && !path.startsWith('/admin/')) : role === 'owner' ? [['POST', '/consultations'], ['POST', '/appointments/a1/billing'], ['POST', '/walk-in'], ['POST', '/logs'], ['POST', '/pet-requests/r1/approve']] : role === 'assistant' ? [['POST', '/consultations'], ['POST', '/vaccinations'], ['GET', '/logs'], ['POST', '/logs']] : [['POST', '/appointments'], ['PUT', '/appointments/a1'], ['POST', '/appointments/a1/billing'], ['POST', '/walk-in'], ['POST', '/pet-requests/r1/approve'], ['GET', '/logs']];
  for (const [method, path] of forbidden) {
    const result = await request(role, method, path, method === 'GET' ? undefined : { actorRole: 'admin', actorName: 'Forged', petId: 'p1', status: 'Completed' });
    assert.ok([403, 410].includes(result.status), `${method} ${path}: ${result.status}`);
  }
  assert.equal(calls.some(c => /^(INSERT|UPDATE|DELETE) /.test(c.sql)), false);
});
test('doctors cannot manage bookings even for assigned patients or by spoofing reception', async () => {
  const before = structuredClone(db);
  for (const [method, path] of [
    ['GET', '/appointments/availability'], ['POST', '/appointments'],
    ['PUT', '/appointments/a1'], ['DELETE', '/appointments/a1'], ['POST', '/walk-in'],
  ]) {
    const body = method === 'GET' ? undefined : { actorRole: 'assistant', petId: 'p1', vetId: 'v1', date: futureDate(), time: '11:00' };
    assert.equal((await request('vet', method, path, body)).status, 403, `${method} ${path}`);
  }
  for (const status of ['Scheduled', 'Checked-in', 'Cancelled', 'Rejected', 'No-show']) {
    assert.equal((await request('vet', 'PATCH', '/appointments/a1/status', { actorRole: 'assistant', status })).status, 409, status);
  }
  assert.deepEqual(db, before);
  assert.equal(calls.some(c => /^(INSERT|UPDATE|DELETE) /.test(c.sql)), false);
});
test('owner cannot read or mutate another owner through IDs, pet photos or requests', async () => {
  for (const [method, path, body] of [['POST', '/appointments', { petId: 'p2' }], ['PUT', '/appointments/a2', {}], ['PATCH', '/appointments/a2/status', { status: 'Cancelled' }], ['POST', '/pets/p2/photo', { photo: '' }], ['DELETE', '/pet-requests/r2', {}]]) assert.equal((await request('owner', method, path, body)).status, 404, path);
  assert.equal(calls.some(c => /^(INSERT|UPDATE|DELETE) /.test(c.sql)), false);
});
test('owner registration request uses session identity, ignoring supplied owner and actor IDs', async () => {
  const result = await request('owner', 'POST', '/pet-requests', { ownerId: 'o2', actorName: 'Forged', actorRole: 'admin', name: 'New pet', species: 'Cat', birth: '2025-01-01',sex:'Female',weight:4,neutered:'Not sure' });
  assert.equal(result.status, 200); assert.equal(result.data.request.owner_id, 'o1');
  assert.equal(db.logs.at(-1).user_name, 'Synthetic owner'); assert.equal(db.logs.at(-1).user_role, 'owner');
});
test('owner booking cannot set invoice pricing or overwrite existing ID through upsert', async () => {
  const result = await request('owner', 'POST', '/appointments', { id: 'new', petId: 'p1', vetId: 'v1', date: futureDate(), time: '10:00', reason: 'Visit', amount: -99 });
  assert.equal(result.status, 200); assert.equal(result.data.appointment.amount, 600);
  assert.doesNotMatch(calls.find(c => c.sql.startsWith('INSERT INTO appointments')).sql, /ON CONFLICT/);
});
test('owner can cancel own upcoming visit but cannot inject vitals, billing or completion', async () => {
  assert.equal((await request('owner', 'PATCH', '/appointments/a1/status', { status: 'Completed' })).status, 409);
  assert.equal((await request('owner', 'PATCH', '/appointments/a1/status', { status: 'Cancelled', intakeVitals: {} })).status, 409);
  assert.equal((await request('owner', 'PATCH', '/appointments/a1/status', { status: 'Cancelled', billingStatus: 'Paid' })).status, 409);
  assert.equal((await request('owner', 'PATCH', '/appointments/a1/status', { status: 'Cancelled', cancelReason: 'Schedule conflict' })).status, 200);
  assert.equal(db.appts[0].status, 'Cancelled');
});
test('assistant check-in persists reason and measured vitals without the previous ReferenceError', async () => {
  db.appts[0].status = 'Scheduled';
  const result = await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', reason: 'Exam', intakeVitals: { weight: 5.1, temp: 38.6 }, actorName: 'Forged', actorRole: 'vet' });
  assert.equal(result.status, 200); assert.equal(db.appts[0].status, 'Checked-in'); assert.equal(db.appts[0].intake_vitals.weight, 5.1);
  const update = calls.find(c => c.sql.startsWith('UPDATE appointments')); assert.match(update.sql, /reason =/); assert.ok(update.params.includes('Exam'));
  assert.equal(db.logs.at(-1).user_role, 'assistant'); assert.equal(db.logs.at(-1).user_name, 'Synthetic assistant');
});
test('initial check-in requires the saved Manila day and cannot rewrite a reserved slot', async () => {
  const body = {status:'Checked-in',intakeVitals:{weight:5.2,temp:38.6}};
  for (const status of ['Scheduled']) {
    for (const offset of [-1,1]) {
      Object.assign(db.appts[0],{status,date:shiftDate(clinicClock().date,offset)});
      const before=structuredClone(db);
      for (const override of [{},{date:clinicClock().date,time:clinicClock().time}]) {
        calls=[];
        const result=await request('assistant','PATCH','/appointments/a1/status',{...body,...override});
        assert.equal(result.status,409);
        assert.match(result.data.error,/scheduled day|rescheduling/);
        assert.deepEqual(db,before);
        assert.ok(!calls.some(c=>/^(UPDATE|INSERT|DELETE) /.test(c.sql)));
      }
    }
  }
  Object.assign(db.appts[0],{status:'Scheduled',date:clinicClock().date,booking_kind:'scheduled'});
  for (const override of [{date:clinicClock().date},{time:'12:00'}]) {
    assert.equal((await request('assistant','PATCH','/appointments/a1/status',{...body,...override})).status,409);
  }
  const original=structuredClone(db.appts[0]);
  assert.equal((await request('assistant','PATCH','/appointments/a1/status',body)).status,200);
  assert.equal(db.appts[0].date,original.date);
  assert.equal(db.appts[0].time,original.time);
  assert.equal(db.appts[0].booking_kind,original.booking_kind);
});
test('already checked-in patients retain prior-day intake and ongoing care', async () => {
  Object.assign(db.appts[0],{status:'Checked-in',date:shiftDate(clinicClock().date,-1)});
  const original=structuredClone(db.appts[0]);
  assert.equal((await request('assistant','PATCH','/appointments/a1/status',{status:'Checked-in',intakeVitals:{weight:5.4,temp:38.4}})).status,200);
  assert.equal(db.appts[0].date,original.date);assert.equal(db.appts[0].time,original.time);
  assert.equal((await request('vet','PATCH','/appointments/a1/status',{status:'In consultation'})).status,200);
});
test('initial arrival follows the Manila day across UTC midnight boundaries', async (t) => {
  db.appts[0].status = 'Scheduled';
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-24T16:05:00Z')});
  db.appts[0].date='2026-10-24';
  const body={status:'Checked-in',intakeVitals:{weight:5,temp:38.5}};
  assert.equal((await request('assistant','PATCH','/appointments/a1/status',body)).status,409);
  db.appts[0].date='2026-10-25';
  assert.equal((await request('assistant','PATCH','/appointments/a1/status',body)).status,200);
});
test('check-in rejects missing/nonfinite/out-of-range vitals and invalid state transitions', async () => {
  for (const intakeVitals of [undefined, {}, { weight: 0, temp: 38 }, { weight: 5, temp: 100 }, { weight: '5', temp: 38 }]) assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', intakeVitals })).status, 409);
  db.appts[0].status = 'Completed';
  assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', intakeVitals: { weight: 5, temp: 38.5 } })).status, 409);
  assert.equal(calls.some(c => c.sql.startsWith('UPDATE appointments')), false);
});
test('failed check-in rolls back and returns failure', async () => {
  db.appts[0].status = 'Scheduled';
  failSql = /^UPDATE appointments/;
  assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', intakeVitals: { weight: 5, temp: 38.5 } })).status, 500);
  assert.equal(db.appts[0].status, 'Scheduled'); assert.equal(rollbacks, 1);
});
test('only assigned doctor starts consultation; no direct completion bypass', async () => {
  db.appts[0].status = 'Checked-in'; db.appts[1].status = 'Checked-in';
  assert.equal((await request('vet', 'PATCH', '/appointments/a2/status', { status: 'In consultation' })).status, 403);
  assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'In consultation' })).status, 409);
  assert.equal((await request('vet', 'PATCH', '/appointments/a1/status', { status: 'In consultation' })).status, 200);
  assert.equal((await request('vet', 'PATCH', '/appointments/a1/status', { status: 'Completed' })).status, 409);
});
const soap = () => ({ id: 'c1', petId: 'p1', apptId: 'a1', vetId: 'spoofed', date: clinicClock().date, symptoms: 'Complaint', objective: 'Exam', diagnosis: 'Assessment', treatment: 'Plan', prescription: '', vaccination: { id: 'v-new', vaccine: 'Anti-rabies', brand: 'Synthetic brand', batch: 'SYNTHETIC', nextDue: shiftDate(clinicClock().date,365), intervalDays:365, scheduleApproved:true, doseNo:1, doseOf:1 } });
test('SOAP requires clinical fields and an assigned encounter', async () => {
  db.appts[0].status = 'In consultation';
  assert.equal((await request('vet', 'POST', '/consultations', { ...soap(), diagnosis: '' })).status, 400);
  assert.equal((await request('vet', 'POST', '/consultations', { ...soap(), petId: 'p2', apptId: 'a2' })).status, 403);
  assert.equal((await request('vet', 'POST', '/consultations', { ...soap(), vaccination: { ...soap().vaccination, batch: '' } })).status, 400);
  assert.equal(db.consults.length, 0);
});
test('finalization commits notes, vaccine, doctor identity and Completed together', async () => {
  db.appts[0].status = 'In consultation';
  const result = await request('vet', 'POST', '/consultations', soap());
  assert.equal(result.status, 200); assert.equal(db.consults[0].vet_id, 'v1'); assert.equal(db.vaccs[0].vet_id, 'v1'); assert.equal(db.vaccs[0].card_id, 'VACC-SYNTHETIC'); assert.equal(db.appts[0].status, 'Completed'); assert.equal(db.logs.at(-1).user_role, 'vet');
});
// External prescriptions (bought at a pharmacy) are free text: accepted empty, as typed, or beside clinic products.
const externalNote = 'Amoxicillin 250 mg - buy at any pharmacy; give 1 capsule twice daily for 7 days';
for (const [label, note] of [['empty', ''], ['typed text', externalNote]]) test(`external prescription note is accepted when ${label}`, async () => {
  db.appts[0].status = 'In consultation';
  const result = await request('vet', 'POST', '/consultations', { ...soap(), vaccination: undefined, prescription: note });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(db.consults[0].prescription, note); assert.equal(result.data.consultation.prescription, note); assert.deepEqual(result.data.prescriptionItems, []);
  // The browser applies its own confirmation to the server reply; it must accept it too (no 'server did not confirm').
  const sent = { ...soap(), vaccination: null, prescription: note, prescriptionItems: [], vetId: 'v1' };
  assert.doesNotThrow(() => confirmedConsultation(result.data, sent));
});
test('external prescription note is kept beside a clinic product prescription', async () => {
  db.appts[0].status = 'In consultation';
  const items = [{ catalogId: 'product_multivitamin', quantity: 1, instructions: 'Give 1 mL daily with food for 7 days' }];
  const result = await request('vet', 'POST', '/consultations', { ...soap(), vaccination: undefined, prescription: externalNote, prescriptionItems: items });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.match(db.consults[0].prescription, /Give 1 mL daily/); assert.ok(db.consults[0].prescription.endsWith(externalNote));
});
test('an over-long external prescription note is refused with a clear message', async () => {
  db.appts[0].status = 'In consultation';
  const result = await request('vet', 'POST', '/consultations', { ...soap(), vaccination: undefined, prescription: 'x'.repeat(3001) });
  assert.equal(result.status, 400); assert.equal(db.consults.length, 0);
});
for (const failure of [/INSERT INTO vaccinations/, /SET status = 'Completed'/, /INSERT INTO audit_logs/]) test(`finalization rolls back every clinical write on ${failure}`, async () => {
  db.appts[0].status = 'In consultation'; failSql = failure;
  assert.equal((await request('vet', 'POST', '/consultations', soap())).status, 500);
  assert.equal(db.consults.length, 0); assert.equal(db.vaccs.length, 0); assert.equal(db.appts[0].status, 'In consultation'); assert.equal(rollbacks, 1);
});
const bill = () => ({ amount: 500, discount: 0, billingStatus: 'Paid', paymentMethod: 'Cash', cashTendered: 500, invoiceItems: [{ catalogId: 'srv_consult', name: 'Routine General Consultation & Exam', price: 500, qty: 1 }] });
test('billing rejects invalid amount, quantity, discount, channel, cash and reference', async () => {
  for (const body of [{ ...bill(), amount: -1 }, { ...bill(), amount:500.001 }, { ...bill(), cashTendered:500.001 }, { ...bill(), discount: -50 }, { ...bill(), discount: 50 }, { ...bill(), paymentMethod: 'Invalid' }, { ...bill(), cashTendered: 100 }, { ...bill(), paymentMethod: 'Maya' }, { ...bill(), invoiceItems: [{ name: 'Bad', price: 600, qty: 0.5 }] }]) assert.equal((await request('assistant', 'POST', '/appointments/a1/billing', body)).status, 400);
  assert.equal(calls.some(c => c.sql.startsWith('UPDATE appointments')), false);
});
test('checkout rejects direct non-retail additions and accepts shampoo with recorded service', async()=>{
  db.appts[0].status='Completed';db.consults.push({id:'c1',appt_id:'a1',performed_services:bill().invoiceItems});
  const product=(await request('assistant','GET','/services/prices')).data.catalog;
  // Dental scaling and dental products are no longer offered, so they never appear in the price list at all.
  assert.ok(!product.some(p=>/dental/i.test(`${p.id} ${p.name} ${p.category}`)),'dental items are not offered');
  for(const id of ['srv_chem','product_multivitamin','product_gi_diet']) {
    const p=product.find(p=>p.id===id),extra={catalogId:p.id,name:p.name,price:p.price,qty:1};
    const result=await request('assistant','POST','/appointments/a1/billing',{...bill(),amount:500+p.price,cashTendered:500+p.price,invoiceItems:[...bill().invoiceItems,extra]});
    assert.equal(result.status,400,id);assert.match(result.data.error,/Only shampoo and accessories/);
  }
  const p=product.find(p=>p.id==='product_oatmeal_shampoo');
  const accepted=await request('assistant','POST','/appointments/a1/billing',{...bill(),amount:850,cashTendered:1000,invoiceItems:[...bill().invoiceItems,{catalogId:p.id,name:p.name,price:p.price,qty:1}]});
  assert.equal(accepted.status,200);assert.equal(accepted.data.appointment.discount,0);assert.equal(accepted.data.appointment.changeAmount,150);
});
test('billing requires a completed clinical record and rejects repeat payment', async () => {
  assert.equal((await request('assistant', 'POST', '/appointments/a1/billing', bill())).status, 409);
  db.appts[0].status = 'Completed';
  assert.equal((await request('assistant', 'POST', '/appointments/a1/billing', bill())).status, 409);
  db.consults.push({ id: 'c1', appt_id: 'a1', performed_services: bill().invoiceItems });
  const result = await request('assistant', 'POST', '/appointments/a1/billing', bill());
  assert.equal(result.status, 200); assert.equal(result.data.appointment.discount, 0); assert.equal(result.data.appointment.changeAmount, 0); assert.equal(db.appts[0].billing_status, 'Paid');
  assert.equal((await request('assistant', 'POST', '/appointments/a1/billing', bill())).status, 409);
});
test('database access failure fails closed instead of authorizing a mutation', async () => {
  failSql = /SELECT id, owner_id FROM pets/;
  assert.equal((await request('owner', 'POST', '/appointments', { petId: 'p1' })).status, 500);
  assert.equal(calls.some(c => c.sql.startsWith('INSERT')), false);
});

test('assistant may remeasure vitals while waiting, without reopening a completed visit', async () => {
  db.appts[0].status = 'Checked-in';
  assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', intakeVitals: { weight: 5.3, temp: 38.5 } })).status, 200);
  assert.equal(db.appts[0].intake_vitals.weight, 5.3);
  db.appts[0].status = 'In consultation';
  assert.equal((await request('assistant', 'PATCH', '/appointments/a1/status', { status: 'Checked-in', intakeVitals: { weight: 5.3, temp: 38.5 } })).status, 409);
});

test('booking and walk-in reject nonexistent doctors instead of creating invisible queues', async () => {
  assert.equal((await request('owner', 'POST', '/appointments', { petId: 'p1', vetId: 'not-a-doctor' })).status, 400);
  assert.equal((await request('assistant', 'POST', '/walk-in', { addToQueue: true, vetId: 'not-a-doctor' })).status, 400);
  assert.equal(calls.some(c => c.sql.startsWith('INSERT')), false);
});

test('checkout rolls back payment if its durable audit write fails', async () => {
  db.appts[0].status = 'Completed'; db.consults.push({ id: 'c1', appt_id: 'a1', performed_services: bill().invoiceItems });
  failSql = /INSERT INTO audit_logs/;
  assert.equal((await request('assistant', 'POST', '/appointments/a1/billing', bill())).status, 500);
  assert.equal(db.appts[0].billing_status, 'Unbilled'); assert.equal(rollbacks, 1);
});

test('availability reveals only open slot strings and accounts for another owner reservation', async () => {
  const date=futureDate();
  db.appts.push({id:'other-reservation',pet_id:'p2',vet_id:'v1',date,time:'10:00',duration_minutes:120,status:'Pending Approval'});
  const r=await request('owner','GET',`/appointments/availability?vetId=v1&date=${date}&service=checkup`);
  assert.equal(r.status,200); assert.deepEqual(Object.keys(r.data),['slots']);
  assert.ok(r.data.slots.every(s=>/^\d{2}:\d{2}$/.test(s))); assert.ok(!r.data.slots.includes('11:30')); assert.ok(r.data.slots.includes('12:00'));
});
test('availability excludes only the caller own appointment',async()=>{
  assert.equal((await request('owner','GET',`/appointments/availability?vetId=v1&date=${futureDate()}&service=checkup&excludeId=a2`)).status,404);
});
test('server rejects invalid booking dates, slot grids and conflicting durations',async()=>{
  for (const patch of [{date:'2026-02-30'},{date:'2099-01-01'},{time:'10:15'},{time:'16:30'},{service:'invalid'}]) {
    const r=await request('owner','POST','/appointments',{petId:'p1',vetId:'v1',date:futureDate(),time:'10:00',reason:'Annual checkup',...patch});
    assert.equal(r.status,400,JSON.stringify(patch));
  }
  db.appts.push({id:'other',pet_id:'p2',vet_id:'v1',date:futureDate(),time:'09:30',duration_minutes:120,status:'Pending Approval'});
  assert.equal((await request('owner','POST','/appointments',{petId:'p1',vetId:'v1',date:futureDate(),time:'10:30',reason:'Checkup'})).status,409);
});
test('owners cannot bypass reservation validation by calling a booking a walk-in',async()=>{
  assert.equal((await request('owner','POST','/appointments',{petId:'p1',vetId:'v1',bookingKind:'walk-in',date:'2000-01-01',time:'10:15',reason:'Checkup'})).status,400);
});
test('only reception and administrators can inspect automatic reminder status',async()=>{
  for (const role of ['owner','vet']) assert.equal((await request(role,'GET','/reminders/status')).status,403);
  for (const role of ['vet','admin']) assert.equal((await request(role,'GET',`/appointments/availability?vetId=v1&date=${futureDate()}&service=checkup`)).status,403);
});


test('checkout inbox and claims are reception-only, including spoofed role fields',async()=>{
 for(const role of ['owner','vet','admin']) {
  assert.equal((await request(role,'GET','/checkout-inbox')).status,403);
  for(const action of ['claim','renew','release'])assert.equal((await request(role,'POST',`/checkout-inbox/a1/${action}`,{actorRole:'assistant'})).status,403);
 }
});

test('call history is restricted to reception and administrative oversight',async()=>{
 for(const role of ['owner','vet']) assert.equal((await request(role,'GET','/reminders/calls?petId=p1')).status,403);
});

test('state tags never bypass session checks or current role scope', async () => {
  const url = `http://127.0.0.1:${server.address().port}/api/state`;
  const load = (role, etag) => fetch(url, {headers:{...(role ? {Cookie:`sid=session-${role}`} : {}), ...(etag ? {'If-None-Match':etag} : {})}});
  const first = await load('admin');assert.equal(first.status,200);const etag=first.headers.get('etag');await first.json();
  const same=await load('admin',etag);assert.equal(same.status,304);assert.equal(await same.text(),'');
  assert.equal((await load(null,etag)).status,401);
  const owner=await load('owner',etag);assert.equal(owner.status,200);assert.notEqual(owner.headers.get('etag'),etag);
  assert.deepEqual((await owner.json()).data.pets.map(p=>p.id),['p1']);
  db.appts[0].status='Checked-in';const changed=await load('admin',etag);assert.equal(changed.status,200);
  assert.equal((await changed.json()).data.appts[0].status,'Checked-in');
});


test('reception reschedules date/time while retaining the assigned doctor and original request', async () => {
  const date=futureDate();Object.assign(db.appts[0],{vet_id:'v1',date,status:'Scheduled',service:'checkup',duration_minutes:60,notes:'Call owner before visit'});
  const before=structuredClone(db.appts[0]);
  const reassignment=await request('assistant','PUT','/appointments/a1',{petId:'p1',vetId:'u_vet',date,time:'11:00',service:'grooming',reason:'Changed reason',notes:before.notes});
  assert.equal(reassignment.status,400);assert.deepEqual(db.appts[0],before);
  const result=await request('assistant','PUT','/appointments/a1',{date,time:'11:00'});
  assert.equal(result.status,200);assert.equal(result.data.appointment.id,'a1');assert.equal(result.data.appointment.vetId,'v1');
  assert.equal(result.data.appointment.reason,before.reason);assert.equal(result.data.appointment.service,'checkup');
  assert.equal(result.data.appointment.status,'Pending Approval');assert.equal(result.data.appointment.notes,'Call owner before visit');
  const owner=await request('owner','GET','/state');assert.equal(owner.data.data.appts.find(a=>a.id==='a1').vetId,'v1');
  db.appts[0].status='Checked-in';
  assert.equal((await request('assistant','PUT','/appointments/a1',{time:'12:00'})).status,409);
});

test('one visit connects owner booking, reception intake, assigned vet care, checkout and admin audit', async (t) => {
  const date=futureDate(),id='connected-visit';
  const booking=await request('owner','POST','/appointments',{id,petId:'p1',vetId:'v1',date,time:'11:00',service:'checkup',reason:'Owner reports appetite change',notes:'Call before visit'});
  assert.equal(booking.status,200);assert.equal(booking.data.appointment.id,id);assert.equal(booking.data.appointment.status,'Pending Approval');
  const state=async role=>{const result=await request(role,'GET','/state');assert.equal(result.status,200);return applyClinicState(emptyClinicState(),result.data.data);};
  const visit=(data)=>data.appts.find(a=>a.id===id);
  assert.equal(visit(await state('assistant')).notes,'Call before visit');
  assert.equal((await request('assistant','PATCH',`/appointments/${id}/status`,{status:'Scheduled'})).status,200);
  assert.equal(visit(await state('owner')).status,'Scheduled');
  t.mock.timers.enable({apis:['Date'],now:new Date(`${date}T11:00:00+08:00`)});
  assert.equal((await request('assistant','PATCH',`/appointments/${id}/status`,{status:'Checked-in',intakeVitals:{weight:5.2,temp:38.6,triageLevel:'Priority'},reason:'Measured intake complaint'})).status,200);
  const queued=visit(await state('vet'));assert.equal(queued.status,'Checked-in');assert.equal(queued.date,clinicClock().date);assert.equal(queued.intakeVitals.weight,5.2);assert.equal(queued.reason,'Measured intake complaint');
  assert.equal((await request('vet','PATCH',`/appointments/${id}/status`,{status:'In consultation'})).status,200);
  const clinical={...soap(),id:'connected-notes',apptId:id,date:clinicClock().date,vaccination:undefined,performedServices:['srv_consult']};
  assert.equal((await request('vet','POST','/consultations',clinical)).status,200);
  assert.equal(visit(await state('assistant')).status,'Completed');
  assert.equal(db.tasks.find(t=>t.appointment_id===id).status,'pending');
  const payment=await request('assistant','POST',`/appointments/${id}/billing`,bill());assert.equal(payment.status,200);
  const owner=await state('owner'),saved=owner.records.find(r=>r.apptId===id);
  assert.equal(saved.id,'connected-notes');assert.equal(saved.diagnosis,clinical.diagnosis);assert.equal(saved.vetId,'v1');
  assert.equal(visit(owner).billingStatus,'Paid');assert.equal(visit(owner).amount,500);assert.equal(visit(owner).paidAt,'2026-10-24T10:30:00Z');
  assert.equal(db.tasks.find(t=>t.appointment_id===id).status,'completed');
  const admin=await state('admin');assert.equal(visit(admin).billingStatus,'Paid');
  for(const role of ['owner','assistant','vet'])assert.ok(admin.log.some(l=>l.role===role),role+' audit retained');
  assert.ok(!owner.appts.some(a=>a.petId==='p2'));assert.deepEqual(owner.log,[]);
});

test('obsolete registration and vaccine writes are retired without mutations',async()=>{
 for(const [role,path,body]of [['assistant','/owners',{name:''}],['assistant','/pets',{ownerId:'o1',name:'',weight:-5}],['vet','/vaccinations',{petId:'p1',done:true,date:'2099-01-01',doseNo:-2}]]){
  calls=[];const before=structuredClone(db);
  assert.equal((await request(role,'POST',path,body)).status,410);
  assert.deepEqual(db,before);assert.ok(!calls.some(c=>/^(INSERT|UPDATE|DELETE) /.test(c.sql)));
 }
});

test('no-show waits until the saved Manila time, accepts legacy times and fails closed on missing time', async t => {
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-24T01:00:00Z')});
 const {validateStatusChange}=await import('../clinicAccess.js');
 const row={status:'Scheduled',date:'2026-10-24',time:'09:01'};
 const body={status:'No-show'},user={role:'assistant'};
 assert.match(validateStatusChange(row,body,user),/before/);
 for(const time of ['09:00','9:00 AM','08:59'])assert.equal(validateStatusChange({...row,time},body,user),null);
 for(const time of ['9:01 AM','12:00 PM'])assert.match(validateStatusChange({...row,time},body,user),/before/);
 for(const time of ['',null,'25:00'])assert.match(validateStatusChange({...row,time},body,user),/Correct/);
});
