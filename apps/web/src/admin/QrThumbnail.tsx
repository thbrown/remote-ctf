import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function QrThumbnail({ value, size = 96 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { margin: 1, width: size })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch((err) => console.error('qr render failed', err));
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!src) return null;
  return <img className="qr-thumbnail" src={src} width={size} height={size} alt="QR code" />;
}
