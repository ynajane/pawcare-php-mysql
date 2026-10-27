// Exercise the connected workflow through real authenticated HTTP routes and PostgreSQL.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import pg from 'pg';
import express from 'express';
import cookieParser from 'cookie-parser';
import { intakeVisitSnapshot } from '../../src/intakeVisit.js';
if (!process.env.TEST_DATABASE_URL) throw Error('Set TEST_DATABASE_URL to a disposable local PostgreSQL database');
const url = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('Use a local disposable database.');
const admin = new pg.Pool({connectionString:url.href});
const schema = `test_connected_${crypto.randomUUID().replaceAll('-','')}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set('options',`-c search_path=${schema},public`); url.searchParams.set('application_name',schema); process.env.DATABASE_URL = url.href;
const {query,pool} = await import('../db.js');
await query(readFileSync(new URL('../database/schema.sql',import.meta.url),'utf8'));
await query(readFileSync(new URL('../database/appointment-status.sql',import.meta.url),'utf8'));
mock.timers.enable({apis:['Date'],now:new Date('2026-10-26T00:00:00Z').getTime()});
const {sha256} = await import('../security.js');
const {clinicRouter} = await import('../routes/clinic.js');
const app = express(); app.use(express.json()); app.use(cookieParser()); app.use('/api',clinicRouter);
const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
after(async () => { mock.timers.reset(); await new Promise(resolve => server.close(resolve)); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
const call = async (role, method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{'Content-Type':'application/json',...(role?{Authorization:`Bearer connected-${role}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
};
for (const role of ['owner','assistant','vet','admin','other-owner']) {
  const actual = role === 'other-owner' ? 'owner' : role;
  await query("INSERT INTO users(id,first_name,last_name,birthday,password_hash,email,role,owner_id,vet_id,mobile_number,email_verified_at,mobile_verified) VALUES($1,'Synthetic',$2,'1990-01-01','unused',$3,$4,$5,$6,'+639170000001',NOW(),true)",[`connected-${role}`,role,`${role}@example.invalid`,actual,actual==='owner'?role:null,role==='vet'?'connected-vet':null]);
  await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '2 days')",[sha256(`connected-${role}`),`connected-${role}`]);
}
await query("INSERT INTO owners(id,name,email,phone,address) VALUES('owner','Synthetic owner','owner@example.invalid','+639170000001','Synthetic address'),('other-owner','Other owner','other@example.invalid','+639170000002','Synthetic address')");
await query("INSERT INTO pets(id,owner_id,name,species,birth,weight) VALUES('connected-pet','owner','Synthetic patient','Dog','2020-01-01',10)");
let configured;
test('clinic choices require authorized roles, persist, reject concurrent overwrites and audit atomically', async () => {
  assert.equal((await call(null,'GET','/clinical/note-options')).status,401);
  for (const role of ['owner','assistant']) assert.equal((await call(role,'GET','/clinical/note-options')).status,403);
  const baseline = await call('admin','GET','/clinical/note-options'); assert.equal(baseline.status,200); assert.ok(baseline.data.options.diagnosis.includes('Dermatitis')); assert.ok(baseline.data.options.diagnosis.includes('Diabetes mellitus')); assert.ok(baseline.data.options.diagnosis.length>40);
  const body = {revision:baseline.data.revision,options:{diagnosis:['Synthetic assessment'],treatment:['Synthetic home care']}};
  for (const role of ['owner','assistant','vet']) assert.equal((await call(role,'PUT','/clinical/note-options',body)).status,403);
  assert.equal((await call('admin','PUT','/clinical/note-options',{...body,options:{diagnosis:['Repeated','repeated'],treatment:[]}})).status,400);
  const concurrent = await Promise.all([call('admin','PUT','/clinical/note-options',body),call('admin','PUT','/clinical/note-options',body)]);
  assert.deepEqual(concurrent.map(result => result.status).sort(),[200,409]);
  configured = (await call('vet','GET','/clinical/note-options')).data;
  assert.deepEqual(configured.options,body.options);
  assert.equal((await query("SELECT count(*)::int n FROM audit_logs WHERE action LIKE 'Updated diagnosis and treatment choices%'")).rows[0].n,1);
  await query("CREATE FUNCTION reject_options_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'Updated diagnosis and treatment choices%' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_options BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_options_audit()");
  assert.equal((await call('admin','PUT','/clinical/note-options',{revision:configured.revision,options:{diagnosis:[],treatment:[]}})).status,500);
  assert.deepEqual((await call('vet','GET','/clinical/note-options')).data,configured);
  await query('DROP TRIGGER reject_options ON audit_logs');
});
test('booking → approval → check-in → consultation → billing → owner records stays connected', async () => {
  const registration=await call('owner','POST','/pet-requests',{requestId:crypto.randomUUID(),name:'Online Journey Patient',species:'Canine',breed:'Mixed Breed',sex:'Male',birth:'2020-01-01',weight:10,neutered:'Not sure',color:'Brown',notes:'Synthetic owner registration'});
  assert.equal(registration.status,200,JSON.stringify(registration));
  const requestedPet=registration.data.pet.id,expectedRegistration={id:registration.data.request.id,revision:registration.data.request.revision};
  assert.equal((await call('owner','GET','/state')).data.data.pets.find(p=>p.id===requestedPet).registrationStatus,'Pending');
  const booking = await call('owner','POST','/appointments',{petId:requestedPet,vetId:'connected-vet',date:'2026-10-26',time:'09:00',service:'checkup',reason:'Synthetic clinical concern'});
  assert.equal(booking.status,200,JSON.stringify(booking)); let visit = booking.data.appointment; assert.equal(visit.status,'Pending Approval');
  const patch = async (role,body) => { const result = await call(role,'PATCH',`/appointments/${visit.id}/status`,{...body,expectedVisit:intakeVisitSnapshot(visit)}); assert.equal(result.status,200,JSON.stringify(result)); visit = (await call(role,'GET','/state')).data.data.appts.find(row => row.id === visit.id); };
  await patch('assistant',{status:'Scheduled',expectedRegistration}); assert.equal(visit.status,'Scheduled');
  assert.equal((await call('owner','GET','/state')).data.data.pets.find(p=>p.id===requestedPet).registrationStatus,'Verified','combined approval verifies the exact pending pet');
  await patch('assistant',{status:'Checked-in',intakeVitals:{weight:10.5,temp:38.5,triageLevel:'Routine',notes:'Synthetic intake'}}); assert.equal(visit.intakeVitals.weight,10.5);
  await patch('vet',{status:'In consultation'});
  const admissionRequest = {requestId:crypto.randomUUID(),apptId:visit.id,expectedVisit:intakeVisitSnapshot(visit),clinicalNote:'Private observation reason',carePlan:'Vet-approved observation plan',ownerUpdate:'Your pet is staying for observation.',nextObservationAt:new Date((await query('SELECT clock_timestamp() now')).rows[0].now.getTime()+3600000).toISOString(),observationInstructions:'Private scheduled check',consentConfirmed:true,consentName:'Synthetic owner',consentMethod:'In person',emergencyName:'Synthetic contact',emergencyPhone:'+639170000001',emergencyRelationship:'Owner'};
  const admitted = await call('vet','POST','/admissions',admissionRequest); assert.equal(admitted.status,200,JSON.stringify(admitted));
  const admissionId = admitted.data.admission.id;
  const observation = await call('assistant','POST',`/admissions/${admissionId}/update`,{requestId:crypto.randomUUID(),revision:0,completeObservation:true,clinicalNote:'Private measured observation',ownerUpdate:'Your pet has been checked by clinic staff.',measurements:{temp:38.6}}); assert.equal(observation.status,200,JSON.stringify(observation));
  const note = {id:'connected-note',petId:visit.petId,apptId:visit.id,date:'2026-10-26',symptoms:'Synthetic concern',objective:'Synthetic examination',diagnosis:configured.options.diagnosis[0],treatment:configured.options.treatment[0],prescription:'Synthetic home instructions',performedServices:['srv_consult'],prescriptionItems:[{catalogId:'product_multivitamin',quantity:1,instructions:'Synthetic directions'},{catalogId:'srv_nexgard',quantity:1,instructions:'Synthetic home prescription'}],expectedVisit:intakeVisitSnapshot(visit),weight:10.5,careStatus:'Routine care'};
  const saved = await call('vet','POST','/consultations',note); assert.equal(saved.status,200,JSON.stringify(saved)); assert.equal(saved.data.appointment.status,'Completed');
  const unpaidCard=await call('owner','GET',`/pets/${visit.petId}/vet-card`);assert.ok(unpaidCard.data.document,'standard card does not require payment');assert.ok(!JSON.stringify(unpaidCard.data).includes('Private observation reason'));
  const orderId=crypto.randomUUID();
  const order=await call('vet','POST',`/admissions/${admissionId}/order`,{requestId:orderId,revision:1,clinicalNote:'Private veterinarian order rationale',medicine:'Synthetic prescribed medicine',dose:'1 vet-entered unit',route:'Vet-entered route',frequency:'Vet-entered schedule',catalogId:'srv_nexgard',supplyLimit:1});
  assert.equal(order.status,200,JSON.stringify(order));
  const given=await call('assistant','POST',`/admissions/${admissionId}/medication`,{requestId:crypto.randomUUID(),revision:2,orderId,result:'Given',occurredAt:(await query('SELECT clock_timestamp() now')).rows[0].now.toISOString(),billableQuantity:1,clinicalNote:'Private observed response',ownerUpdate:'The ordered medicine was given by clinic staff.'});
  assert.equal(given.status,200,JSON.stringify(given));
  const inboxBefore = await call('assistant','GET','/checkout-inbox'); assert.ok(!inboxBefore.data.tasks.some(task => task.appointmentId === visit.id));
  assert.equal((await call('assistant','POST',`/checkout-inbox/${visit.id}/claim`,{})).status,409);
  assert.equal((await call('assistant','POST',`/appointments/${visit.id}/billing`,{invoiceItems:saved.data.invoiceItems,amount:1300,paymentMethod:'Cash',cashTendered:2000})).status,409,'direct payment cannot bypass admission hold');
  const staying = await call('owner','GET',`/admissions/${admissionId}`); assert.equal(staying.data.admission.status,'Admitted');
  assert.ok(!JSON.stringify(staying.data).includes('Private')); assert.equal(staying.data.updates.length,3); assert.ok(!staying.data.medicationOrders);
  assert.equal((await call('other-owner','GET',`/admissions/${admissionId}`)).status,404);
  const approved = await call('vet','POST',`/admissions/${admissionId}/discharge`,{requestId:crypto.randomUUID(),revision:3,clinicalNote:'Vet-approved discharge summary',ownerUpdate:'Discharge approved; reception will arrange checkout.',dischargeInstructions:'Follow the saved home-care instructions.'}); assert.equal(approved.status,200,JSON.stringify(approved)); assert.equal(approved.data.admission.status,'Ready for discharge');
  const inbox = await call('assistant','GET','/checkout-inbox'); assert.ok(inbox.data.tasks.some(task => task.appointmentId === visit.id));
  const claim = await call('assistant','POST',`/checkout-inbox/${visit.id}/claim`,{}); assert.equal(claim.status,200,JSON.stringify(claim));
  const invoiceItems = claim.data.invoiceItems; const amount = invoiceItems.reduce((total,line)=>total+line.price*line.qty,0); assert.equal(amount,1850);assert.equal(invoiceItems.filter(line=>line.catalogId==='srv_nexgard').length,2,'same product has separate clinic-use and home-supply lines');
  const pay=items=>call('assistant','POST',`/appointments/${visit.id}/billing`,{claimToken:claim.data.claimToken,invoiceItems:items,amount:items.reduce((n,p)=>n+p.price*p.qty,0),paymentMethod:'Cash',cashTendered:2000});
  assert.equal((await pay(invoiceItems.filter(line=>line.source!=='admission'))).status,400,'clinic use cannot be omitted');
  assert.equal((await pay([...invoiceItems,...invoiceItems.filter(line=>line.source==='admission')])).status,400,'clinic use cannot be duplicated');
  assert.equal((await pay([...invoiceItems,{catalogId:'srv_nexgard',name:'NexGard Spectra Chewable Tablet',price:550,qty:1}])).status,400,'clinic order does not authorize unprescribed take-home medicine');
  const paid = await pay(invoiceItems); assert.equal(paid.status,200,JSON.stringify(paid));
  assert.equal((await call('owner','GET',`/admissions/${admissionId}`)).data.admission.status,'Ready for discharge','paid pet still awaits actual release');
  const paidCard=await call('owner','GET',`/pets/${visit.petId}/vet-card`);assert.equal(paidCard.status,200,JSON.stringify(paidCard));assert.ok(paidCard.data.document);assert.ok(!('visits' in paidCard.data.document.snapshot),'card excludes admission and SOAP visit details');assert.ok(!JSON.stringify(paidCard.data).includes('Private observed response'));
  const released=await call('assistant','POST',`/admissions/${admissionId}/release`,{requestId:crypto.randomUUID(),revision:4,clinicalNote:'Released to verified owner',ownerUpdate:'Your pet has gone home with you.'}); assert.equal(released.status,200,JSON.stringify(released));
  const home = await call('owner','GET',`/admissions/${admissionId}`); assert.equal(home.data.admission.status,'Discharged'); assert.equal(home.data.admission.dischargeInstructions,'Follow the saved home-care instructions.');
  const records = (await call('owner','GET','/state')).data.data;
  assert.equal(records.appts.find(row => row.id === visit.id).billingStatus,'Paid');
  const paidVisit=records.appts.find(row=>row.id===visit.id);assert.equal(paidVisit.amount,1850);assert.equal(paidVisit.invoiceItems.find(line=>line.source==='admission').catalogId,'srv_nexgard');
  assert.equal((await query("SELECT count(*)::int n FROM admission_updates WHERE admission_id=$1 AND kind='Medicine administration'",[admissionId])).rows[0].n,1,'payment and release do not add medicine events');
  const record = records.consults.find(row => row.id === note.id); assert.equal(record.apptId,visit.id); assert.equal(record.diagnosis,note.diagnosis); assert.equal(record.treatment,note.treatment); assert.equal(record.prescriptionItems[0].catalogId,'product_multivitamin');
  const document=await call('owner','GET',`/admissions/${admissionId}/discharge-summary`);assert.equal(document.status,200,JSON.stringify(document));
  assert.equal(document.data.admission.status,'Discharged');assert.equal(document.data.appointment.amount,paidVisit.amount);assert.deepEqual(document.data.appointment.invoiceItems,paidVisit.invoiceItems);assert.equal(document.data.consultation.prescription,record.prescription);assert.equal(document.data.consultation.prescriptionItems[0].name,record.prescriptionItems[0].name);
  assert.ok(!JSON.stringify(document.data).includes('Private'));
  const foreign = (await call('other-owner','GET','/state')).data.data;
  assert.ok(!foreign.appts.some(row => row.id === visit.id)); assert.ok(!foreign.consults.some(row => row.id === note.id));
  assert.equal((await query('SELECT status FROM checkout_tasks WHERE appointment_id=$1',[visit.id])).rows[0].status,'completed');
  assert.equal((await call('admin','PUT','/clinical/note-options',{revision:configured.revision,options:{diagnosis:[],treatment:[]}})).status,200);
  assert.equal((await call('owner','GET','/state')).data.data.consults.find(row => row.id === note.id).diagnosis,note.diagnosis,'retiring choices preserves saved medical notes');
});

test('diagnosis default expansion preserves custom lists and retired suggestions across server initialization',async()=>{
  const {ensureNoteOptionsSchema}=await import(`../noteOptions.js?defaults-check=${crypto.randomUUID()}`);
  const before=(await call('admin','GET','/clinical/note-options')).data;
  const retired=await call('admin','PUT','/clinical/note-options',{revision:before.revision,options:{diagnosis:[],treatment:before.options.treatment}});
  assert.equal(retired.status,200);
  await ensureNoteOptionsSchema();
  const after=(await call('vet','GET','/clinical/note-options')).data;
  assert.deepEqual(after,retired.data,'initialization must not reintroduce retired defaults');
});

test('walk-in vaccination → intake → vet dose → checkout → owner/admin history retains exact links',async()=>{
 const registered=await call('assistant','POST','/walk-in',{ownerId:'owner',ownerName:'Synthetic owner',phone:'+639170000001',email:'owner@example.invalid',address:'Synthetic address',petName:'Walkin Vaccine Patient',species:'Canine',breed:'Mixed Breed',sex:'Male',birth:'2020-01-01',weight:12,neutered:'Not sure',color:'Brown',notes:'Synthetic walk-in',addToQueue:true,vetId:'connected-vet',serviceCategory:'vaccination',vaccineId:'rabies',reason:'Vaccination: Anti-rabies'});
 assert.equal(registered.status,200,JSON.stringify(registered));
 const petId=registered.data.pet.id;let visit=registered.data.appointment;
 assert.equal(registered.data.owner.id,'owner');assert.equal(visit.status,'Scheduled');assert.equal(visit.intakeVitals,null);assert.equal(visit.service,'vaccination');
 const patch=async(role,body)=>{
  const result=await call(role,'PATCH',`/appointments/${visit.id}/status`,{...body,expectedVisit:intakeVisitSnapshot(visit)});
  assert.equal(result.status,200,JSON.stringify(result));visit=(await call(role,'GET','/state')).data.data.appts.find(a=>a.id===visit.id);
 };
 await patch('assistant',{status:'Checked-in',intakeVitals:{weight:12.4,temp:38.5,triageLevel:'Routine',notes:'Measured at arrival'}});
 await patch('vet',{status:'In consultation'});
 const noteId='walkin-vaccine-note',doseId='walkin-vaccine-dose';
 const saved=await call('vet','POST','/consultations',{id:noteId,petId,apptId:visit.id,date:visit.date,symptoms:'Reason for visit: Vaccination: Anti-rabies',objective:'Measured weight 12.4 kg, temperature 38.5 C. Veterinarian examination recorded.',diagnosis:'Suitable for vaccination following examination',treatment:'Anti-rabies administered; monitoring instructions explained',prescription:'',performedServices:[],prescriptionItems:[],expectedVisit:intakeVisitSnapshot(visit),careStatus:'Routine care',vaccination:{id:doseId,doseNo:1,doseOf:1,scheduleApproved:true,intervalDays:365,vaccine:'Anti-rabies',brand:'Synthetic Vaccine',batch:'SYNTHETIC-LOT',date:visit.date,nextDue:'2027-10-26',manufacturer:'Synthetic Manufacturer',serialNumber:'SYNTHETIC-SERIAL'}});
 assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(saved.data.appointment.status,'Completed');
 const ownerBefore=(await call('owner','GET','/state')).data.data;
 const dose=ownerBefore.vaccs.find(v=>v.id===doseId);assert.equal(dose.apptId,visit.id);assert.equal(dose.consultationId,noteId);assert.equal(dose.vetId,'connected-vet');
 assert.equal(ownerBefore.consults.find(c=>c.id===noteId).apptId,visit.id);
 const card=await call('owner','GET',`/pets/${petId}/vet-card`);assert.equal(card.status,200);assert.ok(card.data.document,'card is available before checkout');
 assert.ok(JSON.stringify(card.data.document).includes('SYNTHETIC-LOT'));
 assert.equal((await call('other-owner','GET',`/pets/${petId}/vet-card`)).status,404);
 const inbox=await call('assistant','GET','/checkout-inbox');assert.ok(inbox.data.tasks.some(t=>t.appointmentId===visit.id));
 const claim=await call('assistant','POST',`/checkout-inbox/${visit.id}/claim`,{});assert.equal(claim.status,200,JSON.stringify(claim));
 assert.equal(claim.data.invoiceItems.length,1,'only the administered vaccine is charged');assert.equal(claim.data.invoiceItems[0].catalogId,'srv_rabies');
 const amount=claim.data.invoiceItems.reduce((n,line)=>n+line.qty*line.price,0);
 const paid=await call('assistant','POST',`/appointments/${visit.id}/billing`,{claimToken:claim.data.claimToken,invoiceItems:claim.data.invoiceItems,amount,paymentMethod:'Cash',cashTendered:1000});
 assert.equal(paid.status,200,JSON.stringify(paid));
 for(const role of ['owner','admin']){
  const state=(await call(role,'GET','/state')).data.data,paidVisit=state.appts.find(a=>a.id===visit.id);
  assert.equal(paidVisit.status,'Completed');assert.equal(paidVisit.billingStatus,'Paid');assert.equal(paidVisit.amount,amount);
  assert.equal(state.consults.find(c=>c.id===noteId).petId,petId);assert.equal(state.vaccs.find(v=>v.id===doseId).consultationId,noteId);
 }
 const before=(await query('SELECT count(*)::int n FROM vaccinations WHERE id=$1',[doseId])).rows[0].n;
 assert.equal(before,1,'billing never duplicates administration');
});

test('concurrent invoices cannot reuse a case-insensitive digital payment reference',async()=>{
 const ids=[crypto.randomUUID(),crypto.randomUUID()];
 const product=(await call('assistant','GET','/services/prices')).data.catalog.find(item=>item.id==='srv_consult');
 const invoice=[{catalogId:product.id,name:product.name,price:product.price,qty:1,source:'performed'}];
 const claims=[];
 for(const id of ids){
  await query("INSERT INTO appointments(id,pet_id,vet_id,date,time,reason,status,billing_status,invoice_items) VALUES($1,'connected-pet','connected-vet','2026-10-26','10:00','Synthetic concurrent checkout','Completed','Unpaid',$2)",[id,JSON.stringify(invoice)]);
  await query("INSERT INTO consultations(id,pet_id,vet_id,appt_id,date,symptoms,objective,diagnosis,treatment,performed_services) VALUES($1,'connected-pet','connected-vet',$2,'2026-10-26','Recorded history','Recorded exam','Synthetic assessment','Synthetic home care',$3)",[crypto.randomUUID(),id,JSON.stringify(invoice)]);
  const claimed=await call('assistant','POST',`/checkout-inbox/${id}/claim`,{});
  assert.equal(claimed.status,200,JSON.stringify(claimed));claims.push(claimed.data.claimToken);
 }
 // Hold both requests at a database lock: before the fix both have already
 // passed the duplicate lookup; after the fix the second waits at that lookup.
 const gateKey=randomInt(1,2147483647),gate=await pool.connect();
 await gate.query('SELECT pg_advisory_lock($1)',[gateKey]);
 const idsSql=ids.map(id=>`'${id}'`).join(',');
 await query(`CREATE FUNCTION pause_reference_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id IN (${idsSql}) AND NEW.billing_status='Paid' THEN PERFORM pg_advisory_xact_lock(${gateKey}); END IF; RETURN NEW; END $$; CREATE TRIGGER pause_reference_payment BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION pause_reference_payment()`);
 const pay=(index,reference)=>call('assistant','POST',`/appointments/${ids[index]}/billing`,{claimToken:claims[index],invoiceItems:invoice,amount:product.price,paymentMethod:'GCash',paymentReference:reference});
 const pending=Promise.all([pay(0,'SYNTHETIC-REFERENCE-001'),pay(1,' synthetic-reference-001 ')]);
 let bothWaiting=false;
 try{
  for(let i=0;i<100;i++){
   const waiting=await query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND application_name=$1 AND wait_event='advisory'",[schema]);
   if(waiting.rows[0].n>=2){bothWaiting=true;break;}
   await new Promise(resolve=>setTimeout(resolve,20));
  }
 }finally{
  await gate.query('SELECT pg_advisory_unlock($1)',[gateKey]);gate.release();
 }
 let responses;
 try{responses=await pending;}finally{await query('DROP TRIGGER pause_reference_payment ON appointments; DROP FUNCTION pause_reference_payment()');}
 assert.ok(bothWaiting,'both concurrent requests reached the database barrier');
 assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
 const stored=(await query('SELECT id,billing_status,payment_details FROM appointments WHERE id=ANY($1::varchar[])',[ids])).rows;
 assert.equal(stored.filter(row=>row.billing_status==='Paid').length,1,'one payment is saved');
 const loser=responses.findIndex(response=>response.status===409);
 assert.match(responses[loser].data.error,/already used/);
 assert.equal(stored.find(row=>row.id===ids[loser]).billing_status,'Unpaid');
 assert.equal((await pay(loser,'SYNTHETIC-REFERENCE-002')).status,200,'rejected invoice can retry with a distinct actual reference');
});
