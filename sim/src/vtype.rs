//! Vehicle types and their driving parameters.

use crate::network::vclass;

#[derive(Clone, Copy, Debug)]
pub struct VType {
    /// Vehicle length (m).
    pub length: f32,
    /// Minimum standstill gap to the vehicle ahead (m).
    pub min_gap: f32,
    /// Maximum acceleration (m/s²).
    pub accel: f32,
    /// Comfortable deceleration (m/s²).
    pub decel: f32,
    /// Emergency deceleration (m/s²).
    pub emergency_decel: f32,
    /// Desired time headway (s).
    pub tau: f32,
    /// Top speed (m/s).
    pub max_speed: f32,
    /// Permission bit the vehicle needs on a lane.
    pub vclass: u16,
}

pub const CAR: u8 = 0;
pub const TRUCK: u8 = 1;
pub const BUS: u8 = 2;
pub const TRAM: u8 = 3;
pub const TRAIN: u8 = 4;
/// Cyclists (M8d): 15-20 km/h, apart from other traffic except inside junctions.
pub const BIKE: u8 = 5;

pub static TYPES: [VType; 6] = [
    VType {
        length: 4.5,
        min_gap: 2.0,
        accel: 2.2,
        decel: 3.0,
        emergency_decel: 7.5,
        tau: 1.0,
        max_speed: 50.0,
        vclass: vclass::PASSENGER,
    },
    VType {
        length: 10.0,
        min_gap: 2.5,
        accel: 1.0,
        decel: 2.2,
        emergency_decel: 6.0,
        tau: 1.4,
        max_speed: 25.0,
        vclass: vclass::TRUCK,
    },
    VType {
        length: 12.0,
        min_gap: 2.5,
        accel: 1.1,
        decel: 2.2,
        emergency_decel: 6.0,
        tau: 1.5,
        max_speed: 22.0,
        vclass: vclass::BUS,
    },
    VType {
        length: 32.0,
        min_gap: 3.0,
        accel: 1.0,
        decel: 1.6,
        emergency_decel: 4.0,
        tau: 1.8,
        max_speed: 19.5,
        vclass: vclass::TRAM,
    },
    // HŽ's suburban electric unit (Končar 6112): 75 m, 160 km/h, braking gently for its
    // passengers; on most lines in the map the track's limit is lower.
    VType {
        length: 75.0,
        min_gap: 10.0,
        accel: 0.8,
        decel: 0.8,
        emergency_decel: 1.5,
        tau: 3.0,
        max_speed: 44.0,
        vclass: vclass::RAIL,
    },
    VType {
        length: 1.8,
        min_gap: 1.0,
        accel: 1.0,
        decel: 2.5,
        emergency_decel: 4.5,
        tau: 1.0,
        max_speed: 5.0,
        vclass: vclass::BICYCLE,
    },
];
