export type ContainerLookupFn<T> = (code: string) => Promise<T>;

export interface ContainerLookupCallbacks<T> {
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  onResolved: (result: T, normalizedCode: string) => void;
}

export async function submitContainerCode<T>(
  inputCode: string,
  lookup: ContainerLookupFn<T>,
  callbacks: ContainerLookupCallbacks<T>,
  formatError: (error: unknown) => string,
): Promise<void> {
  callbacks.setBusy(true);
  callbacks.setError(null);

  try {
    const normalizedCode = inputCode.trim();
    if (!normalizedCode) {
      callbacks.setError('Vui lòng nhập mã can.');
      return;
    }

    const result = await lookup(normalizedCode);
    callbacks.onResolved(result, normalizedCode);
  } catch (error) {
    callbacks.setError(formatError(error));
  } finally {
    callbacks.setBusy(false);
  }
}
