import type { ErrorInfo } from '../core/errors.ts';
import type { Texts } from './texts.ts';

// A failed request, with the server's error code for translating it.
export class ApiError extends Error {
  info: ErrorInfo;
  constructor(info: ErrorInfo) {
    super(info.message);
    this.info = info;
  }
}

// The error in the interface language; errors without a known code keep the server's English text.
export function errorText(t: Texts, e: ApiError | ErrorInfo | unknown): string {
  const info: ErrorInfo = e instanceof ApiError ? e.info : e instanceof Error ? { message: e.message } : (e as ErrorInfo);
  const text = info.code && (t.errors[info.code] as ((p: unknown) => string) | undefined);
  return text ? text(info.params) : info.message;
}
