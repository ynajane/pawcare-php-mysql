-- PawCare presentation data (PostgreSQL / Neon).  Run the WHOLE file once in the Neon SQL editor or psql.
--
--  1. DELETES all clinic data: owners, pets, appointments, consultations, vaccinations, admissions,
--     pet requests, billing, reminders and audit logs, plus every owner login.
--  2. KEEPS admin / vet / assistant accounts and the price catalog.
--  3. Inserts a fresh demo clinic whose dates are relative to today, so the dashboard is never empty.
--
-- Demo owner logins (password for all three: PawCare#Demo2026 - change it after the presentation):
--     demo.maria@example.com   demo.jose@example.com   demo.carla@example.com
-- Needs at least one active vet account (role 'vet'). Assistant name is read from the first assistant, if any.

BEGIN;

-- ---------------------------------------------------------------- 1. wipe past data
TRUNCATE TABLE owners, pets, appointments, consultations, vaccinations, pet_weights, pet_requests, audit_logs
  RESTART IDENTITY CASCADE;
DELETE FROM users WHERE role = 'owner';

-- ---------------------------------------------------------------- 2. demo data
DO $$
DECLARE
  d     date := CURRENT_DATE;
  vet1  text;
  vet2  text;
  vet1n text;
  vet2n text;
  asst  text;
  pw    text := crypt('PawCare#Demo2026', gen_salt('bf', 10));
BEGIN
  SELECT COALESCE(vet_id, id), first_name || ' ' || last_name INTO vet1, vet1n
    FROM users WHERE role = 'vet' ORDER BY created_at, id LIMIT 1;
  IF vet1 IS NULL THEN RAISE EXCEPTION 'Create at least one vet account first.'; END IF;
  SELECT COALESCE(vet_id, id), first_name || ' ' || last_name INTO vet2, vet2n
    FROM users WHERE role = 'vet' AND COALESCE(vet_id, id) <> vet1 ORDER BY created_at, id LIMIT 1;
  IF vet2 IS NULL THEN vet2 := vet1; vet2n := vet1n; END IF;
  SELECT first_name || ' ' || last_name INTO asst FROM users WHERE role = 'assistant' ORDER BY created_at LIMIT 1;
  asst := COALESCE(asst, 'Front Desk');

  -- Owner logins (already verified so nobody needs an email or SMS code during the demo)
  INSERT INTO users (id, first_name, last_name, birthday, password_hash, email, role, owner_id, mobile_number, email_verified_at, mobile_verified, mobile_verified_at) VALUES
    ('u_demo_o1', 'Maria', 'Santos',  '1992-04-10', pw, 'demo.maria@example.com', 'owner', 'o_demo_1', '+63 917 888 1111', NOW(), true, NOW()),
    ('u_demo_o2', 'Jose',  'Dalisay', '1989-09-18', pw, 'demo.jose@example.com',  'owner', 'o_demo_2', '+63 917 888 2222', NOW(), true, NOW()),
    ('u_demo_o3', 'Carla', 'Gomez',   '1995-01-22', pw, 'demo.carla@example.com', 'owner', 'o_demo_3', '+63 922 333 4444', NOW(), true, NOW());

  INSERT INTO owners (id, user_id, name, email, phone, address, first_pet_registered_at) VALUES
    ('o_demo_1', 'u_demo_o1', 'Maria Santos',  'demo.maria@example.com', '+63 917 888 1111', '12 Mabini St., Brgy. San Antonio, Pasig City', NOW() - interval '400 days'),
    ('o_demo_2', 'u_demo_o2', 'Jose Dalisay',  'demo.jose@example.com',  '+63 917 888 2222', '45 Katipunan Ave., Loyola Heights, Quezon City', NOW() - interval '300 days'),
    ('o_demo_3', 'u_demo_o3', 'Carla Gomez',   'demo.carla@example.com', '+63 922 333 4444', '88 Rizal Ave., San Carlos, Makati City', NOW() - interval '200 days'),
    ('o_demo_4', NULL,        'Ramon Villanueva', 'ramon.v@example.com', '+63 925 555 0101', '7 Sampaguita St., Brgy. Kapitolyo, Pasig City', NOW() - interval '60 days');

  INSERT INTO pets (id, owner_id, name, species, breed, sex, birth, weight, color, neutered, allergies, vaccination_card_id, notes, registration_status) VALUES
    ('p_demo_1', 'o_demo_1', 'Bantay',  'Dog', 'Golden Retriever',    'Male',   '2021-03-15', 24.50, 'Golden Blonde',  'Yes',      '{"Chicken"}', 'VACC-2026-2001', 'Friendly and calm during exams.', 'Verified'),
    ('p_demo_2', 'o_demo_1', 'Mingming','Cat', 'Domestic Shorthair',  'Female', '2022-07-20',  4.20, 'Calico',         'Yes',      '{}',          'VACC-2026-2002', 'Prefers gentle handling.', 'Verified'),
    ('p_demo_3', 'o_demo_2', 'Choco',   'Dog', 'Shih Tzu',            'Male',   '2023-01-08',  6.10, 'Brown & White',  'No',       '{}',          'VACC-2026-2003', 'Active and playful.', 'Verified'),
    ('p_demo_4', 'o_demo_2', 'Mochi',   'Cat', 'Persian',             'Female', '2023-10-12',  3.50, 'White',          'No',       '{}',          'VACC-2026-2004', 'Indoor cat.', 'Verified'),
    ('p_demo_5', 'o_demo_3', 'Rocky',   'Dog', 'Labrador Retriever',  'Male',   '2020-06-02', 29.80, 'Black',          'Yes',      '{}',          'VACC-2026-2005', 'Sensitive stomach.', 'Verified'),
    ('p_demo_6', 'o_demo_3', 'Luna',    'Cat', 'Siamese',             'Female', '2021-11-30',  4.60, 'Cream Point',    'Yes',      '{"Fish"}',    'VACC-2026-2006', 'Allergic to fish-based food.', 'Verified'),
    ('p_demo_7', 'o_demo_4', 'Brownie', 'Dog', 'Aspin',               'Male',   '2019-09-09', 12.30, 'Brown',          'Yes',      '{}',          'VACC-2026-2007', 'Walk-in client; owner has no online account.', 'Verified');

  INSERT INTO pet_weights (pet_id, date, kg, recorded_by) VALUES
    ('p_demo_1', d - 400, 23.80, 'Front Desk'), ('p_demo_1', d - 200, 24.20, 'Front Desk'), ('p_demo_1', d - 1, 24.50, 'Front Desk'),
    ('p_demo_2', d - 300,  4.00, 'Front Desk'), ('p_demo_2', d - 1,   4.20, 'Front Desk'),
    ('p_demo_3', d - 250,  5.60, 'Front Desk'), ('p_demo_3', d - 2,   6.10, 'Front Desk'),
    ('p_demo_5', d - 180, 28.90, 'Front Desk'), ('p_demo_5', d - 5,  29.80, 'Front Desk');

  -- ---- appointments: finished & paid (fills sales and history)
  INSERT INTO appointments (id, pet_id, vet_id, date, time, reason, status, billing_status, amount, service, payment_method, paid_at, invoice_items, payment_details, approved_at, approved_by) VALUES
    ('a_demo_01', 'p_demo_1', vet1, d - 1, '09:00', 'Annual check-up',            'Completed', 'Paid', 850.00, 'consultation', 'Cash',  (d - 1 + time '09:45')::timestamp, '[{"name":"Consultation","qty":1,"price":600,"source":"catalog"},{"name":"Nail trimming","qty":1,"price":250,"source":"catalog"}]', '{"discount":0,"reference":"","cashTendered":1000,"changeAmount":150}', NOW(), asst),
    ('a_demo_02', 'p_demo_2', vet2, d - 1, '10:30', 'Skin scratching / allergy',  'Completed', 'Paid', 600.00, 'consultation', 'GCash', (d - 1 + time '11:15')::timestamp, '[{"name":"Consultation","qty":1,"price":600,"source":"catalog"}]', '{"discount":0,"reference":"GC-884201","cashTendered":600,"changeAmount":0}', NOW(), asst),
    ('a_demo_03', 'p_demo_3', vet1, d - 2, '14:00', 'Rabies vaccination',         'Completed', 'Paid', 500.00, 'vaccination', 'Cash',  (d - 2 + time '14:30')::timestamp, '[{"name":"Anti-rabies vaccine","qty":1,"price":500,"source":"catalog"}]', '{"discount":0,"reference":"","cashTendered":500,"changeAmount":0}', NOW(), asst),
    ('a_demo_04', 'p_demo_4', vet2, d - 3, '11:00', 'Routine deworming',          'Completed', 'Paid', 450.00, 'deworming',   'Cash',  (d - 3 + time '11:30')::timestamp, '[{"name":"Deworming","qty":1,"price":450,"source":"catalog"}]', '{"discount":0,"reference":"","cashTendered":500,"changeAmount":50}', NOW(), asst),
    ('a_demo_05', 'p_demo_5', vet1, d - 5, '15:00', 'Vomiting / diarrhea',        'Completed', 'Paid', 1200.00,'consultation', 'GCash', (d - 5 + time '16:00')::timestamp, '[{"name":"Consultation","qty":1,"price":600,"source":"catalog"},{"name":"Medicines","qty":1,"price":600,"source":"catalog"}]', '{"discount":0,"reference":"GC-771930","cashTendered":1200,"changeAmount":0}', NOW(), asst);
  INSERT INTO appointments (id, pet_id, vet_id, date, time, reason, status, billing_status, amount, service, cancel_reason, approved_at, approved_by) VALUES
    ('a_demo_06', 'p_demo_6', vet2, d - 2, '09:30', 'Dental check',               'No-show',   'Unbilled', 600.00, 'consultation', NULL, NOW(), asst);

  -- ---- today's queue (waiting, in consultation, ready for checkout, still to come)
  INSERT INTO appointments (id, pet_id, vet_id, date, time, reason, status, billing_status, amount, service, intake_vitals, invoice_items, approved_at, approved_by) VALUES
    ('a_demo_10', 'p_demo_1', vet1, d, '09:00', 'Booster shots & routine check', 'Checked-in',      'Unbilled', 850.00, 'consultation',
       '{"weight": 24.5, "weightStatus": "healthy", "temp": 38.4, "tempStatus": "normal", "heartRate": 95, "checkedInBy": "Front Desk"}', '[]', NOW(), asst),
    ('a_demo_11', 'p_demo_2', vet2, d, '10:00', 'Sneezing and watery eyes',      'In consultation', 'Unbilled', 600.00, 'consultation',
       '{"weight": 4.2, "weightStatus": "healthy", "temp": 38.7, "tempStatus": "normal", "heartRate": 170, "checkedInBy": "Front Desk"}', '[]', NOW(), asst),
    ('a_demo_12', 'p_demo_6', vet1, d, '08:30', 'Vaccination for cats (FVRCP)',  'Completed',       'Unpaid',   950.00, 'vaccination', NULL,
       '[{"name":"Consultation","qty":1,"price":600,"source":"catalog"},{"name":"FVRCP vaccine","qty":1,"price":350,"source":"catalog"}]', NOW(), asst),
    ('a_demo_13', 'p_demo_3', vet2, d, '16:30', 'Puppy grooming and ear cleaning','Scheduled',      'Unbilled', 600.00, 'consultation', NULL, '[]', NOW(), asst);

  -- ---- upcoming requests (pending approval) and a confirmed booking
  INSERT INTO appointments (id, pet_id, vet_id, date, time, reason, status, billing_status, amount, service, invoice_items) VALUES
    ('a_demo_20', 'p_demo_4', vet1, d + 1, '09:30', 'Deworming - routine deworming',        'Pending Approval', 'Unbilled', 450.00, 'deworming',    '[]'),
    ('a_demo_21', 'p_demo_5', vet2, d + 1, '10:30', 'Limping on front left leg',            'Pending Approval', 'Unbilled', 600.00, 'consultation', '[]'),
    ('a_demo_22', 'p_demo_7', vet1, d + 2, '14:00', 'Anti-rabies booster',                  'Pending Approval', 'Unbilled', 500.00, 'vaccination',  '[]');
  INSERT INTO appointments (id, pet_id, vet_id, date, time, reason, status, billing_status, amount, service, invoice_items, approved_at, approved_by) VALUES
    ('a_demo_23', 'p_demo_6', vet2, d + 3, '11:00', 'Follow-up check',                       'Scheduled',        'Unbilled', 600.00, 'consultation', '[]', NOW(), asst);

  -- ---- consultation (SOAP) notes for finished visits
  INSERT INTO consultations (id, pet_id, vet_id, appt_id, date, symptoms, objective, diagnosis, treatment, prescription) VALUES
    ('c_demo_01', 'p_demo_1', vet1, 'a_demo_01', d - 1, 'No complaints. Owner requests yearly check-up.', 'Alert and active. T 38.4 C, HR 95 bpm, mucous membranes pink, CRT < 2 s.', 'Healthy adult dog', 'General examination and nail trim. Continue current diet.', NULL),
    ('c_demo_02', 'p_demo_2', vet2, 'a_demo_02', d - 1, 'Scratching ears and neck for 3 days.', 'Mild erythema behind ears. No fleas seen. T 38.6 C.', 'Allergic dermatitis (suspected)', 'Topical anti-itch cleanse. Hypoallergenic diet trial for 4 weeks.', 'Medicated shampoo twice weekly for 2 weeks.'),
    ('c_demo_03', 'p_demo_3', vet1, 'a_demo_03', d - 2, 'Due for yearly rabies booster.', 'Healthy, T 38.5 C. Eligible for vaccination.', 'Vaccination - anti-rabies', 'Anti-rabies vaccine administered.', NULL),
    ('c_demo_04', 'p_demo_4', vet2, 'a_demo_04', d - 3, 'Routine deworming.', 'Bright and alert, weight 3.5 kg.', 'Routine deworming', 'Oral dewormer given by weight.', NULL),
    ('c_demo_05', 'p_demo_5', vet1, 'a_demo_05', d - 5, 'Vomiting twice and loose stools since yesterday.', 'Mild dehydration, abdomen soft, T 38.9 C.', 'Acute gastroenteritis', 'Supportive care, bland diet for 3 days.', 'Probiotic once daily for 5 days; anti-nausea tablet twice daily for 3 days.'),
    ('c_demo_12', 'p_demo_6', vet1, 'a_demo_12', d,     'FVRCP vaccination.', 'Healthy, T 38.6 C. No signs of illness.', 'Vaccination - FVRCP', 'FVRCP vaccine administered.', NULL);

  -- ---- vaccination cards (some due soon so reminders and dashboards have content)
  INSERT INTO vaccinations (id, pet_id, card_id, vaccine, brand, batch, date, next_due, dose_no, dose_of, done, automated, protocol_type, notes, vet_id, recorded_by) VALUES
    ('v_demo_01', 'p_demo_1', 'VACC-2026-2001', 'Anti-rabies',   'Defensor 3',        'DEF-9021', d - 355, d + 10,  1, 1, true, false, 'Core Rabies',          'No reaction',  vet1, vet1n),
    ('v_demo_02', 'p_demo_1', 'VACC-2026-2001', 'DHPP (5-in-1)', 'Nobivac DHPPi',     'NOB-4412', d - 340, d + 25,  3, 3, true, false, 'Core Canine Protocol', 'Completed series', vet1, vet1n),
    ('v_demo_03', 'p_demo_2', 'VACC-2026-2002', 'FVRCP',         'Fel-O-Vax IV',      'FEL-5501', d - 340, d + 25,  2, 2, true, false, 'Core Feline Protocol', 'Tolerated well', vet2, vet2n),
    ('v_demo_04', 'p_demo_3', 'VACC-2026-2003', 'Anti-rabies',   'Defensor 3',        'DEF-9033', d - 2,   d + 363, 1, 1, true, false, 'Core Rabies',          'Given at visit', vet1, vet1n),
    ('v_demo_05', 'p_demo_5', 'VACC-2026-2005', 'DHPP (5-in-1)', 'Nobivac DHPPi',     'NOB-5120', d - 370, d - 5,   3, 3, true, false, 'Core Canine Protocol', 'Booster overdue', vet1, vet1n),
    ('v_demo_06', 'p_demo_6', 'VACC-2026-2006', 'FVRCP',         'Fel-O-Vax IV',      'FEL-6107', d,       d + 365, 1, 1, true, false, 'Core Feline Protocol', 'Given at visit', vet1, vet1n),
    ('v_demo_07', 'p_demo_7', 'VACC-2026-2007', 'Anti-rabies',   'Defensor 3',        'DEF-9040', d - 362, d + 3,   1, 1, true, false, 'Core Rabies',          'Booster due this week', vet2, vet2n);

  INSERT INTO audit_logs (user_name, user_role, action) VALUES
    (asst, 'assistant', 'Approved appointment a_demo_10 for Bantay'),
    (asst, 'assistant', 'Processed payment for visit a_demo_01'),
    (vet1n, 'vet', 'Finalized consultation notes for Rocky'),
    ('System', 'system', 'Presentation data loaded');
END $$;

COMMIT;
