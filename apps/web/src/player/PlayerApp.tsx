import { useGame } from '../useGame';
import { RegistrationScreen } from './RegistrationScreen';
import { ClaimBadgeScreen } from './ClaimBadgeScreen';
import { GameplayScreen } from './GameplayScreen';

export function PlayerApp() {
  const { socket, state } = useGame('player');
  const ownPlayer = state.ownPlayer;

  if (!ownPlayer?.teamId) {
    return <RegistrationScreen socket={socket} teams={state.teams} initialName={ownPlayer?.playerName ?? ''} />;
  }

  // qrCodeClaimed is authoritative server state, not a local flag - it's set true only
  // once player:claimQr actually succeeds, so a refresh/reconnect always shows the right
  // screen without relying on anything cached client-side.
  if (!ownPlayer.qrCodeClaimed) {
    return <ClaimBadgeScreen socket={socket} />;
  }

  return <GameplayScreen socket={socket} state={state} />;
}
