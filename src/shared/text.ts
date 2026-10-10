/** Plain sentence shown when something is being used by an open app. */
export function inUseText(names: string[]): string {
  const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  const one = names.length === 1;
  return `${list} ${one ? 'is' : 'are'} using this right now. Quit ${one ? 'it' : 'them'}, then press Re-check.`;
}
