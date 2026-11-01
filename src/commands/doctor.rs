//! Maps to: CC `commands/doctor/doctor.tsx`.
//!
//! The official local-jsx command `call(...)` returns `<Doctor onDone={onDone} />`
//! from `screens/Doctor.tsx`. Nyan keeps the same command-to-screen boundary:
//! command processing opens the local UI, while the screen implementation lives
//! in `src/screens/doctor.rs`.

pub use crate::screens::doctor::{Doctor, DoctorProps};
