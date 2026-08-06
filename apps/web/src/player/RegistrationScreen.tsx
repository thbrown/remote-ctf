import { useState } from 'react';
import type { QrCtfTeam } from '@foundry-ctf/shared';
import type { Socket } from 'socket.io-client';
import { downscalePhoto } from './photo';

/** Registration happens before gameplay starts, so it doesn't need camera-stream or
 * geolocation permissions - those are requested later by GameplayScreen, once there's
 * an actual reason to ask for them. A photo, if the player adds one, is a one-shot
 * file/camera picker rather than a live video permission grant.
 *
 * Team selection here only picks a team locally - it does NOT submit anything by
 * itself, so a player can still fill in their name/photo afterward. Submission (and the
 * transition away from this screen once the server confirms it) happens on the explicit
 * "Join game" button. */
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
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  function submit() {
    if (!nameInput.trim() || !selectedTeamId || submitting) return;
    setSubmitting(true);
    socket.emit('player:update', {
      playerName: nameInput.trim(),
      teamId: selectedTeamId,
      ...(photoBase64 ? { profilePicture: photoBase64 } : {}),
    });
  }

  const canSubmit = nameInput.trim().length > 0 && selectedTeamId !== null && !submitting;

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
            style={{ background: t.hexColor, outline: selectedTeamId === t.teamId ? '3px solid white' : 'none' }}
            disabled={submitting}
            onClick={() => setSelectedTeamId(t.teamId)}
          >
            {t.teamName}
            {selectedTeamId === t.teamId ? ' ✓' : ''}
          </button>
        ))}
      </div>

      <button disabled={!canSubmit} onClick={submit}>
        {submitting ? 'Joining…' : 'Join game'}
      </button>
    </div>
  );
}
