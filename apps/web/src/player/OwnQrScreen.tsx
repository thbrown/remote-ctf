import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';
// @ts-expect-error -- vite ?url import, no types
import QrScannerWorkerPath from 'qr-scanner/qr-scanner-worker.min.js?url';
import QRCode from 'qrcode';
import { encodePlQr } from '@foundry-ctf/shared';

QrScanner.WORKER_PATH = QrScannerWorkerPath;

/** One-time onboarding gate shown right after registration: displays the player's own QR
 * (their `qrCodeToken`, the same code others scan to tag them) and requires scanning it
 * before gameplay starts. This is the first point camera permission is requested for
 * gameplay, so it doubles as a "does your camera actually work" check up front, and
 * makes sure every player has actually seen/located their own code before playing. */
export function OwnQrScreen({ qrCodeToken, onConfirmed }: { qrCodeToken: string; onConfirmed: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const expected = encodePlQr(qrCodeToken);

  useEffect(() => {
    QRCode.toDataURL(expected, { margin: 1, width: 240 })
      .then(setQrImage)
      .catch((err) => console.error('own QR render failed', err));
  }, [expected]);

  useEffect(() => {
    if (!videoRef.current) return;
    const scanner = new QrScanner(
      videoRef.current,
      (result) => {
        if (result.data === expected) {
          scanner.stop();
          onConfirmed();
        } else {
          setMismatch(true);
        }
      },
      { highlightScanRegion: true, maxScansPerSecond: 8 },
    );
    scannerRef.current = scanner;
    scanner.start().catch((err) => console.error('camera start failed', err));
    return () => {
      scanner.stop();
      scanner.destroy();
      scannerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expected]);

  return (
    <div className="own-qr-screen">
      <h2>Almost there</h2>
      <p>Scan your own code below to confirm your camera works. It's the same code other players scan to tag you.</p>
      {qrImage && <img className="own-qr-code" src={qrImage} alt="Your player QR code" />}
      <div className="own-qr-camera">
        <video ref={videoRef} muted playsInline autoPlay />
      </div>
      {mismatch && <div className="form-error">That's a different code — scan the one shown above.</div>}
    </div>
  );
}
