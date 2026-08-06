import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';
// @ts-expect-error -- vite ?url import, no types
import QrScannerWorkerPath from 'qr-scanner/qr-scanner-worker.min.js?url';
import type { Socket } from 'socket.io-client';

QrScanner.WORKER_PATH = QrScannerWorkerPath;

const ERROR_MESSAGES: Record<string, string> = {
  unknown_qr: "That's not a valid QR code — try another.",
  wrong_qr_kind: "That's a Control Point or Respawn Location code, not a player badge — scan a player badge instead.",
  already_claimed: 'Someone already claimed that badge — grab a different one.',
  invalid_payload: 'Could not read that code — try again.',
};

/** Onboarding: players claim a pre-printed physical badge (a `pl`-kind QR minted
 * independently of any player, e.g. a wristband handed out before the game) by scanning
 * it once. Whatever token they scan becomes their qrCodeToken - the same code other
 * players scan on their badge to tag them. This is also the first point camera
 * permission is requested, so it doubles as a "does your camera work" check.
 *
 * When used for initial onboarding (no onClaimed passed) a successful claim just sets
 * qrCodeClaimed on the server, which arrives back as a qrCtfPlayer patch and flips
 * PlayerApp over to GameplayScreen on its own. When used to change an already-claimed
 * badge (e.g. from GameplayScreen's profile editor) qrCodeClaimed is already true, so
 * nothing flips automatically - callers pass onClaimed to know when to close the scanner. */
export function ClaimBadgeScreen({
  socket,
  title = 'Claim your badge',
  description = "Scan the QR code on the badge/wristband you were handed — it's what other players will scan to tag you.",
  onClaimed,
}: {
  socket: Socket;
  title?: string;
  description?: string;
  onClaimed?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const claimingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    const scanner = new QrScanner(
      videoRef.current,
      (result) => {
        if (claimingRef.current) return;
        claimingRef.current = true;
        setError(null);
        socket.emit('player:claimQr', { raw: result.data }, (ack: any) => {
          if (ack?.ok) {
            scanner.stop();
            onClaimed?.();
          } else {
            claimingRef.current = false;
            setError(ERROR_MESSAGES[ack?.error] ?? 'Could not claim that badge — try again.');
          }
        });
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
  }, [socket]);

  return (
    <div className="own-qr-screen">
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="own-qr-camera">
        <video ref={videoRef} muted playsInline autoPlay />
      </div>
      {error && <div className="form-error">{error}</div>}
    </div>
  );
}
