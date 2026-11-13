// Alarm limits shared by the HMI and the dashboard. [alarm below, alarm above]; undefined = no limit.
// Farm standards (ammonia, nitrite, nitrate, alkalinity, turbidity, calcium hardness) come from the farm.
// The rest are starting guides.
export type Lim = [number | undefined, number | undefined]
export const LIM0: Record<string, Lim> = {
  nh3: [undefined, 0.25], no2: [undefined, 0], no3: [undefined, 0], alk: [undefined, 100], turb: [undefined, 15], cah: [undefined, 200],
  hard: [undefined, undefined], ph: [6.8, 8.2], jflow: [80, 120], jdo: [5, undefined], jp: [0.08, 0.6], temp: [26, 31],
}
