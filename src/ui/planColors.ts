import type { Action } from '../server/api.ts';

// Colours of the file actions in the update and restore plans.
export const COLORS: Record<Exclude<Action, 'unchanged'>, 'success' | 'accent' | 'danger' | 'warning'> = {
  add: 'success',
  replace: 'accent',
  delete: 'danger',
  conflict: 'warning',
};

// Full class names, so Tailwind finds them.
export const TILES: Record<Exclude<Action, 'unchanged'>, string> = {
  add: 'bg-success-soft text-success-soft-foreground',
  replace: 'bg-accent-soft text-accent-soft-foreground',
  delete: 'bg-danger-soft text-danger-soft-foreground',
  conflict: 'bg-warning-soft text-warning-soft-foreground',
};
