import { useEffect, useState } from 'react';
import { useGame } from '../useGame';
import { hasCompletedOnboarding, markOnboardingComplete } from '../socket';
import { RegistrationScreen } from './RegistrationScreen';
import { OwnQrScreen } from './OwnQrScreen';
import { GameplayScreen } from './GameplayScreen';

export function PlayerApp() {
  const { socket, state } = useGame('player');
  const ownPlayer = state.ownPlayer;
  const [onboarded, setOnboarded] = useState(false);

  useEffect(() => {
    if (ownPlayer?.playerId) setOnboarded(hasCompletedOnboarding(ownPlayer.playerId));
  }, [ownPlayer?.playerId]);

  if (!ownPlayer?.teamId) {
    return <RegistrationScreen socket={socket} teams={state.teams} initialName={ownPlayer?.playerName ?? ''} />;
  }

  if (!onboarded) {
    return (
      <OwnQrScreen
        qrCodeToken={ownPlayer.qrCodeToken}
        onConfirmed={() => {
          markOnboardingComplete(ownPlayer.playerId);
          setOnboarded(true);
        }}
      />
    );
  }

  return <GameplayScreen socket={socket} state={state} />;
}
