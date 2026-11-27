export function downloadManagementPowerPoint(base64: string, fileName: string) {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const href = URL.createObjectURL(new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }));
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}
