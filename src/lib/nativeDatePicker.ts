export function showDatePicker(input: HTMLInputElement): void {
  try {
    input.showPicker();
  } catch {
    input.focus();
  }
}
