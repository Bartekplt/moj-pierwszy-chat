export function toolResult<T extends object>(data: T, now = new Date()) {
  return { ...data, pobrano: now.toISOString() };
}

export function toolFailure(blad: string) {
  return toolResult({ blad });
}
