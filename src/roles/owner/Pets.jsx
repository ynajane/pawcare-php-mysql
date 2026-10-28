import {useUnsavedChanges} from '../../components/useUnsavedChanges.jsx';
import ExternalHistory, {ExternalHistorySummary} from '../../components/ExternalHistory.jsx';
import {externalHistoryErrors} from '../../externalHistory.js';
import VitalsHistory from '../VitalsHistory.jsx';
import {weightSourceLabel} from '../../vitalLabels.js';
import ClinicDialog from '../../components/ClinicDialog.jsx';
import { isVerifiedPet, registrationPatient } from '../../ownerOnboarding.js';
import { reviewedRequest } from '../../registrationReview.js';
import { PaginatedList } from "../../components/Pagination.jsx";
import {HistoryControls,useHistoryComplete} from "../../ClinicHistory.jsx";
import { useSubmissionReview } from "../../components/SubmissionReview.jsx";
import { useRef, useState } from "react";
import { TODAY, scope, uid, addLog, ICON } from "../../lib.jsx";
import { useLive, Field, Modal, petAge, fmt12, onlyDecimal, Icon, PhotoUpload } from "./ui.jsx";
import {
  computeAgeDetails,
  computeWeightBracket,
  normalizeSpecies,
  formatSpeciesLabel
} from "../../preventiveSchedule.js";
import { petPlausibility } from "../../petLimits.js";
import { currentVaccinationDue, vaccinationStatus } from "../../ownerVaccination.js";
import { today as clinicToday } from "../../booking.js";
import { petBirthError, PET_BIRTH_EARLIEST } from "../../dateRules.js";
const clinicDay = () => clinicToday();
import { api } from "../../api.js";

/* ---------- Clinical Species Classification (VCMS Protocols v2.0) ---------- */
export const SPECIES = [
  "Canine (Dog)",
  "Feline (Cat)",
  "Lagomorph (Rabbit)",
  "Rodent (Hamster / Guinea Pig / etc.)",
  "Avian (Bird)",
  "Other"
];

export const NEUTERED = ["Yes", "No", "Not sure"];


export const PET_COLORS = [
  "Black",
  "White",
  "Brown / Chocolate",
  "Tan / Fawn",
  "Golden / Yellow",
  "Cream / Blonde",
  "Red / Ginger / Orange",
  "Gray / Blue / Silver",
  "Tricolor (Black, White & Tan)",
  "Bicolor / Tuxedo (Black & White)",
  "Brown & White",
  "Brindle (Tiger-striped)",
  "Merle / Dapple (Marbled)",
  "Calico (Tri-color patches)",
  "Tortoiseshell (Tortie)",
  "Tabby (Striped / Swirls)",
  "Sable",
  "Spotted",
  "Other / Custom markings (type below)"
];

export const MAX_PETS = 10;      // approved pets + requests on one account
export const MAX_PENDING = 3;    // requests waiting for the clinic at one time
export const MAX_NOTES = 200;

export const BREEDS_BY_SPECIES = {
  "Canine (Dog)": [
    "Aspin (Philippine Native Dog)",
    "Shih Tzu",
    "Pomeranian",
    "Golden Retriever",
    "Labrador Retriever",
    "Siberian Husky",
    "Poodle (Toy / Standard)",
    "French Bulldog",
    "German Shepherd",
    "Beagle",
    "Pug",
    "Chihuahua",
    "Pembroke Welsh Corgi",
    "Rottweiler",
    "Chow Chow",
    "Doberman Pinscher",
    "Belgian Malinois",
    "Yorkshire Terrier",
    "Boxer",
    "Dachshund",
    "Alaskan Malamute",
    "Samoyed",
    "Maltese",
    "Jack Russell Terrier",
    "Other / Mixed (type your own)"
  ],
  "Feline (Cat)": [
    "Puspin (Philippine Domestic Short Hair)",
    "Persian",
    "Siamese",
    "British Shorthair",
    "Maine Coon",
    "Bengal",
    "Ragdoll",
    "Scottish Fold",
    "Russian Blue",
    "Sphynx",
    "American Shorthair",
    "Abyssinian",
    "Birman",
    "Himalayan",
    "Other / Mixed (type your own)"
  ],
  "Lagomorph (Rabbit)": [
    "Netherland Dwarf",
    "Holland Lop",
    "Mini Rex",
    "Lionhead",
    "Flemish Giant",
    "Angora",
    "Dutch Rabbit",
    "Mini Lop",
    "English Spot",
    "Other / Mixed (type your own)"
  ],
  "Rodent (Hamster / Guinea Pig / etc.)": [
    "Syrian Hamster (Golden / Teddy Bear)",
    "Roborovski Dwarf Hamster",
    "Winter White Dwarf Hamster",
    "Campbell's Dwarf Hamster",
    "Guinea Pig (Abyssinian)",
    "Guinea Pig (American / Short-haired)",
    "Guinea Pig (Peruvian / Long-haired)",
    "Chinchilla (Standard Gray / Mutation)",
    "Fancy Rat (Dumbo / Standard)",
    "Fancy Mouse",
    "Degu",
    "Mongolian Gerbil",
    "Other / Mixed (type your own)"
  ],
  "Avian (Bird)": [
    "Parakeet / Budgerigar (Budgie)",
    "Cockatiel",
    "Lovebird (Agapornis)",
    "African Grey Parrot",
    "Canary",
    "Zebra Finch",
    "Green-cheeked Conure",
    "Sun Conure",
    "Cockatoo",
    "Macaw",
    "Monk Parakeet (Quaker)",
    "Indian Ringneck Parakeet",
    "Dove / Pigeon",
    "Other (type your own)"
  ],
  "Other": [
    "Other (type your own)"
  ]
};

// Aliases for backward compatibility
BREEDS_BY_SPECIES.Dog = BREEDS_BY_SPECIES["Canine (Dog)"];
BREEDS_BY_SPECIES.Cat = BREEDS_BY_SPECIES["Feline (Cat)"];
BREEDS_BY_SPECIES.Rabbit = BREEDS_BY_SPECIES["Lagomorph (Rabbit)"];
BREEDS_BY_SPECIES.Rodent = BREEDS_BY_SPECIES["Rodent (Hamster / Guinea Pig / etc.)"];
BREEDS_BY_SPECIES.Bird = BREEDS_BY_SPECIES["Avian (Bird)"];

export const GUIDANCE_BY_SPECIES = {
  "Canine (Dog)": "Canine Protocol (VCMS v2.0): Bi-weekly deworming starts at Day 14, switching to monthly at Day 90. Core DHPP starts at 6 weeks (Day 42), with Rabies at 12+ weeks (Day 84). Flea/tick/heartworm starts at 8 weeks. Strict heartworm antigen testing required for dogs >= 7 months with safety gaps.",
  "Feline (Cat)": "Feline Protocol (VCMS v2.0): Bi-weekly deworming starts at Day 14 (transitions to quarterly at 6 months). FVRCP 4-in-1 core immunization starts at 6 weeks, with Rabies at 12+ weeks. Strict toxicology block: Never use Permethrin formulas on felines.",
  "Lagomorph (Rabbit)": "Lagomorph Protocol (VCMS v2.0): Annual RHDV1/RHDV2 vaccination starts at Day 35. High-fiber timothy hay (80%+) is vital. Strict toxicology block: Fipronil (Frontline) is strictly prohibited due to fatal neurotoxicity.",
  "Rodent (Hamster / Guinea Pig / etc.)": "Rodent Protocol (VCMS v2.0): Continuous elodont dentition requires semi-annual molar and incisor occlusion surveillance. Monitor for incisor overgrowth, molar spurs, and wet chin / drooling.",
  "Avian (Bird)": "Avian Protocol (VCMS v2.0): Annual fecal float screening at 6 months. Home Hazard Warning: Inhaled PTFE/Teflon cookware fumes and aerosol sprays cause fatal hemorrhagic respiratory failure.",
  "Other": "Other species: the veterinarian will advise on the right care and preventive visits for this pet after the first examination."
};

// Pet birth dates: January 1, 2000 up to and including today (clinic day, Asia/Manila).
export { PET_BIRTH_EARLIEST as OLDEST } from "../../dateRules.js";

const LETTER = /[A-Za-zÀ-ÿ]/;
const NAME_RE = /^[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 .'\-]*$/;
const DECIMAL = /^(\d{1,3}(\.\d{1,2})?|\.\d{1,2})$/;

/* Typing guard for free text: drops characters that don't belong. */
export const petText = s => s.replace(/[^A-Za-zÀ-ÿ0-9 .,'\-\/()]/g, "").replace(/^\s+/, "").replace(/\s{2,}/g, " ");


/* v = form values, taken = lower-case names this owner already has (pets and requests). Returns { field: message }. */
export function validatePet(v, taken = []) {
  const e = {...externalHistoryErrors(v)}, name = v.name.trim();
  if (!name) e.name = "Enter your pet’s name";
  else if (name.length < 2) e.name = "Use at least 2 characters";
  else if (name.length > 30) e.name = "Keep the name under 30 characters";
  else if (!NAME_RE.test(name)) e.name = "Start with a letter or number. Use letters, numbers and . ' - only";
  else if (!LETTER.test(name)) e.name = "The name needs at least one letter";
  else if (taken.includes(name.toLowerCase())) e.name = `You already have a pet named ${name}`;

  if (!v.species) e.species = "Select pet species classification";
  else if (!SPECIES.includes(v.species) && !Object.keys(BREEDS_BY_SPECIES).includes(v.species)) e.species = "Pick a species from the list";
  else if (v.species.includes("Other")) {
    const o = v.other.trim();
    if (!o) e.other = "Tell us what kind of animal it is";
    else if (o.length < 3) e.other = "Use at least 3 characters";
    else if (o.length > 30) e.other = "Keep it under 30 characters";
    else if (!LETTER.test(o)) e.other = "Use words, not only numbers or symbols";
  }

  const br = v.breed.trim();
  if (br.length > 50) e.breed = "Keep the breed under 50 characters";
  else if (br && !LETTER.test(br)) e.breed = "Use words, not only numbers or symbols";

  if (!v.sex) e.sex = "Choose male or female";
  else if (!["Male", "Female"].includes(v.sex)) e.sex = "Pick one from the list";

  const birthProblem = petBirthError(v.birth, clinicToday());
  if (birthProblem) e.birth = birthProblem;

  if (v.weight === "") e.weight = "Enter your pet’s weight in kg";
  else if (!DECIMAL.test(v.weight)) e.weight = "Use numbers only, for example 4.5";
  else if (+v.weight < 0.05) e.weight = "Weight must be at least 0.05 kg";
  else if (+v.weight > 120) e.weight = "Weight can’t be more than 120 kg";

  if (!v.neutered) e.neutered = "Choose one";
  else if (!NEUTERED.includes(v.neutered)) e.neutered = "Pick one from the list";

  const c = v.color.trim();
  if (c.length > 40) e.color = "Keep it under 40 characters";
  else if (c && !LETTER.test(c)) e.color = "Use words, not only numbers or symbols";


  // The server applies the same species limits (src/petLimits.js).
  if (v.species && v.birth && v.weight !== "") for (const [key, message] of Object.entries(petPlausibility({species: v.species, weight: v.weight, birth: v.birth, today: TODAY}))) e[key] ||= message;
  const n = v.notes.trim();
  if (n.length > MAX_NOTES) e.notes = `Keep notes under ${MAX_NOTES} characters`;
  else if (n && !LETTER.test(n)) e.notes = "Write a few words, not only numbers or symbols";
  return e;
}

export const myRequests = (db, me) => (db.petRequests || []).filter(r => (r.ownerId === me.ownerId || r.ownerId === me.id) && r.status !== "Approved");

export const addBlock = (db, me) => {
  const have = scope(db, me, "pets").filter(isVerifiedPet).length, reqs = myRequests(db, me);
  if (have + reqs.length >= MAX_PETS) return `One account can hold up to ${MAX_PETS} pets`;
  if (reqs.filter(r => r.status === "Pending").length >= MAX_PENDING) return `${MAX_PENDING} requests are already waiting for the clinic. Wait for a reply before adding more`;
  return "";
};

const kind = p => (p.species && p.species.includes("Other") && p.speciesOther) ? p.speciesOther : formatSpeciesLabel(p.species);

/* ---------- Add / edit a pet request ---------- */
export function PetFormModal({ db, setDb, me, say, editing, onClose, requiredSetup = false, onLogout, onExistingRecord }) {
  const e0 = editing || {};
  const taken = [...scope(db, me, "pets").filter(isVerifiedPet), ...myRequests(db, me).filter(r => !editing || r.id !== editing.id)].map(p => p.name.trim().toLowerCase());
  
  // Normalize initial species
  const initialSpecies = e0.species ? formatSpeciesLabel(e0.species) : "";

  const f = useLive({
    name: e0.name || "",
    species: initialSpecies || "",
    other: e0.speciesOther || "",
    breed: e0.breed || "",
    sex: e0.sex || "",
    birth: e0.birth || "",
    weight: e0.weight != null ? String(e0.weight) : "",
    neutered: e0.neutered || "",
    color: e0.color || "",
    dentalOcclusion: "",
    priorVaccines:e0.priorVaccines || [],externalClinicNotes:e0.externalClinicNotes || "",
    notes: e0.notes || ""
  }, v => validatePet(v, taken));

  const { v } = f, [top, setTop] = useState("");
  const [photo,setPhoto] = useState(e0.photo || "");
  const [saving,setSaving] = useState(false);
  const [uploading,setUploading] = useState(false);
  const savingRef = useRef(false);
  const unsaved=useUnsavedChanges({value:{...v,photo},saving:saving||uploading,onClose});
  const submissionId = useRef(crypto.randomUUID());

  const initialSpeciesBreeds = BREEDS_BY_SPECIES[v.species] || BREEDS_BY_SPECIES[e0.species] || [];
  const isCustomInitial = e0.breed && !initialSpeciesBreeds.includes(e0.breed);
  const [breedChoice, setBreedChoice] = useState(isCustomInitial ? "Other / Mixed (type your own)" : (e0.breed || ""));
  const [customBreed, setCustomBreed] = useState(isCustomInitial ? e0.breed : "");

  const isCustomColorInitial = e0.color && !PET_COLORS.includes(e0.color);
  const [colorChoice, setColorChoice] = useState(isCustomColorInitial ? "Other / Custom markings (type below)" : (e0.color || ""));
  const [customColor, setCustomColor] = useState(isCustomColorInitial ? e0.color : "");

  const handleSpeciesChange = newSpecies => {
    f.set("species", newSpecies);
    setBreedChoice("");
    setCustomBreed("");
    f.set("breed", "");
  };

  const handleBreedChoiceChange = choice => {
    setBreedChoice(choice);
    if (choice === "Other / Mixed (type your own)" || choice === "Other (type your own)") {
      f.set("breed", customBreed || "");
    } else {
      f.set("breed", choice);
    }
  };

  const handleCustomBreedChange = text => {
    setCustomBreed(text);
    f.set("breed", text);
  };

  const handleColorChoiceChange = choice => {
    setColorChoice(choice);
    if (choice === "Other / Custom markings (type below)") {
      f.set("color", customColor || "");
    } else {
      f.set("color", choice);
    }
  };

  const handleCustomColorChange = text => {
    setCustomColor(text);
    f.set("color", text);
  };

  const review = useSubmissionReview([v,photo,uploading,editing,db.petRequests,db.pets,me.ownerId]);

  const submit = async ev => {
    ev.preventDefault();
    if (savingRef.current || uploading) return;
    setTop(""); f.submit(ev);
    if (!f.valid) return;
    if (editing) {
      const cur = (db.petRequests || []).find(r => r.id === editing.id && r.ownerId === me.ownerId);
      if (!cur) { say("This request is no longer available"); return onClose(); }
    } else { const m = addBlock(db, me); if (m) return setTop(m); }

    const canonicalSpecies = normalizeSpecies(v.species);
    const data = {
      name: v.name.trim(),
      species: canonicalSpecies,
      speciesLabel: formatSpeciesLabel(v.species),
      speciesOther: v.species.includes("Other") ? v.other.trim() : "",
      breed: v.breed.trim(),
      sex: v.sex,
      birth: v.birth,
      weight: +v.weight,
      neutered: v.neutered,
      color: v.color.trim(),
      dentalOcclusion: "",
      priorVaccines:v.priorVaccines.map(v=>v.trim()),externalClinicNotes:v.externalClinicNotes.trim(),
      notes: v.notes.trim(),
      photo
    };

    if (!await review.ask({title:"Review pet registration request",confirmLabel:editing ? "Resubmit to clinic" : "Submit to clinic",
      description:"Check your pet’s details. Your pet will appear as Pending verification. You can request an appointment while the clinic reviews the registration.",
      fields:[
        ["Patient",data.name],
        ["Species",`${data.speciesLabel}${data.speciesOther ? ` (${data.speciesOther})` : ""}`],
        ["Breed",data.breed],
        ["Sex / birth date",`${data.sex} / ${data.birth}`],
        ["Owner-reported weight",`${data.weight} kg`],
        ["Previous-clinic references (unverified)",data.priorVaccines.join(", ") || "None"],["Reference notes",data.externalClinicNotes],
        ["Neutered",data.neutered],
        ["Color",data.color],
        ["Notes",data.notes],
        ["Photo",photo ? <img src={photo} alt="Patient photo to submit" /> : "No photo selected"]]
    })) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const res = editing
        ? await api.put(`/api/pet-requests/${editing.id}`, { ...data, revision:editing.revision ?? 0 })
        : await api.post("/api/pet-requests", {...data,requestId:submissionId.current});
      if (res?.success && res.request?.id && res.pet?.id && res.request.pet_id===res.pet.id && res.pet.owner_id===me.ownerId) {
        const reqObj = reviewedRequest(res.request);
        const patient = registrationPatient(res.pet);
        setDb(p => ({
          ...p,
          pets:[...p.pets.filter(pet=>pet.id!==patient.id),patient],
          owners:p.owners.map(owner=>owner.id===me.ownerId ? {...owner,firstPetRegisteredAt:owner.firstPetRegisteredAt || new Date().toISOString()} : owner),
          petRequests: editing
            ? (p.petRequests || []).map(r => r.id === editing.id ? reqObj : r)
            : [...(p.petRequests || []).filter(r => r.id !== reqObj.id), reqObj],
          log: addLog(p, me, `Submitted online registration request for ${data.name} (${canonicalSpecies}) - Pending Vet Assistant Review`)
        }));
        say(`${data.name} is saved. You can request an appointment while registration is pending verification.`);
        onClose();
        return;
      }
    } catch (err) {
      setTop(err.message);
      return;
    } finally { savingRef.current = false; setSaving(false); }
    setTop("The server did not confirm the registration. Please try again.");
  };

  const availableBreeds = BREEDS_BY_SPECIES[v.species] || [];
  const showCustomBreedField = v.species.includes("Other") || breedChoice.startsWith("Other");
  const showCustomColorField = colorChoice.startsWith("Other");
  const petCalculatedAge = v.birth && !f.errs.birth ? petAge(v.birth) : "";
  const petAgeDetails = v.birth && !f.errs.birth ? computeAgeDetails(v.birth) : null;
  const isOlderThanSixMonths = v.birth && !f.errs.birth && petCalculatedAge && !petCalculatedAge.includes("mo") && !petCalculatedAge.includes("under");
  const normSpecies = normalizeSpecies(v.species);

  return (
    <ClinicDialog label={requiredSetup ? "Register your first pet" : editing ? "Edit pet request" : "Add my pet"} onClose={() => {if (!requiredSetup)unsaved.close();}}><section className="modal owner-pet-setup">{unsaved.card}<h3>{requiredSetup ? "Register your first pet" : editing ? "Edit pet request" : "Add my pet"}</h3>
      <form onSubmit={submit} noValidate aria-busy={saving}>
        {review.card}
        <p className="ow-note info">Save your pet’s details to get started. Your pet will appear as Pending verification, and you can request an appointment immediately.</p>

        {v.species && GUIDANCE_BY_SPECIES[v.species] && <p className="ow-note info ow-guide"><Icon n="info" size={16} />{GUIDANCE_BY_SPECIES[v.species]}</p>}

        {(() => {
          const need = ["name", "species", "sex", "birth", "weight", "neutered"], done = need.filter(k => String(v[k] ?? "").trim() && !f.errs[k]).length;
          return <div className="ow-progress" role="status" aria-live="polite"><div><b>{done === need.length ? "All required details are filled in" : `${done} of ${need.length} required details complete`}</b><span>{done === need.length ? "Review your request when you are ready." : "Fields turn green as you finish them."}</span></div><i style={{ "--p": `${(done / need.length) * 100}%` }} aria-hidden="true" /></div>;
        })()}
        <fieldset disabled={saving} style={{border:0,padding:0,margin:0,minWidth:0}}>
        <div className="op-sec">
          <h4>Pet picture (optional)</h4>
          <PhotoUpload src={photo} fallback={<Icon n="paw" />} label="Choose pet picture" onBusyChange={setUploading} onSave={async value => setPhoto(value)} onRemove={async () => setPhoto("")} />
          <p className="ow-hint">The picture is saved when you send this request and stays with the approved pet.</p>
        </div>
        <div className="op-2">
          <h4 className="ow-formsec full">About your pet</h4>
          <Field id="pn" label="Pet name" req value={v.name} filter={petText} filterMsg="Letters, numbers and . ' - only" maxLen={30} onChange={x => f.set("name", x)} onBlur={() => f.blur("name")} error={f.show("name")} valid={f.ok("name")} />
          
          <Field id="ps" label="Species (Animal Classification)" req type="select" value={v.species} onChange={handleSpeciesChange} onBlur={() => f.blur("species")} options={SPECIES.map(s => [s, s])} error={f.show("species")} valid={f.ok("species")} hint="Mandatory clinical classification (VCMS Protocols v2.0)" />
          
          {v.species.includes("Other") && (
            <div className="full">
              <Field id="po" label="What kind of animal?" req value={v.other} filter={petText} filterMsg="Letters, numbers and basic punctuation only" maxLen={30} onChange={x => f.set("other", x)} onBlur={() => f.blur("other")} error={f.show("other")} hint="For example Hedgehog, Sugar Glider, Bearded Dragon, Tortoise" />
            </div>
          )}


          {v.species && availableBreeds.length > 0 ? (
            <Field id="pb-sel" label={`${formatSpeciesLabel(v.species)} breed`} req={false} type="select" value={breedChoice} onChange={handleBreedChoiceChange} options={availableBreeds.map(b => [b, b])} error={f.show("breed")} valid={f.ok("breed")} hint="Select breed or choose Other/Mixed" />
          ) : null}

          {(showCustomBreedField || !availableBreeds.length) && (
            <Field id="pb" label="Specific breed / mix details (optional)" value={v.breed} filter={petText} filterMsg="Letters, numbers and basic punctuation only" maxLen={50} onChange={handleCustomBreedChange} onBlur={() => f.blur("breed")} error={f.show("breed")} valid={f.ok("breed")} hint="For example Beagle-Poodle mix, Domestic, or leave blank" />
          )}

          <Field id="px" label="Sex" req type="select" value={v.sex} onChange={x => f.set("sex", x)} onBlur={() => f.blur("sex")} options={[["Male", "Male"], ["Female", "Female"]]} error={f.show("sex")} valid={f.ok("sex")} />

          <div>
            <Field id="pd" label="Birth date (Jan 1, 2000 to today)" req type="date" min={PET_BIRTH_EARLIEST} maxDate={clinicDay()} value={v.birth} onChange={x => f.set("birth", x)} onBlur={() => f.blur("birth")} error={f.show("birth")} valid={f.ok("birth")} hint="Birth date cannot be today or in the future" />
            {petCalculatedAge && (
              <p className="ow-agechip"><Icon n="clock" size={14} />Age: {petCalculatedAge}</p>
            )}
          </div>

          <Field id="pw" label="Reported registration weight (kg)" req value={v.weight} filter={onlyDecimal} filterMsg="Numbers only, with one decimal point" inputMode="decimal" onChange={x => f.set("weight", x)} onBlur={() => f.blur("weight")} error={f.show("weight")} valid={f.ok("weight")} hint="For example 4.5" />

          <h4 className="ow-formsec full">Health &amp; appearance</h4>
          <div>
            <Field id="pt" label="Spayed or neutered?" req type="select" value={v.neutered} onChange={x => f.set("neutered", x)} onBlur={() => f.blur("neutered")} options={NEUTERED.map(s => [s, s])} error={f.show("neutered")} valid={f.ok("neutered")} />
            {isOlderThanSixMonths && v.neutered === "No" && (
              <p className="ow-tip"><Icon n="info" size={14} />At {petCalculatedAge}, spaying/neutering is strongly recommended for reproductive health and behavior.</p>
            )}
          </div>

          <Field id="pc-sel" label="Color / Coat pattern" req={false} type="select" value={colorChoice} onChange={handleColorChoiceChange} options={PET_COLORS.map(c => [c, c])} error={f.show("color")} valid={f.ok("color")} hint="Select primary color or coat pattern" />

          {showCustomColorField && (
            <Field id="pc" label="Specific color or unique markings" value={v.color} filter={petText} filterMsg="Letters, numbers and basic punctuation only" maxLen={40} onChange={handleCustomColorChange} onBlur={() => f.blur("color")} error={f.show("color")} valid={f.ok("color")} hint="For example brown with a white chest, white socks" />
          )}

          <div className="full"><Field id="pm" label="Anything the clinic should know (optional)" type="textarea" rows={2} max={200} value={v.notes} onChange={x => f.set("notes", x)} onBlur={() => f.blur("notes")} error={f.show("notes")} valid={f.ok("notes")} hint="Health problems, behavior or past treatments" /></div>
        </div>

        <ExternalHistory form={f} species={normSpecies} />
        </fieldset>
        {top && <p className="err" role="alert">{top}</p>}
        {f.submitted && !f.valid && <p className="err" role="alert">Please fix {f.count} field{f.count > 1 ? "s" : ""} above.</p>}
        <div className="row end"><button type="button" className="btn ghost" onClick={requiredSetup ? onLogout : unsaved.close} disabled={saving}>{requiredSetup ? "Log out" : "Close"}</button><button className="btn" disabled={saving || uploading}>{saving ? "Sending…" : uploading ? "Preparing picture…" : editing ? "Review and resend" : "Review request"}</button></div>
      </form>
    </section></ClinicDialog>
  );
}

/* ---------- Requests waiting for (or declined by) the clinic ---------- */
export function RequestList({ db, setDb, me, say, onEdit, onBook }) {
  const [ask, setAsk] = useState("");
  const list = myRequests(db, me);
  if (!list.length) return null;
  const withdraw = async r => {
    if (ask !== r.id) return setAsk(r.id);
    try {
      await api.delete(`/api/pet-requests/${r.id}`);
    } catch (err) { say(err.message); return; }
    setDb(p => ({
      ...p,
      petRequests: (p.petRequests || []).filter(x => x.id !== r.id),
      pets:p.pets.filter(pet=>pet.id!==r.petId),
      log: addLog(p, me, `Owner withdrew the pet request for ${r.name}`)
    }));
    setAsk("");
    say("Request removed");
  };
  return (
    <section className="op-reqs" aria-label="Pet requests">
      <h3>Pets pending verification</h3>
      <PaginatedList label="Pet registration requests" resetKey={null}>{list.map(r => {
        const no = r.status === "Declined";
        return (
          <div className="op-req" key={r.id}>
            <span className={`op-ico${no ? " no" : ""}`}><Icon n={no ? "alert" : "clock"} size={20} /></span>
            <div className="op-reqb">
              <b>{r.name}</b> <small>{kind(r)}{r.breed ? ` · ${r.breed}` : ""} · {r.sex} · {r.weight} kg</small>
              <span className={`op-chip ${no ? "no" : "wait"}`}>{no ? "Declined by the clinic" : "Pending verification"}</span>
              {no && r.declineReason && <small className="op-why">Reason: {r.declineReason}</small>}
              {no && <small className="op-why">Fix the details and send it again, or remove it.</small>}
            </div>
            <div className="op-acts">
              {!no && onBook && r.petId && <button className="btn sm" onClick={()=>onBook(r.petId)}>Request appointment</button>}
              <button className="btn ghost sm" onClick={() => onEdit(r)}><Icon n="edit" size={14} /> {no ? "Fix and resend" : "Edit"}</button>
              <button className="btn danger sm" disabled={db.appts.some(a=>a.petId===r.petId)} title={db.appts.some(a=>a.petId===r.petId) ? "This pet has appointment records; keep its registration for clinic review." : undefined} onClick={() => withdraw(r)} onBlur={() => setAsk("")}>{ask === r.id ? "Confirm remove" : "Remove"}</button>
            </div>
          </div>
        );
      })}</PaginatedList>
    </section>
  );
}

/* ---------- Full profile of an approved pet ---------- */
export function PetProfileModal({ pet, db, setDb, me, onClose, onVacc, onBook }) {
  const historyComplete=useHistoryComplete();
  const p=db.pets.find(row=>row.id===pet.id)||pet;
  const V = scope(db, me, "vacc").filter(v => v.petId === p.id), A = scope(db, me, "appts").filter(a => a.petId === p.id);
  const current = currentVaccinationDue(V);
  const over = current.filter(v => vaccinationStatus(v, current) === "Overdue").length;
  const soon = current.filter(v => vaccinationStatus(v, current) === "Due soon").length;
  const pending = V.filter(v => !v.done || !v.vetId).length;
  const next = A.filter(a => ["Pending Approval", "Scheduled", "Checked-in", "In consultation"].includes(a.status) && a.date >= clinicToday()).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
  
  const petAgeDetails = p.birth ? computeAgeDetails(p.birth) : null;
  const rows = [
    ["Species", formatSpeciesLabel(p.species)],
    ["Digital Card ID", p.vaccinationCardId],
    ["Life Stage Protocol", petAgeDetails ? petAgeDetails.lifeStageLabel : "Standard"],
    ["Breed", p.breed],
    ["Sex", p.sex],
    ["Age", p.birth ? petAge(p.birth) : ""],
    ["Birth date", p.birth],
    [weightSourceLabel(p), p.weight != null ? `${p.weight} kg` : ""],
    ["Spayed or neutered", p.neutered],
    ["Color", p.color],
    null
  ].filter(Boolean).filter(([, x]) => x);

  return (
    <Modal title={p.name} onClose={onClose}>
      <HistoryControls auto />
      <dl className="op-dl">{rows.map(([k, x]) => <div key={k}><dt>{k}</dt><dd>{x}</dd></div>)}</dl>

      {(p.allergies || []).length > 0 && <div className="op-sec"><h4>Allergies</h4><ul className="ow-tags">{p.allergies.map(a => <li className="ow-tag" key={a}>{a}</li>)}</ul></div>}
      {p.notes && <div className="op-sec"><h4>Care notes</h4><p>{p.notes}</p></div>}
      
      <OwnerReferenceHistory pet={p} setDb={setDb} />
      <VitalsHistory petId={p.id} me={me} />
      <div className="op-sec">
        <h4>Health at a glance</h4>
        <p className="op-line"><Icon n="syringe" size={16} /> {V.length ? <>{V.length} {historyComplete?"":"loaded "}vaccine record{V.length > 1 ? "s" : ""}{over ? <span className="op-chip no">{over} overdue</span> : soon ? <span className="op-chip wait">{soon} due soon</span> : current.length ? <span className="op-chip ok">Approved boosters on track</span> : <span className="op-chip">No approved booster date</span>}{pending > 0 && <span className="op-chip wait">{pending} awaiting vet review</span>}</> : "No vaccine records yet"}</p>
        <p className="op-line"><Icon n="calendar" size={16} /> {next ? `Next visit: ${next.date} at ${fmt12(next.time)} (${next.status})` : "No visit booked"}</p>
      </div>

      <p className="ow-hint">Need to change the name, breed or birth date? Ask the clinic front desk, they keep the official record.</p>
      <div className="row end"><button className="btn ghost" onClick={onVacc}>Vaccination card</button><button className="btn" onClick={() => onBook()}>Book a visit</button></div>
    </Modal>
  );
}

function OwnerReferenceHistory({pet,setDb}) {
  const [editing,setEditing]=useState(false), [error,setError]=useState(''),[saving,setSaving]=useState(false);
  const busy=useRef(false), baseline=useRef(pet.referenceRevision || 0);
  const f=useLive({priorVaccines:pet.priorVaccines || [],externalClinicNotes:pet.externalClinicNotes || ''},externalHistoryErrors);
  const review=useSubmissionReview([f.v,baseline.current]);
  const submit=async event=>{
    event.preventDefault();if(busy.current)return;f.submit(event);if(!f.valid)return;
    if(!await review.ask({title:'Review previous-clinic references',confirmLabel:'Save references',description:'Owner-reported guide only. Existing clinic measurements, administered doses and approved booster dates remain separately recorded.',fields:[['Vaccines',f.v.priorVaccines.join(', ') || 'None reported'],['Previous clinic and notes',f.v.externalClinicNotes || 'None reported']]}))return;
    busy.current=true;setSaving(true);setError('');
    try {
      const result=await api.put(`/api/pets/${pet.id}/reference-history`,{...f.v,priorVaccines:f.v.priorVaccines.map(v=>v.trim()),revision:baseline.current});
      if(!result.success || result.pet?.id!==pet.id)throw Error('The clinic did not confirm this save. Keep your entries and retry.');
      const saved={priorVaccines:result.pet.prior_vaccines,externalClinicNotes:result.pet.external_clinic_notes,referenceRevision:result.pet.reference_revision};
      setDb(previous=>({...previous,pets:previous.pets.map(p=>p.id===pet.id?{...p,...saved}:p)}));baseline.current=saved.referenceRevision;setEditing(false);
    } catch(e){setError(e.message);} finally{busy.current=false;setSaving(false);}
  };
  return <section className="op-sec">{review.card}<ExternalHistorySummary patient={pet} />{editing?<form onSubmit={submit} noValidate><fieldset disabled={saving}><ExternalHistory form={f} species={pet.species} />{error&&<p className="err" role="alert">{error}</p>}<div className="row end"><button className="btn ghost" type="button" onClick={()=>setEditing(false)}>Cancel</button><button className="btn">{saving?'Saving…':'Review references'}</button></div></fieldset></form>:<button type="button" className="btn sm ghost" onClick={()=>{baseline.current=pet.referenceRevision || 0;f.quiet({priorVaccines:pet.priorVaccines || [],externalClinicNotes:pet.externalClinicNotes || ''});setEditing(true);}}>Add / update previous-clinic references</button>}</section>;
}
