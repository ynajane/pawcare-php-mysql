import ExistingClinicRecord from './owner/ExistingClinicRecord.jsx';
import { isVerifiedPet, needsFirstPetSetup } from '../ownerOnboarding.js';
import { PaginatedList } from "../components/Pagination.jsx";
import AdmissionsPage, { AdmissionsSummary } from './AdmissionsPage.jsx';
import OwnerBills, {RecentTransactions} from "./owner/Bills.jsx";
import { today as bookingToday } from "../booking.js";
import { currentVaccinationDue, nextVaccination, vaccinationStatus } from "../ownerVaccination.js";
import CareFollowUps from "./CareFollowUps.jsx";
import Prices from "./owner/Prices.jsx";
import { useState } from "react";
import { I, Hero, ICON, Badge, scope, petName } from "../lib.jsx";
import OwnerAppts from "./owner/Appts.jsx";
import { OwnerVacc } from "./owner/VaccCard.jsx";
import { OwnerVisits } from "./owner/Visits.jsx";
import OwnerHeader from "./owner/Header.jsx";
import { PetFormModal, PetProfileModal, RequestList, myRequests, addBlock } from "./owner/Pets.jsx";
import { setPrefill, petAge, fmt12, Avatar, pick, Icon } from "./owner/ui.jsx";
import "./owner/owner.css";
import "./owner/owner-modern.css";   // keep AFTER owner.css so the refreshed look wins
import "./owner/owner-redesign.css";   // field states, search box and page layouts; keep LAST

const LIVE = ["Pending Approval", "Scheduled", "Checked-in", "In consultation"];
function Dash({ db, setDb, me, go, say }) {
  const TODAY = bookingToday();
  const [modal, setModal] = useState(null);   // { form, editing } or { profile }
  const registered = scope(db, me, "pets"), pets = registered.filter(isVerifiedPet), A = scope(db, me, "appts"), V = scope(db, me, "vacc"), reqs = myRequests(db, me);
  const blocked = addBlock(db, me);
  const book = (petId, reason) => { setPrefill(petId ? { petId, reason } : null); go("appts"); };
  const recalls = currentVaccinationDue(V);
  const over = recalls.filter(v => v.nextDue < TODAY);
  const upcoming = A.filter(a => LIVE.includes(a.status) && a.date >= TODAY).length;
  const dueVacc = recalls.filter(v => vaccinationStatus(v, recalls) !== "On track").length;
  const first = me.name.split(" ")[0];
  const steps = [
    ["plus", "Add your pet", "Name, species, birth date and weight.", () => setModal({ form: true })],
    ["calendar", "Request a visit", "Available once the clinic has verified your pet.", () => book()],
    ["clock", "The clinic reviews it", "Track registration and appointment updates here."],
  ];

  return (<>
    <section className="ow-hero">
      <img className="ow-hero-pic" src="/images/hero-pets.jpg" alt="" aria-hidden="true" />
      <div className="ow-hero-head">
        <div>
          <h2>Hi {first}!</h2>
          <p>Here’s how your pets are doing.</p>
        </div>
        <div className="ow-hero-acts">
          <button className="btn glass" onClick={()=>setModal({link:true})}>Link clinic records</button>
          <button className="btn glass" onClick={() => go("bills")}>Bills & payments</button>
          <button className="btn glass" onClick={() => go("prices")}>View services & prices</button>
          {pets.length > 0 && <button className="btn gold" onClick={() => book()}><Icon n="calendar" size={16} /> Book a visit</button>}
          <button className={pets.length ? "btn glass" : "btn gold"} disabled={!!blocked} title={blocked} onClick={() => setModal({ form: true })}><Icon n="plus" size={16} /> Add my pet</button>
        </div>
      </div>
      {pets.length > 0 && (
        <ul className="ow-hero-stats" aria-label="Summary">
          <li><b>{pets.length}</b><span>{pets.length === 1 ? "Pet" : "Pets"}</span></li>
          <li><b>{upcoming}</b><span>Upcoming {upcoming === 1 ? "visit" : "visits"}</span></li>
          <li className={dueVacc ? "warn" : ""}><b>{dueVacc}</b><span>{dueVacc === 1 ? "Treatment" : "Treatments"} due</span></li>
        </ul>
      )}
      {!pets.length && !reqs.length && (
        <div className="ow-start">
          <p>Let’s set up your first pet. Your account is ready.</p>
          <ol className="ow-steps">
            {steps.map(([ic, t, d, fn], i) => {
              const act = fn ? { role: "button", tabIndex: 0, onClick: fn, onKeyDown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } } } : {};
              return (
                <li key={t} className={fn ? "clickable" : ""} {...act}>
                  <span className="ow-step-ico"><Icon n={ic} size={20} /></span>
                  <div><b>{i + 1}. {t}</b><small>{d}</small></div>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </section>

    {over.length > 0 && <div className="ow-banner"><Icon n="alert" size={20} /><span><b>Preventive care overdue:</b> {over.map(v => `${petName(db, v.petId)} (${v.vaccine})`).join(", ")}</span><button className="btn sm" onClick={() => go("vacc")}>View records</button></div>}
    <CareFollowUps db={db} go={go} owner />
    <AdmissionsSummary me={me} go={go} />
    <RequestList db={db} setDb={setDb} me={me} say={say} onEdit={r => setModal({ form: true, editing: r })} onBook={book} />
    {pets.length ? <PaginatedList label="My pets" resetKey={null} className="petgrid">{pets.map(p => {
      const { recall: nv, appointment: nvAppt, matched } = nextVaccination(p.id, V, A, TODAY);
      const na = A.filter(a => a.petId === p.id && LIVE.includes(a.status) && a.date >= TODAY).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
      return <article className="petcard" key={p.id} role="button" tabIndex={0} aria-label={`${p.name}, open pet details`} onClick={() => setModal({ profile: p })} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setModal({ profile: p }); } }}>
        <div className="pc-top">
          <div className="big"><Avatar src={p.photo} fallback={<I e={ICON[p.species]} size={40} />} size={84} round={false} /></div>
          <div className="pc-id"><h3>{p.name}</h3><p>{p.breed || p.species}</p></div>
        </div>
        <div className="pc-tags">{p.sex && <span>{p.sex}</span>}{p.weight ? <span>{p.weight} kg</span> : null}{p.birth ? <span>{petAge(p.birth)}</span> : null}</div>
        <div className="kv pc-vaccine"><span>Next preventive care</span>
          {nvAppt ? <>
            <b>{matched?.vaccine || nvAppt.reason?.replace(/^vaccination\s*[–:-]\s*/i, "") || "Preventive care visit"}</b>
            <div className="pc-vaccine-detail"><Icon n="calendar" size={15} /><span>Visit: {nvAppt.date}{nvAppt.time ? ` at ${fmt12(nvAppt.time)}` : " · Time to be confirmed"}</span><Badge v={nvAppt.status} /></div>
          </> : <b>{nv ? nv.vaccine : "No preventive care scheduled"}</b>}
          {nv ? <>
            <div className="pc-vaccine-detail"><span>Vet-approved due: {nv.nextDue}{nvAppt && matched?.id !== nv.id ? ` · ${nv.vaccine}` : ""}</span><Badge v={vaccinationStatus(nv, recalls, TODAY)} /></div>
            {matched?.id !== nv.id && <small>Contact the clinic to book this treatment.</small>}
          </> : <small>{nvAppt ? nvAppt.service==='deworming' ? "Next deworming due date not recorded. Confirm it with your vet at this visit." : "Booster date not recorded. Confirm the next dose with your vet at this visit." : "Ask the clinic to confirm the next vaccination or deworming date."}</small>}
        </div>
        <div className="kv"><span>Booked visit</span><b>{na ? <>{na.date} {fmt12(na.time)} <Badge v={na.status} /></> : "None booked"}</b></div>
        <small className="pc-more">View details <Icon n="chevron" size={14} /></small></article>;
    })}</PaginatedList> : null}
    {!pets.length && reqs.length > 0 && <div className="empty sm">Your saved pets are listed above. You can request an appointment while verification is pending.</div>}
    <RecentTransactions db={db} me={me} go={go}/>
    {modal?.link && <ExistingClinicRecord me={me} onClose={()=>setModal(null)} />}
    {modal && modal.form && <PetFormModal db={db} setDb={setDb} me={me} say={say} editing={modal.editing} onClose={() => setModal(null)} />}
    {modal && modal.profile && <PetProfileModal pet={modal.profile} db={db} setDb={setDb} me={me} onClose={() => setModal(null)} onVacc={() => { pick.petId = modal.profile.id; go("vacc"); }} onBook={(pid, rsn) => book(pid || modal.profile.id, rsn)} />}
  </>);
}
const P = (k, l, i, sub, Page, s) => ({ k, l, i, sub, Page, s });
export function FirstPetSetup({db,setDb,me,say,go,onLogout}) {
  const [existing,setExisting]=useState(false);
  if(!needsFirstPetSetup(db,me)) return null;
  if(existing)return <ExistingClinicRecord required me={me} onLogout={onLogout} onClose={()=>setExisting(false)} />;
  return <PetFormModal onExistingRecord={()=>setExisting(true)} requiredSetup db={db} setDb={setDb} me={me} say={say} onLogout={onLogout} onClose={()=>go('home')} />;
}
export const owner = { Onboarding:FirstPetSetup, portal: "Pet Owner Portal", Dash, Header: OwnerHeader, menu: [
  { k: "home", l: "My Pets", s: "Pets", i: "paw", dash: 1, sub: "Your pets, their profiles, next treatments, visits and recent transactions." },
  P("appts", "My Appointments", "calendar", "Book, change or cancel a visit. Switch between the list and the calendar.", OwnerAppts, "Visits"),
  P('admissions', 'Pet Admission Updates', 'hospital', 'Clinic-shared updates during your pet’s stay and discharge instructions.', AdmissionsPage, 'Updates'),
  P("prices", "Services & Prices", "file", "Official clinic service and product prices.", Prices, "Prices"),
  P("bills", "Bills & Payments", "receipt", "View saved charges, checkout status and payment records.", OwnerBills, "Bills"),
  P("vacc", "Vaccination Cards", "syringe", "Pick a pet to see its vaccination card.", OwnerVacc, "Vaccines"),
  P("records", "Visit History", "file", "Diagnoses and treatments from past visits.", OwnerVisits, "History")] };
