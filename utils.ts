declare const IS_PROD: boolean;

export function debug(...args: unknown[]): void {
  if (!IS_PROD) {
    console.log(...args);
  }
}
