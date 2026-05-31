// Maps the voice id (what we store in DB / pass to ElevenLabs) to a display
// name and short character description. The script prompt uses the name so
// the model can write "I'm Rachel, with Adam here today" instead of generic
// host/co-host references.

export type VoicePersona = {
  id: string;
  name: string;
  flavor: string;
};

const PERSONAS: Record<string, VoicePersona> = {
  rachel: { id: "rachel", name: "Rachel", flavor: "warm, narrative" },
  adam: { id: "adam", name: "Adam", flavor: "calm, analytical" },
  aria: { id: "aria", name: "Aria", flavor: "bright, energetic" },
};

export function personaFor(voiceId: string): VoicePersona {
  return PERSONAS[voiceId] ?? { id: voiceId, name: voiceId, flavor: "" };
}
