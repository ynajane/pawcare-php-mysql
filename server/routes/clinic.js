import {resolveAdministrationLot} from '../administrationLot.js';
import {dewormingProducts} from '../dewormingProducts.js';
import {ownerAccountLinkRouter} from './ownerAccountLink.js';
import {resolveWalkInOwner} from '../walkInOwner.js';
import {vaccinationCardFieldErrors} from '../../src/vaccinationCardFields.js';
import {externalHistoryErrors} from '../../src/externalHistory.js';
import {ownerDetailErrors,petDetailErrors,tidy,phoneKey} from '../../src/recordCorrection.js';
import {assertNoDuplicatePet,assertOwnerContactFree,assertPaymentReferenceUnused,assertDoseNotRecorded} from '../duplicates.js';
import {closeVisitErrors,closeReasonText,closeReasonLabel,OPEN_STATUSES} from '../../src/visitClosure.js';
import {clinicToday} from '../../src/ageRules.js';
import {bookingReasonErrors,bookingReason} from '../../src/bookingReason.js';
import {digitalVetCardRouter} from './digitalVetCard.js';
import {ensureDigitalVetCardSchema,internalCardReference,refreshDigitalVetCard} from '../digitalVetCard.js';
import {ensureVitalsSchema} from '../vitals.js';
import {vitalsRouter} from './vitals.js';
import { approveRegistration } from '../approveRegistration.js';
import { approveAppointment, ensureAppointmentApprovalSchema } from '../appointmentApproval.js';
import { savePendingPatient } from '../petRegistration.js';
import { ensureAdmissionsSchema } from '../admissions.js';
import { assertAdmissionCheckout, admissionCharges, validateAdmissionCharges } from '../admissionMedication.js';
import { noteOptionsRouter } from "./noteOptions.js";
import { admissionsRouter } from './admissions.js';
import { requestedVaccineReason } from '../vaccineBooking.js';
import { vaccineIdFromReason } from '../../src/vaccineBooking.js';
import {stateReadPlan,historyPage} from '../stateReadPlan.js';
import { assessWeight, assessTemp } from '../../src/roles/vitals.js';
import { sendClinicState } from "../stateResponse.js";
import { visibleStateVaccinations } from "../stateVaccinations.js";
import { logReminderCall, reminderCallHistory } from "../reminderCalls.js";
import { sameIntakeVisit } from "../../src/intakeVisit.js";
import { clinicalCharges, validateClinicalCharges } from "../clinicalCharges.js";
import { boosterDate } from "../../src/clinicalWorkflow.js";
import { ensurePrescriptionSchema, normalizePrescription, prescriptionInvoice, validatePrescriptionSale } from "../prescriptions.js";
import { ensureCareSchema, validateCarePlan } from "../careWorkflow.js";
import { priceCatalog, canonicalInvoice, validateCheckoutAddons } from "../priceCatalog.js";
import { adminRouter } from "./admin.js";
import { EARLIEST_DATE } from "../../src/dateRules.js";
import { refreshManagedCatalog } from "../clinicCatalog.js";
import { saveAllergies } from "../allergies.js";
import { ADMINISTERED_VACCINES } from "../../src/vaccineSchedule.js";
import {walkInReasonError} from '../../src/walkInRegistration.js';
import { validateWalkInRegistration } from '../walkInRegistration.js';
import { ensurePetRegistrationSchema, validatePetRegistration, validatePetPlausibility, validatePetPhoto, lockRegistrationOwner, checkRegistrationCapacity, checkRequestRevision, registrationAudit, registrationError } from '../petRegistration.js';
import { checkoutRouter } from "./checkout.js";
import { ensureCheckoutInboxSchema, createCheckoutTask, authorizeCheckoutPayment, finishCheckoutTask } from "../checkout.js";
import { validateBoosterDate } from "../reminders.js";
import { ensureSchedulingSchema } from "../database/schedulingSchema.js";
import { availableSlots, assertAvailable, lockSchedule, clinicClock, inferBookingService, bookingError, minutes, validDate } from "../scheduling.js";
import { ensureCheckoutSchema } from "../database/clinicSchema.js";
import express from "express";
import { query, withTransaction } from "../db.js";
import { sha256 } from "../security.js";
import { sendMail, sendSms } from "../services.js";
import { getAppUrl, requireAuth } from "./auth.js";
import { clinicAccess, assignedTo, validateStatusChange } from "../clinicAccess.js";

export const clinicRouter = express.Router();
clinicRouter.use(requireAuth, clinicAccess);
// Keep administrator price changes current. If the table is unreachable the built-in list still works.
clinicRouter.use(async (req, res, next) => { try { await refreshManagedCatalog(); } catch (error) { console.error('Catalog refresh failed:', error.message); } next(); });
clinicRouter.use(digitalVetCardRouter);
clinicRouter.use(ownerAccountLinkRouter);
clinicRouter.use("/checkout-inbox", checkoutRouter);
clinicRouter.use("/pets/:petId/vitals",vitalsRouter);
clinicRouter.use("/admin", adminRouter);
clinicRouter.use("/clinical/note-options", noteOptionsRouter);
clinicRouter.use('/admissions', admissionsRouter);

/* Helper: log an action to audit_logs */
async function recordAudit(userName, userRole, action) {
  try {
    await query(
      "INSERT INTO audit_logs (user_name, user_role, action) VALUES ($1, $2, $3)",
      [userName || "System", userRole || "system", action]
    );
  } catch (err) {
    console.error("Audit log error:", err.message);
  }
}

function toDateStr(val) {
  if (!val) return "";
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, "0");
    const d = String(parsed.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return s;
}

/* 1. BOOTSTRAP / FULL STATE SYNC */
clinicRouter.get(["/state","/state/summary","/state/history"], async (req, res) => {
  try {
    await ensurePetRegistrationSchema();
    await ensureAppointmentApprovalSchema();
    await ensureVitalsSchema();
    await ensureCareSchema();
    await ensurePrescriptionSchema();
    await ensureAdmissionsSchema();
    const plan=stateReadPlan(req.user,{...req.query,view:req.path==='/state/summary'?'summary':req.path==='/state/history'?'history':'full'});
    const {owner,vet,scoped,params:scopeParams,petScope}=plan;
    const read=key=>query(plan.reads[key].sql,plan.reads[key].params);
    const [
      ownersRes,
      petsRes,
      weightsRes,
      apptsRes,
      vaccsRes,
      consultsRes,
      requestsRes,
      logsRes,
      vetsRes,
      countsRes
    ] = await Promise.all([
      plan.history ? Promise.resolve({rows:[]}) : query(`
        SELECT o.*, u.birthday, u.first_name, u.last_name, u.middle_initial, u.role as user_role,
               a.house_street, a.country, a.state, a.city, a.zip_code
        FROM owners o
        LEFT JOIN users u ON u.id = o.user_id
        LEFT JOIN addresses a ON a.user_id = o.user_id
        ${owner ? "WHERE o.id = $1" : vet ? `WHERE o.id IN (SELECT owner_id FROM pets WHERE id IN (${petScope}))` : ""}
        ORDER BY o.name ASC
      `, scopeParams),
      plan.history ? Promise.resolve({rows:[]}) : query(`SELECT * FROM pets${scoped ? ` WHERE id IN (${petScope})` : ""} ORDER BY name ASC`, scopeParams),
      read("weights"),
      read("appts"),
      read("vaccs"),
      read("consults"),
      vet || plan.history ? Promise.resolve({ rows: [] }) : query(`SELECT * FROM pet_requests${owner ? " WHERE owner_id = $1" : ""} ORDER BY created_at DESC`, owner ? scopeParams : []),
      req.user.role === "admin" && !plan.history ? query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100") : Promise.resolve({ rows: [] }),
      plan.history ? Promise.resolve({rows:[]}) : query("SELECT id, vet_id, first_name, last_name, role FROM users WHERE role = 'vet' AND COALESCE(to_jsonb(users)->>'is_active', 'true') <> 'false' ORDER BY first_name ASC"),
      // Independent of the reads above, so it runs with them instead of after them.
      plan.summary ? query(`SELECT (SELECT count(*)::int FROM consultations WHERE ${plan.filters.consults}) AS consultations, (SELECT jsonb_object_agg(status,n) FROM (SELECT status,count(*)::int n FROM appointments WHERE ${plan.filters.appts} GROUP BY status) s) AS appointment_status`,scopeParams) : Promise.resolve({rows:[]})
    ]);

    const page=plan.history?historyPage(plan,{appts:apptsRes,vaccs:vaccsRes,consults:consultsRes,weights:weightsRes}):null;
    // Page boundary must not hide the appointment/vitals for a saved note.
    if(plan.history && consultsRes.rows.length) {
      const related=await query(`SELECT * FROM appointments WHERE id=ANY($${scopeParams.length+1}::varchar[]) AND ${plan.filters.appts}`,[...scopeParams,consultsRes.rows.map(c=>c.appt_id).filter(Boolean)]);
      const ids=new Set(apptsRes.rows.map(a=>a.id));apptsRes.rows.push(...related.rows.filter(a=>!ids.has(a.id)));
    }
    let totals;
    if(plan.summary) {
      const counts=countsRes;
      totals=counts.rows[0];
    }

    // Only annotate appointments already selected by this user's scope/page.
    const admissionStates = apptsRes.rows.length ? (await query('SELECT id,appt_id,status FROM admissions WHERE appt_id=ANY($1::varchar[])',[apptsRes.rows.map(a=>a.id)])).rows : [];
    const admissionByVisit = new Map(admissionStates.map(row=>[row.appt_id,row]));

    // Attach weights to pets
    const weightsByPet = {};
    for (const w of weightsRes.rows) {
      if (!weightsByPet[w.pet_id]) weightsByPet[w.pet_id] = [];
      weightsByPet[w.pet_id].push({
        id: w.id,
        date: toDateStr(w.date),
        kg: parseFloat(w.kg),
        by: w.recorded_by || "Unknown historical staff", origin:w.origin || (/^(owner|registration|initial registration)$/i.test(w.recorded_by || '')?'registration':'legacy_unknown'), visitId:w.appt_id || null, measuredAt:w.measured_at || null, unit:"kg",staffId:w.staff_id || null,vitalId:w.vital_id || null
      });
    }

    const pets = petsRes.rows.map(p => ({
      id: p.id,
      ownerId: p.owner_id,
      registrationStatus: p.registration_status || "Verified",
      name: p.name,
      species: p.species,
      speciesOther: p.species_other || "",
      breed: p.breed,
      sex: p.sex,
      birth: toDateStr(p.birth),
      weight: parseFloat(p.weight), weightOrigin:p.registration_status==='Pending'?'registration':p.weight_origin || 'legacy_unknown',
      color: p.color || "",
      neutered: p.neutered || "Not sure",
      allergies: p.allergies || [],
      vaccinationCardId: p.vaccination_card_id || "",
      notes: p.notes || "",
      photo: p.photo || "",
      dentalOcclusion: p.dental_occlusion || "",
      priorVaccines:p.prior_vaccines || [], externalClinicNotes:p.external_clinic_notes || "", referenceRevision:p.reference_revision || 0,
      weights: weightsByPet[p.id] || []
    }));

    const owners = ownersRes.rows.map(o => ({
      id: o.id,
      userId: o.user_id,
      firstPetRegisteredAt: o.first_pet_registered_at || null,
      name: o.name,
      firstName: o.first_name || "",
      lastName: o.last_name || "",
      middleInitial: o.middle_initial || "",
      birthday: toDateStr(o.birthday),
      email: o.email,
      phone: o.phone,
      houseStreet: o.house_street || "",
      country: o.country || "",
      state: o.state || "",
      city: o.city || "",
      zipCode: o.zip_code || "",
      address: o.address || (o.house_street ? `${o.house_street}, ${o.city}, ${o.state} ${o.zip_code}, ${o.country}` : "")
    }));

    const appts = apptsRes.rows.map(a => ({
      id: a.id,
      petId: a.pet_id,
      vetId: a.vet_id,
      date: toDateStr(a.date),
      time: Number.isFinite(minutes(a.time)) ? `${String(Math.floor(minutes(a.time) / 60)).padStart(2, "0")}:${String(minutes(a.time) % 60).padStart(2, "0")}` : a.time,
      service: a.service, durationMinutes: a.duration_minutes || 30, bookingKind: a.booking_kind || "reservation", notes: a.notes || "",
      reason: a.reason,
      status: a.status,
      billingStatus: a.billing_status,
      amount: parseFloat(a.amount),
      billingStatus: a.billing_status,
      paymentMethod: a.payment_method || "",
      paymentReference: a.payment_details?.reference || "",
      discount: a.payment_details?.discount || 0,
      cashTendered: a.payment_details?.cashTendered ?? null,
      changeAmount: a.payment_details?.changeAmount || 0,
      receivedBy: a.payment_details?.receivedBy || "",
      paidAt: a.paid_at || null,
      admissionId: admissionByVisit.get(a.id)?.id || null,
      admissionStatus: admissionByVisit.get(a.id)?.status || null,
      invoiceItems: a.invoice_items || [],
      intakeVitals: a.intake_vitals || null,
      handoffs: owner ? [] : (a.handoffs || []),
      followUpId: a.follow_up_id || null,
      approvedAt: a.approved_at || null, approvedBy: a.approved_by || "", approvedByUserId: a.approved_by_user_id || "",
      cancelReason: a.cancel_reason || ""
    }));

    const rawVaccs = vaccsRes.rows.map(v => ({
      id: v.id,
      petId: v.pet_id,
      cardId: v.card_id,
      apptId: v.appt_id || "",
      consultationId: v.consultation_id || "",
      vaccine: v.vaccine,
      brand: v.brand || "",
      batch: v.batch || "",
      date: toDateStr(v.date),
      createdAt: v.created_at,
      nextDue: v.next_due ? toDateStr(v.next_due) : null,
      doseNo: v.dose_no,
      doseOf: v.dose_of,
      done: Boolean(v.done),
      automated: Boolean(v.automated),
      protocolType: v.protocol_type || "",
      notes: v.notes || "",
      vetId: v.vet_id || "",
      recordedBy: v.recorded_by || ""
    }));

    const vaccs = visibleStateVaccinations(rawVaccs);

    const consults = consultsRes.rows.map(c => ({
      id: c.id,
      petId: c.pet_id,
      vetId: c.vet_id,
      apptId: c.appt_id || "",
      date: toDateStr(c.date),
      backdateReason:c.backdate_reason || "",
      symptoms: c.symptoms,
      objective: c.objective,
      diagnosis: c.diagnosis,
      treatment: c.treatment,
      careStatus: c.care_status || "Routine care",
      followUpDate: c.follow_up_date ? toDateStr(c.follow_up_date) : null,
      followUpReason: c.follow_up_reason || "",
      performedServices: c.performed_services || [],
      prescriptionItems: c.prescription_items || [],
      prescription: c.prescription || ""
    }));

    const petRequests = requestsRes.rows.map(r => ({
      id: r.id,
      ownerId: r.owner_id,
      name: r.name,
      species: r.species,
      speciesOther: r.species_other || "",
      breed: r.breed || "",
      sex: r.sex,
      birth: toDateStr(r.birth),
      weight: parseFloat(r.weight),
      color: r.color || "",
      neutered: r.neutered || "",
      notes: r.notes || "",
      photo: r.photo || "",
      dentalOcclusion: r.dental_occlusion || "",
      priorVaccines:r.prior_vaccines || [], externalClinicNotes:r.external_clinic_notes || "",
      revision: r.revision ?? 0,
      status: r.status,
      declineReason: r.decline_reason || "",
      petId: r.pet_id || "",
      cardId: r.card_id || "",
      requestedAt: toDateStr(r.requested_at),
      approvedAt: r.approved_at ? toDateStr(r.approved_at) : null,
      approvedBy: r.approved_by || "", reviewedAt:r.reviewed_at || null, approvedByUserId:r.approved_by_user_id || ""
    }));

    const log = logsRes.rows.map(l => {
      const formattedDate = l.created_at ? new Date(l.created_at).toLocaleString("en-PH") : "";
      return {
        id: l.id,
        ts: formattedDate,
        at: formattedDate,
        by: l.user_name || "System",
        role: l.user_role || "staff",
        user: { name: l.user_name || "System", role: l.user_role || "staff" },
        action: l.action,
        msg: l.action
      };
    });

    sendClinicState(req, res, {
      ...(plan.summary?{summary:true,totals}:{}),
      ...(page?{page,weights:weightsByPet}:{}),
      vets: vetsRes.rows.map(v => ({
        id: v.vet_id || v.id,
        userId: v.id,
        name: `Dr. ${[v.first_name, v.last_name].filter(Boolean).join(" ")}`
      })),
      owners,
      pets,
      appts,
      vaccs,
      consults,
      petRequests,
      log
    });
  } catch (err) {
    console.error("Clinic state fetch error:", err);
    res.status(err.status || 500).json({ error: err.status?err.message:"Failed to load clinic records. Please retry." });
  }
});

/* 1.5 OWNER CONTACT & PROFILE UPDATE */
clinicRouter.post("/owner/contact", async (req, res) => {
  try {
    const { email, phone, address, houseStreet, city, state, country, zipCode } = req.body;
    const sid = req.cookies?.sid || (req.headers.authorization && req.headers.authorization.replace("Bearer ", ""));
    let userId = null;
    let ownerId = null;

    if (sid) {
      const s = await query("SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > NOW()", [sha256(sid)]);
      if (s.rows.length) userId = s.rows[0].user_id;
    }
    if (userId) {
      const o = await query("SELECT id FROM owners WHERE user_id = $1", [userId]);
      if (o.rows.length) ownerId = o.rows[0].id;
    }
    if (!ownerId && email) {
      const o = await query("SELECT id, user_id FROM owners WHERE LOWER(email) = LOWER($1)", [email]);
      if (o.rows.length) {
        ownerId = o.rows[0].id;
        userId = o.rows[0].user_id;
      }
    }
    if (!ownerId) {
      return res.status(404).json({ error: "Owner record not found." });
    }

    if (email) {
      await query("UPDATE owners SET email = $1 WHERE id = $2", [email, ownerId]);
      if (userId) await query("UPDATE users SET email = $1 WHERE id = $2", [email, userId]);
    }
    if (phone) {
      await query("UPDATE owners SET phone = $1 WHERE id = $2", [phone, ownerId]);
      if (userId) await query("UPDATE users SET mobile_number = $1 WHERE id = $2", [phone, userId]);
    }
    if (address) {
      await query("UPDATE owners SET address = $1 WHERE id = $2", [address, ownerId]);
    }
    if (userId && (houseStreet || city || state || country || zipCode)) {
      await query(
        `UPDATE addresses
         SET house_street = COALESCE($1, house_street),
             city = COALESCE($2, city),
             state = COALESCE($3, state),
             country = COALESCE($4, country),
             zip_code = COALESCE($5, zip_code)
         WHERE user_id = $6`,
        [houseStreet || null, city || null, state || null, country || null, zipCode || null, userId]
      );
    }

    const updated = await query(`
      SELECT o.*, u.birthday, u.first_name, u.last_name, u.middle_initial,
             a.house_street, a.country, a.state, a.city, a.zip_code
      FROM owners o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN addresses a ON a.user_id = o.user_id
      WHERE o.id = $1
    `, [ownerId]);

    const row = updated.rows[0];
    res.json({
      status: "ok",
      owner: {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        firstName: row.first_name || "",
        lastName: row.last_name || "",
        middleInitial: row.middle_initial || "",
        birthday: toDateStr(row.birthday),
        email: row.email,
        phone: row.phone,
        houseStreet: row.house_street || "",
        country: row.country || "",
        state: row.state || "",
        city: row.city || "",
        zipCode: row.zip_code || "",
        address: row.address || ""
      }
    });
  } catch (err) {
    console.error("Update contact error:", err);
    res.status(500).json({ error: "Failed to update contact details." });
  }
});

/* 2. OWNERS CRUD */
/* 3. PETS CRUD & WEIGHT LOGGING */
clinicRouter.post("/owner/pets", async (req, res) => {
  const {
    ownerId, name, species, speciesOther, breed, sex,
    birth, weight, color, neutered, dentalOcclusion, notes, photo
  } = req.body;

  let effectiveOwnerId = ownerId;
  const token = req.cookies?.pawcare_session || (req.headers.authorization || "").replace("Bearer ", "");
  if (!effectiveOwnerId && token) {
    try {
      const sRes = await query(
        `SELECT u.owner_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
        [token]
      );
      if (sRes.rows.length && sRes.rows[0].owner_id) {
        effectiveOwnerId = sRes.rows[0].owner_id;
      }
    } catch (_) {}
  }

  if (!effectiveOwnerId) {
    try {
      const oRes = await query(`SELECT id FROM owners ORDER BY created_at DESC LIMIT 1`);
      if (oRes.rows.length) effectiveOwnerId = oRes.rows[0].id;
    } catch (_) {}
  }

  const petId = "p_" + Math.random().toString(36).slice(2, 8);
  const cardId = "VACC-" + new Date().getFullYear() + "-" + Math.floor(1000 + Math.random() * 9000);
  const today = new Date().toISOString().slice(0, 10);
  const addDays = (dStr, days) => {
    const d = new Date(dStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const sp = (species || "Canine").toLowerCase();
  const isDog = sp.includes("dog") || sp.includes("canine");
  const isCat = sp.includes("cat") || sp.includes("feline");
  const isRabbit = sp.includes("rabbit") || sp.includes("lagomorph");
  const isRodent = sp.includes("rodent") || sp.includes("hamster") || sp.includes("guinea");
  const isAvian = sp.includes("bird") || sp.includes("avian");

  try {
    const { pet, vaccs } = await withTransaction(async (client) => {
      // 1. Insert Pet into PostgreSQL Masterlist
      const insPet = await client.query(
        `INSERT INTO pets (id, owner_id, name, species, species_other, breed, sex, birth, weight, color, neutered, vaccination_card_id, notes, photo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          petId,
          effectiveOwnerId,
          name,
          species || "Canine (Dog)",
          speciesOther || "",
          breed || "Mixed Breed",
          sex || "Male",
          birth || today,
          parseFloat(weight) || 5.0,
          color || "",
          neutered || "Not sure",
          cardId,
          notes || "",
          photo || ""
        ]
      );

      // 2. Insert Initial Weight
      await client.query(
        `INSERT INTO pet_weights (pet_id, date, kg, recorded_by) VALUES ($1, $2, $3, $4)`,
        [petId, birth || today, parseFloat(weight) || 5.0, "owner"]
      );

      // Calculate pet life stage (Puppy/Kitten vs Adult vs Senior)
      let isAdult = false;
      let isSenior = false;
      if (birth) {
        const b = new Date(birth + "T00:00:00");
        const now = new Date(today + "T00:00:00");
        const diffDays = Math.floor((now - b) / (1000 * 60 * 60 * 24));
        if (diffDays >= 365) isAdult = true;
        if (diffDays >= 365 * 7) isSenior = true;
      }

      // 3. Seed Core Vaccination Protocols based on VCMS v2.0 & Life Stage
      const seeded = [];
      if (isDog) {
        if (isAdult) {
          // Lifelong Adult Canine Maintenance Schedule (1 Year and Beyond)
          // 1. Annual DHPP Booster (Core)
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "DHPP (5-in-1 Adult Core Booster)",
            brand: "Nobivac DHPP",
            batch: "AUTO-DHPP-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Adult Core Immunization (Annual)",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          // 2. Annual Anti-Rabies Core Booster (Mandatory RA 9482)
          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Anti-Rabies Booster (RA 9482 Compliance)",
            brand: "Defensor 3",
            batch: "AUTO-RAB-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol (Annual Mandatory)",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);

          // 3. Adult Deworming (Quarterly / Every 3 Months / 90 Days)
          const v3 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Adult Deworming (Quarterly Routine)",
            brand: "Canex Multi-Spectrum",
            batch: "AUTO-DEW-ADULT",
            date: today,
            next_due: addDays(today, 90),
            dose_no: 1,
            dose_of: 4,
            done: false,
            automated: true,
            protocol_type: "Adult Parasiticide Protocol (Quarterly)",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v3)
          );
          seeded.push(v3);

          // 4. Monthly Flea, Tick & Heartworm Prevention (Every 30 Days)
          const v4 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Monthly Flea, Tick & Heartworm Chewable",
            brand: "NexGard Spectra / Simparica Trio",
            batch: "AUTO-ECTO-M",
            date: today,
            next_due: addDays(today, 30),
            dose_no: 1,
            dose_of: 12,
            done: false,
            automated: true,
            protocol_type: "Monthly Prophylaxis Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v4)
          );
          seeded.push(v4);
        } else {
          // Puppy series (< 12 months)
          // DHPP 5-in-1
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "DHPP (5-in-1 Core)",
            brand: "Nobivac DHPP",
            batch: "AUTO-DHPP-01",
            date: today,
            next_due: addDays(today, 21),
            dose_no: 1,
            dose_of: 3,
            done: false,
            automated: true,
            protocol_type: "Core Canine Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          // Anti-Rabies (Mandatory Core RA 9482)
          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Anti-Rabies (1-Year Core)",
            brand: "Defensor 3",
            batch: "AUTO-RAB-01",
            date: today,
            next_due: addDays(today, 30),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);

          // Broad-Spectrum Deworming
          const v3 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Broad-Spectrum Deworming",
            brand: "Canex Multi-Spectrum",
            batch: "AUTO-DEW-01",
            date: today,
            next_due: addDays(today, 14),
            dose_no: 1,
            dose_of: 4,
            done: false,
            automated: true,
            protocol_type: "Parasiticide Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v3)
          );
          seeded.push(v3);
        }
      } else if (isCat) {
        if (isAdult) {
          // Adult Feline Maintenance
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "FVRCP (4-in-1 Adult Core Booster)",
            brand: "Fel-O-Vax 4",
            batch: "AUTO-FVR-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Adult Core Feline Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Anti-Rabies Booster (Feline Formulation)",
            brand: "Defensor 3",
            batch: "AUTO-RABF-ADULT",
            date: today,
            next_due: addDays(today, 365),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol (Annual)",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);

          const v3 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Adult Feline Deworming (Quarterly)",
            brand: "Profender / Milbemax",
            batch: "AUTO-DEWF-ADULT",
            date: today,
            next_due: addDays(today, 90),
            dose_no: 1,
            dose_of: 4,
            done: false,
            automated: true,
            protocol_type: "Feline Parasiticide Protocol (Quarterly)",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v3)
          );
          seeded.push(v3);
        } else {
          // Kitten series
          const v1 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "FVRCP (4-in-1 Core)",
            brand: "Fel-O-Vax 4",
            batch: "AUTO-FVR-01",
            date: today,
            next_due: addDays(today, 28),
            dose_no: 1,
            dose_of: 3,
            done: false,
            automated: true,
            protocol_type: "Core Feline Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v1)
          );
          seeded.push(v1);

          const v2 = {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            pet_id: petId,
            card_id: cardId,
            vaccine: "Anti-Rabies (Feline Formulation)",
            brand: "Defensor 3",
            batch: "AUTO-RABF-01",
            date: today,
            next_due: addDays(today, 30),
            dose_no: 1,
            dose_of: 1,
            done: false,
            automated: true,
            protocol_type: "Core Rabies Protocol",
            recorded_by: "System Automation"
          };
          await client.query(
            `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            Object.values(v2)
          );
          seeded.push(v2);
        }
      } else if (isRabbit) {
        const v1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: "RHDV1 / RHDV2 Core Vaccine",
          brand: "Filavac VHD",
          batch: "AUTO-RHD-01",
          date: today,
          next_due: addDays(today, 30),
          dose_no: 1,
          dose_of: 1,
          done: false,
          automated: true,
          protocol_type: "Core Lagomorph Protocol",
          recorded_by: "System Automation"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v1)
        );
        seeded.push(v1);
      } else if (isAvian) {
        const v1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: "Diagnostic Fecal Float Screening",
          brand: "Microscopic Screen",
          batch: "AUTO-FLT-01",
          date: today,
          next_due: addDays(today, 180),
          dose_no: 1,
          dose_of: 1,
          done: false,
          automated: true,
          protocol_type: "Avian Diagnostic Protocol",
          recorded_by: "System Automation"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v1)
        );
        seeded.push(v1);
      }

      // 4. Record in pet_requests with Approved status for audit and front desk visibility
      const reqId = "req_" + Math.random().toString(36).slice(2, 8);
      await client.query(
        `INSERT INTO pet_requests (id, owner_id, name, species, species_other, breed, sex, birth, weight, color, neutered, notes, status, approved_at, approved_by, pet_id, card_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'Approved', CURRENT_DATE, 'Owner Instant Online Registration', $13, $14)`,
        [reqId, effectiveOwnerId, name, species, speciesOther || "", breed || "", sex, birth || today, parseFloat(weight) || 5.0, color || "", neutered || "", notes || "", petId, cardId]
      );

      // 5. Pre-schedule initial preventive appointment
      const earliestDue = seeded.filter(v => v.next_due).sort((a, b) => a.next_due.localeCompare(b.next_due))[0];
      let preAppt = null;
      if (earliestDue) {
        const apptId = "a_pre_" + Math.random().toString(36).slice(2, 8);
        const insAppt = await client.query(
          `INSERT INTO appointments (id, pet_id, vet_id, date, time, reason, status, billing_status, amount)
           VALUES ($1, $2, $3, $4, $5, $6, 'Scheduled', 'Unbilled', 0) RETURNING *`,
          [apptId, petId, "vet_cruz", earliestDue.next_due, "10:00", `${earliestDue.vaccine} (Pre-scheduled)`]
        );
        preAppt = insAppt.rows[0];
      }

      return { pet: insPet.rows[0], vaccs: seeded, appointment: preAppt };
    });

    await recordAudit("Owner", "owner", `Registered new patient ${name} (${species}) with digital card ${cardId}`);

    res.json({
      success: true,
      pet: {
        id: pet.id,
        ownerId: pet.owner_id,
        name: pet.name,
        species: pet.species,
        speciesOther: pet.species_other || "",
        breed: pet.breed,
        sex: pet.sex,
        birth: pet.birth ? new Date(pet.birth).toISOString().slice(0, 10) : "",
        weight: parseFloat(pet.weight),
        color: pet.color || "",
        neutered: pet.neutered || "Not sure",
        allergies: pet.allergies || [],
        vaccinationCardId: cardId,
        notes: pet.notes || "",
        photo: pet.photo || "",
        dentalOcclusion: dentalOcclusion || "",
        weights: [{ date: toDateStr(pet.birth) || today, kg: parseFloat(pet.weight) }]
      },
      cardId,
      vaccs: vaccs.map(v => ({
        id: v.id,
        petId: v.pet_id,
        cardId: v.card_id,
        vaccine: v.vaccine,
        brand: v.brand,
        batch: v.batch,
        date: v.date,
        nextDue: v.next_due,
        doseNo: v.dose_no,
        doseOf: v.dose_of,
        done: v.done,
        automated: v.automated,
        protocolType: v.protocol_type,
        notes: "",
        recordedBy: v.recorded_by
      }))
    });
  } catch (err) {
    console.error("Owner pet registration error:", err);
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

// Weight measurements use clinic dates, canonical identity and one audited transaction.
clinicRouter.post("/pets/:id/weights", async (req, res) => {
  try {
    await ensureVitalsSchema();
    const {kg,visitId} = req.body;
    if(typeof visitId!=='string'||!visitId||visitId.length>50)throw registrationError('Choose the visit for this clinic measurement.');
    if(typeof req.body.measuredAt!=='string'||!validDate(req.body.measuredAt.slice(0,10))||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(req.body.measuredAt)||!Number.isFinite(Date.parse(req.body.measuredAt))||Date.parse(req.body.measuredAt)>Date.now())throw registrationError('Enter the actual measurement date and time with a timezone, not in the future.');
    const date=clinicClock(new Date(req.body.measuredAt)).date;
    if (typeof kg !== 'number' || !Number.isFinite(kg) || kg < 0.05 || kg > 120 || Math.abs(kg*100-Math.round(kg*100)) > 0.000001) throw registrationError('Enter a measured weight from 0.05 to 120 kg with at most two decimal places.');
    if (!validDate(date) || date > clinicClock().date || date < EARLIEST_DATE) throw registrationError('Enter a real measurement date from 2000 onward that is not in the future.');
    const result = await withTransaction(async client => {
      const visit=(await client.query('SELECT * FROM appointments WHERE id=$1 FOR UPDATE',[visitId])).rows[0];
      if(!visit||visit.pet_id!==req.params.id)throw registrationError('Choose a visit for this patient.',404);
      if(req.user.role==='vet'&&!assignedTo(visit,req.user))throw registrationError('This visit is assigned to another veterinarian.',403);
      const pet = (await client.query('SELECT * FROM pets WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if (!pet) throw registrationError('Pet not found.',404);
      if (date < toDateStr(pet.birth)) throw registrationError('The measurement cannot be dated before the patient’s birth.');
      const latest = (await client.query('SELECT date,measured_at FROM pet_weights WHERE pet_id=$1 ORDER BY date DESC,measured_at DESC NULLS LAST,created_at DESC LIMIT 1',[pet.id])).rows[0];
      await client.query("INSERT INTO pet_weights (pet_id,date,kg,recorded_by,origin,appt_id,measured_at,staff_id,staff_role) VALUES ($1,$2,$3,$4,'clinic',$5,$6,$7,$8)",[pet.id,date,kg,req.user.name,visitId,req.body.measuredAt,req.user.id,req.user.role]);
      if (!latest || date > toDateStr(latest.date) || date===toDateStr(latest.date) && (!latest.measured_at || Date.parse(req.body.measuredAt)>=new Date(latest.measured_at).getTime())) await client.query("UPDATE pets SET weight=$1,weight_origin='clinic' WHERE id=$2",[kg,pet.id]);
      await registrationAudit(client,req.user,`Recorded measured weight for ${pet.id} on ${date}`);
      return {petId:pet.id,date,kg,by:req.user.name};
    });
    res.json({success:true,measurement:result});
  } catch(error) {res.status(error.status || 500).json({error:error.status ? error.message : 'Unable to save the weight. Please retry.'});}
});

clinicRouter.post(['/owner/pets/:id/photo','/pets/:id/photo'],async (req,res) => {
  try {
    const photo = validatePetPhoto(req.body.photo);
    await ensurePetRegistrationSchema();
    const row = await withTransaction(async client => {
      const pet = (await client.query('SELECT id,owner_id FROM pets WHERE id = $1',[req.params.id])).rows[0];
      const request = pet && pet.registration_status==='Verified' ? null : (await client.query('SELECT * FROM pet_requests WHERE id = $1 OR pet_id = $1',[req.params.id])).rows[0];
      const ownerId = pet?.owner_id || request?.owner_id;
      if (!ownerId || req.user.role === 'owner' && ownerId !== req.user.ownerId) throw registrationError('Pet not found.',404);
      await lockRegistrationOwner(client,ownerId);
      // Approval may have completed since the initial read. Re-read under its lock.
      const current = request ? (await client.query('SELECT * FROM pet_requests WHERE id = $1 FOR UPDATE',[request.id])).rows[0] : null;
      if (request && !current) throw registrationError('Pet request not found.',404);
      const petId = current && current.status!=='Approved' ? null : pet?.id || current?.pet_id;
      const saved = petId
        ? await client.query('UPDATE pets SET photo = $1 WHERE id = $2 RETURNING *',[photo,petId])
        : await client.query('UPDATE pet_requests SET photo=$1,revision=revision+1 WHERE id=$2 RETURNING *',[photo,current.id]);
      if (!saved.rows.length) throw registrationError('Pet not found.',404);
      if(current && current.status!=='Approved' && current.pet_id) {
        const patient=(await client.query('UPDATE pets SET photo=$1 WHERE id=$2 RETURNING *',[photo,current.pet_id])).rows[0];
        saved.rows[0]={...patient,revision:saved.rows[0].revision};
      }
      await registrationAudit(client,req.user,`Updated pet photo ${petId || current.id}`);
      return saved.rows[0];
    });
    res.json({success:true,pet:{id:row.id,ownerId:row.owner_id,name:row.name,species:row.species,speciesOther:row.species_other || '',breed:row.breed,sex:row.sex,birth:toDateStr(row.birth),weight:Number(row.weight),color:row.color || '',neutered:row.neutered,allergies:row.allergies || [],vaccinationCardId:row.vaccination_card_id || '',notes:row.notes || '',photo:row.photo,dentalOcclusion:row.dental_occlusion || '',registrationStatus:row.registration_status || 'Verified',revision:row.revision}});
  } catch(error) {res.status(error.status || 500).json({error:error.status ? error.message : 'Unable to save the pet picture. Please retry.'});}
});

clinicRouter.put('/pets/:id/allergies', saveAllergies);
// Front desk and administrators correct the official owner and patient record. Each save is checked against what the form was opened with.
const correctionError = (message, status = 400, errors) => Object.assign(new Error(message), { status, errors });
const sameText = (a, b) => tidy(a) === tidy(b);
const correctionFailure = (res, error, fallback) => res.status(error.status || 500).json({ error: error.status ? error.message : fallback, ...(error.errors ? { errors: error.errors } : {}) });
const isoDay = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
clinicRouter.put('/owners/:id/details', async (req, res) => {
  try {
    const input = req.body || {}, errors = ownerDetailErrors(input);
    if (Object.keys(errors).length) throw correctionError('Check the highlighted fields.', 400, errors);
    const expected = input.expected || {};
    const owner = await withTransaction(async client => {
      const row = (await client.query('SELECT * FROM owners WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!row) throw correctionError('This owner is no longer in the records. Refresh clinic records.', 404);
      if (row.user_id) throw correctionError('This owner has a verified online account. They update their own name and contact details from My Profile.', 409);
      if (!sameText(row.name, expected.name) || phoneKey(row.phone) !== phoneKey(expected.phone) || !sameText(row.email, expected.email) || !sameText(row.address, expected.address)) throw correctionError('Another staff member changed this owner. Close this form, review the latest details and try again.', 409);
      const next = { name: tidy(input.name), phone: phoneKey(input.phone), email: String(input.email ?? '').trim().toLowerCase(), address: tidy(input.address) };
      const changed = ['name', 'phone', 'email', 'address'].filter(key => !sameText(row[key], next[key]));
      if (!changed.length) return row;
      await assertOwnerContactFree(client, { phone: changed.includes('phone') ? next.phone : '', email: changed.includes('email') ? next.email : '', excludeId: row.id });
      const saved = (await client.query('UPDATE owners SET name=$2,phone=$3,email=$4,address=$5 WHERE id=$1 RETURNING *', [row.id, next.name, next.phone, next.email, next.address])).rows[0];
      await client.query('INSERT INTO audit_logs (user_name,user_role,action) VALUES ($1,$2,$3)', [req.user.name, req.user.role, `Corrected owner record ${row.id}: ${changed.join(', ')}`]);
      return saved;
    });
    res.json({ success: true, owner: { id: owner.id, name: owner.name, phone: owner.phone, email: owner.email, address: owner.address } });
  } catch (error) { correctionFailure(res, error, 'Unable to save the owner details. Please retry.'); }
});
clinicRouter.put('/pets/:id/details', async (req, res) => {
  try {
    const input = req.body || {}, errors = petDetailErrors(input, clinicToday());
    if (Object.keys(errors).length) throw correctionError('Check the highlighted fields.', 400, errors);
    const expected = input.expected || {};
    const pet = await withTransaction(async client => {
      const row = (await client.query('SELECT * FROM pets WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!row) throw correctionError('This patient is no longer in the records. Refresh clinic records.', 404);
      if ((row.registration_status || 'Verified') !== 'Verified') throw correctionError('Review pending registrations from Online Pet Requests before editing the record.', 409);
      const current = { name: row.name, breed: row.breed, sex: row.sex, birth: isoDay(row.birth), color: row.color, neutered: row.neutered, notes: row.notes };
      if (Object.keys(current).some(key => !sameText(current[key], expected[key]))) throw correctionError('Another staff member changed this patient. Close this form, review the latest details and try again.', 409);
      const next = { name: tidy(input.name), breed: tidy(input.breed) || 'Mixed Breed', sex: input.sex, birth: input.birth, color: tidy(input.color), neutered: input.neutered, notes: String(input.notes ?? '').trim() };
      const changed = Object.keys(next).filter(key => !sameText(current[key], next[key]));
      if (!changed.length) return row;
      if (changed.includes('name') || changed.includes('birth')) await assertNoDuplicatePet(client, { ownerId: row.owner_id, name: next.name, species: row.species, birth: next.birth, excludeId: row.id });
      const saved = (await client.query('UPDATE pets SET name=$2,breed=$3,sex=$4,birth=$5,color=$6,neutered=$7,notes=$8 WHERE id=$1 RETURNING *', [row.id, next.name, next.breed, next.sex, next.birth, next.color, next.neutered, next.notes])).rows[0];
      await client.query('INSERT INTO audit_logs (user_name,user_role,action) VALUES ($1,$2,$3)', [req.user.name, req.user.role, `Corrected patient record ${row.id}: ${changed.join(', ')}`]);
      return saved;
    });
    res.json({ success: true, pet: { id: pet.id, name: pet.name, breed: pet.breed, sex: pet.sex, birth: isoDay(pet.birth), color: pet.color || '', neutered: pet.neutered || 'Not sure', notes: pet.notes || '' } });
  } catch (error) { correctionFailure(res, error, 'Unable to save the patient details. Please retry.'); }
});
clinicRouter.put('/pets/:id/reference-history', async (req,res) => {
  try {
    const error=Object.values(externalHistoryErrors(req.body)).find(Boolean);
    if(error) throw registrationError(error);
    if(req.user.role!=='owner') throw registrationError('Only the pet owner can submit owner-reported references.',403);
    if(!Number.isInteger(req.body.revision) || req.body.revision<0) throw registrationError('Refresh the reference history before saving.',409);
    await ensurePetRegistrationSchema();
    const pet=await withTransaction(async client=>{
      await lockRegistrationOwner(client,req.user.ownerId);
      const row=(await client.query('SELECT * FROM pets WHERE id=$1 AND owner_id=$2 FOR UPDATE',[req.params.id,req.user.ownerId])).rows[0];
      if(!row) throw registrationError('Patient not found.',404);
      if(row.registration_status!=='Verified') throw registrationError('Edit the pending registration to update these references.',409);
      const vaccines=(req.body.priorVaccines || []).map(v=>v.trim()), notes=(req.body.externalClinicNotes || '').trim();
      if(JSON.stringify(vaccines)===JSON.stringify(row.prior_vaccines) && notes===row.external_clinic_notes) return row;
      if(row.reference_revision!==req.body.revision) throw registrationError('Reference history changed. Close and reopen it before editing.',409);
      await client.query('INSERT INTO pet_reference_updates(pet_id,prior_vaccines,notes,actor_id,actor_name) VALUES($1,$2,$3,$4,$5)',[row.id,JSON.stringify(vaccines),notes,req.user.id,req.user.name]);
      await registrationAudit(client,req.user,`Updated owner-reported vaccination references for ${row.id}`);
      return (await client.query('UPDATE pets SET prior_vaccines=$2,external_clinic_notes=$3,reference_revision=reference_revision+1 WHERE id=$1 RETURNING *',[row.id,JSON.stringify(vaccines),notes])).rows[0];
    });
    res.json({success:true,pet});
  } catch(error) {res.status(error.status || 500).json({error:error.status?error.message:'Unable to save references. Keep your entries and retry.'});}
});

/* 4. ONLINE PET REGISTRATION REQUESTS & APPROVAL AUTOMATION */
// Creating and correcting requests use the same validation and owner lock.
async function savePetRequest(req, res) {
  try {
    const data = validatePetRegistration(req.body);
    validatePetPlausibility(data, req.body);
    if(req.body.requestId!==undefined && (typeof req.body.requestId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.body.requestId))) throw registrationError('Reopen the registration form before submitting.');
    const submissionId='req_'+(req.body.requestId || crypto.randomUUID()).toLowerCase();
    await ensurePetRegistrationSchema();
    const result = await withTransaction(async client => {
      await lockRegistrationOwner(client,req.user.ownerId);
      if(!req.params.id) {
        const previous=(await client.query('SELECT *,submission_payload=$2::jsonb AS same FROM pet_requests WHERE id=$1',[submissionId,JSON.stringify(data)])).rows[0];
        if(previous) {
          if(previous.owner_id!==req.user.ownerId || !previous.same) throw registrationError('This submission was already saved with different details. Refresh to open the saved pet.',409);
          const pet=(await client.query('SELECT * FROM pets WHERE id=$1',[previous.pet_id])).rows[0];
          return {request:previous,pet};
        }
      }
      if (req.params.id) {
        const current = (await client.query('SELECT * FROM pet_requests WHERE id = $1 FOR UPDATE',[req.params.id])).rows[0];
        if (!current || current.owner_id !== req.user.ownerId) throw registrationError('Pet request not found.',404);
        if (!['Pending','Declined'].includes(current.status)) throw registrationError('This request has already been approved. Contact the clinic to correct the patient record.',409);
        checkRequestRevision(current,req.body.revision);
      }
      await checkRegistrationCapacity(client,req.user.ownerId,data.name,req.params.id || null);
      const values = [data.name,data.species,data.speciesOther,data.breed,data.sex,data.birth,data.weight,data.color,data.neutered,data.notes,data.photo,data.dentalOcclusion];
      const saved = req.params.id
        ? await client.query(`UPDATE pet_requests SET name=$1,species=$2,species_other=$3,breed=$4,sex=$5,birth=$6,weight=$7,color=$8,neutered=$9,notes=$10,photo=$11,dental_occlusion=$12,
            status='Pending',decline_reason=NULL,approved_at=NULL,approved_by=NULL,revision=revision+1,requested_at=CURRENT_DATE WHERE id=$13 RETURNING *`,[...values,req.params.id])
        : await client.query(`INSERT INTO pet_requests (name,species,species_other,breed,sex,birth,weight,color,neutered,notes,photo,dental_occlusion,id,owner_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[...values,submissionId,req.user.ownerId]);
      const history=(await client.query('UPDATE pet_requests SET prior_vaccines=$2,external_clinic_notes=$3 WHERE id=$1 RETURNING *',[saved.rows[0].id,JSON.stringify(data.priorVaccines),data.externalClinicNotes])).rows[0];
      Object.assign(saved.rows[0],history);
      if(saved.rows[0].pet_id) {
        const visits=(await client.query("SELECT to_jsonb(a)->>'service' AS service,a.reason FROM appointments a WHERE pet_id=$1 AND status IN ('Pending Approval','Scheduled')",[saved.rows[0].pet_id])).rows;
        for(const visit of visits) if(visit.service==='vaccination' && vaccineIdFromReason(visit.reason)) requestedVaccineReason({...visit,species:data.species});
      }
      const pet=await savePendingPatient(client,saved.rows[0]);
      if(!req.params.id) await client.query('UPDATE pet_requests SET submission_payload=$2 WHERE id=$1',[saved.rows[0].id,JSON.stringify(data)]);
      await registrationAudit(client,req.user,`${req.params.id ? 'Corrected and resubmitted' : 'Submitted'} pet request ${saved.rows[0].id} for ${data.name}`);
      return {request:saved.rows[0],pet};
    });
    res.json({success:true,...result});
  } catch (error) { res.status(error.status || 500).json({error:error.status ? error.message : 'Unable to save the pet request. Your entries are preserved; please retry.'}); }
}
clinicRouter.post('/pet-requests',savePetRequest);
clinicRouter.put('/pet-requests/:id',savePetRequest);

clinicRouter.delete('/pet-requests/:id',async (req,res) => {
  try {
    await ensurePetRegistrationSchema();
    await withTransaction(async client => {
      await lockRegistrationOwner(client,req.user.ownerId);
      const row = (await client.query('SELECT * FROM pet_requests WHERE id = $1 FOR UPDATE',[req.params.id])).rows[0];
      if (!row || row.owner_id !== req.user.ownerId) throw registrationError('Pet request not found.',404);
      if (row.status === 'Approved') throw registrationError('This request has already been approved. Refresh to view the patient.',409);
      if(row.pet_id && (await client.query('SELECT id FROM appointments WHERE pet_id=$1 LIMIT 1',[row.pet_id])).rows.length) throw registrationError('This pet has appointment records. Keep the registration for clinic review; you can cancel an upcoming appointment from My Appointments.',409);
      await client.query('DELETE FROM pet_requests WHERE id = $1',[row.id]);
      if(row.pet_id) await client.query("DELETE FROM pets WHERE id=$1 AND registration_status<>'Verified'",[row.pet_id]);
      await registrationAudit(client,req.user,`Withdrew pet request ${row.id} for ${row.name}`);
    });
    res.json({success:true});
  } catch(error) {res.status(error.status || 500).json({error:error.status ? error.message : 'Unable to remove the pet request. Please retry.'});}
});

clinicRouter.post("/pet-requests/:id/approve", async (req, res) => {
  try {
    await ensurePetRegistrationSchema();
    await ensureAppointmentApprovalSchema();
    await ensureVitalsSchema();
    const result = await withTransaction(async client => {
      await lockSchedule(client);
      const pending = await client.query("SELECT id FROM appointments WHERE pet_id=(SELECT pet_id FROM pet_requests WHERE id=$1) AND status='Pending Approval' LIMIT 1",[req.params.id]);
      if (pending.rows.length) throw registrationError('Review the linked appointment request to approve the visit and registration together.',409);
      return approveRegistration(client, req.params.id, req.user, req.body.revision);
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

clinicRouter.post('/pet-requests/:id/decline',async (req,res) => {
  try {
    const reason = req.body.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) throw registrationError('Explain what the owner needs to correct (up to 500 characters).');
    await ensurePetRegistrationSchema();
    const result = await withTransaction(async client => {
      const ownerId = (await client.query('SELECT owner_id FROM pet_requests WHERE id = $1',[req.params.id])).rows[0]?.owner_id;
      await lockRegistrationOwner(client,ownerId);
      const row = (await client.query('SELECT * FROM pet_requests WHERE id = $1 FOR UPDATE',[req.params.id])).rows[0];
      if (!row) throw registrationError('Pet request not found.',404);
      if (row.status !== 'Pending') throw registrationError('This request has already been processed.',409);
      checkRequestRevision(row,req.body.revision);
      const saved = await client.query("UPDATE pet_requests SET status='Declined',decline_reason=$1,revision=revision+1 WHERE id=$2 RETURNING *",[reason.trim(),row.id]);
      if(row.pet_id) await client.query("UPDATE pets SET registration_status='Declined' WHERE id=$1 AND registration_status='Pending'",[row.pet_id]);
      await registrationAudit(client,req.user,`Declined pet request ${row.id}: ${reason.trim()}`);
      return saved.rows[0];
    });
    res.json({success:true,request:result});
  } catch(error) {res.status(error.status || 500).json({error:error.status ? error.message : 'Unable to save the review. Please retry.'});}
});

/* 5. APPOINTMENTS & CHECK-IN INTAKE FLOW */
// Owners receive open times only, never other clients or internal timetables.
clinicRouter.get("/appointments/availability", async (req, res) => {
  try {
    await ensureSchedulingSchema();
    const { vetId, date, service, excludeId } = req.query;
    if (!validDate(date)) throw bookingError("Choose a valid appointment date.");
    const doctor = (await query("SELECT id, vet_id FROM users WHERE role = 'vet' AND COALESCE(to_jsonb(users)->>'is_active', 'true') <> 'false' AND (vet_id = $1 OR id = $1)", [vetId])).rows[0];
    if (!doctor) throw bookingError("Choose a current veterinarian.");
    let excluded;
    if (excludeId) {
      excluded = (await query("SELECT * FROM appointments WHERE id = $1", [excludeId])).rows[0];
      if (!excluded || (req.user.role === "owner" && !(await query("SELECT id FROM pets WHERE id = $1 AND owner_id = $2", [excluded.pet_id, req.user.ownerId])).rows.length)) throw bookingError("Appointment not found.", 404);
    }
    if (excluded && req.user.role==='assistant' && ![doctor.id,doctor.vet_id].includes(excluded.vet_id)) throw bookingError('Keep the assigned veterinarian when rescheduling.');
    const rows = (await query("SELECT * FROM appointments WHERE date = $1 AND vet_id = ANY($2::varchar[])", [date, [doctor.id,doctor.vet_id].filter(Boolean)])).rows;
    const rescheduling=excluded && req.user.role==='assistant';
    res.json({ slots: availableSlots(rows, { date, service:rescheduling?excluded.service:service, excludeId: excluded?.id },new Date(),rescheduling?excluded.duration_minutes || 30:undefined) });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to load availability. Choose a valid date and retry." }); }
});

async function saveBooking(req, res, editing = false) {
  try {
    await ensurePetRegistrationSchema();
    await ensureAppointmentApprovalSchema();
    await ensureCareSchema();
    await ensureSchedulingSchema();
    const row = await withTransaction(async client => {
      await lockSchedule(client);
      const previous = editing ? (await client.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0] : null;
      if (editing && !previous) throw bookingError("Appointment not found.", 404);
      if (previous && !["Pending Approval", "Scheduled"].includes(previous.status)) throw bookingError("Only upcoming appointments can be edited.", 409);
      const b = req.body;
      const v = { petId: b.petId ?? previous?.pet_id, vetId: b.vetId ?? previous?.vet_id, date: b.date ?? previous?.date, time: b.time ?? previous?.time, reason: b.reason ?? previous?.reason, notes: b.notes ?? previous?.notes ?? "" };
      v.service = b.service ?? previous?.service ?? inferBookingService(v.reason);
      const patient=(await client.query('SELECT owner_id FROM pets WHERE id=$1',[v.petId])).rows[0];
      if(!patient) throw bookingError('Pet not found.',404);
      await lockRegistrationOwner(client,patient.owner_id);
      const registration=(await client.query('SELECT registration_status FROM pets WHERE id=$1',[v.petId])).rows[0];
      if(registration?.registration_status==='Declined') throw bookingError('Correct and resubmit this pet registration before requesting a visit.',409);
      if(req.user.role==='owner' && registration?.registration_status==='Pending') throw bookingError('This pet is still pending verification. You can book a visit once the clinic has verified it.',409);
      // The old assessment slot is no longer offered. Visits already booked with it can still be rescheduled.
      if(v.service==='surgery' && previous?.service!=='surgery') throw bookingError('This service is no longer offered. Book a check-up instead.');
      if(previous && req.user.role==='assistant') {
        // Reception reschedules an existing request; all clinical/request fields stay immutable.
        const fixed={id:previous.id,petId:previous.pet_id,vetId:previous.vet_id,service:previous.service,reason:previous.reason,notes:previous.notes || '',followUpId:previous.follow_up_id || null,amount:Number(previous.amount),durationMinutes:previous.duration_minutes,bookingKind:previous.booking_kind};
        const doctor=(await client.query("SELECT id, vet_id FROM users WHERE role = 'vet' AND COALESCE(to_jsonb(users)->>'is_active','true') <> 'false' AND (id = $1 OR vet_id = $1)",[previous.vet_id])).rows[0];
        if(!doctor)throw bookingError('The assigned veterinarian is unavailable. Contact the clinic to review this visit.');
        for(const [key,value] of Object.entries(fixed)) {
          if(b[key]!==undefined && b[key]!==value && !(key==='vetId' && [doctor.id,doctor.vet_id].includes(b[key])))
            throw bookingError('Rescheduling can change only the date and time. Keep the original patient, veterinarian, service, reason and follow-up.');
        }
        if(b.vaccineId!==undefined && b.vaccineId!==vaccineIdFromReason(previous.reason))throw bookingError('Keep the original vaccine request when rescheduling.');
        if(b.reasonChoice!==undefined || b.otherReason!==undefined)throw bookingError('Keep the original visit reason when rescheduling.');
        const sameSlot=v.date===toDateStr(previous.date) && v.time===previous.time;
        if(b.expectedVisit && !sameIntakeVisit(previous,b.expectedVisit)) {
          // A lost-response retry may acknowledge the same saved slot, including a later reapproval.
          const original={...b.expectedVisit,date:previous.date,time:previous.time,status:previous.status};
          if(!sameSlot || !sameIntakeVisit(previous,original))throw bookingError('This appointment has changed. Refresh and review its current schedule.',409);
        }
        if(sameSlot)return previous;
        await assertAvailable(client,{...v,vetAliases:[doctor.id,doctor.vet_id].filter(Boolean)},previous.id,previous.duration_minutes || 30);
        const saved=(await client.query("UPDATE appointments SET date=$2,time=$3,status='Pending Approval',approved_at=NULL,approved_by=NULL,approved_by_user_id=NULL WHERE id=$1 RETURNING *",[previous.id,v.date,v.time])).rows[0];
        await client.query("INSERT INTO audit_logs (user_name,user_role,action) VALUES ($1,$2,$3)",[req.user.name,req.user.role,`Rescheduled appointment ${previous.id} from ${toDateStr(previous.date)} ${previous.time} to ${v.date} ${v.time}`]);
        return saved;
      }
      if(b.reasonChoice!==undefined || b.otherReason!==undefined) {
        const reasonErrors=bookingReasonErrors(v.service,b.reasonChoice,b.otherReason);
        if(v.service==='vaccination' || Object.keys(reasonErrors).length)throw bookingError(Object.values(reasonErrors)[0] || 'Choose a vaccine request instead.');
        // Preserve unchanged legacy wording, while deriving every new/changed reason from the choices.
        if(!(previous && v.service===previous.service && b.reason===previous.reason))v.reason=bookingReason(v.service,b.reasonChoice,b.otherReason);
      }
      if (typeof v.reason !== "string" || v.reason.trim().length < 3 || v.reason.length > 300 || typeof v.notes !== "string" || v.notes.length > 200) throw bookingError("Add a visit reason (3–300 characters) and keep notes under 200 characters.");
      if ((!previous || v.reason !== previous.reason) && walkInReasonError(v.reason)) throw bookingError(walkInReasonError(v.reason));
      // Recheck ownership inside the transaction, after any simultaneous change.
      if (req.user.role === "owner") {
        for (const id of new Set([v.petId, previous?.pet_id].filter(Boolean))) {
          if (!(await client.query("SELECT id FROM pets WHERE id = $1 AND owner_id = $2", [id, req.user.ownerId])).rows.length) throw bookingError("Pet not found.", 404);
        }
      }
      // Stable client IDs make an acknowledged-lost create safe to retry.
      if (!editing && b.id) {
        if (typeof b.id !== 'string' || b.id.length > 50) throw bookingError('Invalid booking identifier.');
        const existing=(await client.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE",[b.id])).rows[0];
        if (existing) {
          if (existing.pet_id !== v.petId || existing.vet_id !== v.vetId || toDateStr(existing.date) !== v.date || existing.time !== v.time || existing.service !== v.service || existing.reason !== v.reason.trim() || (existing.notes || '') !== v.notes || (existing.follow_up_id || null) !== (b.followUpId || null))
            throw bookingError('This booking identifier has already been used. Refresh appointments before retrying.',409);
          return existing;
        }
      }
      if (previous && b.expectedVisit && !sameIntakeVisit(previous,b.expectedVisit))
        throw bookingError('This appointment has changed. Refresh and review its current schedule.',409);
      if (b.vaccineId !== undefined || (v.service === 'vaccination' && vaccineIdFromReason(v.reason))) {
        const pet = (await client.query("SELECT species FROM pets WHERE id = $1", [v.petId])).rows[0];
        if (!pet) throw bookingError("Pet not found.", 404);
        v.reason = requestedVaccineReason({...v, vaccineId:b.vaccineId, species:pet.species});
        if(v.reason.length > 300) throw bookingError("Keep the requested vaccine purpose under 300 characters.");
      }
      const followUpId = b.followUpId ?? previous?.follow_up_id ?? null;
      if (previous?.follow_up_id && followUpId !== previous.follow_up_id) throw bookingError("Keep the linked follow-up when rescheduling.");
      if (followUpId) {
        const request = (await client.query("SELECT * FROM consultations WHERE id = $1 FOR UPDATE", [followUpId])).rows[0];
        if (!request || request.pet_id !== v.petId || !request.follow_up_date || request.care_status === 'Routine care') throw bookingError("Choose an outstanding follow-up for this pet.");
        const linked = await client.query("SELECT id FROM appointments WHERE follow_up_id=$1 AND status NOT IN ('Cancelled','Rejected','No-show') AND id <> $2", [followUpId, previous?.id || '']);
        if (linked.rows.length) throw bookingError("This follow-up already has a booked or completed visit.", 409);
      }
      const walkIn = !editing && b.bookingKind === "walk-in" && req.user.role === "assistant";
      let duration;
      if (walkIn) {
        if (registration?.registration_status && registration.registration_status!=='Verified')
          throw bookingError('Review and approve this pet’s registration before saving a walk-in arrival.',409);
        const clock = clinicClock(); v.date = clock.date; v.time = clock.time;
        const existing = (await client.query("SELECT * FROM appointments WHERE date = $1 AND (vet_id = $2 OR pet_id = $3)", [v.date, v.vetId, v.petId])).rows;
        if (existing.some(a => a.pet_id === v.petId && !["Cancelled", "Rejected", "No-show", "Completed"].includes(a.status))) throw bookingError("This pet already has an active visit today. Check in that visit.", 409);
        duration = 30;
      } else {
        const doctor=(await client.query("SELECT id, vet_id FROM users WHERE role = 'vet' AND COALESCE(to_jsonb(users)->>'is_active','true') <> 'false' AND (id = $1 OR vet_id = $1)",[v.vetId])).rows[0];
        if(!doctor)throw bookingError('Choose a current veterinarian.');
        duration = await assertAvailable(client, {...v,vetAliases:[doctor.id,doctor.vet_id].filter(Boolean)}, previous?.id);
      }
      const changedSlot = previous && (v.petId !== previous.pet_id || v.vetId !== previous.vet_id || v.date !== previous.date || v.time !== previous.time || v.service !== previous.service || (v.service === "vaccination" && v.reason !== previous.reason));
      const values = [editing ? previous.id : b.id || `a_${crypto.randomUUID()}`, v.petId, v.vetId, v.date, v.time, v.reason.trim(), req.user.role === "owner" ? previous?.amount ?? 600 : Number(b.amount) || previous?.amount || 600, v.service, duration, walkIn ? "walk-in" : "reservation", v.notes];
      const sql = editing ? `UPDATE appointments SET pet_id=$2,vet_id=$3,date=$4,time=$5,reason=$6,amount=$7,status=$12,service=$8,duration_minutes=$9,booking_kind=$10,notes=$11 WHERE id=$1 RETURNING *` : `INSERT INTO appointments (id,pet_id,vet_id,date,time,reason,amount,service,duration_minutes,booking_kind,notes,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Pending Approval') RETURNING *`;
      if (editing) values.push(changedSlot ? "Pending Approval" : previous.status);
      // UPDATE uses the same parameter positions as INSERT.
      const saved = await client.query(sql, values);
      if (changedSlot) {
        await client.query('UPDATE appointments SET approved_at=NULL,approved_by=NULL,approved_by_user_id=NULL WHERE id=$1',[values[0]]);
        Object.assign(saved.rows[0],{approved_at:null,approved_by:null,approved_by_user_id:null});
      }
      if (walkIn) { await client.query("UPDATE appointments SET status='Scheduled' WHERE id=$1",[values[0]]); saved.rows[0].status="Scheduled"; }
      if (followUpId) {
        await client.query("UPDATE appointments SET follow_up_id=$1 WHERE id=$2", [followUpId, values[0]]);
        saved.rows[0].follow_up_id = followUpId;
      }
      await client.query("INSERT INTO audit_logs (user_name,user_role,action) VALUES ($1,$2,$3)", [req.user.name,req.user.role,`${editing ? "Updated" : "Booked"} appointment ${values[0]} on ${v.date} ${v.time}: ${v.reason.trim()}`]);
      return saved.rows[0];
    });
    res.json({ success: true, appointment: { followUpId: row.follow_up_id || null, id: row.id, petId: row.pet_id, vetId: row.vet_id, date: toDateStr(row.date), time: row.time, reason: row.reason, notes: row.notes, service: row.service, durationMinutes: row.duration_minutes, bookingKind: row.booking_kind, status: row.status, billingStatus: row.billing_status, approvedAt:row.approved_at || null,approvedBy:row.approved_by || null,approvedByUserId:row.approved_by_user_id || null, amount: Number(row.amount) } });
  } catch (error) {
    res.status(error.status || (error.code === "23505" ? 409 : 500)).json({ error: error.status ? error.message : error.code === "23505" ? "This booking already exists. Refresh before retrying." : "Unable to save the booking. Please retry." });
  }
}
clinicRouter.post("/appointments", (req, res) => saveBooking(req, res));
clinicRouter.put("/appointments/:id", (req, res) => saveBooking(req, res, true));

clinicRouter.patch("/appointments/:id/status", async (req, res) => {
  const apptId = req.params.id;
  const { status, intakeVitals, cancelReason, billingStatus, reason, actorName, actorRole } = req.body;

  try {
    await ensurePetRegistrationSchema();
    await ensureAppointmentApprovalSchema();
    await ensureVitalsSchema();
    const result = await withTransaction(async (client) => {
      // Serialize arrival/handoff with deactivation so a visit cannot join an inactive vet's queue.
      await lockSchedule(client);
      const current = (await client.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [apptId])).rows[0];
      if (!current) throw Object.assign(new Error("Appointment not found."), { status: 404 });
      if (req.user.role === "owner" && !(await client.query("SELECT id FROM pets WHERE id = $1 AND owner_id = $2", [current.pet_id, req.user.ownerId])).rows.length) throw Object.assign(new Error("Appointment not found."), { status: 404 });
      if (status === 'Scheduled') return approveAppointment(client, current, req.body, req.user);
      if (req.body.expectedVisit !== undefined && !sameIntakeVisit(current, req.body.expectedVisit)) {
        throw bookingError("This visit has changed. Refresh clinic records and reopen its current action.", 409);
      }
      const invalid = validateStatusChange(current, req.body, req.user);
      if (invalid) throw Object.assign(new Error(invalid), { status: 409 });
      if (status === 'Checked-in' || (status === 'In consultation' && current.status !== 'In consultation')) {
        const other = (await client.query("SELECT id, date, status FROM appointments WHERE pet_id=$1 AND id<>$2 AND status IN ('Checked-in','In consultation') ORDER BY date LIMIT 1", [current.pet_id, current.id])).rows[0];
        if (other) throw Object.assign(new Error(`This patient already has an open visit from ${String(other.date instanceof Date ? other.date.toISOString() : other.date).slice(0, 10)} (${other.status}). Finish it or close it before opening another.`), { status: 409 });
      }
      if (['Checked-in','In consultation'].includes(status) && (await client.query("SELECT id FROM pets WHERE id=$1 AND registration_status<>'Verified'",[current.pet_id])).rows.length) throw bookingError('Approve this pet’s appointment request or registration before starting the visit.',409);
      if (status === 'Checked-in' || status === 'In consultation') {
        const doctor=(await client.query("SELECT id, vet_id FROM users WHERE role = 'vet' AND (id=$1 OR vet_id=$1) AND COALESCE(to_jsonb(users)->>'is_active','true') <> 'false'",[current.vet_id])).rows[0];
        if(!doctor)throw bookingError("The assigned veterinarian is inactive. Reception must reassign an upcoming visit before check-in; active care requires a veterinarian handoff.",409);
      }
      let q = "UPDATE appointments SET status = $1";
      const params = [status];
      let pIdx = 2;

      if (intakeVitals !== undefined) {
        q += `, intake_vitals = $${pIdx++}`;
        const pet = (await client.query("SELECT species, breed, weight FROM pets WHERE id = $1", [current.pet_id])).rows[0];
        const captureId=crypto.randomUUID(),measuredAt=new Date().toISOString();
        const canonicalVitals = {captureId,measuredAt,staffId:req.user.id,staffRole:req.user.role,measurementIds:{weight:captureId+'-weight',temp:captureId+'-temp'},weight:intakeVitals.weight,temp:intakeVitals.temp,
          triageLevel:intakeVitals.triageLevel ?? 'Routine',fasted:intakeVitals.fasted ?? false,notes:(intakeVitals.notes ?? '').trim(),
          checkedInAt:clinicClock().time,checkedInBy:req.user.name,
          weightAnalysis:assessWeight(intakeVitals.weight,pet?.species || '',pet?.breed || '',Number(pet?.weight) || null),
          tempAnalysis:assessTemp(intakeVitals.temp,pet?.species || '')};
        params.push(JSON.stringify(canonicalVitals));
      }
      if (cancelReason !== undefined) {
        q += `, cancel_reason = $${pIdx++}`;
        params.push(cancelReason.trim());
      }
      if (billingStatus !== undefined) {
        q += `, billing_status = $${pIdx++}`;
        params.push(billingStatus);
      }
      if (reason !== undefined) {
        q += `, reason = $${pIdx++}`;
        if (inferBookingService(reason) === 'vaccination' && vaccineIdFromReason(reason)) {
          const pet=(await client.query("SELECT species FROM pets WHERE id = $1",[current.pet_id])).rows[0];
          requestedVaccineReason({service:'vaccination',reason,species:pet?.species});
        }
        params.push(reason.trim());
      }

      q += ` WHERE id = $${pIdx} RETURNING *`;
      params.push(apptId);

      const upd = await client.query(q, params);
      if (!upd.rows.length) throw new Error("Appointment not found");

      // If Checked-in and has weight in intake vitals, update pet weight log
      if (["Checked-in","In consultation"].includes(status) && intakeVitals?.weight) {
        const appt = upd.rows[0];
        const numWeight = parseFloat(intakeVitals.weight);
        if (!isNaN(numWeight)) {
          await client.query("UPDATE pets SET weight = $1 WHERE id = $2", [numWeight, appt.pet_id]);
          await client.query(
            "INSERT INTO pet_weights (pet_id, date, kg, recorded_by,origin,appt_id,measured_at,staff_id,staff_role,vital_id) VALUES ($1,$2,$3,$4,'clinic',$5,$6,$7,$8,$9)",
            [appt.pet_id,clinicClock().date,numWeight,req.user.name,appt.id,appt.intake_vitals.measuredAt,req.user.id,req.user.role,appt.intake_vitals.measurementIds.weight]
          );
        }
      }

      await client.query("INSERT INTO audit_logs (user_name,user_role,action) VALUES ($1,$2,$3)",
        [req.user.name, req.user.role, `Updated appointment ${apptId} status to "${status}"`]);
      return upd.rows[0];
    });
    res.json({ success: true, ...(result.appointment ? result : {appointment:result}) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : "Unable to save visit status. Please try again." });
  }
});

// Closing a visit that never produced a clinical record. Anything already saved against the visit must be completed instead.
clinicRouter.post("/appointments/:id/close", async (req, res) => {
  try {
    const input = req.body || {}, errors = closeVisitErrors(input);
    if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], errors });
    await ensureDigitalVetCardSchema();
    await ensureAdmissionsSchema();
    const appointment = await withTransaction(async client => {
      await lockSchedule(client);
      const row = (await client.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
      if (!row) throw Object.assign(new Error("Appointment not found."), { status: 404 });
      if (!OPEN_STATUSES.includes(row.status)) throw Object.assign(new Error("Only a checked-in or in-consultation visit can be closed. Refresh clinic records."), { status: 409 });
      if (input.expectedStatus !== row.status) throw Object.assign(new Error("This visit changed. Refresh clinic records and review its current status."), { status: 409 });
      const [notes, doses, admission] = await Promise.all([
        client.query("SELECT 1 FROM consultations WHERE appt_id = $1 LIMIT 1", [row.id]),
        client.query("SELECT 1 FROM vaccinations WHERE appt_id = $1 AND done LIMIT 1", [row.id]),
        client.query("SELECT 1 FROM admissions WHERE appt_id = $1 LIMIT 1", [row.id]),
      ]);
      if (admission.rows.length) throw Object.assign(new Error("This pet was admitted for this visit. Continue care from Admitted Pets instead of closing it."), { status: 409 });
      if (notes.rows.length || doses.rows.length || (row.invoice_items || []).length) throw Object.assign(new Error("This visit already has saved clinical notes, vaccines or charges. Complete the visit instead of closing it."), { status: 409 });
      const saved = (await client.query("UPDATE appointments SET status = 'Cancelled', cancel_reason = $2 WHERE id = $1 RETURNING *", [row.id, closeReasonText(input)])).rows[0];
      await client.query("INSERT INTO audit_logs (user_name,user_role,action) VALUES ($1,$2,$3)", [req.user.name, req.user.role, `Closed visit ${row.id} without a record (${closeReasonLabel(input.reasonCode)})`]);
      return saved;
    });
    res.json({ success: true, appointment });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : "Unable to close this visit. Please try again." });
  }
});

clinicRouter.delete("/appointments/:id", async (req, res) => {
  try {
    await query("DELETE FROM appointments WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

/* 5.1 CLINIC BILLING & PRICE CATALOG */


clinicRouter.get("/services/prices", (req, res) => {
  res.json({ success: true, catalog: priceCatalog(), dewormingProducts: dewormingProducts() });
});

clinicRouter.post("/appointments/:id/billing", async (req, res) => {
  const apptId = req.params.id;
  const { amount, billingStatus, paymentMethod, actorName, actorRole } = req.body;
  const invoiceItems = req.body.invoiceItems;

  if (req.body.discount !== undefined && req.body.discount !== 0) return res.status(400).json({error:'Discounts are not available for new payments.'});
  const discount = 0;
  const validItems = Array.isArray(invoiceItems) && invoiceItems.length > 0 && invoiceItems.length <= 100 && invoiceItems.every(item => item && typeof item.name === "string" && item.name.trim() && typeof item.price === "number" && Number.isFinite(item.price) && item.price >= 0 && item.price <= 10000000 && Number.isInteger(item.qty) && item.qty > 0 && item.qty <= 1000);
  const subtotal = validItems ? invoiceItems.reduce((sum, item) => sum + Math.round(item.price * 100) * item.qty, 0) : NaN;
  const total = (subtotal - Math.round(discount * 100)) / 100;
  if (!validItems || !Number.isFinite(discount) || discount < 0 || !Number.isFinite(total) || total <= 0 || total > 10000000 || typeof amount !== "number" || !Number.isFinite(amount) || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001 || Math.round(amount * 100) !== Math.round(total * 100) || !["Cash", "GCash", "Maya", "Credit / Debit Card"].includes(paymentMethod) || (billingStatus && billingStatus !== "Paid")) {
    return res.status(400).json({ error: "Check invoice quantities, prices, total and payment method." });
  }
  if (paymentMethod === "Cash" ? (typeof req.body.cashTendered !== "number" || !Number.isFinite(req.body.cashTendered) || !Number.isSafeInteger(Math.round(req.body.cashTendered * 100)) || Math.abs(req.body.cashTendered * 100 - Math.round(req.body.cashTendered * 100)) > 0.000001 || req.body.cashTendered < total) : (typeof req.body.paymentReference !== "string" || req.body.paymentReference.trim().length < 4 || req.body.paymentReference.length > 100)) return res.status(400).json({ error: "Enter sufficient cash received or the confirmed payment reference." });
  try {
    await ensureDigitalVetCardSchema();
    await ensureCheckoutSchema();
    await ensureCheckoutInboxSchema();
    await ensurePrescriptionSchema();
    await ensureCareSchema();
    await ensureAdmissionsSchema();
    const paymentDetails = { discount, reference: req.body.paymentReference || "", cashTendered: paymentMethod === "Cash" ? req.body.cashTendered : total, changeAmount: paymentMethod === "Cash" ? Math.round((req.body.cashTendered - total) * 100) / 100 : 0, receivedBy: req.user.name || "" };
    const result = await withTransaction(async client => {
      const current = (await client.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [apptId])).rows[0];
      if (!current) throw Object.assign(new Error("Appointment not found."), { status: 404 });
      if (current.status !== "Completed" || current.billing_status === "Paid") throw Object.assign(new Error("Only a completed, unpaid consultation can be checked out."), { status: 409 });
      const consultation = (await client.query("SELECT id, prescription_items, performed_services FROM consultations WHERE appt_id = $1 ORDER BY date DESC, created_at DESC, id DESC LIMIT 1", [apptId])).rows[0];
      if (!consultation) throw Object.assign(new Error("A finalized consultation is required before payment."), { status: 409 });
      if (paymentMethod !== "Cash") await assertPaymentReferenceUnused(client, { reference: req.body.paymentReference, appointmentId: apptId });
      await assertAdmissionCheckout(client, apptId);
      const expectedAdmission = await admissionCharges(client, apptId);
      const canonical = canonicalInvoice(invoiceItems, priceCatalog({includeRetired: true}), expectedAdmission);
      if (!canonical) throw Object.assign(new Error('Use the official clinic prices and recorded admission supplies.'), {status:400});
      const admissionError = validateAdmissionCharges(canonical, expectedAdmission);
      if (admissionError) throw Object.assign(new Error(admissionError), {status:400});
      const chargeError = validateClinicalCharges(canonical, consultation.performed_services || []);
      if (chargeError) throw Object.assign(new Error(chargeError), {status:400});
      const addonError = validateCheckoutAddons(canonical, consultation, current.invoice_items || []);
      if (addonError) throw Object.assign(new Error(addonError), {status:400});
      const saleError = validatePrescriptionSale(canonical.filter(line => line.source !== 'admission'), consultation.prescription_items || []);
      if (saleError) throw Object.assign(new Error(saleError), {status: 400});
      await authorizeCheckoutPayment(client, apptId, req.user, req.body.claimToken);
      const updated = await client.query(
        `UPDATE appointments SET amount = $1, billing_status = 'Paid', payment_method = $2, invoice_items = $3, payment_details = $4, paid_at = NOW() WHERE id = $5 RETURNING *`,
        [total, paymentMethod, JSON.stringify(canonical), JSON.stringify(paymentDetails), apptId]
      );
      await client.query("INSERT INTO audit_logs (user_name, user_role, action) VALUES ($1,$2,$3)", [req.user.name, req.user.role, `Processed payment ₱${total} (${paymentMethod}) for visit ${apptId}`]);
      await finishCheckoutTask(client, apptId, req.user.id);
      // Vet-approved stays are closed by final payment, so the pet is recorded as discharged.
      const closed = (await client.query("UPDATE admissions SET status='Discharged',discharged_at=clock_timestamp(),revision=revision+1 WHERE appt_id=$1 AND status='Ready for discharge' RETURNING id", [apptId])).rows[0];
      if (closed) {
        await client.query(`INSERT INTO admission_updates (id,admission_id,kind,clinical_note,owner_update,actor_id,actor_name,actor_role,request_payload)
          VALUES ($1,$2,'Release','Final payment received; pet discharged.','Your pet has been discharged after final payment.',$3,$4,$5,'{}')`, [crypto.randomUUID(), closed.id, req.user.id, req.user.name || '', req.user.role === 'vet' ? 'vet' : 'assistant']);
        await client.query("INSERT INTO audit_logs (user_name, user_role, action) VALUES ($1,$2,$3)", [req.user.name, req.user.role, `Discharged admission ${closed.id} after final payment`]);
      }
      await refreshDigitalVetCard(client, current.pet_id);
      return updated;
    });

    const row = result.rows[0];

    res.json({
      success: true,
      appointment: {
        id: row.id,
        petId: row.pet_id,
        vetId: row.vet_id,
        date: toDateStr(row.date),
        time: row.time,
        reason: row.reason,
        status: row.status,
        billingStatus: row.billing_status,
        amount: parseFloat(row.amount),
        paymentMethod: row.payment_method,
        paymentReference: paymentDetails.reference,
        discount,
        cashTendered: paymentDetails.cashTendered,
        changeAmount: paymentDetails.changeAmount,
        receivedBy: paymentDetails.receivedBy,
        paidAt: row.paid_at,
        invoiceItems: row.invoice_items
      }
    });
  } catch (err) {
    if (!err.status) console.error("Payment save failed:", err);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Unable to save payment. Refresh the visit before retrying." });
  }
});

/* 5.2 WALK-IN REGISTRATION (OWNER + PET + DIGITAL CARD + QUEUE) */
clinicRouter.post("/walk-in", async (req, res) => {
  const {
    ownerName, phone, email, address,
    petName, species, speciesOther, breed, sex, birth, weight, color, neutered, dentalOcclusion, notes,
    addToQueue, reason, actorName, actorRole,
    serviceCategory, specificVaccine,
    priorVaccines, externalClinicNotes
  } = req.body;

  const ownerId = "o_" + Math.random().toString(36).slice(2, 8);
  const petId = "p_" + Math.random().toString(36).slice(2, 8);
  const cardId = "VACC-" + new Date().getFullYear() + "-" + Math.floor(1000 + Math.random() * 9000);
  const today = clinicClock().date;

  try {
    await ensureVitalsSchema();
    const registration = validateWalkInRegistration(req.body);
    const patient = registration.patient;
    const requestedReason = requestedVaccineReason({service:serviceCategory, vaccineId:req.body.vaccineId,
      reason:reason || (serviceCategory === 'vaccination' ? `Vaccination: ${specificVaccine || 'Vaccine consultation'}` : ''), species:patient.species});
    await ensureSchedulingSchema();
    await ensurePetRegistrationSchema();
    const result = await withTransaction(async (client) => {
      // Match contacts only to prompt a reviewed selection; never choose a household silently.
      const effectiveOwner = await resolveWalkInOwner(client,req.body.ownerId,registration,ownerId);
      await lockRegistrationOwner(client,effectiveOwner.id);
      await checkRegistrationCapacity(client,effectiveOwner.id,patient.name,null,{pendingRequest:false});
      await assertNoDuplicatePet(client,{ownerId:effectiveOwner.id,name:patient.name,species:patient.species,birth:patient.birth});

      // 2. Insert Pet
      const insPet = await client.query(
        `INSERT INTO pets (id, owner_id, name, species, species_other, breed, sex, birth, weight, color, neutered, vaccination_card_id, notes, dental_occlusion)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          petId,
          effectiveOwner.id,
          patient.name,
          patient.species,
          patient.speciesOther,
          patient.breed,
          patient.sex,
          patient.birth,
          patient.weight,
          patient.color,
          patient.neutered,
          cardId,
          patient.notes,
          patient.dentalOcclusion
        ]
      );
      const pet = insPet.rows[0];

      // 3. Weight log
      await client.query(
        `INSERT INTO pet_weights (pet_id, date, kg, recorded_by,origin) VALUES ($1, $2, $3, $4,'registration')`,
        [petId, today, patient.weight, req.user.name]
      );

      // 4. Seed Vaccines: Record Prior External History Guide + Pre-Schedule Next Protocol
      const sp = (species || "").toLowerCase();
      const isDog = sp.includes("dog") || sp.includes("canine");
      const isCat = sp.includes("cat") || sp.includes("feline");
      const addDays = (dStr, days) => {
        const d = new Date(dStr);
        d.setDate(d.getDate() + days);
        return d.toISOString().slice(0, 10);
      };

      const seeded = [];
      const priorList = patient.priorVaccines;
      await client.query('UPDATE pets SET prior_vaccines=$2,external_clinic_notes=$3 WHERE id=$1',[petId,JSON.stringify(priorList),patient.externalClinicNotes]);

      // A) Preserve previous-clinic references; document readers identify these as unverified reports.
      const hasPriorDHPP1 = priorList.some(x => /dhpp.*1|dose.*1|puppy.*1/i.test(String(x)));
      const hasPriorDHPP2 = priorList.some(x => /dhpp.*2|dose.*2|puppy.*2/i.test(String(x)));
      const hasPriorDHPP3 = priorList.some(x => /dhpp.*3|dose.*3|puppy.*3/i.test(String(x)));
      const hasPriorDHPPRoutine = priorList.some(x => /annual.*5-in-1|completed puppy|adult 5-in-1/i.test(String(x)));
      const hasPriorRabies = priorList.some(x => /rabies/i.test(String(x)));
      const hasPriorDeworm = priorList.some(x => /deworm/i.test(String(x)));
      const hasPriorFVRCP1 = priorList.some(x => /fvrcp.*1|feline.*1/i.test(String(x)));
      const hasPriorFVRCP2 = priorList.some(x => /fvrcp.*2|feline.*2/i.test(String(x)));

      for (const pItem of priorList) {
        const pLabel = typeof pItem === "string" ? pItem : pItem.name || "External Vaccine";
        const extV = {
          id: "v_ext_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: pLabel,
          brand: "External Clinic Record",
          batch: "EXTERNAL-HIST",
          date: today,
          next_due: null,
          dose_no: 1,
          dose_of: 1,
          done: true,
          automated: false,
          protocol_type: "External History (Guide)",
          recorded_by: "Previous Vet (External Guide)"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [...Object.values(extV), externalClinicNotes ? `Previous clinic note: ${externalClinicNotes}` : "Administered at external clinic; recorded as reference guide for schedule calibration."]
        );
        seeded.push(extV);
      }

      // B) Pre-Schedule Next Upcoming Protocol Based on What Was Given
      if (isDog) {
        // DHPP Logic
        let nextDHPP = "DHPP (5-in-1 Core Vaccine)";
        let dhppDoseNo = 1;
        let dhppDoseOf = 3;
        let dhppDueDays = 21;

        if (hasPriorDHPP1 && hasPriorDHPP2) {
          nextDHPP = "DHPP (5-in-1 Core Vaccine - Dose 3)";
          dhppDoseNo = 3;
          dhppDoseOf = 3;
          dhppDueDays = 21;
        } else if (hasPriorDHPP1) {
          nextDHPP = "DHPP (5-in-1 Core Vaccine - Dose 2)";
          dhppDoseNo = 2;
          dhppDoseOf = 3;
          dhppDueDays = 21;
        } else if (hasPriorDHPP3 || hasPriorDHPPRoutine) {
          nextDHPP = "DHPP (5-in-1 Adult Core Booster)";
          dhppDoseNo = 1;
          dhppDoseOf = 1;
          dhppDueDays = 365;
        }

        const isDHPPToday = serviceCategory === "vaccination" && (specificVaccine || "").toLowerCase().includes("5-in-1");
        const v1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: isDHPPToday ? (specificVaccine || nextDHPP) : nextDHPP,
          brand: "Nobivac DHPP",
          batch: "WALK-DHPP",
          date: today,
          next_due: isDHPPToday ? addDays(today, dhppDoseNo === 3 ? 365 : 21) : addDays(today, dhppDueDays),
          dose_no: dhppDoseNo,
          dose_of: dhppDoseOf,
          done: false,
          automated: true,
          protocol_type: dhppDoseOf === 1 ? "Adult Core Immunization" : "Core Puppy Protocol",
          recorded_by: actorName || "Front Desk"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v1)
        );
        seeded.push(v1);

        // Rabies Logic
        const isRabiesToday = serviceCategory === "vaccination" && (specificVaccine || "").toLowerCase().includes("rabies");
        const v2 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: isRabiesToday ? (specificVaccine || "Anti-Rabies (RA 9482 Compliance)") : (hasPriorRabies ? "Annual Anti-Rabies Core Booster" : "Anti-Rabies (RA 9482 Compliance)"),
          brand: "Defensor 3",
          batch: "WALK-RAB",
          date: today,
          next_due: (hasPriorRabies || isRabiesToday) ? addDays(today, 365) : addDays(today, 30),
          dose_no: 1,
          dose_of: 1,
          done: false,
          automated: true,
          protocol_type: "Legal Rabies Mandate",
          recorded_by: actorName || "Front Desk"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v2)
        );
        seeded.push(v2);

        // Parasiticide & Deworming Pre-scheduling
        const isDewormToday = serviceCategory === "deworming" || (serviceCategory === "vaccination" && (specificVaccine || "").toLowerCase().includes("deworm"));
        const v3 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: "Broad-Spectrum Deworming",
          brand: "Canex Multi-Spectrum",
          batch: "WALK-DEW",
          date: today,
          next_due: isDewormToday ? addDays(today, 90) : (hasPriorDeworm ? addDays(today, 90) : addDays(today, 14)),
          dose_no: 1,
          dose_of: 4,
          done: false,
          automated: true,
          protocol_type: "Parasiticide Protocol",
          recorded_by: actorName || "Front Desk"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(v3)
        );
        seeded.push(v3);
      } else if (isCat) {
        // Feline FVRCP & Rabies
        let fvrcpName = "FVRCP (4-in-1 Feline Core)";
        let fvrcpDoseNo = 1;
        let fvrcpDoseOf = 2;
        let fvrcpDueDays = 21;

        if (hasPriorFVRCP1) {
          fvrcpName = "FVRCP (4-in-1 Feline Core - Dose 2)";
          fvrcpDoseNo = 2;
          fvrcpDueDays = 21;
        } else if (hasPriorFVRCP2) {
          fvrcpName = "FVRCP Annual Booster";
          fvrcpDoseNo = 1;
          fvrcpDoseOf = 1;
          fvrcpDueDays = 365;
        }

        const isFVRCPToday = serviceCategory === "vaccination" && (specificVaccine || "").toLowerCase().includes("fvrcp");
        const cv1 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: isFVRCPToday ? (specificVaccine || fvrcpName) : fvrcpName,
          brand: "Nobivac Feline 1-HCP",
          batch: "WALK-FVRCP",
          date: today,
          next_due: isFVRCPToday ? addDays(today, 365) : addDays(today, fvrcpDueDays),
          dose_no: fvrcpDoseNo,
          dose_of: fvrcpDoseOf,
          done: false,
          automated: true,
          protocol_type: "Core Feline Immunization",
          recorded_by: actorName || "Front Desk"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(cv1)
        );
        seeded.push(cv1);

        const isRabiesCatToday = serviceCategory === "vaccination" && (specificVaccine || "").toLowerCase().includes("rabies");
        const cv2 = {
          id: "v_" + Math.random().toString(36).slice(2, 8),
          pet_id: petId,
          card_id: cardId,
          vaccine: "Anti-Rabies (1-Year Feline Core)",
          brand: "Defensor 3",
          batch: "WALK-RAB-CAT",
          date: today,
          next_due: (hasPriorRabies || isRabiesCatToday) ? addDays(today, 365) : addDays(today, 30),
          dose_no: 1,
          dose_of: 1,
          done: false,
          automated: true,
          protocol_type: "Core Rabies Protocol",
          recorded_by: actorName || "Front Desk"
        };
        await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          Object.values(cv2)
        );
        seeded.push(cv2);
      }

      // 5. Save an arrival; measured intake is required before Checked-in.
      let appt = null;
      if (addToQueue) {
        const apptId = "a_walk_" + Math.random().toString(36).slice(2, 8);
        const timeNow = clinicClock().time;
        
        let visitReason = (requestedReason || "").trim();
        if (!visitReason) {
          if (serviceCategory === "vaccination") {
            visitReason = `Vaccination: ${specificVaccine || "Core Vaccine Booster"}`;
          } else if (serviceCategory === "deworming") {
            visitReason = "Routine Deworming (Parasiticide)";
          } else if (serviceCategory === "flea_tick") {
            visitReason = "Flea & Tick Prevention (Chewable / Spot-on)";
          } else if (serviceCategory === "grooming") {
            visitReason = "Grooming & Sanitary Care";
          } else if (serviceCategory === "emergency") {
            visitReason = "Urgent / Emergency Clinical Triage";
          } else {
            visitReason = "Walk-in Consultation & Routine Exam";
          }
        }

        const insAppt = await client.query(
          `INSERT INTO appointments (id, pet_id, vet_id, date, time, reason, status, billing_status, amount, intake_vitals, booking_kind, service)
           VALUES ($1, $2, $3, $4, $5, $6, 'Scheduled', 'Unbilled', 600, $7, 'walk-in', $8)
           RETURNING *`,
          [
            apptId,
            petId,
            req.body.vetId,
            today,
            timeNow,
            visitReason,
            null,
            ["vaccination","deworming","grooming"].includes(serviceCategory) ? serviceCategory : "checkup"
          ]
        );
        const aRow = insAppt.rows[0];
        appt = {
          id: aRow.id,
          petId: aRow.pet_id,
          vetId: aRow.vet_id,
          date: toDateStr(aRow.date),
          time: aRow.time,
          reason: aRow.reason,
          service: aRow.service,
          bookingKind: aRow.booking_kind,
          status: aRow.status,
          billingStatus: aRow.billing_status,
          amount: parseFloat(aRow.amount),
          intakeVitals: aRow.intake_vitals
        };
      }

      await registrationAudit(client, req.user, `Registered walk-in owner ${effectiveOwner.name} & pet ${pet.name} (Issued Card #${cardId})${appt ? `; arrival requested: ${appt.reason}` : ""}`);
      return {
        owner: effectiveOwner,
        pet: {
          id: pet.id,
          ownerId: pet.owner_id,
          name: pet.name,
          species: pet.species,
          speciesOther: pet.species_other || "",
          breed: pet.breed,
          sex: pet.sex,
          birth: toDateStr(pet.birth),
          weight: parseFloat(pet.weight),
          weightOrigin:'registration',
          color: pet.color || "",
          neutered: pet.neutered || "Not sure",
          allergies: pet.allergies || [],
          vaccinationCardId: cardId,
          notes: pet.notes || "",
          photo: "",
          dentalOcclusion: pet.dental_occlusion || "",
          weights: [{date:today,kg:patient.weight,by:req.user.name,origin:'registration',unit:'kg',visitId:null,measuredAt:null}]
        },
        vaccs: seeded,
        appointment: appt
      };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Walk-in registration error:", err.message);
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

/* 6. VACCINATIONS & FRONT DESK / ASSISTANT LOGGING */
clinicRouter.delete("/vaccinations/:id", async (req, res) => {
  const { id } = req.params;
  const { actorName, actorRole } = req.body;
  try {
    await query("DELETE FROM vaccinations WHERE id = $1", [id]);
    await recordAudit(actorName, actorRole, `Deleted vaccination record ${id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

/* 7. CONSULTATIONS (SOAP MEDICAL NOTES) */
clinicRouter.post("/consultations", async (req, res) => {
  const { id, petId, apptId, date, symptoms, objective, diagnosis, treatment, prescription, weight } = req.body;
  let vaccination=req.body.vaccination;
  try { vaccination=resolveAdministrationLot(vaccination,date); } catch(error) {return res.status(error.status || 500).json({error:error.status ? error.message : "Unable to load deworming products."});}
  const cardFieldErrors=vaccinationCardFieldErrors({...vaccination,...(req.body.microchip?{microchipNumber:req.body.microchip.number,microchipDate:req.body.microchip.date}:{})},clinicClock().date);
  if(Object.keys(cardFieldErrors).length)return res.status(400).json({error:Object.values(cardFieldErrors)[0],errors:cardFieldErrors});
  if(req.body.microchip && (typeof req.body.microchip.number!=='string' || !req.body.microchip.number.trim()))return res.status(400).json({error:'Enter the microchip number.'});
  const careError = validateCarePlan(req.body, date);
  if (careError) return res.status(400).json({ error: careError });
  const vetId = req.user.vetId || req.user.id;
  const consultId = id || ("c_" + crypto.randomUUID());
  const required = [symptoms, objective, diagnosis, treatment];
  if (required.some(v => typeof v !== "string" || !v.trim() || v.length > 10000) || typeof prescription !== "string" || prescription.length > 3000 || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    return res.status(400).json({ error: "Complete the SOAP fields and enter a valid consultation date." });
  }
  if (vaccination && [vaccination.vaccine, vaccination.brand,...(vaccination.vaccine==='Deworming'?[]:[vaccination.batch])].some(v => typeof v !== "string" || !v.trim())) return res.status(400).json({ error: "Vaccine, brand and lot/batch are required." });
  if (vaccination && !ADMINISTERED_VACCINES.includes(vaccination.vaccine)) return res.status(400).json({ error: "Choose the administered vaccine from the clinic list." });
  if (vaccination?.nextDue && (!/^\d{4}-\d{2}-\d{2}$/.test(vaccination.nextDue) || vaccination.nextDue <= date)) return res.status(400).json({ error: "The booster date must follow the vaccination date." });
  if (weight !== undefined && (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || weight > 120)) return res.status(400).json({ error: "Enter a valid weight." });
  try {
    await ensureDigitalVetCardSchema();
    await ensurePetRegistrationSchema();
    const rx = normalizePrescription(req.body.prescriptionItems, prescription);
    const services = clinicalCharges(req.body.performedServices, vaccination);
    if (!validDate(date) || date > clinicClock().date || date < EARLIEST_DATE) throw bookingError("Enter a valid administration / consultation date from 2000 onward that is not in the future.");
    if (vaccination && (!Number.isInteger(vaccination.doseNo) || vaccination.doseNo < 1 || !Number.isInteger(vaccination.doseOf) || vaccination.doseOf < vaccination.doseNo || vaccination.doseOf > 20)) throw bookingError("Confirm the administered dose number and total planned doses (1–20).");
    if (vaccination && (vaccination.scheduleApproved !== true || !boosterDate(date, vaccination.intervalDays) || vaccination.nextDue !== boosterDate(date, vaccination.intervalDays))) throw bookingError("Approve the booster interval and calculated date for this patient.");
    await ensureCheckoutInboxSchema();
    await ensureCheckoutSchema();
    await ensureCareSchema();
    await ensurePrescriptionSchema();
    if (vaccination) validateBoosterDate(date, vaccination.nextDue);
    const result = await withTransaction(async client => {
      const appt = (await client.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [apptId])).rows[0];
      if (!appt || appt.pet_id !== petId || !assignedTo(appt, req.user)) throw Object.assign(new Error("An assigned visit is required."), { status: 403 });
      if (req.body.expectedVisit !== undefined && !sameIntakeVisit(appt, req.body.expectedVisit)) throw bookingError("This visit has changed. Refresh clinic records and reopen the consultation.",409);
      if (appt.status !== "In consultation") throw Object.assign(new Error("Start the consultation before finalizing. This visit may already be complete."), { status: 409 });
      if (date < toDateStr(appt.date)) throw bookingError("The consultation date cannot be before the linked visit.");
      const backdateReason=req.body.backdateReason;
      if(date<clinicClock().date && (typeof backdateReason!=='string' || backdateReason.trim().length<5 || backdateReason.length>500 || !/[\p{L}]/u.test(backdateReason))) throw bookingError("Explain why this historical consultation date is being recorded (5–500 characters).");
      const patient = (await client.query("SELECT birth, vaccination_card_id FROM pets WHERE id = $1 FOR UPDATE", [petId])).rows[0];
      if (!patient) throw bookingError("Patient record not found.",404);
      patient.vaccination_card_id=await internalCardReference(client,petId,patient.vaccination_card_id);
      if(req.body.microchip){
        if(req.body.microchip.date && req.body.microchip.date<toDateStr(patient.birth))throw bookingError('The microchip date cannot be before the patient’s birth.');
        await client.query('UPDATE pets SET microchip_number=$2,microchip_date=$3 WHERE id=$1',[petId,req.body.microchip.number.trim(),req.body.microchip.date || null]);
      }
      if (patient.birth && date < toDateStr(patient.birth)) throw bookingError("The consultation date cannot be before the patient's birth.");
      const inserted = await client.query(
        `INSERT INTO consultations (id, pet_id, vet_id, appt_id, date, symptoms, objective, diagnosis, treatment, prescription)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [consultId, petId, vetId, apptId, date, symptoms.trim(), objective.trim(), diagnosis.trim(), treatment.trim(), rx.text]
      );
      await client.query('UPDATE consultations SET backdate_reason=$2 WHERE id=$1',[consultId,date<clinicClock().date ? req.body.backdateReason.trim() : '']);
      await client.query("UPDATE consultations SET care_status=$1, follow_up_date=$2, follow_up_reason=$3 WHERE id=$4", [req.body.careStatus || "Routine care", req.body.careStatus && req.body.careStatus !== "Routine care" ? req.body.followUpDate : null, req.body.careStatus && req.body.careStatus !== "Routine care" ? req.body.followUpReason.trim() : "", consultId]);
      await client.query("UPDATE consultations SET prescription_items=$1 WHERE id=$2", [JSON.stringify(rx.items), consultId]);
      inserted.rows[0].prescription_items = rx.items;
      const savedConsultation = (await client.query("UPDATE consultations SET performed_services=$1 WHERE id=$2 RETURNING *", [JSON.stringify(services), consultId])).rows[0];
      let savedVaccination = null;
      if (vaccination) {
        await assertDoseNotRecorded(client, { petId, vaccine: vaccination.vaccine.trim(), date });
        const pet = patient;
        const saved = await client.query(
          `INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, done, notes, vet_id, recorded_by, protocol_type, dose_no, dose_of, manufacturer, serial_number)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
          [vaccination.id || "v_" + crypto.randomUUID(), petId, pet.vaccination_card_id, vaccination.vaccine.trim(), vaccination.brand.trim(), vaccination.batch.trim(), date, vaccination.nextDue || null, vaccination.notes || "", vetId, req.user.name, `Vet-approved interval: ${vaccination.intervalDays} days`, vaccination.doseNo, vaccination.doseOf, (vaccination.manufacturer || "").trim(), (vaccination.serialNumber || "").trim()]
        );
        savedVaccination = saved.rows[0];
        await client.query("UPDATE vaccinations SET appt_id=$2,consultation_id=$3 WHERE id=$1",[savedVaccination.id,apptId,consultId]);
        await client.query("DELETE FROM vaccinations WHERE pet_id = $1 AND done = false AND LOWER(vaccine) = LOWER($2)", [petId, vaccination.vaccine]);
      }
      if (weight !== undefined) {
        await client.query("UPDATE pets SET weight = $1 WHERE id = $2", [weight, petId]);
        await client.query("INSERT INTO pet_weights (pet_id, date, kg, recorded_by,origin,appt_id,measured_at,staff_id,staff_role) VALUES ($1,$2,$3,$4,'clinic',$5,clock_timestamp(),$6,$7)", [petId,date,weight,req.user.name,apptId,req.user.id,req.user.role]);
      }
      const invoice = [...services, ...prescriptionInvoice(rx.items)];
      const savedAppointment = (await client.query("UPDATE appointments SET status = 'Completed', billing_status = 'Unpaid', invoice_items=$2 WHERE id = $1 RETURNING *", [apptId, JSON.stringify(invoice)])).rows[0];
      await createCheckoutTask(client, apptId);
      await client.query("INSERT INTO audit_logs (user_name, user_role, action) VALUES ($1,$2,$3)", [req.user.name, req.user.role, `Finalized consultation ${consultId} for visit ${apptId}`]);
      return { consultation: savedConsultation, appointment: savedAppointment, vaccination: savedVaccination, weight: weight === undefined ? null : {petId,date,kg:weight,by:req.user.name}, prescriptionItems: rx.items, prescription: rx.text, invoiceItems: invoice };
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : "Unable to finalize the consultation. Refresh the visit before retrying." });
  }
});

/* 8. AUDIT LOGS RETRIEVAL & MANUAL LOGGING */
clinicRouter.get("/logs", async (req, res) => {
  try {
    const result = await query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200");
    res.json({ success: true, logs: result.rows });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

clinicRouter.post("/logs", async (req, res) => {
  const { userName, userRole, action } = req.body;
  try {
    await recordAudit(userName, userRole, action);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || (err.code === "23505" ? 409 : 500)).json({ error: err.status ? err.message : err.code === "23505" ? "This record already exists. Refresh before trying again." : "Unable to save clinic data. Please try again." });
  }
});

/* 9. REMINDERS & LOG CALL (SEND VIA EMAIL & SMS) */
async function handleSendReminder(req, res) {
  try {
    const {
      ownerId,
      petId,
      vaccine,
      dueDate,
      ownerName,
      ownerPhone,
      ownerEmail,
      petName,
      staffName,
      staffRole,
      callNotes,
      sendEmail = true,
      sendSmsMsg = true,
    } = req.body;

    let targetOwnerName = ownerName || "Pet Parent";
    let targetPhone = ownerPhone || "";
    let targetEmail = ownerEmail || "";
    let targetPetName = petName || "your pet";

    // 1. Database lookups if IDs provided
    if (ownerId) {
      try {
        const oRes = await query("SELECT * FROM owners WHERE id = $1", [ownerId]);
        if (oRes.rows?.length) {
          const o = oRes.rows[0];
          targetOwnerName = o.name || targetOwnerName;
          targetPhone = o.phone || o.mobile || targetPhone;
          targetEmail = o.email || targetEmail;
        } else {
          // Check users table in case owner is stored as a user
          const uRes = await query("SELECT * FROM users WHERE id = $1", [ownerId]);
          if (uRes.rows?.length) {
            const u = uRes.rows[0];
            targetOwnerName = u.name || targetOwnerName;
            targetPhone = u.phone || u.mobile || targetPhone;
            targetEmail = u.email || targetEmail;
          }
        }
      } catch (dbErr) {
        console.warn("Owner lookup warning in reminder:", dbErr.message);
      }
    }

    if (petId) {
      try {
        const pRes = await query("SELECT * FROM pets WHERE id = $1", [petId]);
        if (pRes.rows?.length) {
          targetPetName = pRes.rows[0].name || targetPetName;
        }
      } catch (dbErr) {
        console.warn("Pet lookup warning in reminder:", dbErr.message);
      }
    }

    const appUrl = getAppUrl(req);
    const vaccineName = vaccine || "Vaccine Booster";
    const dueStr = dueDate ? toDateStr(dueDate) : "soon";

    let emailSent = false;
    let smsSent = false;
    const errors = [];

    // 2. Dispatch SMS if requested and phone number available
    if (sendSmsMsg && targetPhone) {
      const smsText = `PawCare Clinic: Hi ${targetOwnerName}! This is a reminder that ${targetPetName}'s ${vaccineName} is due on ${dueStr}. Please contact us or book a visit online: ${appUrl} . Have a great day!`;
      try {
        const smsRes = await sendSms(targetPhone, smsText);
        if (smsRes?.ok) smsSent = true;
      } catch (err) {
        errors.push("SMS failed: " + err.message);
      }
    }

    // 3. Dispatch Email if requested and email address available
    if (sendEmail && targetEmail) {
      const emailSubject = `🐾 PawCare Vaccine Reminder: ${targetPetName}'s ${vaccineName} Due`;
      const emailText = `Hello ${targetOwnerName}!\n\nThis is a friendly reminder from PawCare Veterinary Clinic that ${targetPetName} is due for their ${vaccineName} on ${dueStr}.\n\nBook your visit online: ${appUrl}\nClinic Phone: (02) 8920-1234 / 0917-123-4567\n\nWarm regards,\nPawCare Veterinary Team`;

      const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"></head>
      <body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:28px 14px;">
          <tr>
            <td align="center">
              <table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 10px 25px rgba(0,0,0,0.06);">
                <tr>
                  <td style="background:linear-gradient(135deg,#1e3a8a 0%,#2563eb 100%);padding:28px 24px;text-align:center;">
                    <div style="font-size:36px;margin-bottom:6px;">🐾 💉</div>
                    <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:800;">PawCare Veterinary Clinic</h1>
                    <p style="margin:4px 0 0;color:#dbeafe;font-size:13px;">Health & Preventive Care Reminder</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:32px 28px;">
                    <h2 style="margin:0 0 12px;color:#002B49;font-size:19px;">Hi ${targetOwnerName}!</h2>
                    <p style="margin:0 0 18px;color:#475569;font-size:15px;line-height:1.6;">
                      Our veterinary staff conducted a routine schedule check and noticed that <b>${targetPetName}</b> is due for their <b>${vaccineName}</b> on <b>${dueStr}</b>.
                    </p>
                    ${callNotes ? `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:6px;font-size:13px;color:#92400e;margin-bottom:20px;"><b>Staff Call Note:</b> ${callNotes}</div>` : ""}
                    <div style="text-align:center;margin:28px 0 24px;">
                      <a href="${appUrl}/#portals" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#ffe28a,#ffd24d);color:#002B49;font-size:15px;font-weight:800;padding:14px 32px;border-radius:99px;text-decoration:none;box-shadow:0 6px 18px rgba(255,200,60,0.4);">
                        Book Booster Appointment →
                      </a>
                    </div>
                    <div style="background:#f8fafc;padding:14px 16px;border-radius:12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;line-height:1.5;">
                      📍 <b>Clinic Address:</b> 123 Samson Road, Caloocan City<br>
                      📞 <b>Direct Line:</b> (02) 8920-1234 • 0917-123-4567<br>
                      🕒 <b>Hours:</b> Monday to Sunday • 8:00 AM – 7:00 PM
                    </div>
                  </td>
                </tr>
                <tr>
                  <td style="background:#f8fafc;padding:16px 24px;text-align:center;border-top:1px solid #e2e8f0;font-size:11.5px;color:#94a3b8;">
                    PawCare Daily Hub • Helping keep your pets healthy and vaccinated.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
      `;

      try {
        const mailRes = await sendMail(targetEmail, emailSubject, emailText, emailHtml);
        if (mailRes?.ok) emailSent = true;
      } catch (err) {
        errors.push("Email failed: " + err.message);
      }
    }

    // 4. Record in audit_logs
    const channels = [emailSent ? `Email (${targetEmail})` : null, smsSent ? `SMS (${targetPhone})` : null].filter(Boolean).join(" & ") || "None (no contact on file)";
    const auditAction = `Logged reminder call for owner ${targetOwnerName} (${targetPetName} - ${vaccineName} due ${dueStr}). Dispatched reminders via: ${channels}.${callNotes ? ` Call Note: "${callNotes}"` : ""}`;
    await recordAudit(req.user.name, req.user.role, auditAction);

    res.json({
      success: true,
      emailSent,
      smsSent,
      targetOwnerName,
      targetPetName,
      targetEmail,
      targetPhone,
      message: `Call logged successfully! Reminders dispatched: ${channels}`,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error("Failed to log call and send reminder:", err);
    res.status(500).json({ error: "Failed to process reminder call: " + err.message });
  }
}

clinicRouter.get("/reminders/status", async (req, res) => {
  try {
    await ensureSchedulingSchema();
    const summary = (await query("SELECT status, COUNT(*)::integer AS count FROM vaccination_reminders GROUP BY status")).rows;
    const attention = (await query(`SELECT r.id,r.channel,r.status,r.due_date,v.vaccine,p.name AS pet_name
      FROM vaccination_reminders r JOIN vaccinations v ON v.id=r.vaccination_id JOIN pets p ON p.id=v.pet_id
      WHERE r.status IN ('failed','uncertain') ORDER BY r.scheduled_at DESC LIMIT 100`)).rows;
    const health = (await query("SELECT * FROM reminder_worker_health WHERE id=1")).rows[0];
    const overdue = (await query("SELECT COUNT(*)::integer AS count FROM vaccination_reminders WHERE status='pending' AND next_attempt_at < NOW() - INTERVAL '1 day'")).rows[0]?.count || 0;
    res.json({ health: { lastRun: health?.last_completed_at || null, overdue, emailConfigured: Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL || process.env.SMTP_USER && process.env.SMTP_PASS), smsConfigured: Boolean((process.env.TEXTBEE_API_KEY || process.env.TEXTBEE_KEY) && process.env.TEXTBEE_DEVICE_ID) }, summary: Object.fromEntries(summary.map(r => [r.status,r.count])), attention: attention.map(r => ({ id:r.id,channel:r.channel,status:r.status,dueDate:toDateStr(r.due_date),vaccine:r.vaccine,petName:r.pet_name })) });
  } catch { res.status(500).json({ error:"Unable to load reminder status." }); }
});

clinicRouter.get("/reminders/calls", reminderCallHistory);
clinicRouter.post("/reminders/log-call", (req,res) => req.body.logOnly === true ? logReminderCall(req,res) : handleSendReminder(req,res));
clinicRouter.post("/reminders/send", handleSendReminder);


// A handoff transfers responsibility and preserves the sending doctor's instructions.
clinicRouter.post('/appointments/:id/handoff', async (req, res) => {
  const { vetId, note } = req.body;
  if (typeof vetId !== 'string' || typeof note !== 'string' || !note.trim() || note.length > 3000) return res.status(400).json({error: 'Choose a veterinarian and enter handoff instructions (up to 3000 characters).'});
  try {
    await ensureCareSchema();
    const saved = await withTransaction(async client => {
      await lockSchedule(client);
      const row = (await client.query('SELECT * FROM appointments WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!row || !assignedTo(row, req.user)) throw Object.assign(new Error('This visit is no longer assigned to you.'), {status: 403});
      if (req.body.expectedVisit !== undefined && !sameIntakeVisit(row, req.body.expectedVisit)) throw Object.assign(new Error('This visit has changed. Refresh clinic records and reopen the handoff.'), {status: 409});
      if (!['Checked-in', 'In consultation'].includes(row.status)) throw Object.assign(new Error('Only an active arrival can be handed over.'), {status: 409});
      const sender=(await client.query("SELECT id,vet_id FROM users WHERE id=$1 AND role='vet' AND COALESCE(to_jsonb(users)->>'is_active','true') <> 'false'",[req.user.id])).rows[0];
      if(!sender)throw bookingError('Your account is inactive. Contact the administrator.',403);
      const target = (await client.query("SELECT id,vet_id,first_name,last_name FROM users WHERE role='vet' AND (id=$1 OR vet_id=$1) AND COALESCE(to_jsonb(users)->>'is_active','true') <> 'false' FOR SHARE", [vetId])).rows[0];
      if (!target || [req.user.id, req.user.vetId].includes(target.id) || [req.user.id, req.user.vetId].filter(Boolean).includes(target.vet_id)) throw Object.assign(new Error('Choose another active veterinarian.'), {status: 400});
      const recipient = target.vet_id || target.id;
      const entry = {from: req.user.name, fromId: req.user.vetId || req.user.id, to: `${target.first_name} ${target.last_name}`, toId: recipient, note: note.trim(), at: new Date().toISOString()};
      const updated = (await client.query("UPDATE appointments SET vet_id=$1, status='Checked-in', handoffs=handoffs || $2::jsonb WHERE id=$3 RETURNING id,pet_id,vet_id,status", [recipient, JSON.stringify([entry]), row.id])).rows[0];
      await client.query('INSERT INTO audit_logs (user_name,user_role,action) VALUES ($1,$2,$3)', [req.user.name, req.user.role, `Handed visit ${row.id} to ${recipient}`]);
      return {appointment:{id:updated.id,petId:updated.pet_id,vetId:updated.vet_id,status:updated.status},handoff:entry};
    });
    res.json({success: true,...saved});
  } catch (e) { res.status(e.status || 500).json({error: e.status ? e.message : 'Unable to save handoff. Please retry.'}); }
});
