import type { ReactNode } from "react";

/**
 * A radio group rendered as a line of text.
 *
 * Real radios, hidden: arrow keys move within the group and Space selects,
 * which is the behaviour a group of buttons would have to reimplement and get
 * subtly wrong. The labels are what is visible; the inputs are clipped to
 * nothing and never seen. The chosen one is in full ink, the rest are quiet —
 * a stylesheet rule over `:has(:checked)`, not a class this file has to set.
 */

export interface Choice<T extends string | number> {
  value: T;
  label: ReactNode;
}

export interface ChoicesProps<T extends string | number> {
  /** What the group is, for a reader that cannot see the statement above it. */
  label: string;
  /** Shared by the radios so the browser knows they are one group. */
  name: string;
  value: T | null;
  choices: readonly Choice<T>[];
  onChange: (value: T) => void;
  /**
   * Stop taking input without leaving the screen. For the one state where the
   * answer has already been sent and a change to it would be dropped on the
   * floor, which is the only thing worse than not asking.
   */
  disabled?: boolean;
}

export default function Choices<T extends string | number>({
  label,
  name,
  value,
  choices,
  onChange,
  disabled,
}: ChoicesProps<T>) {
  return (
    <div className="choices" role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <label className="choice" key={choice.value}>
          <input
            className="choice__input"
            type="radio"
            name={name}
            value={choice.value}
            checked={value === choice.value}
            disabled={disabled}
            onChange={() => onChange(choice.value)}
          />
          <span className="choice__label">{choice.label}</span>
        </label>
      ))}
    </div>
  );
}
