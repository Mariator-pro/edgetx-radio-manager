// EdgeTX uses some non-standard folder names for languages.
const LANG_ALIAS: Record<string, string> = { cn: 'zh', cz: 'cs', jp: 'ja', se: 'sv', ua: 'uk', gr: 'el' };

// "de" -> "Deutsch" / "German", in the interface language.
export function languageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: 'language' }).of(LANG_ALIAS[code] ?? code);
    return name && name !== code ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : code;
  } catch {
    return code;
  }
}

export function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}

export function dateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function date(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });
}

// Backup folder "2026-10-21_1430" or "2026-10-21_1430_2" as "2026-10-21 14:30".
export function backupLabel(name: string): string {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(?:_(\d+))?$/);
  return m ? `${m[1]} ${m[2]}:${m[3]}${m[4] ? ` (${m[4]})` : ''}` : name;
}
