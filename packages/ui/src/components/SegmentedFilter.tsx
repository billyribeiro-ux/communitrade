"use client";

import { useRef, type KeyboardEvent } from "react";
import styles from "./SegmentedFilter.module.css";

export type SegmentedOption<T extends string> = { value: T; label: string };
export type SegmentedFilterProps<T extends string> = {
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
};

export function SegmentedFilter<T extends string>({ label, value, options, onChange }: SegmentedFilterProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const target = (index + direction + options.length) % options.length;
    refs.current[target]?.focus();
    const option = options[target];
    if (option) onChange(option.value);
  }
  return <div aria-label={label} className={styles.group} role="group">
    {options.map((option, index) => <button aria-pressed={value === option.value} className={styles.option} key={option.value} onClick={() => onChange(option.value)} onKeyDown={(event) => onKeyDown(event, index)} ref={(element) => { refs.current[index] = element; }} type="button">{option.label}</button>)}
  </div>;
}
