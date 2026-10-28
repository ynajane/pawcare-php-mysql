import LiveControl from './LiveControl.jsx';
import { createContext, useContext } from 'react';
import { Syringe, Info } from 'lucide-react';
import { useClinicRead } from '../useClinicRead.js';
import { VACCINE_CHOICES, vaccineChoiceError, vaccineIdFromReason, vaccinePrice, vaccinePriceLabel, phpPrice } from '../vaccineBooking.js';
import './vaccine-booking.css';
const Catalog=createContext(null);
export function BookingCatalogProvider({children}) {
  const read=useClinicRead('/api/services/prices');
  return <Catalog.Provider value={read}>{children}</Catalog.Provider>;
}
export function useBookingCatalog(){return useContext(Catalog);}
export function VaccinePicker({value,onChange,species,petSelected=true,error,id='booking-vaccine',disabled=false,plain=false}) {
  const read=useBookingCatalog(),catalog=read?.data?.catalog || [];
  // Plain: the same label + select as the other form fields, with the price as a one-line note.
  if(plain)return <div className="sf-field">
    <label htmlFor={id}>Vaccine *</label>
    <LiveControl as="select" name="vaccineId" required error={error || (value ? vaccineChoiceError(value,species) : '')} id={id} value={value} disabled={disabled||!petSelected} onChange={e=>onChange(e.target.value)} aria-invalid={!!error}>
      <option value="">{petSelected?'Choose a vaccine':'Choose a patient first'}</option>
      {VACCINE_CHOICES.filter(c=>!vaccineChoiceError(c.id,species)).map(c=><option key={c.id} value={c.id}>{c.name}{vaccinePrice(c.id,catalog)!==null?` — ${phpPrice(vaccinePrice(c.id,catalog))}`:''}</option>)}
    </LiveControl>
    {value && <small>{vaccinePriceLabel(value,catalog)}. The veterinarian confirms suitability before administering.</small>}
    {read?.error && <small role="status">Prices could not load. <button type="button" className="btn sm ghost" onClick={()=>read.load()}>Retry prices</button></small>}
  </div>;
  return <section className="vaccine-picker" aria-label="Requested vaccine">
    <label htmlFor={id}><Syringe size={18} aria-hidden="true" />Which vaccine is this visit for? <span>*</span></label>
    <LiveControl as="select" name="vaccineId" required error={error || (value ? vaccineChoiceError(value,species) : '')} id={id} value={value} disabled={disabled||!petSelected} onChange={e=>onChange(e.target.value)} aria-invalid={!!error} aria-describedby={`${id}-hint`}>
      <option value="">{petSelected?'Choose a vaccine request':'Choose a pet first'}</option>
      {VACCINE_CHOICES.filter(c=>!vaccineChoiceError(c.id,species)).map(c=><option key={c.id} value={c.id}>{c.name}{vaccinePrice(c.id,catalog)!==null?` — ${phpPrice(vaccinePrice(c.id,catalog))}`:''}</option>)}
    </LiveControl>
    {/* The select already shows its own error message, so the hint never repeats it. */}
    <p id={`${id}-hint`} className="vaccine-help">This is a request. The veterinarian checks your pet, prior doses and suitability before administering a vaccine.</p>
    {value && <div className="vaccine-estimate"><Info size={16} aria-hidden="true" /><div><strong>{vaccinePriceLabel(value,catalog)}</strong><small>Additional care may cost extra. Booking does not issue a bill or record a dose.</small></div></div>}
    {read?.error && <p className="vaccine-help" role="status">Prices could not load. Confirm pricing with the clinic. <button type="button" className="btn sm ghost" onClick={()=>read.load()}>Retry prices</button></p>}
  </section>;
}
export function VaccineEstimate({appointment,compact=false}) {
  const read=useBookingCatalog();
  const id=vaccineIdFromReason(appointment?.reason);
  if(!id || (appointment.service && appointment.service!=='vaccination'))return null;
  return <div className={`vaccine-visit-estimate${compact?' is-compact':''}`}><Syringe size={15} aria-hidden="true" /><span>{vaccinePriceLabel(id,read?.data?.catalog||[])}{!compact&&<small>Requested care only. The veterinarian confirms treatment; reception confirms the final bill.</small>}</span></div>;
}
