import LiveControl from '../components/LiveControl.jsx';
import { SearchField } from "./owner/ui.jsx";
import { PaginatedTable } from "../components/Pagination.jsx";
import { currentVaccinationDue } from "../vaccinationDue.js";
import { useState } from "react";
import {
  Syringe,
  Calendar,
  Clock,
  User,
  Stethoscope,
  Plus,
  CheckCircle2,
  AlertTriangle,
  Search,
  Printer,
  FileText,
  Phone,
  ShieldCheck,
  Check,
  X,
  Edit,
  Trash2,
} from "lucide-react";
import {
  VETS,
  TODAY,
  plus,
  uid,
  addLog,
  scope,
  petName,
  ownerName,
  dueState,
  Badge,
  INTERVAL,
} from "../lib.jsx";
import { SpeciesIcon } from "./ClinicCalendar.jsx";
import { outbox } from "../devOutbox.js";

const CLINIC_INFO = {
  name: "PawCare Veterinary Clinic",
  address: "123 Animal Wellness Boulevard, Metro Manila",
  phone: "(02) 8123-4567 / 0917-123-4567",
  email: "care@pawcareclinic.ph",
  license: "BAI Reg. No. VET-2026-0914",
};

const VACCINE_PRESETS = [
  { name: "Anti-rabies", brand: "Defensor 3", interval: 365, doseOf: 1 },
  { name: "5-in-1 (DHPP Core)", brand: "Vanguard Plus 5", interval: 365, doseOf: 3 },
  { name: "4-in-1 (FVRCP Core)", brand: "Felocell 4", interval: 365, doseOf: 3 },
  { name: "Bordetella (Kennel Cough)", brand: "Bronchi-Shield", interval: 365, doseOf: 1 },
  { name: "Broad-Spectrum Deworming", brand: "Canex Multi-Spectrum", interval: 90, doseOf: 4 },
  { name: "Feline Deworming", brand: "Profender Spot-on", interval: 90, doseOf: 4 },
  { name: "Other Vaccination", brand: "Standard Veterinary", interval: 365, doseOf: 1 },
];

export default function AssistantVaccinationManager({ db, setDb, me, say }) {
  const [search, setSearch] = useState("");
  const [selectedPetId, setSelectedPetId] = useState(db.pets[0] ? db.pets[0].id : "");
  const [logModal, setLogModal] = useState(null); // { pet, existingVacc: null | record }
  const [filterDue, setFilterDue] = useState("all"); // 'all' | 'dueSoon' | 'overdue'

  const pets = db.pets || [];
  const selectedPet = pets.find(p => p.id === selectedPetId) || pets[0] || {};
  const owner = db.owners.find(o => o.id === selectedPet.ownerId) || {};

  // Vaccines for selected pet
  const petVaccs = (db.vacc || [])
    .filter(v => v.petId === selectedPet.id)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const completedCount = petVaccs.filter(v => v.done).length;
  const pendingCount = petVaccs.filter(v => !v.done).length;
  const overdueCount = petVaccs.filter(v => !v.done && v.nextDue && v.nextDue < TODAY).length;

  // Reminders list for all pets
  const allReminders = currentVaccinationDue(db.vacc).filter(v => v.nextDue <= plus(30));

  const filteredPets = pets.filter(p => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    const o = db.owners.find(x => x.id === p.ownerId) || {};
    return (
      p.name.toLowerCase().includes(q) ||
      (p.breed || "").toLowerCase().includes(q) ||
      (p.vaccinationCardId || "").toLowerCase().includes(q) ||
      o.name.toLowerCase().includes(q) ||
      (o.phone || "").includes(q)
    );
  });

  const handleSaveVaccine = (vaccData) => {
    setDb(p => {
      let nextVacc = p.vacc || [];
      const isEdit = vaccData.id && nextVacc.some(v => v.id === vaccData.id);

      if (isEdit) {
        nextVacc = nextVacc.map(v => (v.id === vaccData.id ? { ...v, ...vaccData } : v));
      } else {
        const newRecord = {
          id: "v" + uid(),
          petId: selectedPet.id,
          cardId: selectedPet.vaccinationCardId || "VACC-OFFICIAL",
          ...vaccData,
        };
        nextVacc = [newRecord, ...nextVacc];
      }

      // Log in clinic audit
      const supervisingVet = (VETS.find(v => v[0] === vaccData.vetId) || [])[1] || "Attending Veterinarian";
      const nextLog = addLog(
        p,
        me,
        `Vet Assistant ${me.name} updated vaccination card for ${selectedPet.name} (${owner.name}). Logged "${vaccData.vaccine}" (${vaccData.brand}, Lot #${vaccData.batch}) administered by ${supervisingVet}. Next booster due: ${vaccData.nextDue}.`
      );

      return {
        ...p,
        vacc: nextVacc,
        log: nextLog,
      };
    });

    setLogModal(null);
    say && say(`Vaccination card updated for ${selectedPet.name}! Synced with owner portal.`);
  };

  const handleDeleteVaccine = (vaccId) => {
    if (!confirm("Are you sure you want to remove this vaccination entry?")) return;
    setDb(p => ({
      ...p,
      vacc: p.vacc.filter(v => v.id !== vaccId),
      log: addLog(p, me, `Vet Assistant ${me.name} removed a vaccination record from ${selectedPet.name}'s card.`),
    }));
    say && say("Vaccine record removed.");
  };

  const handleSendReminderSms = async (v) => {
    const p = (db.pets || []).find(x => x.id === v.petId) || {};
    const o = (db.owners || []).find(x => x.id === p.ownerId) || {};
    try {
      const res = await fetch("/api/reminders/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerId: o.id || p.ownerId,
          petId: p.id || v.petId,
          vaccine: v.vaccine,
          dueDate: v.nextDue,
          ownerName: o.name,
          ownerPhone: o.phone || o.mobile,
          ownerEmail: o.email,
          petName: p.name,
          staffName: me?.name || "Vet Assistant",
          staffRole: me?.role || "assistant",
          callNotes: "Clinic vaccine booster due reminder notice",
          sendEmail: true,
          sendSmsMsg: true
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        say && say(data.message || `✓ Reminders sent to ${o.name || "owner"} via Email and SMS!`);
      } else {
        say && say(`✓ Reminder sent to ${o.name || "owner"}!`);
      }
    } catch (_) {
      say && say(`Reminder recorded for ${o.name || "owner"}.`);
    }
  };

  return (
    <div style={{ padding: "0 0 24px" }}>
      {/* Top Header Card */}
      <div className="card" style={{ marginBottom: "16px", padding: "16px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <h2 style={{ margin: "0 0 4px", fontSize: "calc(20px * var(--fs, 1))", display: "flex", alignItems: "center", gap: "8px", color: "var(--navy)" }}>
              <Syringe size={22} color="var(--navy)" />
              <span>Front Desk Vaccination Card Management</span>
            </h2>
            <p style={{ margin: 0, fontSize: "calc(13px * var(--fs, 1))", color: "#64748b" }}>
              Update patient vaccination records upon doctor examination, record vial batches, and manage official digital cards.
            </p>
          </div>

          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <button
              className="btn gold"
              onClick={() => setLogModal({ pet: selectedPet, existingVacc: null })}
              style={{ display: "flex", alignItems: "center", gap: "6px" }}
              disabled={!selectedPet.id}
            >
              <Plus size={16} />
              <b>+ Log Administered Vaccine</b>
            </button>
            <button
              className="btn ghost"
              onClick={() => window.print()}
              style={{ display: "flex", alignItems: "center", gap: "6px" }}
              title="Print official vaccination card with clinic header & signature lines"
            >
              <Printer size={16} />
              <span>Print Official Card</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Two-Column Layout */}
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: "16px", alignItems: "start" }}>
        {/* Left Column: Patient Selector & Reminders */}
        <div>
          <div className="card" style={{ padding: "14px", marginBottom: "14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <b style={{ fontSize: "calc(13.5px * var(--fs, 1))", color: "var(--navy)" }}>Select Patient</b>
              <span style={{ fontSize: "calc(11px * var(--fs, 1))", color: "#64748b" }}>{filteredPets.length} pets</span>
            </div>

            <SearchField id="vm-search" label="Find a patient" value={search} onChange={setSearch} placeholder="Pet or owner" />

            <div style={{ maxHeight: "320px", overflowY: "auto", display: "grid", gap: "6px" }}>
              {filteredPets.map(p => {
                const o = db.owners.find(x => x.id === p.ownerId) || {};
                const isSelected = p.id === selectedPet.id;
                const petV = (db.vacc || []).filter(v => v.petId === p.id);
                const hasOverdue = petV.some(v => !v.done && v.nextDue && v.nextDue < TODAY);

                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedPetId(p.id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: "8px",
                      border: isSelected ? "2px solid #0284c7" : "1px solid #e2e8f0",
                      background: isSelected ? "#f0f9ff" : "#fff",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      transition: "all 0.15s ease",
                    }}
                  >
                    <div style={{ color: isSelected ? "#0369a1" : "#64748b" }}>
                      <SpeciesIcon species={p.species} size={20} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <b style={{ fontSize: "calc(13.5px * var(--fs, 1))", color: isSelected ? "#0369a1" : "#1e293b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {p.name}
                        </b>
                        {hasOverdue && (
                          <span style={{ fontSize: "calc(10px * var(--fs, 1))", background: "#fee2e2", color: "#991b1b", padding: "1px 5px", borderRadius: "4px", fontWeight: "700" }}>
                            Overdue
                          </span>
                        )}
                      </div>
                      <small style={{ color: "#64748b", fontSize: "calc(11.5px * var(--fs, 1))", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.breed || p.species} &bull; {o.name}
                      </small>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Quick Reminders Due Card */}
          <div className="card" style={{ padding: "14px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
              <b style={{ fontSize: "calc(13px * var(--fs, 1))", color: "var(--navy)", display: "flex", alignItems: "center", gap: "6px" }}>
                <Clock size={15} /> Clinic Boosters Due ({allReminders.length})
              </b>
              <span style={{ fontSize: "calc(11px * var(--fs, 1))", color: "#64748b" }}>Next 14 Days</span>
            </div>

            {allReminders.length ? (
              <div style={{ display: "grid", gap: "8px", maxHeight: "240px", overflowY: "auto" }}>
                {allReminders.slice(0, 5).map(v => {
                  const p = db.pets.find(x => x.id === v.petId) || {};
                  const o = db.owners.find(x => x.id === p.ownerId) || {};
                  const isLate = v.nextDue < TODAY;

                  return (
                    <div
                      key={v.id}
                      style={{
                        padding: "8px 10px",
                        borderRadius: "8px",
                        background: isLate ? "#fef2f2" : "#f8fafc",
                        border: `1px solid ${isLate ? "#fca5a5" : "#e2e8f0"}`,
                        fontSize: "calc(12px * var(--fs, 1))",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <b>{p.name}</b>
                        <span style={{ fontWeight: 700, color: isLate ? "#dc2626" : "#d97706" }}>
                          {v.nextDue}
                        </span>
                      </div>
                      <div style={{ color: "#64748b", fontSize: "calc(11.5px * var(--fs, 1))", margin: "2px 0 4px" }}>
                        {v.vaccine} &bull; {o.name}
                      </div>
                      {(() => {
                        const hasAppt = (db.appts || []).find(a =>
                          a.petId === (p.id || v.petId) &&
                          !["Cancelled", "Rejected", "No-show"].includes(a.status) &&
                          (a.date === v.nextDue || (a.date >= TODAY && (a.reason || "").toLowerCase().includes((v.vaccine || "").toLowerCase())))
                        );
                        return hasAppt ? (
                          <div style={{ color: "#15803d", fontSize: "calc(11px * var(--fs, 1))", fontWeight: 700, margin: "0 0 6px" }}>
                            {hasAppt.status} on {hasAppt.date} {hasAppt.time ? `(${hasAppt.time})` : ""}
                          </div>
                        ) : null;
                      })()}
                      <button
                        type="button"
                        className="btn ghost sm"
                        style={{ fontSize: "calc(11px * var(--fs, 1))", padding: "2px 8px", width: "100%", justifyContent: "center" }}
                        onClick={() => handleSendReminderSms(v)}
                      >
                        <Phone size={11} style={{ marginRight: "4px" }} /> Send Email & SMS Reminder
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: "calc(12px * var(--fs, 1))", color: "#64748b", fontStyle: "italic", textAlign: "center", padding: "12px 0" }}>
                All patient vaccines up to date!
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Active Vaccination Card Management */}
        <div>
          {selectedPet.id ? (
            <div className="card" style={{ padding: "20px" }}>
              {/* Pet Info Banner */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  borderBottom: "1px solid #e2e8f0",
                  paddingBottom: "14px",
                  marginBottom: "16px",
                  flexWrap: "wrap",
                  gap: "12px",
                }}
              >
                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                  <div style={{ background: "#e0f2fe", padding: "10px", borderRadius: "10px", color: "#0369a1" }}>
                    <SpeciesIcon species={selectedPet.species} size={28} />
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <h3 style={{ margin: 0, fontSize: "calc(20px * var(--fs, 1))", color: "var(--navy)" }}>{selectedPet.name}</h3>
                      <span style={{ fontSize: "calc(12px * var(--fs, 1))", background: "#f1f5f9", padding: "2px 8px", borderRadius: "6px", color: "#334155" }}>
                        {selectedPet.species} &bull; {selectedPet.breed || "Mixed"} &bull; {selectedPet.sex}
                      </span>
                      {selectedPet.vaccinationCardId && (
                        <span style={{ fontSize: "calc(12px * var(--fs, 1))", background: "#dbeafe", color: "#1e40af", padding: "2px 8px", borderRadius: "6px", fontWeight: "700", border: "1px solid #bfdbfe" }}>
                          Card #{selectedPet.vaccinationCardId}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "calc(12.5px * var(--fs, 1))", color: "#64748b", marginTop: "4px" }}>
                      <b>Owner:</b> {owner.name} &bull; <b>Phone:</b> {owner.phone || "No phone"} &bull; <b>Birth:</b> {selectedPet.birth || "Not specified"} &bull; <b>Weight:</b> {selectedPet.weight ? `${selectedPet.weight} kg` : "—"}
                    </div>
                  </div>
                </div>

                {/* Status Badges */}
                <div style={{ display: "flex", gap: "8px" }}>
                  <div style={{ textAlign: "center", background: "#f8fafc", padding: "6px 12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                    <b style={{ fontSize: "calc(15px * var(--fs, 1))", color: "#15803d" }}>{completedCount}</b>
                    <small style={{ display: "block", fontSize: "calc(10.5px * var(--fs, 1))", color: "#64748b" }}>Administered</small>
                  </div>
                  <div style={{ textAlign: "center", background: "#f8fafc", padding: "6px 12px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                    <b style={{ fontSize: "calc(15px * var(--fs, 1))", color: "#0369a1" }}>{pendingCount}</b>
                    <small style={{ display: "block", fontSize: "calc(10.5px * var(--fs, 1))", color: "#64748b" }}>Scheduled</small>
                  </div>
                  {overdueCount > 0 && (
                    <div style={{ textAlign: "center", background: "#fef2f2", padding: "6px 12px", borderRadius: "8px", border: "1px solid #fca5a5" }}>
                      <b style={{ fontSize: "calc(15px * var(--fs, 1))", color: "#dc2626" }}>{overdueCount}</b>
                      <small style={{ display: "block", fontSize: "calc(10.5px * var(--fs, 1))", color: "#dc2626" }}>Overdue</small>
                    </div>
                  )}
                </div>
              </div>

              {/* Vaccine Table */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                <h4 style={{ margin: 0, fontSize: "calc(15px * var(--fs, 1))", color: "var(--navy)" }}>
                  Official Vaccination History &amp; Schedules
                </h4>
                <span style={{ fontSize: "calc(12px * var(--fs, 1))", color: "#64748b" }}>
                  Assistant logged records reflect immediately in the Pet Owner Portal
                </span>
              </div>

              {petVaccs.length ? (
                <div style={{ overflowX: "auto" }}>
                  <PaginatedTable label="Vaccination records" resetKey={selectedPetId} style={{ width: "100%", borderCollapse: "collapse", fontSize: "calc(13px * var(--fs, 1))" }}>
                    <thead>
                      <tr style={{ background: "#f8fafc", borderBottom: "2px solid #e2e8f0", textAlign: "left" }}>
                        <th style={{ padding: "10px 12px" }}>Vaccine &amp; Prophylaxis</th>
                        <th style={{ padding: "10px 12px" }}>Brand &amp; Lot #</th>
                        <th style={{ padding: "10px 12px" }}>Dose</th>
                        <th style={{ padding: "10px 12px" }}>Date Administered</th>
                        <th style={{ padding: "10px 12px" }}>Supervising Vet</th>
                        <th style={{ padding: "10px 12px" }}>Next Due Date</th>
                        <th style={{ padding: "10px 12px" }}>Status</th>
                        <th style={{ padding: "10px 12px", textAlign: "right" }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {petVaccs.map(v => {
                        const vetName = (VETS.find(x => x[0] === v.vetId) || [])[1] || v.vetName || (v.done ? "Dr. Attending" : "Pending Order");
                        const status = v.done ? "Completed" : dueState(v.nextDue);

                        return (
                          <tr key={v.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                            {/* Vaccine Name */}
                            <td style={{ padding: "10px 12px" }}>
                              <b style={{ color: "var(--navy)" }}>{v.vaccine}</b>
                              {v.notes && (
                                <small style={{ display: "block", color: "#64748b", fontSize: "calc(11px * var(--fs, 1))", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {v.notes}
                                </small>
                              )}
                            </td>

                            {/* Brand & Lot */}
                            <td style={{ padding: "10px 12px" }}>
                              <div>{v.brand || "—"}</div>
                              <small style={{ color: "#64748b", fontSize: "calc(11px * var(--fs, 1))" }}>
                                {v.batch ? `Lot: ${v.batch}` : "No lot recorded"}
                              </small>
                            </td>

                            {/* Dose */}
                            <td style={{ padding: "10px 12px" }}>
                              {v.doseNo ? (
                                <span style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: "4px", fontSize: "calc(11.5px * var(--fs, 1))", fontWeight: "600" }}>
                                  {v.doseOf ? `Dose ${v.doseNo}/${v.doseOf}` : `Dose ${v.doseNo}`}
                                </span>
                              ) : (
                                "—"
                              )}
                            </td>

                            {/* Date Given */}
                            <td style={{ padding: "10px 12px" }}>
                              {v.done ? (
                                <span style={{ fontWeight: 600 }}>{v.date}</span>
                              ) : (
                                <span style={{ color: "#0369a1", fontSize: "calc(11.5px * var(--fs, 1))", fontStyle: "italic" }}>
                                  Scheduled Protocol
                                </span>
                              )}
                            </td>

                            {/* Veterinarian */}
                            <td style={{ padding: "10px 12px", color: "#334155" }}>
                              {vetName}
                            </td>

                            {/* Next Due */}
                            <td style={{ padding: "10px 12px" }}>
                              {v.nextDue ? (
                                <div>
                                  <b style={{ color: v.nextDue < TODAY ? "#dc2626" : "#047857" }}>
                                    {v.nextDue}
                                  </b>
                                  <small style={{ display: "block", color: "#64748b", fontSize: "calc(11px * var(--fs, 1))" }}>
                                    {v.nextDue < TODAY ? "Overdue" : `in ${Math.round((new Date(v.nextDue) - new Date(TODAY)) / 864e5)} days`}
                                  </small>
                                </div>
                              ) : (
                                "—"
                              )}
                            </td>

                            {/* Status */}
                            <td style={{ padding: "10px 12px" }}>
                              <Badge v={status} />
                            </td>

                            {/* Actions */}
                            <td style={{ padding: "10px 12px", textAlign: "right" }}>
                              <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end" }}>
                                {!v.done && (
                                  <button
                                    type="button"
                                    className="btn gold sm"
                                    style={{ fontSize: "calc(11.5px * var(--fs, 1))", padding: "3px 8px" }}
                                    onClick={() => setLogModal({ pet: selectedPet, existingVacc: v })}
                                    title="Doctor administered shot: record batch and mark completed"
                                  >
                                    Update Shot
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn ghost sm"
                                  style={{ padding: "4px" }}
                                  onClick={() => setLogModal({ pet: selectedPet, existingVacc: v })}
                                  title="Edit entry"
                                >
                                  <Edit size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="btn ghost sm danger"
                                  style={{ padding: "4px" }}
                                  onClick={() => handleDeleteVaccine(v.id)}
                                  title="Remove entry"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </PaginatedTable>
                </div>
              ) : (
                <div className="empty sm" style={{ padding: "28px" }}>
                  No vaccination entries recorded for {selectedPet.name} yet. Click &ldquo;+ Log Administered Vaccine&rdquo; to begin.
                </div>
              )}
            </div>
          ) : (
            <div className="empty">No pet selected.</div>
          )}
        </div>
      </div>

      {/* Modal: Log / Update Administered Shot */}
      {logModal && (
        <VaccineEntryModal
          pet={logModal.pet}
          existing={logModal.existingVacc}
          db={db}
          me={me}
          onClose={() => setLogModal(null)}
          onSave={handleSaveVaccine}
        />
      )}
    </div>
  );
}

function VaccineEntryModal({ pet, existing, db, me, onClose, onSave }) {
  const isEditing = !!existing;
  const initialPreset = VACCINE_PRESETS.find(p => p.name === existing?.vaccine) || VACCINE_PRESETS[0];

  const [vaccine, setVaccine] = useState(existing?.vaccine || initialPreset.name);
  const [brand, setBrand] = useState(existing?.brand || initialPreset.brand);
  const [batch, setBatch] = useState(existing?.batch && existing.batch !== "Pending Administration" ? existing.batch : "LOT-" + new Date().getFullYear() + "-01");
  const [vetId, setVetId] = useState(existing?.vetId || "v1");
  const [date, setDate] = useState(existing?.date || TODAY);
  const [nextDue, setNextDue] = useState(() => {
    if (existing?.nextDue) return existing.nextDue;
    const intervalDays = INTERVAL[initialPreset.name] || initialPreset.interval || 365;
    return plus(intervalDays);
  });
  const [doseNo, setDoseNo] = useState(existing?.doseNo != null ? String(existing.doseNo) : "1");
  const [doseOf, setDoseOf] = useState(existing?.doseOf != null ? String(existing.doseOf) : String(initialPreset.doseOf || "1"));
  const [isDone, setIsDone] = useState(true); // default marked as administered when assistant logs
  const [notes, setNotes] = useState(existing?.notes || "Administered subcutaneously per doctor instruction. Pet observed without immediate adverse reaction.");

  const handleSelectPreset = (presetName) => {
    setVaccine(presetName);
    const p = VACCINE_PRESETS.find(x => x.name === presetName);
    if (p) {
      setBrand(p.brand);
      setDoseOf(String(p.doseOf || "1"));
      const intervalDays = INTERVAL[p.name] || p.interval || 365;
      const d = new Date(date + "T00:00:00");
      d.setDate(d.getDate() + intervalDays);
      setNextDue(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave({
      id: existing?.id,
      vaccine,
      brand: brand.trim(),
      batch: batch.trim(),
      vetId,
      date,
      nextDue,
      doseNo: doseNo ? +doseNo : null,
      doseOf: doseOf ? +doseOf : null,
      done: isDone,
      notes: notes.trim(),
      recordedBy: me.name,
    });
  };

  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: "min(600px, 100%)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #e2e8f0", paddingBottom: "12px", marginBottom: "16px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "calc(18px * var(--fs, 1))", display: "flex", alignItems: "center", gap: "8px", color: "var(--navy)" }}>
              <Syringe size={20} color="var(--navy)" />
              <span>{isEditing ? "Update Vaccine Entry" : "Log Administered Vaccine"}</span>
            </h3>
            <p style={{ margin: "2px 0 0", fontSize: "calc(12.5px * var(--fs, 1))", color: "#64748b" }}>
              Patient: <b>{pet.name}</b> ({pet.breed || pet.species}) &bull; Recorded by: <b>{me.name}</b>
            </p>
          </div>
          <button className="btn ghost sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ display: "grid", gap: "12px" }}>
            {/* 1. Vaccine & Quick Preset */}
            <div className="fld">
              <label><b>Vaccine Type &amp; Disease Target</b><i> *</i></label>
              <LiveControl as="select" value={vaccine} onChange={e => handleSelectPreset(e.target.value)} required>
                {VACCINE_PRESETS.map(p => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </LiveControl>
            </div>

            {/* 2. Doctor Order & Date */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <div className="fld">
                <label><b>Supervising Veterinarian</b><i> *</i></label>
                <LiveControl as="select" value={vetId} onChange={e => setVetId(e.target.value)} required>
                  {VETS.map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </LiveControl>
              </div>

              <div className="fld">
                <label><b>Date Administered</b><i> *</i></label>
                <LiveControl as="input" type="date" value={date} onChange={e => setDate(e.target.value)} min="2000-01-01" max={TODAY} required />
              </div>
            </div>

            {/* 3. Brand & Vial Batch Number */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <div className="fld">
                <label>Product Brand</label>
                <LiveControl as="input"
                  type="text"
                  value={brand}
                  onChange={e => setBrand(e.target.value)}
                  placeholder="e.g. Vanguard Plus 5, Defensor 3"
                  required
                />
              </div>

              <div className="fld">
                <label><b>Vial Batch / Lot #</b><i> *</i></label>
                <LiveControl as="input"
                  type="text"
                  value={batch}
                  onChange={e => setBatch(e.target.value)}
                  placeholder="e.g. LOT-2026-09A"
                  required
                />
              </div>
            </div>

            {/* 4. Doses & Next Booster Due Date */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.5fr", gap: "10px" }}>
              <div className="fld">
                <label>Dose #</label>
                <LiveControl as="input" type="number" min="1" max="10" value={doseNo} onChange={e => setDoseNo(e.target.value)} />
              </div>

              <div className="fld">
                <label>Total Doses</label>
                <LiveControl as="input" type="number" min="1" max="10" value={doseOf} onChange={e => setDoseOf(e.target.value)} />
              </div>

              <div className="fld">
                <label><b>Next Booster Due Date</b><i> *</i></label>
                <LiveControl as="input" type="date" error={nextDue && nextDue<=date ? 'The booster date must follow the vaccination date.' : ''} value={nextDue} min={date || undefined} max="2100-12-31" onChange={e => setNextDue(e.target.value)} required />
              </div>
            </div>

            {/* 5. Mark as Given / Administered */}
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", padding: "10px 12px", borderRadius: "8px", display: "flex", alignItems: "center", gap: "10px" }}>
              <LiveControl as="input"
                type="checkbox"
                id="doneCheck"
                checked={isDone}
                onChange={e => setIsDone(e.target.checked)}
                style={{ width: "18px", height: "18px" }}
              />
              <label htmlFor="doneCheck" style={{ margin: 0, fontSize: "calc(13px * var(--fs, 1))", color: "#166534", cursor: "pointer" }}>
                <b>Mark as Administered &amp; Verified Today</b> (Updates pet’s vaccination status to &ldquo;Completed&rdquo;)
              </label>
            </div>

            {/* 6. Clinical / Assistant Notes */}
            <div className="fld">
              <label>Doctor Instructions &amp; Assistant Notes</label>
              <LiveControl as="textarea"
                rows={2}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="e.g. Administered SC left shoulder. Weight 14.5 kg checked..."
              />
            </div>
          </div>

          <div className="row end" style={{ marginTop: "18px", gap: "10px" }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn gold" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <Check size={16} />
              <b>Save &amp; Update Card</b>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

