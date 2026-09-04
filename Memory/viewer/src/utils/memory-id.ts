export function displayMemoryId(id: string): string {
  const separatorIndex = id.indexOf("::");
  return separatorIndex > 0 ? id.slice(separatorIndex + 2) : id;
}
