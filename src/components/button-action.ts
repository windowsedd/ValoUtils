/** Cancellation uses an empty rejection; real failures need visible feedback. */
export async function runButtonAction(
  action: () => unknown,
  reportError: (message: string) => void,
  fallback: string,
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error: unknown) {
    if (error != null) {
      const response = (error as { response?: { data?: { message?: unknown } } }).response;
      const message = response?.data?.message ?? (error instanceof Error ? error.message : error);
      reportError(typeof message === "string" && message.trim() ? message : fallback);
    }
    return false;
  }
}
