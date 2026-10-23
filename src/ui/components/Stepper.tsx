import { CheckIcon } from './icons.tsx';

// Progress through the steps of a guided flow (update, restore); skipped steps show a dash instead of a tick.
export function Stepper({
  current,
  steps,
  label: listLabel,
  skipped = [],
}: {
  current: number;
  steps: string[];
  label: string;
  skipped?: number[];
}) {
  return (
    <ol aria-label={listLabel} className="m-0 grid list-none gap-2 p-0" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((label, i) => {
        const skip = i < current && skipped.includes(i);
        const done = i < current && !skip;
        const now = i === current;
        return (
          <li key={label} aria-current={now ? 'step' : undefined} className="flex flex-col gap-2">
            <span className={`h-1 rounded-full ${done || now ? 'bg-accent' : 'bg-border'}`} aria-hidden="true" />
            <span className={`flex items-center gap-2 text-sm ${now ? 'font-semibold' : ''} ${done || now ? '' : 'text-muted'}`}>
              <span
                className={`inline-flex size-[22px] items-center justify-center rounded-full text-xs font-semibold ${
                  done || now ? 'bg-accent text-accent-foreground' : 'bg-surface-secondary text-muted'
                }`}
              >
                {done ? <CheckIcon size={13} /> : skip ? '–' : i + 1}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
