/** Keep both the machine name and its distinguishing suffix visible in compact controls. */
export function environmentShortLabel(label: string, maxLength = 32): string {
  const text = label.trim();
  if (text.length <= maxLength) return text;
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${text.slice(0, maxLength - tailLength - 1).trimEnd()}…${text.slice(-tailLength).trimStart()}`;
}
