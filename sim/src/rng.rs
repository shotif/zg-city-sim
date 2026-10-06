//! Small deterministic random number generator (PCG32), so runs are reproducible.

#[derive(Clone, Debug)]
pub struct Rng {
    state: u64,
    inc: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut rng = Rng {
            state: 0,
            inc: (seed << 1) | 1,
        };
        rng.next_u32();
        rng.state = rng.state.wrapping_add(seed ^ 0x853c_49e6_748f_ea9b);
        rng.next_u32();
        rng
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform in [0, 1).
    pub fn f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 24) as f32
    }

    pub fn f64(&mut self) -> f64 {
        let hi = (self.next_u32() >> 5) as u64;
        let lo = (self.next_u32() >> 6) as u64;
        (hi * 67_108_864 + lo) as f64 / 9_007_199_254_740_992.0
    }

    /// Uniform in [lo, hi).
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.f32()
    }

    /// Approximately normal (sum of uniforms), mean 0, standard deviation 1.
    pub fn normal(&mut self) -> f32 {
        let mut s = 0.0;
        for _ in 0..6 {
            s += self.f32();
        }
        (s - 3.0) * std::f32::consts::SQRT_2
    }
}
