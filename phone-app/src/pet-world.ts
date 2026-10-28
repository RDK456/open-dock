// What the pet is told about the world beyond its own screen: music playing on the PC, a game in front on the PC,
// and (soon) the phone's own sensors. Any part of the app calls setPetWorld; the widget layer forwards the whole
// picture to the page (OpenDockPet.setWorld in pc-companion/src/pet/pet.js).
export type PetWorld = {
  music?: boolean; game?: string | null;
  // The phone's own senses (pet-sensors.ts): battery 0 to 1, charging, tilt to the right 0 to +-1, the time of the last shake,
  // face down, room light in lux, and how the phone is held.
  battery?: number; charging?: boolean; tiltX?: number; shakeAt?: number; facedown?: boolean; lux?: number; orientation?: 'portrait' | 'landscape';
};
let world: PetWorld = {};
const listeners = new Set<(world: PetWorld) => void>();
export const getPetWorld = () => world;
export function setPetWorld(patch: PetWorld) {
  const next = { ...world, ...patch };
  if (patch.battery === undefined && 'battery' in patch) delete next.battery;
  if (JSON.stringify(next) === JSON.stringify(world)) return;
  world = next;
  listeners.forEach((listener) => listener(world));
}
export const subscribePetWorld = (listener: (world: PetWorld) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
