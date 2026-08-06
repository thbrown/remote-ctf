import { useEffect, useRef } from 'react';
import QrScanner from 'qr-scanner';
// @ts-expect-error -- vite ?url import, no types
import QrScannerWorkerPath from 'qr-scanner/qr-scanner-worker.min.js?url';

QrScanner.WORKER_PATH = QrScannerWorkerPath;

/** Generic one-shot QR scanner for Admin actions (registering a Control Point or Respawn
 * Point by scanning its physical QR code instead of typing a MAC/ID by hand). Fires onScan
 * once per open and stops itself - callers decide what to do with the raw string
 * (parseQr + kind-check) and whether to reopen for a retry. */
export function AdminQrScanner({ title, onScan, onCancel }: { title: string; onScan: (raw: string) => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const firedRef = useRef(false);

  useEffect(() => {
    if (!videoRef.current) return;
    const scanner = new QrScanner(
      videoRef.current,
      (result) => {
        if (firedRef.current) return;
        firedRef.current = true;
        scanner.stop();
        onScanRef.current(result.data);
      },
      { highlightScanRegion: true, maxScansPerSecond: 8 },
    );
    scanner.start().catch((err) => console.error('camera start failed', err));
    return () => {
      scanner.stop();
      scanner.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="own-qr-screen">
      <h2>{title}</h2>
      <div className="own-qr-camera">
        <video ref={videoRef} muted playsInline autoPlay />
      </div>
      <button onClick={onCancel}>Cancel</button>
    </div>
  );
}
