// The dashboard greeting, from the hour on the user's own clock (0-23).
//   05-11 morning, 12-17 afternoon, 18-21 evening, 22-04 night
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  if (hour >= 18 && hour < 22) return "Good evening";
  return "Good night";
}

// The first word of the user's name, if there is a usable one.
export function firstName(name: string | null | undefined): string | null {
  const word = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return word === "" ? null : word.slice(0, 40);
}

// `time` is the user's local "HH:MM".
export function greetingLine(time: string, name: string | null | undefined): string {
  const parsed = Number(time.slice(0, 2));
  const greeting = greetingFor(Number.isFinite(parsed) ? parsed : 12);
  const first = firstName(name);
  return first ? `${greeting}, ${first}` : greeting;
}
