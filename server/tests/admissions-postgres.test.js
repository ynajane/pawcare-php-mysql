import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import express from 'express';
import cookieParser from 'cookie-parser';
import { intakeVisitSnapshot } from '../../src/intakeVisit.js';

if (!process.env.TEST_DATABASE_URL) throw Error('Set TEST_DATABASE_URL to a disposable local PostgreSQL database');
const url = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('Use a local disposable database.');
const admin = new pg.Pool({connectionString:url.href});
const schema = `test_admissions_${crypto.randomUUID().replaceAll('-','')}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options',`-c search_path=${schema},public`); process.env.DATABASE_URL = url.href;
const {query,pool} = await import('../db.js');
await query(readFileSync(new URL('../database/schema.sql',import.meta.url),'utf8'));
await query(readFileSync(new URL('../database/appointment-status.sql',import.meta.url),'utf8'));
const {sha256} = await import('../security.js');
const {clinicRouter} = await import('../routes/clinic.js');
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use('/api',clinicRouter);
const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
after(async () => { await new Promise(resolve => server.close(resolve)); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
for (const role of ['owner','other-owner','assistant','vet','other-vet','admin']) {
  const actual = role.replace('other-','');
  await query("INSERT INTO users(id,first_name,last_name,birthday,password_hash,email,role,owner_id,vet_id,mobile_number,email_verified_at,mobile_verified) VALUES($1,'Synthetic',$2,'1990-01-01','unused',$3,$4,$5,$6,'+639170000001',NOW(),true)",[`admission-${role}`,role,`${role}@example.invalid`,actual,actual==='owner'?role:null,actual==='vet'?role:null]);
  await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '2 days')",[sha256(`admission-${role}`),`admission-${role}`]);
}
await query("INSERT INTO owners(id,name,email,phone,address) VALUES('owner','Synthetic owner','owner@example.invalid','+639170000001','Synthetic address'),('other-owner','Other owner','other@example.invalid','+639170000002','Synthetic address')");
const call = async (role,method,path,body) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admissions${path}`,{method,headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer admission-${role}`}:{})},...(body ? {body:JSON.stringify(body)} : {})});
  return {status:response.status,data:await response.json()};
};
const fixture = async (status='In consultation', petId=crypto.randomUUID()) => {
  await query("INSERT INTO pets(id,owner_id,name,species,birth,weight) VALUES($1,'owner','Synthetic patient','Dog','2020-01-01',10) ON CONFLICT DO NOTHING",[petId]);
  const visit = (await query("INSERT INTO appointments(id,pet_id,vet_id,date,time,reason,status,intake_vitals) VALUES($1,$2,'vet','2026-10-25','09:00','Synthetic visit',$3,'{\"temp\":38.5,\"weight\":10}') RETURNING *",[crypto.randomUUID(),petId,status])).rows[0];
  if (status==='Completed') await query("INSERT INTO consultations(id,pet_id,vet_id,appt_id,date,symptoms,objective,diagnosis,treatment) VALUES($1,$2,'vet',$3,'2026-10-25','Recorded history','Recorded exam','Vet diagnosis','Vet treatment')",[crypto.randomUUID(),petId,visit.id]);
  return {visit,body:{requestId:crypto.randomUUID(),apptId:visit.id,expectedVisit:intakeVisitSnapshot(visit),clinicalNote:'Private admission reason',carePlan:'Private veterinarian care plan',ownerUpdate:'Your pet is staying for observation.',nextObservationAt:new Date(Date.now()+3600000).toISOString(),observationInstructions:'Private scheduled check',consentConfirmed:true,consentName:'Synthetic owner',consentMethod:'In person',emergencyName:'Synthetic contact',emergencyPhone:'+639170000001',emergencyRelationship:'Owner'}};
};
const admit = async status => {
  const f = await fixture(status); const response = await call('vet','POST','',f.body);
  assert.equal(response.status,200,JSON.stringify(response)); return {...f,admission:response.data.admission};
};
const update = (revision=0,extra={}) => ({requestId:crypto.randomUUID(),revision,clinicalNote:'Private staff observation',ownerUpdate:'Your pet has been checked by clinic staff.',measurements:{temp:38.6,weight:10.1},...extra});

test('admission creation enforces assigned veterinarian, active consultation, snapshot and one active stay',async () => {
  const f = await fixture();
  assert.equal((await call(null,'POST','',f.body)).status,401);
  for (const role of ['owner','other-owner','assistant','admin','other-vet']) assert.equal((await call(role,'POST','',f.body)).status,403,role);
  assert.equal((await call('vet','POST','',{...f.body,expectedVisit:{...f.body.expectedVisit,status:'Checked-in'}})).status,409);
  const first = await call('vet','POST','',f.body); assert.equal(first.status,200,JSON.stringify(first));
  assert.equal((await call('vet','POST','',f.body)).status,200,'create replay is confirmed');
  assert.equal((await call('vet','POST','',{...f.body,ownerUpdate:'Different text'})).status,409,'conflicting ID reuse rejected');
  assert.equal((await call('vet','POST','',{...f.body,requestId:crypto.randomUUID()})).status,409,'duplicate visit rejected');
  const other = await fixture('In consultation',f.visit.pet_id);
  assert.equal((await call('vet','POST','',other.body)).status,409,'duplicate active pet rejected across visits');
  const scheduled = await fixture('Pending Approval');
  assert.equal((await call('vet','POST','',scheduled.body)).status,409);
  const eligible = await call('vet','GET','/eligible'); assert.equal(eligible.status,200); assert.ok(!eligible.data.visits.some(row=>row.petId===f.visit.pet_id));
  assert.equal((await query('SELECT count(*)::int n FROM admission_updates WHERE admission_id=$1',[f.body.requestId])).rows[0].n,1);
});
test('owners see only their own shared updates; assistants cannot change clinical plans or discharge',async () => {
  const f = await admit(); const path = `/${f.admission.id}`;
  for (const role of ['owner','assistant','admin']) assert.equal((await call(role,'GET',path)).status,200,role);
  for (const role of ['owner','assistant','admin','other-owner']) assert.equal((await call(role,'GET','/eligible')).status,403,role);
  for (const role of ['other-owner','other-vet']) assert.equal((await call(role,'GET',path)).status,404,role);
  const foreign = await call('other-owner','GET',''); assert.equal(foreign.data.total,0);
  const privateNote = update(0,{ownerUpdate:'',clinicalNote:'Never send this internal note to the owner.'});
  assert.equal((await call('assistant','POST',`${path}/update`,privateNote)).status,200);
  for (const body of [update(1,{carePlan:'Spoofed plan'}),update(1,{dischargeInstructions:'Spoofed discharge'})]) assert.equal((await call('assistant','POST',`${path}/update`,body)).status,403);
  for (const role of ['assistant','owner','admin','other-vet']) assert.equal((await call(role,'POST',`${path}/discharge`,update(1,{dischargeInstructions:'Go home'}))).status,403,role);
  const shared = update(1,{clinicalNote:'Private temperature interpretation',ownerUpdate:'A clinic staff member checked your pet.'});
  assert.equal((await call('assistant','POST',`${path}/update`,shared)).status,200);
  const owner = await call('owner','GET',path);
  assert.equal(owner.data.updates.length,2,'private-only entry omitted');
  const serialized = JSON.stringify(owner.data);
  for (const secret of ['Private','Never send','clinicalNote','clinical_note','carePlan','measurements','request_payload','revision','ownerName']) assert.ok(!serialized.includes(secret),secret);
  const list = await call('owner','GET','');
  assert.ok(!JSON.stringify(list.data).includes('Private'));
  assert.equal((await call('vet','GET',path)).data.admission.carePlan,'Private veterinarian care plan');
});
test('revision conflicts, safe retries and audit failures cannot duplicate or partially save observations',async () => {
  const f = await admit(); const path = `/${f.admission.id}`;
  const bodies = [update(),update()];
  const results = await Promise.all(bodies.map(body=>call('assistant','POST',`${path}/update`,body)));
  assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);
  const winner = bodies[results.findIndex(row=>row.status===200)];
  assert.equal((await call('assistant','POST',`${path}/update`,winner)).status,200,'lost response retry is idempotent');
  assert.equal((await call('assistant','POST',`${path}/update`,{...winner,clinicalNote:'Different note'})).status,409);
  const changedPlan = update(1,{carePlan:'New vet monitoring instructions'});
  assert.equal((await call('vet','POST',`${path}/update`,changedPlan)).status,200);
  assert.equal((await call('vet','GET',path)).data.admission.carePlan,changedPlan.carePlan);
  await query("CREATE FUNCTION reject_admission_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'Updated admission%' THEN RAISE EXCEPTION 'Synthetic admission audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_admission_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_admission_audit()");
  try { assert.equal((await call('assistant','POST',`${path}/update`,update(2))).status,500); }
  finally { await query('DROP TRIGGER reject_admission_audit ON audit_logs'); }
  const after = (await call('vet','GET',path)).data;
  assert.equal(after.admission.revision,2); assert.equal(after.updates.length,3);
  for (const measurements of [{temp:NaN},{temp:50.1},{weight:-1},{weight:'10'},{condition:'Stable'},[]]) assert.equal((await call('assistant','POST',`${path}/update`,update(2,{measurements}))).status,400);
});
test('vet approval, saved payment and reception release are distinct; retries do not duplicate transitions',async () => {
  const unfinished = await admit();
  assert.equal((await call('vet','POST',`/${unfinished.admission.id}/discharge`,update(0,{dischargeInstructions:'Home care'}))).status,409);
  const f = await admit('Completed'), path = `/${f.admission.id}`;
  const body = update(0,{dischargeInstructions:'Follow the veterinarian’s home-care instructions.'});
  assert.equal((await call('vet','POST',`${path}/discharge`,body)).status,200);
  assert.equal((await call('vet','POST',`${path}/discharge`,body)).status,200,'discharge retry is idempotent');
  const result = (await call('owner','GET',path)).data;
  assert.equal(result.admission.status,'Ready for discharge'); assert.ok(result.admission.dischargeApprovedAt); assert.equal(result.admission.dischargedAt,null);
  assert.equal(result.admission.dischargeInstructions,body.dischargeInstructions);
  assert.ok(result.updates.some(row=>row.kind==='Discharge' && row.ownerUpdate.includes(body.dischargeInstructions)));
  assert.equal((await call('assistant','POST',`${path}/update`,update(1))).status,409);
  assert.equal((await call('vet','POST',`${path}/discharge`,update(1,{dischargeInstructions:'Second discharge'}))).status,409);
  assert.equal((await query('SELECT count(*)::int n FROM admission_updates WHERE admission_id=$1',[f.admission.id])).rows[0].n,2);
  const release=update(1,{ownerUpdate:'Your pet has been released to you.'});
  for (const role of ['owner','vet','admin','other-vet']) assert.equal((await call(role,'POST',`${path}/release`,release)).status,403);
  assert.equal((await call('assistant','POST',`${path}/release`,release)).status,409,'unpaid release blocked');
  const repeatBlocked=await fixture('In consultation',f.visit.pet_id);
  assert.equal((await call('vet','POST','',repeatBlocked.body)).status,409,'ready for discharge still occupies the active stay');
  await query("UPDATE appointments SET billing_status='Paid' WHERE id=$1",[f.visit.id]);
  assert.equal((await call('owner','GET',path)).data.admission.status,'Ready for discharge','payment alone does not release');
  assert.equal((await call('assistant','POST',`${path}/release`,release)).status,200);
  assert.equal((await call('assistant','POST',`${path}/release`,release)).status,200,'release retry is safe');
  const released=(await call('owner','GET',path)).data.admission; assert.equal(released.status,'Discharged'); assert.ok(released.dischargedAt);
  const stateResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/state`,{headers:{Authorization:'Bearer admission-assistant'}});
  assert.equal(stateResponse.status,200);
  const stateVisit = (await stateResponse.json()).data.appts.find(row=>row.id===f.visit.id);
  assert.equal(stateVisit.admissionId,f.admission.id,'receipt links to the exact saved admission');
  assert.equal(stateVisit.admissionStatus,'Discharged','refresh retains the confirmed release status');
  assert.ok((await call('owner','GET','?status=Discharged')).data.admissions.some(row=>row.id===f.admission.id));
  const repeat = await fixture('In consultation',f.visit.pet_id);
  assert.equal((await call('vet','POST','',repeat.body)).status,200,'a new visit can start a later stay');
});
test('timeline pagination preserves sub-millisecond ordering and filters private events before paging',async () => {
  const f = await admit(); const path = `/${f.admission.id}`;
  await query(`INSERT INTO admission_updates(id,admission_id,kind,clinical_note,owner_update,actor_id,actor_name,actor_role,request_payload,created_at)
    SELECT gen_random_uuid(),$1,'Observation','Internal note '||g,CASE WHEN g%2=0 THEN 'Shared message '||g ELSE '' END,'admission-assistant','Synthetic assistant','assistant','{}',TIMESTAMPTZ '2026-10-25 01:00:00+00'+g*INTERVAL '1 microsecond' FROM generate_series(1,130) g`,[f.admission.id]);
  for (const [role,total] of [['vet',131],['owner',66]]) {
    const ids = []; let cursor;
    do {
      const response = await call(role,'GET',`${path}${cursor ? `?before=${cursor}` : ''}`); assert.equal(response.status,200);
      ids.push(...response.data.updates.map(row=>row.id)); cursor=response.data.nextCursor;
    } while(cursor);
    assert.equal(ids.length,total); assert.equal(new Set(ids).size,total);
  }
  assert.equal((await call('owner','GET',`${path}?before=invalid`)).status,400);
});

test('a veterinarian with a signed consultation and admitted patient cannot be deactivated',async () => {
  await query("INSERT INTO users(id,first_name,last_name,birthday,password_hash,email,role,vet_id,mobile_number,email_verified_at,mobile_verified) VALUES('guard-vet','Synthetic','Guard','1990-01-01','unused','guard@example.invalid','vet','guard-vet','+639170000001',NOW(),true)");
  await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,'guard-vet',NOW()+INTERVAL '2 days')",[sha256('admission-guard-vet')]);
  const f = await fixture('Completed');
  await query("UPDATE appointments SET vet_id='guard-vet' WHERE id=$1",[f.visit.id]);
  f.body.expectedVisit.vetId='guard-vet';
  const admitted = await call('guard-vet','POST','',f.body); assert.equal(admitted.status,200,JSON.stringify(admitted));
  const access = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/staff/guard-vet/access`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer admission-admin'},body:JSON.stringify({action:'deactivate',revision:0,reasonCode:'security',reasonNote:'Synthetic access check'})});
    return {status:response.status,data:await response.json()};
  };
  const blocked = await access(); assert.equal(blocked.status,409,JSON.stringify(blocked)); assert.match(blocked.data.error,/admissions/);
  assert.equal((await query("SELECT is_active FROM users WHERE id='guard-vet'")).rows[0].is_active,true);
  assert.equal((await call('guard-vet','POST',`/${admitted.data.admission.id}/discharge`,update(0,{dischargeInstructions:'Vet-approved home-care instructions'}))).status,200);
  assert.equal((await access()).status,409,'approval alone does not complete physical care');
  await query("UPDATE appointments SET billing_status='Paid' WHERE id=$1",[f.visit.id]);
  assert.equal((await call('assistant','POST',`/${admitted.data.admission.id}/release`,update(1))).status,200);
  assert.equal((await access()).status,200,'deactivation allowed after paid release');
});

const medicineOrder = revision => ({...update(revision,{ownerUpdate:''}),medicine:'Synthetic medicine',dose:'1 vet-entered unit',route:'Vet-entered route',frequency:'Vet-entered schedule',instructions:'Private instructions',catalogId:'srv_nexgard',supplyLimit:2});
const medicineEvent = (revision,orderId,extra={}) => ({...update(revision,{ownerUpdate:''}),orderId,result:'Given',occurredAt:new Date().toISOString(),billableQuantity:1,...extra});
test('medicine orders and actual events enforce clinical roles, snapshots, privacy and safe retries',async()=>{
  const f=await admit(),path=`/${f.admission.id}`,body=medicineOrder(0);
  for(const role of ['owner','assistant','admin','other-vet'])assert.equal((await call(role,'POST',`${path}/order`,body)).status,403,role);
  assert.equal((await call('vet','POST',`${path}/order`,body)).status,200);
  assert.equal((await call('vet','POST',`${path}/order`,body)).status,200);
  assert.equal((await call('vet','POST',`${path}/order`,{...body,dose:'9 conflicting units'})).status,409);
  const event=medicineEvent(1,body.requestId.toUpperCase(),{dose:'Forged dose',medicine:'Forged medicine'});
  assert.equal((await call('owner','POST',`${path}/medication`,event)).status,403);
  assert.equal((await call('other-vet','POST',`${path}/medication`,event)).status,403);
  const given=await call('assistant','POST',`${path}/medication`,event);assert.equal(given.status,200,JSON.stringify(given));
  assert.equal((await call('assistant','POST',`${path}/medication`,event)).status,200,'same retry never gives or bills a second dose');
  const detail=(await call('vet','GET',path)).data;
  const saved=detail.updates.find(row=>row.id===event.requestId);assert.equal(saved.medication.dose,body.dose);assert.equal(saved.medication.medicine,body.medicine);assert.equal(saved.medication.result,'Given');
  assert.equal(detail.medicationOrders.length,1);assert.equal(detail.medicationOrders[0].ordered_by,'Synthetic vet');
  const owner=(await call('owner','GET',path)).data;assert.equal(owner.updates.length,1);assert.ok(!owner.medicationOrders);assert.ok(!JSON.stringify(owner).includes(body.medicine));
  for(const extra of [{result:'Missed',billableQuantity:1},{result:'Held',billableQuantity:1},{billableQuantity:0.5},{occurredAt:'2020-01-01T00:00:00Z'},{occurredAt:'2099-01-01T00:00:00Z'},{orderId:crypto.randomUUID()}])assert.ok([400,404].includes((await call('assistant','POST',`${path}/medication`,medicineEvent(2,body.requestId,extra))).status),JSON.stringify(extra));
  assert.equal((await call('assistant','POST',`${path}/medication`,medicineEvent(2,body.requestId,{result:'Held',billableQuantity:0,ownerUpdate:'The dose was held; the veterinarian is reviewing care.'}))).status,200);
  assert.ok((await call('owner','GET',path)).data.updates.some(row=>row.ownerUpdate.includes('held')));
});

test('concurrent doses respect the supply authorization; corrections preserve originals and restore unused allowance',async()=>{
  const f=await admit(),path=`/${f.admission.id}`,body={...medicineOrder(0),supplyLimit:1};
  assert.equal((await call('vet','POST',`${path}/order`,body)).status,200);
  const events=[medicineEvent(1,body.requestId),medicineEvent(1,body.requestId)];
  const results=await Promise.all(events.map(event=>call('assistant','POST',`${path}/medication`,event)));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.equal((await call('assistant','POST',`${path}/medication`,medicineEvent(2,body.requestId))).status,400,'cannot exceed vet authorization');
  const original=events[results.findIndex(r=>r.status===200)],correction=update(2,{eventId:original.requestId.toUpperCase(),clinicalNote:'Entry recorded for wrong time; marked in error.',ownerUpdate:''});
  assert.equal((await call('assistant','POST',`${path}/correct-medication`,correction)).status,403);
  assert.equal((await call('vet','POST',`${path}/correct-medication`,correction)).status,200);
  assert.equal((await call('vet','POST',`${path}/correct-medication`,correction)).status,200);
  const detail=(await call('vet','GET',path)).data;assert.equal(detail.updates.find(row=>row.id===original.requestId).voided,true);assert.ok(detail.updates.some(row=>row.kind==='Medication correction'));
  assert.equal((await query('SELECT count(*)::int n FROM admission_updates WHERE id=$1',[original.requestId])).rows[0].n,1,'original never deleted');
  assert.equal((await call('assistant','POST',`${path}/medication`,medicineEvent(3,body.requestId))).status,200,'corrected charge no longer consumes allowance');
  const stop=update(4,{orderId:body.requestId,ownerUpdate:''});assert.equal((await call('vet','POST',`${path}/stop-medication`,stop)).status,200);
  assert.equal((await call('assistant','POST',`${path}/medication`,medicineEvent(5,body.requestId,{billableQuantity:0}))).status,409,'stopped order rejects new entries');
});

test('medicine saves and corrections roll back with audit failures; shared corrections require an owner message',async()=>{
  const f=await admit(),path=`/${f.admission.id}`,order=medicineOrder(0);
  assert.equal((await call('vet','POST',`${path}/order`,order)).status,200);
  await query("CREATE TRIGGER reject_med_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_admission_audit()");
  const event=medicineEvent(1,order.requestId,{ownerUpdate:'The ordered medicine was given.'});
  try{assert.equal((await call('assistant','POST',`${path}/medication`,event)).status,500);}finally{await query('DROP TRIGGER reject_med_audit ON audit_logs');}
  assert.equal((await call('vet','GET',path)).data.admission.revision,1);
  assert.equal((await query('SELECT count(*)::int n FROM admission_updates WHERE id=$1',[event.requestId])).rows[0].n,0);
  assert.equal((await call('assistant','POST',`${path}/medication`,event)).status,200);
  assert.equal((await call('vet','POST',`${path}/correct-medication`,update(2,{eventId:event.requestId,ownerUpdate:''}))).status,400);
  assert.equal((await call('vet','POST',`${path}/correct-medication`,update(2,{eventId:event.requestId,ownerUpdate:'Correction: the earlier medicine entry was recorded in error.'}))).status,200);
  assert.ok((await call('owner','GET',path)).data.updates.some(row=>row.ownerUpdate.startsWith('Correction:')));
});

test('admission and checkout claims serialize; paid or already claimed visits cannot be admitted',async()=>{
 const apiCall=async(method,path,body)=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer admission-assistant'},body:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
 };
 const f=await fixture('Completed');
 const results=await Promise.all([call('vet','POST','',f.body),apiCall('POST',`/checkout-inbox/${f.visit.id}/claim`,{})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409],JSON.stringify(results));
 if(results[0].status===200)assert.equal((await apiCall('POST',`/checkout-inbox/${f.visit.id}/claim`,{})).status,409);
 else assert.equal((await call('vet','POST','',f.body)).status,409);
 const paid=await fixture('Completed');await query("UPDATE appointments SET billing_status='Paid' WHERE id=$1",[paid.visit.id]);
 assert.equal((await call('vet','POST','',paid.body)).status,409);
});

test('workflow migration preserves legacy discharges and can be applied repeatedly',async()=>{
 const f=await fixture('Completed'),legacy=`legacy_${crypto.randomUUID().replaceAll('-','')}`,client=await admin.connect();
 try{
  await client.query('BEGIN');await client.query(`CREATE SCHEMA ${legacy}`);await client.query(`SET LOCAL search_path=${legacy},${schema},public`);
  await client.query(readFileSync(new URL('../database/admissions.sql',import.meta.url),'utf8'));
  const id=crypto.randomUUID();
  await client.query("INSERT INTO admissions(id,pet_id,appt_id,reason,care_plan,status,discharged_at,discharge_instructions) VALUES($1,$2,$3,'Original reason','Original plan','Discharged','2026-10-24T10:00:00Z','Original instructions')",[id,f.visit.pet_id,f.visit.id]);
  const before=(await client.query('SELECT * FROM admissions WHERE id=$1',[id])).rows[0];
  for(let i=0;i<2;i++) {
    await client.query(readFileSync(new URL('../database/admission-workflow.sql',import.meta.url),'utf8'));
    await client.query(readFileSync(new URL('../database/admission-care.sql',import.meta.url),'utf8'));
  }
  const after=(await client.query('SELECT * FROM admissions WHERE id=$1',[id])).rows[0];
  for(const key of Object.keys(before))assert.deepEqual(after[key],before[key],key);
  assert.equal(after.discharge_approved_at,null,'no fabricated historic approval time');
  assert.equal(after.consent,null);assert.equal(after.next_observation_at,null);assert.equal(after.observation_completed_at,null);
 }finally{await client.query('ROLLBACK');client.release();}
});

test('consent and timed observation tasks are vet-set and consent is staff-recorded, versioned, completed once and owner-isolated',async()=>{
  const f=await fixture();
  for(const extra of [{consentConfirmed:false},{consentName:42},{nextObservationAt:'2099-02-30T12:00:00Z'},{emergencyPhone:'123'},{nextObservationAt:'2000-01-01T12:00:00Z'},{observationInstructions:''}])assert.equal((await call('vet','POST','',{...f.body,...extra})).status,400);
  const created=await call('vet','POST','',f.body);assert.equal(created.status,200,JSON.stringify(created));
  const id=f.body.requestId,path=`/${id}`;
  assert.equal(created.data.admission.consent.name,'Synthetic owner');assert.ok(created.data.admission.consent.recordedAt);
  assert.equal(created.data.admission.nextObservationAt,f.body.nextObservationAt);
  for(const extra of [{nextObservationAt:new Date(Date.now()+7200000).toISOString(),observationInstructions:'Unauthorized'},{observationInstructions:'Unauthorized'}])assert.equal((await call('assistant','POST',`${path}/update`,update(0,extra))).status,403);
  const done=update(0,{completeObservation:true,ownerUpdate:''});
  const completed=await call('assistant','POST',`${path}/update`,done);assert.equal(completed.status,200,JSON.stringify(completed));assert.ok(completed.data.admission.observationCompletedAt);
  assert.equal((await call('assistant','POST',`${path}/update`,done)).status,200);
  assert.equal((await call('assistant','POST',`${path}/update`,update(1,{completeObservation:true}))).status,409);
  const schedule=update(1,{nextObservationAt:new Date(Date.now()+7200000).toISOString(),observationInstructions:'Private recheck instruction'});
  const rescheduled=await call('vet','POST',`${path}/update`,schedule);assert.equal(rescheduled.status,200,JSON.stringify(rescheduled));assert.equal(rescheduled.data.admission.observationCompletedAt,null);
  assert.equal((await call('assistant','POST',`${path}/update`,update(1,{completeObservation:true}))).status,409,'stale completion cannot complete replacement task');
  const record=(await call('vet','GET',path)).data;
  assert.equal(record.updates.find(e=>e.id===done.requestId).careDetails.completedObservation.instructions,f.body.observationInstructions);
  assert.equal(record.updates.find(e=>e.id===schedule.requestId).careDetails.observationInstructions,schedule.observationInstructions);
  const owner=(await call('owner','GET',path)).data;
  assert.equal(owner.admission.consent.emergencyPhone,f.body.emergencyPhone);
  for(const secret of ['observationInstructions','nextObservationAt','careDetails','Private']) assert.ok(!JSON.stringify(owner).includes(secret),secret);
  assert.equal((await call('other-owner','GET',path)).status,404);
  // No fabricated completion or consent when a transaction's audit fails.
  await query("CREATE FUNCTION reject_care_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'Updated admission%' THEN RAISE EXCEPTION 'Synthetic care audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_care_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_care_audit()");
  try { assert.equal((await call('assistant','POST',`${path}/update`,update(2,{completeObservation:true}))).status,500); }
  finally { await query('DROP TRIGGER reject_care_audit ON audit_logs'); }
  assert.equal((await call('vet','GET',path)).data.admission.observationCompletedAt,null);
});

test('discharge document scopes saved prescriptions and payment without private inpatient records',async()=>{
  const f=await admit('Completed'),path=`/${f.admission.id}`;
  assert.equal((await call('owner','GET',`${path}/discharge-summary`)).status,409);
  await query("UPDATE consultations SET prescription='Saved home directions' WHERE appt_id=$1",[f.visit.id]);
  const approved=await call('vet','POST',`${path}/discharge`,update(0,{dischargeInstructions:'Saved discharge instructions'}));assert.equal(approved.status,200);
  const unpaid=await call('owner','GET',`${path}/discharge-summary`);assert.equal(unpaid.status,200,JSON.stringify(unpaid));assert.notEqual(unpaid.data.appointment.billingStatus,'Paid');assert.equal(unpaid.data.admission.status,'Ready for discharge');
  await query(`UPDATE appointments SET billing_status='Paid',amount=123.45,paid_at=NOW(),payment_method='Cash',invoice_items='[{"name":"Saved clinic supply","qty":1,"price":125.45,"source":"admission"}]',payment_details='{"discount":2,"cashTendered":150,"changeAmount":26.55}' WHERE id=$1`,[f.visit.id]);
  for(const role of ['vet','assistant','admin','owner']) {
    const result=await call(role,'GET',`${path}/discharge-summary`);assert.equal(result.status,200,JSON.stringify(result));
    assert.equal(result.data.consultation.prescription,'Saved home directions');assert.equal(result.data.admission.dischargeInstructions,'Saved discharge instructions');assert.equal(result.data.appointment.amount,123.45);assert.equal(result.data.appointment.invoiceItems[0].price,125.45);assert.equal(result.data.appointment.discount,2);
    for(const secret of ['Private','clinicalNote','carePlan','measurements','careDetails','request_payload','revision','medicationOrders']) assert.ok(!JSON.stringify(result.data).includes(secret),secret);
  }
  for(const role of ['other-owner','other-vet'])assert.equal((await call(role,'GET',`${path}/discharge-summary`)).status,404);
  assert.equal((await call(null,'GET',`${path}/discharge-summary`)).status,401);
});

test('vet admission order leaves an assistant consent task; consent saves are scoped, atomic and retry-safe',async()=>{
 const f=await fixture();
 for(const key of ['consentConfirmed','consentName','consentMethod','emergencyName','emergencyPhone','emergencyRelationship'])delete f.body[key];
 const created=await call('vet','POST','',f.body);assert.equal(created.status,200,JSON.stringify(created));assert.equal(created.data.admission.consent,null);
 const path=`/${f.body.requestId}/consent`,body=update(0,{measurements:{},consentConfirmed:true,consentName:'Synthetic owner',consentMethod:'Phone',emergencyName:'Synthetic contact',emergencyPhone:'+639170000001',emergencyRelationship:'Owner'});
 for(const role of ['owner','other-owner','vet','admin'])assert.equal((await call(role,'POST',path,body)).status,403,role);
 assert.equal((await call('assistant','POST',path,{...body,emergencyPhone:'123'})).status,400);
 assert.equal((await call('assistant','POST',path,{...body,carePlan:'Unauthorized change'})).status,403);
 const saves=await Promise.all([call('assistant','POST',path,body),call('assistant','POST',path,body)]);assert.deepEqual(saves.map(r=>r.status),[200,200]);
 const consent=saves[0].data.admission.consent;assert.equal(consent.staffRole,'assistant');assert.ok(consent.staffId);assert.ok(consent.recordedAt);
 let record=(await call('vet','GET',`/${f.body.requestId}`)).data;assert.equal(record.admission.revision,1);assert.equal(record.updates.filter(u=>u.id===body.requestId).length,1);assert.equal(record.admission.carePlan,f.body.carePlan);
 assert.equal((await call('assistant','POST',path,{...body,requestId:crypto.randomUUID(),consentName:'Stale contact'})).status,409);
 const correction={...body,requestId:crypto.randomUUID(),revision:1,emergencyName:'Updated contact'};
 assert.equal((await call('assistant','POST',path,correction)).status,200);
 record=(await call('vet','GET',`/${f.body.requestId}`)).data;
 assert.equal(record.admission.consent.emergencyName,'Updated contact');assert.equal(record.updates.find(u=>u.id===body.requestId).careDetails.consent.emergencyName,'Synthetic contact');
 assert.equal((await call('other-owner','GET',`/${f.body.requestId}`)).status,404);
 await query("CREATE FUNCTION fail_consent_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'Updated admission%' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_consent_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_consent_audit()");
 try{assert.equal((await call('assistant','POST',path,{...correction,requestId:crypto.randomUUID(),revision:2,emergencyName:'Must roll back'})).status,500);}finally{await query('DROP TRIGGER fail_consent_audit ON audit_logs');}
 record=(await call('vet','GET',`/${f.body.requestId}`)).data;assert.equal(record.admission.revision,2);assert.equal(record.admission.consent.emergencyName,'Updated contact');assert.equal(record.updates.length,3);
});

test('consent saves without an alternate contact, preserves owner contact access and rejects incomplete alternates',async()=>{
 const f=await fixture();
 for(const key of ['consentConfirmed','consentName','consentMethod','emergencyName','emergencyPhone','emergencyRelationship'])delete f.body[key];
 const created=await call('vet','POST','',f.body);assert.equal(created.status,200,JSON.stringify(created));
 const body=update(0,{measurements:{},consentConfirmed:true,consentName:'Synthetic owner',consentMethod:'In person'});
 const path=`/${f.body.requestId}/consent`;
 assert.equal((await call('assistant','POST',path,{...body,emergencyName:'Alternate'})).status,400);
 const saved=await call('assistant','POST',path,body);assert.equal(saved.status,200,JSON.stringify(saved));
 assert.equal(saved.data.admission.consent.emergencyName,'');assert.equal(saved.data.admission.ownerPhone,'+639170000001');
 const read=await call('owner','GET',`/${f.body.requestId}`);assert.equal(read.data.admission.consent.name,'Synthetic owner');
 assert.equal(read.data.admission.ownerPhone,undefined,'staff contact projection does not widen owner API');
});

test('admission dropdown selections survive save, retry and reload in private care history',async()=>{
 const f=await fixture();
 Object.assign(f.body,{reasonChoice:'Supportive care and stabilization',clinicalNote:'Supportive care and stabilization',planTemplate:'General observation',observationTemplate:'Recovery observation',planConfirmed:true});
 const saved=await call('vet','POST','/',f.body);assert.equal(saved.status,200,JSON.stringify(saved));
 assert.equal((await call('vet','POST','/',f.body)).status,200);
 const detail=await call('vet','GET',`/${saved.data.admission.id}`);assert.equal(detail.status,200);
 const entry=detail.data.updates.find(row=>row.id===f.body.requestId);
 for(const key of ['reasonChoice','planTemplate','observationTemplate','planConfirmed']) assert.equal(entry.careDetails[key],f.body[key],key);
 assert.equal(entry.carePlan,f.body.carePlan);
 const owner=await call('owner','GET',`/${saved.data.admission.id}`);
 assert.ok(!JSON.stringify(owner.data).includes('planTemplate'));
 assert.equal(detail.data.updates.filter(row=>row.id===f.body.requestId).length,1);
});
