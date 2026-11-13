// Source of mechanics: Narukami LocalHealingGun. Balance: existing project values, per user 2026-11-04.
export interface IsidaConfig {
  capacity: number; chargeRate: number; checkPeriodMsec: number; coneAngle: number; radius: number;
  dischargeDamageRate: number; dischargeHealingRate: number; dischargeIdleRate: number;
}

// Offline fallback keeps the previous project balance: 10s active, 11.71s recharge, 15m.
// Radius 15m remains an estimate; no original Isida balance exists in assets/protanki.
export const ISIDA_DEFAULT: IsidaConfig = {
  capacity: 1000, chargeRate: 1000 / 11.71, checkPeriodMsec: 250, coneAngle: Math.PI / 6,
  radius: 1500, dischargeDamageRate: 100, dischargeHealingRate: 100, dischargeIdleRate: 50,
};
