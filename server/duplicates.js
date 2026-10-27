import { findDuplicatePet, duplicatePetMessage, phoneKey, emailKey } from '../src/duplicateRules.js';

const conflict = (message, errors) => Object.assign(new Error(message), { status: 409, ...(errors ? { errors } : {}) });
const isoDay = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);

/** One owner cannot have two pets with the same name, species and birth date. */
export async function assertNoDuplicatePet(client, { ownerId, name, species, birth, excludeId = null }) {
  const rows = (await client.query('SELECT id, owner_id, name, species, birth FROM pets WHERE owner_id = $1', [ownerId])).rows;
  const hit = findDuplicatePet(rows.map(row => ({ id: row.id, ownerId: row.owner_id, name: row.name, species: row.species, birth: isoDay(row.birth) })), { ownerId, name, species, birth: isoDay(birth) }, excludeId);
  if (hit) throw conflict(duplicatePetMessage(hit), { name: duplicatePetMessage(hit) });
}

/** A phone number or email can belong to one owner record only. */
export async function assertOwnerContactFree(client, { phone, email, excludeId = null }) {
  const rows = (await client.query('SELECT id, name, phone, email FROM owners WHERE id <> $1', [excludeId || '']) ).rows;
  const errors = {};
  if (phone) { const hit = rows.find(row => phoneKey(row.phone) === phoneKey(phone)); if (hit) errors.phone = `This mobile number is already on ${hit.name}'s record.`; }
  if (email) { const hit = rows.find(row => emailKey(row.email) === emailKey(email)); if (hit) errors.email = `This email is already on ${hit.name}'s record.`; }
  if (Object.keys(errors).length) throw conflict(Object.values(errors)[0] + ' Open that owner instead of creating a duplicate.', errors);
}

/** A payment reference (GCash, Maya, card) proves one payment, so it cannot settle two invoices. */
export async function assertPaymentReferenceUnused(client, { reference, appointmentId }) {
  const text = String(reference ?? '').trim();
  if (!text) return;
  // Different invoices hold different row locks. Serialize the same reference
  // until commit so the next lookup sees the winning saved payment.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pawcare:payment-reference:' || LOWER($1), 0))", [text]);
  const hit = (await client.query("SELECT id FROM appointments WHERE id <> $1 AND billing_status = 'Paid' AND LOWER(TRIM(payment_details->>'reference')) = LOWER($2) LIMIT 1", [appointmentId, text])).rows[0];
  if (hit) throw conflict(`This payment reference was already used to settle visit ${hit.id}. Check the reference number.`, { refNo: 'This payment reference was already used for another invoice.' });
}

/** The same vaccine cannot be certified twice for one pet on one date. */
export async function assertDoseNotRecorded(client, { petId, vaccine, date }) {
  const hit = (await client.query("SELECT id FROM vaccinations WHERE pet_id = $1 AND done AND LOWER(vaccine) = LOWER($2) AND date = $3 LIMIT 1", [petId, vaccine, date])).rows[0];
  if (hit) throw conflict(`${vaccine} is already recorded as given to this pet on ${date}. Check the vaccination card before recording it again.`);
}
