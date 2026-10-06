//! Intelligent Driver Model (Treiber, Hennecke, Helbing 2000).

use crate::vtype::VType;

/// Acceleration of a vehicle at speed `v` with desired speed `v0`, a gap of `gap` metres
/// (bumper to bumper) to a leader driving at `v_leader`. An infinite gap means free road.
#[inline]
pub fn acceleration(v: f32, v0: f32, gap: f32, v_leader: f32, p: &VType) -> f32 {
    let v0 = v0.max(0.1);
    let free = 1.0 - (v / v0).powi(4);
    let interaction = if gap.is_finite() {
        let dv = v - v_leader;
        let s_star = p.min_gap + (v * p.tau + v * dv / (2.0 * (p.accel * p.decel).sqrt())).max(0.0);
        let s = gap.max(0.05);
        (s_star / s).powi(2)
    } else {
        0.0
    };
    (p.accel * (free - interaction)).clamp(-p.emergency_decel, p.accel)
}

/// Deceleration needed to stop within `distance` from speed `v`.
#[inline]
pub fn stopping_decel(v: f32, distance: f32) -> f32 {
    if distance <= 0.01 {
        return f32::INFINITY;
    }
    v * v / (2.0 * distance)
}
