import type { RadioChoiceView } from '../server/api.ts';
import type { Texts } from './texts.ts';

export const choiceName = (t: Texts, c: RadioChoiceView) => (c.unknown ? t.originUnknown : (c.name ?? c.type));

// The entry shown first: the radio chosen in the sidebar, else the first, which is the one connected last.
export function preselect(choices: RadioChoiceView[], volume: string | undefined): string {
  return (choices.find((c) => volume && c.volume === volume) ?? choices[0])?.key ?? '';
}
