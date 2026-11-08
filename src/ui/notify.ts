import { toast } from '@heroui/react';

// Short messages after an action, as toasts that close by themselves or with their close button; an error
// stays longer, so its text can be read. Pointing at a toast pauses its countdown.
export type Notice = { status: 'success' | 'danger' | 'default'; title: string; text?: string };

export function notify({ status, title, text }: Notice): void {
  toast(title, { variant: status, timeout: status === 'danger' ? 8000 : 4000, ...(text ? { description: text } : {}) });
}
