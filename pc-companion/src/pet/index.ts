import './pet.js';

export type PetFace = { id: string; name: string; blurb: string };
export type PetTouch = 'down' | 'move' | 'up' | 'cancel';
export type PetOptions = { outfit?: string; mood?: boolean; sound?: boolean; camera?: boolean; sleepy?: number; hyper?: number; shy?: number; grumpy?: number; quietFrom?: number; quietTo?: number };
export const PET_OUTFITS = ['auto', 'none', 'glasses', 'mustache', 'crown', 'tophat', 'bowtie'] as const;
type OpenDockPetApi = {
  faces: PetFace[];
  defaultColor: string;
  mount(host: HTMLElement, options: { face?: string; color?: string; width: number; height: number; opacity?: number; pet?: PetOptions }): { destroy(): void; touch(kind: PetTouch, x: number, y: number): void };
  setPaused(paused: boolean): void;
  setWorld(world: { music?: boolean; game?: string | null }): void;
};

export const OpenDockPet = (globalThis as unknown as { OpenDockPet: OpenDockPetApi }).OpenDockPet;

export function petFace(id?: string): PetFace {
  return OpenDockPet.faces.find((face) => face.id === id) ?? OpenDockPet.faces[0];
}
