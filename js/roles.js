export const ROLES = {
  MAFIA: {
    id: 'mafia',
    name: 'Mafia',
    team: 'mafia',
    description: 'You are the Mafia. Every night, you choose a player to eliminate. Blend in during the day and survive to win.',
    icon: '🔪',
  },
  DOCTOR: {
    id: 'doctor',
    name: 'Doctor',
    team: 'village',
    description: 'You are the Doctor. Every night, you can choose one player to protect from elimination.',
    icon: '⚕️',
  },
  INVESTIGATOR: {
    id: 'investigator',
    name: 'Investigator',
    team: 'village',
    description: 'You are the Investigator. Every night, you can choose one player to investigate and learn their alignment.',
    icon: '🔍',
  },
  VILLAGER: {
    id: 'villager',
    name: 'Villager',
    team: 'village',
    description: 'You are a Villager. You have no special abilities at night. Use the day phase to find the Mafia and vote them out.',
    icon: '🌾',
  }
};
