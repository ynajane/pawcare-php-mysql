import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import '../../src/styles.css';
import '../../src/portal-polish.css';
import '../../src/roles/admin-workspace.css';
import '../../src/staff-modern.css';
import '../../src/clinical-admin-workspace.css';
import {OwnerVacc} from '../../src/roles/owner/VaccCard.jsx';
import OwnerHeader from '../../src/roles/owner/Header.jsx';
import StaffHeader from '../../src/roles/StaffHeader.jsx';
import {PetFormModal} from '../../src/roles/owner/Pets.jsx';
import {emptyClinicState} from '../../src/clinicState.js';
const owner={id:'owner',name:'Synthetic owner',userId:'client',phone:'+639170000001',email:'synthetic@example.invalid',address:'Synthetic address'};
const client={id:'client',ownerId:'owner',name:owner.name,role:'owner'},staff={id:'staff',name:'Synthetic staff',role:'assistant'};
const base={...emptyClinicState(),owners:[owner],pets:[{id:'one',ownerId:'owner',name:'First patient',species:'Canine',breed:'Aspin',birth:'2024-01-01',sex:'Male',weight:10,registrationStatus:'Verified'},{id:'two',ownerId:'owner',name:'Second patient',species:'Feline',breed:'Puspin',birth:'2025-01-01',sex:'Female',weight:3,registrationStatus:'Verified'}],accountProfiles:{client:{...client,email:owner.email,phone:owner.phone,houseStreet:'Synthetic street',city:'Manila',state:'Metro Manila',country:'Philippines'},staff:{...staff,email:'staff@example.invalid',phone:owner.phone}}};
const root=createRoot(document.getElementById('fixture'));let key=0;
const tick=()=>new Promise(resolve=>setTimeout(resolve,40));
const assert=(condition,message)=>{if(!condition)throw Error(message);};
const until=async fn=>{for(let i=0;i<180;i++){if(fn())return;await tick();}throw Error('Timed out waiting for fixture state');};
const button=(text,scope=document)=>[...scope.querySelectorAll('button')].find(node=>node.textContent.trim()===text);
function edit(selector,value){const input=document.querySelector(selector);Object.getOwnPropertyDescriptor(input.tagName==='SELECT'?HTMLSelectElement.prototype:input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,value);flushSync(()=>{input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});}
function Screen({name}){
 const [db,setDb]=React.useState(()=>{const data=structuredClone(base);data.pets[0].photo=window.initialPhoto;data.accountProfiles.client.photo=window.initialPhoto;data.accountProfiles.staff.photo=window.initialPhoto;return data;});
 window.ownerRecallDb=db;
 const props={db,setDb,me:client,say:message=>window.lastMessage=message,go:(page,context)=>window.lastNavigation={page,context},onLogout:()=>{}};
 return <div className={`shell th-${name==='account-staff'?'assistant':'owner'}`}><div className="main"><main className="content" id="portal-main">
 {name==='owner-card'?<OwnerVacc {...props}/>:name==='account-owner'?<OwnerHeader {...props}/>:name==='account-staff'?<StaffHeader {...props} me={staff}/>:name==='pet-form'?<PetFormModal {...props} onClose={()=>{}}/>:null}
 </main></div></div>;
}
window.showOwnerRecall=name=>{window.lastMessage='';window.lastNavigation=null;flushSync(()=>root.render(<Screen key={++key} name={name}/>));};
window.photoWrites=0;
window.fetch=async(path,options={})=>{
 const url=String(path),json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 if(url.endsWith('/photo') && options.method==='POST'){
  window.photoWrites++;window.photoPath=url;window.photoPayload=JSON.parse(options.body);await new Promise(resolve=>window.photoGate=resolve);
  if(window.photoReply==='fail')return json({error:'Synthetic photo failure'},503);
  if(window.photoReply==='missing')return json({});
  const data=url.includes('/auth/')?{photo:window.photoReply==='wrong'?'different':window.photoPayload.photo}:{success:true,pet:{id:window.photoReply==='wrong'?'other':url.split('/').at(-2),photo:window.photoPayload.photo,weight:999}};
  return json(data);
 }
 if(url.endsWith('/vet-card')){const id=url.split('/').at(-2);return json({history:{pet:base.pets.find(p=>p.id===id),owner,events:[]},document:{}});}
 if(url.includes('/services/prices'))return json({catalog:[]});
 if(options.method && options.method!=='GET')throw Error('Fixture blocks writes');
 return json({});
};
window.checkOwnerRecallFixes=async()=>{
 const canvas=document.createElement('canvas');canvas.width=canvas.height=80;canvas.getContext('2d').fillRect(0,0,80,80);
 window.initialPhoto=canvas.toDataURL('image/png');const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const photo=new File([blob],'patient.png',{type:'image/png'});
 const pick=(selector,file=photo)=>{const input=document.querySelector(selector),data=new DataTransfer();data.items.add(file);input.files=data.files;flushSync(()=>input.dispatchEvent(new Event('change',{bubbles:true})));};
 window.showOwnerRecall('owner-card');await tick();
 edit('#card-pet','two');await until(()=>document.querySelector('.pet-portrait'));
 let writes=window.photoWrites;
 pick('.pet-portrait input',new File(['invalid'],'wrong.txt',{type:'text/plain'}));await tick();assert(document.body.textContent.includes('Only JPG') && window.photoWrites===writes,'Owner gets inline file feedback');
 for(const reply of ['fail','missing','wrong','saved']){
  window.photoReply=reply;pick('.pet-portrait input');writes++;await until(()=>window.photoWrites===writes);
  assert(document.querySelector('#card-pet').matches(':disabled') && button('Book a visit').matches(':disabled'),'Owner cannot switch patient or book during upload');
  assert(window.photoPath.includes('/two/photo'),'Upload belongs to selected patient');
  pick('.pet-portrait input');await tick();assert(window.photoWrites===writes,'Owner upload lock rejects overlapping selection');
  const leave=new Event('beforeunload',{cancelable:true});window.dispatchEvent(leave);assert(leave.defaultPrevented,'In-flight upload guards browser reload');
  window.photoGate();await until(()=>!document.querySelector('#card-pet').matches(':disabled'));
  const saved=window.ownerRecallDb.pets.find(p=>p.id==='two');
  assert(saved.weight===3 && window.ownerRecallDb.pets[0].photo===window.initialPhoto,'Photo saves preserve measurements and other patient');
  assert(saved.photo===(reply==='saved'?window.photoPayload.photo:undefined),'Only confirmed matching owner photo replaces saved value');
  assert(reply==='saved'?document.body.textContent.includes('Pet photo saved.'):!!document.querySelector('[role=alert]'),'Owner photo outcome visible');
 }
 window.photoReply='saved';document.querySelector('[aria-label="Remove pet photo"]').click();writes++;await until(()=>window.photoWrites===writes);window.photoGate();await until(()=>document.body.textContent.includes('Pet photo removed.'));
 edit('#card-pet','one');await tick();assert(!document.body.textContent.includes('Pet photo removed.'),'Photo feedback belongs to selected patient');
 for(const name of ['account-owner','account-staff']){
  window.showOwnerRecall(name);await tick();document.querySelector('[aria-label="Account menu"]').click();await tick();[...document.querySelectorAll('[role=menuitem]')].find(node=>node.textContent.toLowerCase().includes('profile')).click();await tick();
  edit('#pcity','Changed city');await tick();const profileId=name==='account-owner'?'client':'staff';
  for(const reply of ['missing','wrong','fail','saved']){
   window.photoReply=reply;pick('.ow-photo input');writes++;await until(()=>window.photoWrites===writes);await tick();
   assert(window.photoPath==='/api/auth/profile/photo','Account photo uses own profile endpoint');
   document.querySelector('dialog.clinic-dialog').dispatchEvent(new Event('cancel',{cancelable:true}));await tick();
   assert(document.querySelector('dialog.clinic-dialog') && !document.querySelector('dialog.submission-review'),'Profile stays open during photo upload');
   pick('.ow-photo input');await tick();assert(window.photoWrites===writes,'Profile upload prevents overlap');
   window.photoGate();await until(()=>!button('Working…'));
   assert(document.querySelector('#pcity').value==='Changed city','Photo operation retains contact draft');
   assert(reply==='saved'?window.lastMessage==='Profile picture saved':!!document.querySelector('.ow-photo .err'),'Account reports confirmed outcome');
   assert(window.ownerRecallDb.accountProfiles[profileId].photo===(reply==='saved'?window.photoPayload.photo:window.initialPhoto),'Failed/unconfirmed account upload preserves saved photo');
  }
  document.querySelector('dialog.clinic-dialog').dispatchEvent(new Event('cancel',{cancelable:true}));await tick();
  assert(document.querySelector('dialog.submission-review'),'Contact draft is still guarded after photo save');button('Back to edit',document.querySelector('dialog.submission-review')).click();await tick();
 }
 window.showOwnerRecall('pet-form');await tick();pick('.ow-photo input');await until(()=>document.querySelector('.ow-photo img'));
 assert(window.photoWrites===writes,'Registration photo stays a draft until form submission');
 const result={ownerPhotoAcknowledgements:4,profilePhotoAcknowledgements:8,multiPetIsolation:true,profileBusyAndDraftGuard:true,registrationPhotoDraft:true,viewport:[innerWidth,innerHeight]};
 document.getElementById('results').textContent='PASS: '+JSON.stringify(result);return result;
};
window.showOwnerRecall('owner-card');
