// Byte count applies to the serialized, sanitized facet, including UTF-8 text.
export function fitsBlockerAgeBudget(value: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144;
}
