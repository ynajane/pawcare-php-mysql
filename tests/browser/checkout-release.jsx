// Synthetic API responses: no database, payment or clinical writes.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import BillingModal from '../../src/roles/BillingModal.jsx';
import {emptyClinicState} from '../../src/clinicState.js';
import '../../src/styles.css';
const root=createRoot(document.getElementById('fixture'));
const realFetch=window.fetch;
const assert=(value,message)=>{if(!value)throw Error(message);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await tick();}throw Error('Timed out');}
let key=0,failRead=false,failRelease=false,invalidRelease=false,readOverride=null,duplicatePayment=false,payments=0,releases=0,lastRequest,db;
const item={catalogId:'srv_consult',name:'Saved consultation',category:'Consultation',price:600,qty:1,source:'performed'};
const base={id:'visit',petId:'pet',date:'2026-10-27',time:'09:00',reason:'Consultation',status:'Completed',billingStatus:'Unpaid',admissionStatus:'Ready for discharge',admissionId:'stay',invoiceItems:[item]};
const me={id:'assistant',role:'assistant',name:'Synthetic assistant'};
let admission;
function reset(){
 admission={id:'stay',apptId:'visit',petName:'Synthetic patient',revision:1,status:'Ready for discharge',billingStatus:'Unpaid',dischargeInstructions:'Keep the patient comfortable. Follow the saved prescription.'};
 db={...emptyClinicState(),pets:[{id:'pet',name:'Synthetic patient',ownerId:'owner'}],owners:[{id:'owner',name:'Synthetic owner'}],appts:[{...base}]};
}
window.fetch=async(path,options={})=>{
 const url=String(path),body=options.body?JSON.parse(options.body):{};
 let data,status=200;
 if(url.includes('/services/prices'))data={catalog:[]};
 else if(url.endsWith('/claim'))data={claimToken:'synthetic-claim',invoiceItems:[item],prescriptionItems:[]};
 else if(url.includes('/checkout-inbox/') && (url.endsWith('/release') || url.endsWith('/renew')))data={};
 else if(url.endsWith('/billing')){
  if(duplicatePayment){status=409;data={error:'This payment reference was already used to settle another invoice.'};}
  else {payments++;admission.billingStatus='Paid';
   data={success:true,appointment:{...base,...body,paidAt:new Date().toISOString()}};}
 }else if(url==='/api/admissions/stay' && (!options.method || options.method==='GET')){
  if(failRead){status=503;data={error:'Synthetic admission read failure'};}else data={admission:readOverride || admission};
 }else if(url==='/api/admissions/stay/release'){
  releases++;lastRequest=body;
  assert(body.revision===1 && body.requestId,'Release needs saved revision and request ID');
  if(invalidRelease)data={success:true,admission:invalidRelease==='wrong-visit' ? {...admission,status:'Discharged',revision:2,dischargedAt:new Date().toISOString(),apptId:'another-visit'} : invalidRelease==='missing-time' ? {...admission,status:'Discharged',revision:2,dischargedAt:null} : admission};
  else if(failRelease){status=503;data={error:'Synthetic release failure'};}
  else {admission={...admission,status:'Discharged',revision:2,dischargedAt:new Date().toISOString()};data={success:true,admission};}
 }else throw Error(`Unexpected request ${url}`);
 return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
};
async function mount(appt=db.appts[0],role=me){
 flushSync(()=>root.render(<BillingModal key={++key} appt={appt} db={db} me={role} setDb={updater=>{db=updater(db);}} onClose={()=>{}}/>));await tick();
}
async function edit(selector,value){const el=document.querySelector(selector);assert(el,`Missing ${selector}`);
 flushSync(()=>{Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));});await tick();}
async function click(text,scope=document){const button=[...scope.querySelectorAll('button')].find(b=>b.textContent===text);assert(button,`Missing button ${text}`);flushSync(()=>button.click());await tick();}
async function submit(){const form=[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('form');flushSync(()=>form.requestSubmit());await tick();}
async function run(){try{
 reset();await mount();await until(()=>document.querySelector('fieldset') && !document.querySelector('fieldset').disabled);
 await edit('#billing-cash','600');await submit();await click('Confirm payment',document.querySelector('.submission-review'));
 await until(()=>document.body.textContent.includes('Status remains Ready for discharge'));
 assert(payments===1 && releases===0,'Payment must not release a pet');
 assert(document.body.textContent.includes(admission.dischargeInstructions),'Show saved home-care instructions');
 // A receipt opened later must still offer release.
 await mount(db.appts[0]);await until(()=>document.body.textContent.includes('Status remains Ready for discharge'));
 await click('Confirm release to owner');await edit('textarea[name="clinicalNote"]','Released to the owner after reviewing home-care instructions.');
 await submit();assert(releases===0,'Review alone must not record release');
 failRelease=true;await click('Confirm release to owner',document.querySelector('.submission-review'));
 await until(()=>document.body.textContent.includes('Synthetic release failure'));
 assert(document.querySelector('textarea[name="clinicalNote"]').value.includes('Released to the owner'),'Failed release retains entries');
 const requestId=lastRequest.requestId;
 failRelease=false;
 for(const invalid of ['pending','wrong-visit','missing-time']){
  invalidRelease=invalid;await submit();
  const review=document.querySelector('.submission-review');
  assert(review.textContent.includes('Review pet release') && review.textContent.includes('Paid') && review.textContent.includes(admission.dischargeInstructions),'Release review must show saved payment and home-care instructions');
  await click('Confirm release to owner',review);
  await until(()=>document.body.textContent.includes('The server did not confirm this release'));
  assert(db.appts[0].admissionStatus==='Ready for discharge','Incomplete acknowledgment cannot update visit status');
 }
 invalidRelease=false;failRead=true;await submit();await click('Confirm release to owner',document.querySelector('.submission-review'));
 await until(()=>document.body.textContent.includes('Release to the owner has been recorded.'));
 assert(lastRequest.requestId===requestId,'Retry keeps idempotency key');
 assert(db.appts[0].admissionStatus==='Discharged','Update visit status only after saved release');
 assert(payments===1,'Release retry must not repeat payment');
 await until(()=>document.body.textContent.includes('Retry release status'));
 assert(document.body.textContent.includes('Release to the owner has been recorded.'),'Failed refresh must retain the saved Discharged confirmation');
 readOverride={...admission,status:'Ready for discharge',revision:1,dischargedAt:null};failRead=false;
 await click('Retry release status');
 assert(document.body.textContent.includes('Release to the owner has been recorded.'),'Stale refresh must not undo the confirmed release');
 assert(![...document.querySelectorAll('button')].some(b=>b.textContent==='Confirm release to owner'),'Stale refresh must not offer another release');
 readOverride=null;
 // Reads fail visibly without hiding the saved receipt.
 admission={...admission,status:'Ready for discharge',revision:1};failRead=true;await mount(db.appts[0]);
 await until(()=>document.body.textContent.includes('Retry release status'));
 assert(document.body.textContent.includes('Official receipt'),'Keep receipt available during read failure');
 failRead=false;await click('Retry release status');await until(()=>document.body.textContent.includes('Status remains Ready for discharge'));
 admission.billingStatus='Unpaid';await mount(db.appts[0]);await until(()=>document.body.textContent.includes('Waiting for the saved payment'));
 assert([...document.querySelectorAll('button')].find(b=>b.textContent==='Confirm release to owner').disabled,'Unpaid admission cannot release');
 admission.billingStatus='Paid';await mount(db.appts[0],{...me,role:'owner'});
 assert(!document.querySelector('[aria-label="Pet release after payment"]'),'Owner cannot release from receipt');
 // An outpatient has no admission link.
 db.appts=[{...db.appts[0],admissionId:null,admissionStatus:null}];await mount();
 assert(!document.querySelector('[aria-label="Pet release after payment"]'),'Outpatient receipt has no release action');
 reset();await mount();await until(()=>document.querySelector('fieldset') && !document.querySelector('fieldset').disabled);
 await edit('select','GCash');await edit('input[name="refNo"]','USED-REFERENCE');
 const paidBefore=payments,releasedBefore=releases;
 duplicatePayment=true;await submit();await click('Confirm payment',document.querySelector('.submission-review'));
 await until(()=>document.body.textContent.includes('This payment reference was already used'));
 assert(document.querySelector('input[name="refNo"]').value==='USED-REFERENCE','Rejected payment retains entered reference');
 assert(payments===paidBefore && db.appts[0].billingStatus==='Unpaid','Rejected duplicate must not mark invoice paid');
 duplicatePayment=false;await edit('input[name="refNo"]','DISTINCT-REFERENCE');
 await submit();await click('Confirm payment',document.querySelector('.submission-review'));
 await until(()=>document.body.textContent.includes('Payment recorded'));
 assert(payments===paidBefore+1 && releases===releasedBefore,'Corrected reference saves one payment without release');
 return {passed:true,checks:['payment leaves release pending','saved home-care instructions','reopened paid receipt offers release','explicit release review','failure retains entries','idempotent release retry','saved Discharged status','incomplete/wrong-visit/missing-time acknowledgments rejected','release review includes saved payment and instructions','confirmed release survives stale refresh','saved release survives failed refresh','receipt survives read failure','read retry','unpaid guard','owner guard','outpatient receipt','duplicate payment reference retains input and unpaid status','distinct reference retries without releasing pet']};
}finally{flushSync(()=>root.unmount());window.fetch=realFetch;}}
window.checkoutReleaseResult=run().then(result=>{document.getElementById('results').textContent=JSON.stringify(result,null,2);return result;}).catch(error=>{document.getElementById('results').textContent=error.stack;throw error;});
