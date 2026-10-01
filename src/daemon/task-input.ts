/** Shared executor inputs. Requirements and verification rules are never inferred from names. */
export function taskContext(files: Record<string, string>): string {
  const text = Object.entries(files).map(([name, content]) => `File: ${name}\n${content}`).join('\n\n');
  if (text.length > 200_000) throw new Error('Task inputs exceed the 200,000 character context limit. Provide a smaller task.');
  return text;
}

export function protectedTaskFiles(files: Record<string, string>, explicit: string[] = []): string[] {
  const pattern = /(^|\/)(tests?|spec)\/|(^|\/)[^/]*\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)(tests?|spec)\.[A-Za-z0-9]+$|(^|\/)package\.json$/i;
  return [...new Set([...Object.keys(files).filter(name => pattern.test(name)), ...explicit])].filter(name => name in files);
}
