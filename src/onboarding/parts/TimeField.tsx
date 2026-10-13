/**
 * A time, as a native field.
 *
 * The quiet-hours schedule is the one place the flow needs a control the
 * register cannot render as text — a wall-clock time has to be pickable, and two
 * text inputs parsing "10pm" would be a worse control wearing a nicer face. So
 * it is a real `<input type="time">`, with no box around it, sitting on the same
 * hairline the gauge is drawn with.
 *
 * It has a visible label rather than only an accessible one. A bare time field
 * beside another bare time field is a guess, and "Pause at" and "Pick up at" are
 * two words that remove it.
 *
 * The value is "HH:MM" in local wall clock, which is exactly what
 * `ResourceLimits.quietHours` speaks.
 */

export interface TimeFieldProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** See `Choices`: for the moment the answer has been sent and cannot change. */
  disabled?: boolean;
}

export default function TimeField({ value, onChange, label, disabled }: TimeFieldProps) {
  return (
    <label className="time">
      <span className="time__label">{label}</span>
      <input
        className="time__input"
        type="time"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
