// Links the app hands to the system to open: only web pages, which open in the browser. Any other scheme
// (file:, smb:, ms-msdt:, search-ms: ...) would let a page in the window open files or start programs
// on this computer.
export function isWebLink(url: string): boolean {
  const protocol = URL.parse(url)?.protocol;
  return protocol === 'https:' || protocol === 'http:';
}

// Whether a navigation stays on the app's own page: the same origin, not just the same beginning
// (http://localhost:1234@example.com starts like http://localhost:1234 but leads to example.com).
export function isOwnPage(url: string, own: string): boolean {
  const origin = URL.parse(url)?.origin;
  return !!origin && origin !== 'null' && origin === URL.parse(own)?.origin;
}
