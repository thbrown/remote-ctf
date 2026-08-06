import { useState } from 'react';
import type { QrCtfTeam } from '@foundry-ctf/shared';
import type { Socket } from 'socket.io-client';
import { downscalePhoto } from './photo';

/** Registration happens before gameplay starts, so it doesn't need camera-stream or
 * geolocation permissions - those are requested later by GameplayScreen, once there's
 * an actual reason to ask for them. A photo, if the player adds one, is a one-shot
 * file/camera picker rather than a live video permission grant. */
export function RegistrationScreen({
  socket,
  teams,
  initialName,
}: {
  socket: Socket;
  teams: QrCtfTeam[];
  initialName: string;
}) {
  const [nameInput, setNameInput] = useState(initialName);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const base64 = await downscalePhoto(file);
      setPhotoBase64(base64);
      setPhotoPreview(`data:image/jpeg;base64,${base64}`);
    } catch (err) {
      console.error('photo processing failed', err);
      setError('Could not use that photo — try a different one.');
    }
  }

  function joinTeam(teamId: string) {
    setJoining(teamId);
    socket.emit('player:update', {
      playerName: nameInput.trim() || undefined,
      teamId,
      ...(photoBase64 ? { profilePicture: photoBase64 } : {}),
    });
  }

  return (
    <div className="registration-screen">
      <h2>Join the game</h2>

      <label className="field">
        Name
        <input
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          placeholder="Your name"
          maxLength={40}
        />
      </label>

      <label className="field photo-field">
        Photo (optional)
        <input type="file" accept="image/*" capture="user" onChange={handlePhotoChange} />
      </label>
      {photoPreview && <img className="photo-preview" src={photoPreview} alt="Your selected" />}
      {error && <div className="form-error">{error}</div>}

      <h3>Choose your team</h3>
      <div className="team-picker">
        {teams.map((t) => (
          <button
            key={t.teamId}
            style={{ background: t.hexColor }}
            disabled={joining !== null}
            onClick={() => joinTeam(t.teamId)}
          >
            {joining === t.teamId ? 'Joining…' : t.teamName}
          </button>
        ))}
      </div>
    </div>
  );
}
