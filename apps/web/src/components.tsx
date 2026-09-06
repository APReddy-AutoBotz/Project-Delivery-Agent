import React, { useId } from "react";

const focus =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600";
export function Button({
  type = "button",
  className = "",
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type={type}
      className={`cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${focus} ${className}`}
      {...props}
    />
  );
}
type Field = { label: string; help?: string };
export function TextField({
  label,
  help,
  id,
  className = "",
  ...props
}: Field & React.ComponentProps<"input">) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <label htmlFor={fieldId}>
      {label}
      <input
        id={fieldId}
        className={`w-full ${focus} ${className}`}
        aria-describedby={help ? `${fieldId}-help` : undefined}
        {...props}
      />
      {help && <small id={`${fieldId}-help`}>{help}</small>}
    </label>
  );
}
export function SelectField({
  label,
  help,
  id,
  className = "",
  ...props
}: Field & React.ComponentProps<"select">) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <label htmlFor={fieldId}>
      {label}
      <select
        id={fieldId}
        className={`w-full ${focus} ${className}`}
        aria-describedby={help ? `${fieldId}-help` : undefined}
        {...props}
      />
      {help && <small id={`${fieldId}-help`}>{help}</small>}
    </label>
  );
}
export function Message({
  error = false,
  children,
}: {
  error?: boolean;
  children: React.ReactNode;
}) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={error ? "text-red-800" : "text-teal-800"}
    >
      {children}
    </p>
  );
}
