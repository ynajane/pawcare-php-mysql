import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Exercise real JSX render paths, including callbacks evaluated during render.
const directory = mkdtempSync(join(tmpdir(), 'pawcare-render-'));
after(() => rmSync(directory, { recursive: true, force: true }));
const bundle = join(directory, 'ui.cjs');
buildSync({
  stdin: {
    contents: `
      export { PaginatedTable, PaginatedList, pageBounds } from './src/components/Pagination.jsx';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
      export { owner } from './src/roles/Owner.jsx';
      export { admin } from './src/roles/Admin.jsx';
      export { vet } from './src/roles/Vet.jsx';
      export { assistant } from './src/roles/Assistant.jsx';
      export { ProfileBody, PasswordBody } from './src/roles/owner/Profile.jsx';
      export { PetFormModal, PetProfileModal } from './src/roles/owner/Pets.jsx';
      export { DischargeDocument } from './src/roles/AdmissionDischargeSummary.jsx';
      export {RequestReview} from './src/roles/FrontDeskApprovals.jsx';
      export { default as InClinicRegistration } from './src/roles/InClinicRegistration.jsx';
      export { default as ExistingPatientCheckInModal } from './src/roles/ExistingPatientCheckInModal.jsx';
      export { default as AdmissionForm} from './src/roles/AdmissionForm.jsx';
      export { default as Portal } from './src/Portal.jsx';
      export { default as PetApprovalModal } from './src/roles/PetApprovalModal.jsx';
      export { ConsultationDetailModal } from './src/roles/ConsultationsPage.jsx';
      export { default as Reports } from './src/roles/ReportsPage.jsx';
      export { default as ErrorBoundary } from './src/ErrorBoundary.jsx';
      export { SEED } from './src/lib.jsx';
      export { VitalEntries, Correction } from './src/roles/VitalsHistory.jsx';
      export { QuickBookModal } from './src/roles/ClinicCalendar.jsx';
      export { default as BookingReason } from './src/components/BookingReason.jsx';
      export { VetCardTimeline, NextPreventiveCare } from './src/roles/DigitalVetCard.jsx';
      export { default as CheckInModal } from './src/roles/CheckInModal.jsx';
      export { default as PrescriptionBuilder } from './src/roles/PrescriptionBuilder.jsx';
      export { default as SoapConsultationModal } from './src/roles/SoapConsultationModal.jsx';
      export { emptyClinicState } from './src/clinicState.js';
    `,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true,
  outfile: bundle,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  define: { 'import.meta.env.DEV': 'false' },
  logLevel: 'silent',
});
const ui = createRequire(import.meta.url)(bundle);
const render = (Component, props) => ui.renderToStaticMarkup(ui.createElement(Component, props));
const me = role => ({ id: role === 'vet' ? 'v1' : 'u1', ownerId: 'o1', role, name: 'Sample User', email: 'owner@example.test' });
const populated = () => ({ ...ui.emptyClinicState(), ...structuredClone(ui.SEED), vets: [{ id: 'v1', name: 'Sample Vet' }] });
const props = (role, db) => ({ db, me: me(role), setDb() {}, go() {}, say() {}, onClose() {} });

for (const role of ['owner', 'vet', 'assistant', 'admin']) {
  for (const [state, makeDb] of [['empty', ui.emptyClinicState], ['populated', populated]]) {
    for (const page of ui[role].menu.filter(page => !page.hide)) {
      const Component = page.Page || (page.dash ? ui[role].Dash : page.rep ? ui.Reports : null);
      if (Component) test(`${role} ${page.k} renders with ${state} records`, () => {
        assert.ok(render(Component, props(role, makeDb())).length);
      });
    }
  }
}

test('vaccination card contains only standard administration and weight details',()=>{
 const html=render(ui.VetCardTimeline,{history:{events:[{id:'dose',kind:'vaccination',vaccine:'Anti-rabies',date:'2026-01-01',brand:'Brand',manufacturer:'Manufacturer',batch:'Lot',serialNumber:'Serial',nextDue:'2027-01-01',vetName:'Attending vet'},{id:'worm',kind:'deworming',vaccine:'Deworming',brand:'Medication',date:'2026-01-01'},{id:'weight',kind:'weight',value:12,date:'2026-01-01'}]},filters:{query:''}});
 for(const text of ['Anti-rabies','Manufacturer','Serial','Attending vet','Veterinarian signature','Deworming','Medication','12 kg'])assert.ok(html.includes(text),text);
 for(const text of ['Consultation history','Publication','Paid','Subjective','Temperature'])assert.ok(!html.includes(text),text);
});
test('assistant has a services catalog and admin has no document setup menu',()=>{
 const page=ui.assistant.menu.find(p=>p.k==='prices');assert.ok(page);
 const html=render(page.Page,props('assistant',populated()));assert.match(html,/Services &amp; Prices/);assert.doesNotMatch(html,/Book a visit/);
 assert.ok(!ui.admin.menu.some(p=>p.k==='document-settings'));
});


for (const role of ['owner', 'vet', 'assistant', 'admin']) {
  test(`${role} profile renders a loaded email address`, () => {
    const db = populated();
    db.accountProfiles = { [me(role).id]: { ...me(role), phone: '09171234567' } };
    assert.match(render(ui.ProfileBody, props(role, db)), /owner@example.test/);
  });
  test(`${role} password settings render`, () => {
    assert.match(render(ui.PasswordBody, props(role, populated())), /Current password/);
  });
}

test('owner pet registration and patient details render', () => {
  const db = populated();
  assert.ok(render(ui.PetFormModal, props('owner', db)).length);
  assert.ok(render(ui.PetProfileModal, { ...props('owner', db), pet: db.pets[0] }).length);
});


test('production recovery explains the next action without exposing exception details', () => {
  const boundary = new ui.ErrorBoundary({ inline: true });
  boundary.state = { hasError: true, error: new Error("Cannot access 'mine' before initialization") };
  const html = ui.renderToStaticMarkup(boundary.render());
  assert.match(html, /Try again/);
  assert.match(html, /Back to dashboard/);
  assert.doesNotMatch(html, /before initialization|Developer details/);
});


test('page recovery can return to the dashboard without reloading the workspace', () => {
  let navigated = false, retried = false;
  const boundary = new ui.ErrorBoundary({ inline: true, onReset: () => { navigated = true; } });
  boundary.retry = () => { retried = true; };
  boundary.goHome();
  assert.equal(navigated, true);
  assert.equal(retried, true);
});

test('root recovery only resets the remembered screen and preserves stored data', () => {
  const oldStorage = globalThis.sessionStorage, oldWindow = globalThis.window;
  const store = new Map([
    ['pawcare_last_session_user', JSON.stringify({ id: 'owner' })],
    ['pawcare_page_owner', 'vacc'], ['pawcare_token', 'synthetic-session'],
    ['unrelated-setting', 'preserve'],
  ]);
  let location;
  globalThis.sessionStorage = { getItem: key => store.get(key), removeItem: key => store.delete(key) };
  globalThis.window = { location: { assign: value => { location = value; } } };
  try {
    new ui.ErrorBoundary({}).goHome();
    assert.equal(location, '/');
    assert.equal(store.has('pawcare_page_owner'), false);
    assert.equal(store.get('pawcare_token'), 'synthetic-session');
    assert.equal(store.get('unrelated-setting'), 'preserve');
  } finally {
    if (oldStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = oldStorage;
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});


test('owner dashboard explains a booked vaccine with no booster due date', () => {
  const db = populated();
  db.vacc = [];
  db.appts = [{ id: 'vaccine-visit', petId: 'p1', ownerId: 'o1', service: 'vaccination', reason: 'Vaccination – Anti-rabies', date: '2099-01-05', time: '10:00', status: 'Scheduled' }];
  const html = render(ui.owner.Dash, props('owner', db));
  assert.match(html, /Anti-rabies/);
  assert.match(html, /Visit: 2099-01-05/);
  assert.match(html, /Booster date not recorded/);
});

test('front desk surfaces a future booking before its arrival date', () => {
  const db = populated();
  db.appts = [{id:'future-approval',petId:'p1',vetId:'v1',date:'2099-01-05',time:'10:00',status:'Pending Approval',reason:'Future vaccination request',notes:'Please call before the visit.'}];
  const html = render(ui.assistant.Dash, props('assistant', db));
  assert.match(html, /Pending Appointment Requests/);
  assert.match(html, /Visit requests \(1\)/);
  assert.match(html, /Future vaccination request/);
  assert.match(html, /2099-01-05/);
  assert.match(html, /10:00 AM/);
  assert.match(html, /Sample Vet/);
  assert.match(html, /Please call before the visit/);
  assert.match(html, /View request details/);
});


test('assistant masterlist uses certified latest-dose recalls without implying coverage', () => {
  const db = populated();
  db.vacc = [{ id: 'old-dose', petId: db.pets[0].id, vaccine: 'Anti-rabies', done: true, vetId: 'v1', date: '2020-01-01', nextDue: '2021-01-01' }];
  const Component = ui.assistant.menu.find(page => page.k === 'clients-patients').Page;
  assert.match(render(Component, props('assistant', db)), /1 Overdue/);
  db.vacc.push({ id: 'latest-dose', petId: db.pets[0].id, vaccine: 'Anti-rabies', done: true, vetId: 'v1', date: '2026-01-01', nextDue: null });
  const html = render(Component, props('assistant', db));
  assert.doesNotMatch(html, /1 Overdue|Up to date/);
  assert.match(html, /No active recall/);
});


test('data tables show ten rows while keeping the complete filtered record for print', () => {
  const rows = Array.from({length:23}, (_,i) => ui.createElement('tr',{key:i},ui.createElement('td',{},`Patient ${i+1}`)));
  const html = render(ui.PaginatedTable,{label:'Patients',children:[ui.createElement('thead',{key:'head'},ui.createElement('tr',{},ui.createElement('th',{},'Patient'))),ui.createElement('tbody',{key:'body'},rows),ui.createElement('tfoot',{key:'total'},ui.createElement('tr',{},ui.createElement('td',{},'Total: 23')))]});
  assert.equal((html.match(/class="pagination-hidden-row"/g)||[]).length,13);
  assert.match(html,/Patient 23/);
  assert.match(html,/Total: 23/);
  assert.match(html,/1–10/);
  assert.match(html,/Patients pagination/);
  assert.match(html,/Go to page 3/);
});
test('pagination clamps invalid or removed pages and represents empty results honestly', () => {
  assert.deepEqual(ui.pageBounds(0,99),{page:1,pages:1,start:0,end:0,total:0});
  assert.deepEqual(ui.pageBounds(23,3),{page:3,pages:3,start:20,end:23,total:23});
  assert.equal(ui.pageBounds(10,2).page,1);
  assert.equal(ui.pageBounds(23,-1).page,1);
  assert.equal(ui.pageBounds(23,Infinity).page,3);
});

test('discharge print document distinguishes prescribed medicine, clinic use, unpaid and released records',()=>{
  const data={admission:{id:'stay',petName:'Patient',vetName:'Vet',status:'Ready for discharge',admittedAt:'2026-10-25T00:00:00Z',dischargeApprovedAt:'2026-10-25T01:00:00Z',dischargeInstructions:'Home care saved'},ownerName:'Owner',consultation:{diagnosis:'Vaccination suitability assessment',treatment:'Care saved',prescription:'Home directions saved',prescriptionItems:[{name:'Home medicine',quantity:2,unit:'packages',instructions:'Vet directions'}]},appointment:{id:'visit',status:'Completed',billingStatus:'Unbilled',invoiceItems:[{name:'Clinic medicine',source:'admission',price:100,qty:1}]},generatedAt:'2026-10-25T01:00:00Z'};
  const pending=render(ui.DischargeDocument,{data});
  for(const text of ['Release to owner has not yet been confirmed','Awaiting checkout','Draft total','Home directions saved','Vet directions','Home care saved','Clinic medicine (clinic use)','print-document'])assert.ok(pending.includes(text),text);
  const paid=render(ui.DischargeDocument,{data:{...data,admission:{...data.admission,status:'Discharged',dischargedAt:'2026-10-25T02:00:00Z'},appointment:{...data.appointment,billingStatus:'Paid',amount:90,discount:10,paymentMethod:'Cash',cashTendered:100,changeAmount:10,paidAt:'2026-10-25T01:30:00Z'}}});
  for(const text of ['Paid amount','90.00','Cash received','Change recorded'])assert.ok(paid.includes(text),text);
  assert.ok(!paid.includes('Release to owner has not yet been confirmed'));
});

test('pending appointment queue presents linked registration and visit for one combined approval',()=>{
 const db=populated();
 db.pets[0]={...db.pets[0],registrationStatus:'Pending'};
 db.petRequests=[{id:'review',petId:db.pets[0].id,ownerId:db.pets[0].ownerId,name:'Pending Luna',species:'Feline',breed:'Puspin',sex:'Female',birth:'2025-01-01',weight:4.25,neutered:'Not sure',notes:'Owner registration notes',status:'Pending',revision:2}];
 db.appts=[{id:'pending-visit',petId:db.pets[0].id,vetId:'v1',date:'2099-01-05',time:'10:00',status:'Pending Approval',reason:'Requested examination'}];
 const html=render(ui.assistant.Dash,props('assistant',db));
 for(const text of ['Pending Appointment Requests','Requested examination','View request details','New pet · registration reviewed with this booking']) assert.ok(html.includes(text),text);
 const details=render(ui.RequestReview,{snapshot:{visit:db.appts[0],patient:db.petRequests[0],registration:db.petRequests[0],owner:db.owners[0],vet:db.vets[0]},db,confirming:false});
 for(const text of ['Submitted patient details','Reported weight','4.25','Owner registration notes','Approve appointment &amp; registration','I checked the pet details'])assert.ok(details.includes(text),text);
});

test('registration review of a booked pending patient uses the combined approval action',()=>{
 const db=populated();const request={id:'review',petId:db.pets[0].id,ownerId:db.pets[0].ownerId,name:'Luna',species:'Feline',sex:'Female',birth:'2025-01-01',weight:4.25,neutered:'Not sure',status:'Pending',revision:0};
 db.petRequests=[request];db.appts=[{id:'linked',petId:request.petId,vetId:'v1',date:'2099-01-05',time:'10:00',reason:'Linked requested examination',status:'Pending Approval'}];
 const html=render(ui.PetApprovalModal,{...props('assistant',db),request});
 assert.match(html,/aria-label="Online pet registration review"/);assert.match(html,/does not require payment or clinic-document setup/);assert.doesNotMatch(html,/requires consultation completion/);
 assert.match(html,/Requested visit/);assert.match(html,/Linked requested examination/);assert.match(html,/Approve appointment &amp; registration/);assert.doesNotMatch(html,/>Approve pet and issue vaccination card</);
});


test('vitals render clinical measurements, registration reports, original entries and linked corrections',()=>{
 const original={id:'original',petId:'p1',visitId:'visit',kind:'temp',value:39,unit:'°C',date:'2026-10-25',measuredAt:'2026-10-25T01:00:00Z',recordedAt:'2026-10-25T01:00:01Z',staffName:'Synthetic vet',staffRole:'vet',origin:'clinic',source:'intake',supersededBy:'correction'};
 const entries=[original,{...original,id:'correction',value:38.5,supersededBy:null,correctsId:'original',correctionReason:'Transcription error'}, {...original,id:'report',kind:'weight',value:10,unit:'kg',origin:'registration'}, {...original,id:'note',kind:'observation',value:null,unit:null,notes:'Bedside observation',source:'admission'}];
 const html=render(ui.VitalEntries,{entries,canCorrect:true});
 for(const text of ['Temperature: 39','Temperature: 38.5','Synthetic vet','visit','Correction of original','Corrected by correction','original retained','Transcription error','not a clinic measurement','Bedside observation'])assert.ok(html.includes(text),text);
 assert.equal((html.match(/Correct entry/g)||[]).length,1);
 assert.doesNotMatch(render(ui.VitalEntries,{entries,canCorrect:false}),/Correct entry/);
});
test('correction fields have immediate accessible inline validation and numeric bounds',()=>{
 const html=render(ui.Correction,{entry:{kind:'temp',value:38.5,unit:'°C'},onCancel(){},onSaved(){}});
 assert.match(html,/name="value"/);assert.match(html,/name="reason"/);assert.match(html,/min="20"/);assert.match(html,/max="50"/);assert.match(html,/maxLength="500"/);assert.match(html,/aria-live="polite"/);assert.match(html,/aria-describedby=/);assert.match(html,/original entry stays/);
});
test('vet intake remains available during consultation and registration weight is not a clinical baseline',()=>{
 const db=populated(),pet={...db.pets[0],weight:90,weightOrigin:'registration',weights:[{kg:90,origin:'registration'}]};db.pets[0]=pet;
 const appt={...db.appts.find(a=>a.petId===pet.id),status:'In consultation'};db.appts=[appt];
 const html=render(ui.CheckInModal,{...props('vet',db),appt});
 assert.match(html,/Measured weight/);assert.match(html,/Measured temperature/);assert.match(html,/earlier measurements/i);assert.doesNotMatch(html,/Last clinic measurement/);
});
test('SOAP displays saved intake but starts the new-measurement field empty',()=>{
 const db=populated(),pet=db.pets[0],appt={...db.appts.find(a=>a.petId===pet.id),status:'In consultation',intakeVitals:{weight:10.25,temp:38.5}};db.appts=[appt];
 const html=render(ui.SoapConsultationModal,{...props('vet',db),pet,appt});
 assert.match(html,/New measured weight/);assert.match(html,/10.25 kg/);assert.match(html,/<input[^>]*id="soap-weight"[^>]*value=""/);
});


test('assistant reschedule form exposes only date/time controls and preserves original request visibly',()=>{
 const db=populated(),pet=db.pets[0];
 const html=render(ui.QuickBookModal,{db,doctors:[['v1','Sample Vet']],slot:{id:'fixed',editing:true,petId:pet.id,vetId:'v1',date:'2026-12-01',time:'09:00',service:'surgery',durationMinutes:120,reason:'Original symptoms',notes:'Original owner note',status:'Scheduled'},onClose(){},onBook(){}});
 assert.match(html,/Original symptoms/);assert.match(html,/Original owner note/);assert.match(html,/120 min/);
 assert.match(html,/name="date"/);assert.match(html,/name="time"/);
 for(const name of ['petId','vetId','service','reasonChoice','otherReason','followUpId'])assert.doesNotMatch(html,new RegExp(`name="${name}"`));
});
test('Other reason renders an accessible textbox only for the selected Other choice',()=>{
 const html=render(ui.BookingReason,{service:'checkup',choice:'Other',other:'12',onChoice(){},onOther(){},errors:{otherReason:'Describe symptoms in words.'}});
 assert.match(html,/name="otherReason"/);assert.match(html,/aria-invalid="true"/);assert.match(html,/Describe symptoms in words/);
 assert.doesNotMatch(render(ui.BookingReason,{service:'checkup',choice:'Annual check-up',other:'12'}),/textarea/);
});


for(const [service,title] of [['vaccination','Vaccination record'],['deworming','Deworming record'],['grooming','Grooming record']]) test(`${service} form shows only relevant documentation`,()=>{
 const db=populated(),pet=db.pets[0],appt={...db.appts.find(a=>a.petId===pet.id),service,reason:service,status:'In consultation',intakeVitals:{weight:10.25,temp:38.5}};db.appts=[appt];
 const html=render(ui.SoapConsultationModal,{...props('vet',db),pet,appt});
 assert.match(html,new RegExp(title));assert.match(html,/10.25 kg/);
 assert.doesNotMatch(html,/S - Subjective|O - Objective|A - Assessment|P - Plan|SOAP Clinical Notes|Prescription &amp; take-home|Admit |Clinical Follow-up/);
 assert.equal(html.includes('confirm vaccine was given'),service==='vaccination');
});
test('consultation shows read-only intake and separate additional findings with diagnosis suggestions',()=>{
 const db=populated(),pet=db.pets[0],appt={...db.appts.find(a=>a.petId===pet.id),service:'checkup',status:'In consultation',intakeVitals:{weight:10.25,temp:38.5}};db.appts=[appt];
 const html=render(ui.SoapConsultationModal,{...props('vet',db),pet,appt});
 assert.match(html,/SOAP Clinical Notes/);assert.match(html,/Saved intake measurements/);assert.match(html,/Additional examination findings/);
 assert.match(html,/<textarea[^>]*name="objective"[^>]*><\/textarea>/);
 assert.match(html,/Diagnosis suggestions/);
 assert.doesNotMatch(html,/Clinic diagnosis choices|Clinic treatment choices|Record vaccine given/);
});
test('dispensing has manual quantity, correct total and a short Remove action',()=>{
 const html=render(ui.PrescriptionBuilder,{items:[{catalogId:'water',name:'Water Additive Plaque Remover',price:550,quantity:2,instructions:'Vet directions'}],notes:'',onChange(){},onNotes(){}});
 assert.match(html,/Quantity/);assert.match(html,/Product total: ₱1,100/);assert.match(html,/>Remove<\/button>/);
 assert.doesNotMatch(html,/Calculate supply|Items \/ packages to dispense|Dose per administration/);
});
test('admission consent defaults to the saved owner contact without requiring another person',()=>{
 const html=render(ui.AdmissionForm,{mode:'consent',me:me('assistant'),admission:{id:'stay',petName:'Patient',ownerName:'Synthetic Owner',ownerPhone:'+639170000001',revision:0},onClose(){},onSaved(){}});
 assert.match(html,/Primary contact: Synthetic Owner/);assert.match(html,/Add an alternate contact/);
 assert.doesNotMatch(html,/Emergency phone|Emergency contact name|name="emergencyPhone"/);
});

test('check-in reason presets match the booked service',()=>{
 const db=populated(),pet=db.pets[0];
 const appt={id:'intake',petId:pet.id,vetId:'v1',date:'2026-10-25',time:'09:00',reason:'Routine exam',status:'Scheduled',service:'checkup'};
 db.appts=[appt];const html=render(ui.CheckInModal,{...props('assistant',db),appt});
 assert.match(html,/Vomiting \/ Diarrhea/);assert.doesNotMatch(html,/Vaccination: DHPP|Clinical Dispensing Brackets|Grooming &amp; Sanitary/);
});


test('both walk-in entry points expose the saved arrival then measured intake process',()=>{
 const db=populated();
 const registration=render(ui.InClinicRegistration,props('assistant',db));
 assert.match(registration,/Register patient and save arrival/);assert.match(registration,/Registration weight does not complete/);
 assert.match(registration,/name="ownerName" required/);assert.match(registration,/name="species" required/);
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Manila'});
 db.appts=[{id:'rejected',petId:db.pets[0].id,date:today,status:'Rejected'}];
 const existing=render(ui.ExistingPatientCheckInModal,{...props('assistant',db),initialPetId:db.pets[0].id,onCheckIn(){}});
 assert.match(existing,/Review arrival/);assert.doesNotMatch(existing,/Today&#x27;s existing visit/);
 assert.match(existing,/1. Verify patient &amp; save arrival/);assert.match(existing,/name="reason"/);
});

test('pending walk-in patient has registration review before intake',()=>{
 const db=populated();db.pets[0].registrationStatus='Pending';
 db.petRequests=[{id:'pending',petId:db.pets[0].id,status:'Pending'}];
 db.appts=[{id:'legacy-arrival',petId:db.pets[0].id,date:new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Manila'}),status:'Scheduled'}];
 const html=render(ui.ExistingPatientCheckInModal,{...props('assistant',db),initialPetId:db.pets[0].id,onCheckIn(){}});
 assert.match(html,/Review registration/);assert.match(html,/Registration needs review/);assert.doesNotMatch(html,/>Record vitals for this visit</);
});

test('preventive saved records retain visit-specific labels and linked doses',()=>{
 const db=populated(),pet=db.pets[0];
 const record={id:'record1',petId:pet.id,apptId:'visit1',date:'2026-10-26',diagnosis:'Fit for vaccination',treatment:'Vaccinated'};
 db.appts=[{id:'visit1',petId:pet.id,service:'vaccination',reason:'Vaccination',date:record.date}];
 db.vacc=[{id:'dose',petId:pet.id,consultationId:'record1',done:true,vetId:'v1',vaccine:'Linked dose'},{id:'other',petId:pet.id,date:record.date,done:true,vetId:'v1',vaccine:'Unrelated dose'}];
 const html=render(ui.ConsultationDetailModal,{...props('vet',db),record,onClose:()=>{}});
 assert.match(html,/Vaccination record/);assert.match(html,/Linked dose/);
 assert.doesNotMatch(html,/Subjective \(Chief|No prescription recorded|Unrelated dose/);
});
test('reports use saved doctors without invented clinic credentials',()=>{
 const db=populated();db.vets=[{id:'actual',name:'Actual Attending Vet'}];
 db.appts=[{id:'visit',petId:db.pets[0].id,date:'2026-10-26',vetId:'actual',status:'Scheduled'}];
 const html=render(ui.Reports,props('admin',db));
 assert.match(html,/Actual Attending Vet/);assert.doesNotMatch(html,/128 Rizal|Official Document Seal|PVMA Accredited|Official Certified/);
});

test('owner card directs pending registrations back to their existing request',()=>{
 const db=populated();db.pets=db.pets.filter(p=>p.ownerId==='o1').map(p=>({...p,registrationStatus:'Pending'}));
 const page=ui.owner.menu.find(p=>p.k==='vacc');
 const html=render(page.Page,props('owner',db));
 assert.match(html,/Registration review needed/);assert.match(html,/correct the existing request/);
 assert.doesNotMatch(html,/No registered pets yet/);
});

test('vet queue separates previous-day unfinished work without changing clinical priority',()=>{
 const db=populated(),pet=db.pets[0];
 db.appts=[{id:'old',petId:pet.id,vetId:'v1',date:'2000-01-01',time:'09:00',reason:'Previous day care',status:'Checked-in',intakeVitals:{weight:10,temp:38.5,triageLevel:'Routine'}}];
 const html=render(ui.vet.Dash,props('vet',db));
 assert.match(html,/Unfinished from earlier days/);assert.match(html,/Open \d+ days · booked 2000-01-01/);
 assert.match(html,/Next · Assigned veterinarian/);assert.doesNotMatch(html,/waiting in your queue today/);
});



for(const role of ['assistant','admin'])test(`${role} dashboard no longer shows the automatic vaccination recall reminders card`,()=>{
 const html=render(ui.Portal,{...props(role,populated()),cfg:ui[role],onLogout(){}});
 assert.match(html,role==='admin'?/Appointments by Status/:/Vaccine reminders/,'the dashboard itself must be on the page, so this check means something');
 assert.doesNotMatch(html,/Automatic Vaccination Recall Reminders|Worker needs checking|Awaiting initial run/);
});

for(const role of ['owner','assistant','vet','admin'])test(`${role} complete portal renders role navigation with no page edits`,()=>{
 const html=render(ui.Portal,{...props(role,populated()),cfg:ui[role],onLogout(){}});
 assert.match(html,/aria-label="Main"/);assert.match(html,/portal-heading/);assert.doesNotMatch(html,/Leave with unsaved changes/);
});

for(const [service,reason,title,field] of [
 ['checkup','Skin or ear problem','Skin / ear consultation','Onset and affected areas'],
 ['checkup','Limping or injury','Injury / mobility consultation','Affected limb / area'],
 ['checkup','Vomiting or diarrhea','Vomiting / diarrhea consultation','Onset and frequency'],
 ['checkup','Not eating or drinking','Appetite / drinking consultation','When eating or drinking changed'],
 ['checkup','Annual check-up','Wellness / annual check-up','Diet, activity'],
 ['checkup','Follow-up visit','Follow-up / recheck','Changes since the previous visit'],
 ['grooming','Sanitary care','sanitary care','Requested sanitary care'],
])test(`focused clinical form: ${reason}`,()=>{
 const db=populated(),pet=db.pets[0],appt={...db.appts.find(a=>a.petId===pet.id),service,reason,status:'In consultation'};db.appts=[appt];
 const html=render(ui.SoapConsultationModal,{...props('vet',db),pet,appt});
 assert.ok(html.includes(title));assert.ok(html.includes(field));assert.match(html,/name="visitAnswer-/);
 if(service==='grooming')assert.match(html,/confirm grooming was performed/);
});


test('vaccination card makes both next care dates prominent and separates the booked visit',()=>{
 const history={pet:{id:'p1'},events:[{id:'worm',kind:'deworming',vaccine:'Deworming',date:'2026-10-26',nextDue:'2099-01-26'},{id:'rabies',kind:'vaccination',vaccine:'Anti-rabies',date:'2026-10-26',nextDue:'2099-02-26'}]};
 const html=render(ui.NextPreventiveCare,{history,appointments:[{id:'followup',petId:'p1',service:'deworming',reason:'Deworming Follow-up',date:'2099-01-27',time:'09:00',status:'Scheduled'}],onBook:()=>{}});
 for(const text of ['Next deworming','Next vaccination','2099-01-26','2099-02-26','Booked visit: 2099-01-27','Book vaccination','No appointment booked for this treatment'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('Book deworming'),'Already-booked care should not offer duplicate booking');
});
test('My Pets shows correctly labelled deworming and only the owner’s saved transactions',()=>{
 const db=populated();
 db.vacc=[{id:'worm',petId:'p1',vaccine:'Deworming',done:true,vetId:'vet',date:'2026-10-26',nextDue:'2099-01-26'}];
 db.appts=[{id:'paid',petId:'p1',reason:'Recent deworming',status:'Completed',billingStatus:'Paid',amount:250,paidAt:'2026-10-26T01:00:00Z',date:'2026-10-26',time:'09:00',paymentMethod:'Cash'},
 {id:'private',petId:'foreign-pet',reason:'PRIVATE-FOREIGN-TRANSACTION',status:'Completed',billingStatus:'Paid',amount:9999,date:'2099-01-01'}];
 const html=render(ui.owner.Dash,props('owner',db));
 for(const text of ['Next preventive care','Booked visit','Recent transactions','Recent deworming','250.00','View payment'])assert.ok(html.includes(text),text);
 assert.ok(!html.includes('Next vaccine'));assert.ok(!html.includes('PRIVATE-FOREIGN-TRANSACTION'));
});
