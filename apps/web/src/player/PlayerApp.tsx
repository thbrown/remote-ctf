import { useGame } from '../useGame';
import { RegistrationScreen } from './RegistrationScreen';
import { GameplayScreen } from './GameplayScreen';

export function PlayerApp() {
  const { socket, state } = useGame('player');
  const ownPlayer = state.ownPlayer;

  if (!ownPlayer?.teamId) {
    return <RegistrationScreen socket={socket} teams={state.teams} initialName={ownPlayer?.playerName ?? ''} />;
  }

  return <GameplayScreen socket={socket} state={state} />;
}
