import {
  agentAvatarIds,
  defaultAgentAvatarId,
  type AgentAvatarId,
} from "@everything/agent-contracts/avatar";

/** Names describe the artwork while stable IDs remain independent of future animation states. */
const avatarNames = [
  "Cat",
  "Corgi",
  "Fox",
  "Rabbit",
  "Panda",
  "Red panda",
  "Koala",
  "Brown bear",
  "Polar bear",
  "Otter",
  "Capybara",
  "Hedgehog",
  "Raccoon",
  "Squirrel",
  "Hamster",
  "Mouse",
  "Deer",
  "Sheep",
  "Alpaca",
  "Pig",
  "Cow",
  "Frog",
  "Turtle",
  "Penguin",
  "Duck",
  "Owl",
  "Chick",
  "Parrot",
  "Axolotl",
  "Seal",
  "Whale",
  "Octopus",
  "Dragon",
  "Dinosaur",
  "Ghost",
  "Slime",
  "Mushroom",
  "Sprout",
  "Cactus",
  "Sunflower",
  "Robot",
  "Astronaut",
  "Alien",
  "Star",
  "Moon",
  "Sun",
  "Cloud",
  "Rainbow",
  "Peach",
  "Strawberry",
  "Avocado",
  "Pineapple",
  "Cherry",
  "Lemon",
  "Cupcake",
  "Doughnut",
  "Coffee cup",
  "Teapot",
  "Dumpling",
  "Toast",
  "Ice cream",
  "Sushi",
  "Book",
  "Potion",
] as const;

/** Picker groups are presentation metadata, not persisted teammate state. */
export const avatarCategories = [
  { id: "animals", label: "Animals" },
  { id: "creatures", label: "Creatures" },
  { id: "objects", label: "Objects" },
] as const;

/** One public catalog supplies the picker, cards, details, and sidebar. */
export const teammateAvatars = agentAvatarIds.map((id, index) => ({
  id,
  name: avatarNames[index]!,
  category: index < 32 ? "animals" : index < 48 ? "creatures" : "objects",
  src: `/teammate-avatars/${id}.webp`,
}));

/** Pick an initial avatar for a new teammate with equal probability across the catalog. */
export function randomTeammateAvatarId(): AgentAvatarId {
  return agentAvatarIds[Math.floor(Math.random() * agentAvatarIds.length)]!;
}

/** Resolve a safe bundled image even if a stale client has no saved avatar selection. */
export function teammateAvatar(avatarId: AgentAvatarId = defaultAgentAvatarId) {
  return (
    teammateAvatars.find((avatar) => avatar.id === avatarId) ??
    teammateAvatars[0]!
  );
}
