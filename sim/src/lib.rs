//! ZG City Sim traffic engine.
//!
//! Microscopic simulation on the SUMO-derived network exported by the data pipeline:
//! vehicles follow the Intelligent Driver Model, obey junction right-of-way (SUMO's
//! request/response matrices) and traffic-light programs, change lanes to reach their
//! turns and route with A*. The same code runs natively (tests, offline calibration) and
//! as WebAssembly in the browser (`ffi`).

// Index loops read best in this numeric code.
#![allow(clippy::needless_range_loop)]

pub mod demand;
pub mod engine;
pub mod ffi;
pub mod idm;
pub mod network;
pub mod rng;
pub mod router;
pub mod transit;
pub mod vtype;

#[cfg(test)]
mod tests;
