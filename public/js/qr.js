// Renders a QR code with the vendored qrcodejs library (global `QRCode`, loaded by index.html).

export function renderQr(container, text) {
  container.replaceChildren();
  const QR = globalThis.QRCode;
  if (typeof QR !== 'function') return; // library missing: the link and key are still shown
  new QR(container, {
    text,
    width: 200,
    height: 200,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QR.CorrectLevel.M,
  });
}
