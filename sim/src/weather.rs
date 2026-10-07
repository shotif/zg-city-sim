//! Weather's effect on driving (M6b): in rain, snow and fog drivers go slower, keep longer
//! gaps and accelerate and brake more gently, so roads and junctions carry fewer vehicles.
//!
//! The factors are estimates from the literature on traffic in inclement weather (the
//! US Federal Highway Administration's review "Empirical Studies on Traffic Flow in
//! Inclement Weather", 2006, and the Highway Capacity Manual's weather adjustment factors):
//! free-flow speed falls by about 3-5 % in rain, 6-9 % in heavy rain, about 13 % in light
//! snow, 35-40 % in heavy snow and about 10 % in poor visibility; capacity by about 8 %,
//! 14 %, 10 %, 25-30 % and 10-12 %. The headway and acceleration factors are set so a queue
//! leaves a green light at about those lower rates (see the engine tests).

/// Factors on every driver's parameters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Weather {
    /// Desired speed, as a share of the clear-weather one.
    pub speed: f32,
    /// Desired time headway, as a multiple of the clear-weather one.
    pub headway: f32,
    /// Acceleration and comfortable braking, as a share.
    pub accel: f32,
}

impl Weather {
    pub const CLEAR: Weather = Weather {
        speed: 1.0,
        headway: 1.0,
        accel: 1.0,
    };
    pub const RAIN: Weather = Weather {
        speed: 0.95,
        headway: 1.1,
        accel: 0.95,
    };
    pub const HEAVY_RAIN: Weather = Weather {
        speed: 0.92,
        headway: 1.2,
        accel: 0.9,
    };
    pub const SNOW: Weather = Weather {
        speed: 0.87,
        headway: 1.15,
        accel: 0.85,
    };
    pub const HEAVY_SNOW: Weather = Weather {
        speed: 0.65,
        headway: 1.4,
        accel: 0.65,
    };
    pub const FOG: Weather = Weather {
        speed: 0.9,
        headway: 1.15,
        accel: 1.0,
    };

    /// Factors kept within sensible bounds (from the app).
    pub fn clamped(self) -> Weather {
        Weather {
            speed: self.speed.clamp(0.3, 1.2),
            headway: self.headway.clamp(0.5, 3.0),
            accel: self.accel.clamp(0.3, 1.5),
        }
    }
}

impl Default for Weather {
    fn default() -> Self {
        Weather::CLEAR
    }
}
