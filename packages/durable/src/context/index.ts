/**
 * Context primitives of N4 (section 8.8): the protected positions of a context, the basis of a selected cut, and the
 * admission decision over a context measurement. Pure functions: no storage, no harness, no I/O.
 */
export { type Admission, type AdmissionMeasure, decideAdmission } from "./admission.ts";
export { basisOf, type ContextBasis } from "./basis.ts";
export { isProtected, type Protection, type ProtectionOptions, type ProtectionReason } from "./protection.ts";
export type { ContextLayout } from "./types.ts";
