export function displayMemoryId(id: string): string {
  const separator = "::";
  const index = id.indexOf(separator);
  return index > 0 ? id.slice(index + separator.length) : id;
}
