/**
 * Example module. Replace with real code; keep the pattern: typed, validated, tested.
 */
export function greet(name: string): string {
  const cleaned = name.trim();
  if (cleaned === "") {
    throw new Error("name must not be empty");
  }
  return `Hello, ${cleaned}!`;
}
