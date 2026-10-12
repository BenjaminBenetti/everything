import type { AgentAvatarId } from "@everything/agent-contracts/avatar";
import type { AvatarEye } from "../interface/avatar-animation.js";

/** Cover the eye's edge pixels as well as its pupil during the closed frame. */
function eye(
  x: number,
  y: number,
  width: number,
  height: number,
  lid: string,
): AvatarEye {
  return { x: x - 1, y: y - 1, width: width + 2, height: height + 2, lid };
}

/** Artist-aligned eye regions; coordinates refer to the bundled 128 × 128 images. */
export const avatarIdleEyes = {
  // Cat
  "avatar-01": [eye(53, 47, 6, 8, "#f78b32"), eye(78, 49, 7, 9, "#f78b32")],
  // Corgi
  "avatar-02": [eye(52, 55, 7, 9, "#f9a647"), eye(76, 57, 7, 9, "#f8a647")],
  // Fox
  "avatar-03": [eye(36, 53, 7, 9, "#e5672a"), eye(58, 56, 7, 9, "#e6682a")],
  // Rabbit
  "avatar-04": [eye(52, 63, 6, 9, "#b4a3bc"), eye(76, 63, 6, 9, "#b4a4bc")],
  // Panda
  "avatar-05": [eye(43, 43, 11, 16, "#3c2e3d"), eye(73, 43, 11, 16, "#3c2e3d")],
  // Red panda
  "avatar-06": [eye(39, 45, 8, 8, "#c7572b"), eye(63, 48, 7, 8, "#c9572d")],
  // Koala
  "avatar-07": [eye(45, 51, 8, 10, "#aba3a5"), eye(76, 51, 8, 10, "#aca4a6")],
  // Brown bear
  "avatar-08": [eye(44, 41, 8, 9, "#985135"), eye(78, 41, 7, 9, "#985236")],
  // Polar bear
  "avatar-09": [eye(40, 44, 8, 9, "#fbf9ee"), eye(68, 47, 8, 9, "#fbf9ef")],
  // Otter
  "avatar-10": [eye(41, 32, 7, 9, "#87503b"), eye(71, 32, 8, 9, "#85503b")],
  // Capybara
  "avatar-11": [eye(64, 34, 8, 8, "#ce8f5f"), eye(100, 34, 4, 6, "#ce8f5f")],
  // Hedgehog
  "avatar-12": [eye(52, 61, 8, 8, "#faebd5"), eye(83, 61, 7, 8, "#faebd4")],
  // Raccoon
  "avatar-13": [eye(49, 47, 10, 10, "#292729"), eye(75, 51, 10, 10, "#292729")],
  // Squirrel
  "avatar-14": [eye(70, 54, 7, 9, "#fbe4bf"), eye(94, 54, 6, 9, "#fce4c2")],
  // Hamster
  "avatar-15": [eye(42, 43, 10, 10, "#e59f42"), eye(77, 43, 9, 10, "#e6a045")],
  // Mouse
  "avatar-16": [eye(57, 54, 7, 9, "#8a8792"), eye(83, 50, 7, 9, "#8c8793")],
  // Deer
  "avatar-17": [eye(42, 46, 6, 9, "#fce1bc"), eye(66, 49, 7, 9, "#fbe1bb")],
  // Sheep
  "avatar-18": [eye(37, 53, 7, 9, "#797280"), eye(63, 56, 7, 8, "#7a7480")],
  // Alpaca
  "avatar-19": [eye(41, 39, 6, 6, "#faead0"), eye(61, 39, 6, 7, "#faebcf")],
  // Pig
  "avatar-20": [eye(34, 44, 9, 10, "#fcbabc"), eye(70, 48, 9, 10, "#fcb9bb")],
  // Cow
  "avatar-21": [eye(52, 45, 8, 9, "#fcefd9"), eye(79, 51, 8, 8, "#2d272f")],
  // Frog
  "avatar-22": [eye(33, 25, 18, 20, "#a9e394"), eye(78, 25, 18, 20, "#a9e394")],
  // Turtle
  "avatar-23": [eye(21, 47, 8, 9, "#9eb255"), eye(48, 50, 8, 10, "#9eb153")],
  // Penguin
  "avatar-24": [eye(45, 49, 8, 9, "#f8edd7"), eye(77, 51, 8, 8, "#f8edd8")],
  // Duck
  "avatar-25": [eye(38, 40, 9, 10, "#fcdc3d"), eye(72, 43, 10, 10, "#fcdc3e")],
  // Owl
  "avatar-26": [eye(43, 45, 11, 13, "#fbf0d8"), eye(74, 48, 12, 13, "#fcf0d9")],
  // Chick
  "avatar-27": [eye(43, 49, 10, 11, "#fbda52"), eye(73, 52, 10, 11, "#ffda52")],
  // Parrot
  "avatar-28": [eye(57, 48, 9, 12, "#eff692"), eye(87, 43, 6, 10, "#eff793")],
  // Axolotl
  "avatar-29": [eye(35, 58, 10, 11, "#fbcbd4"), eye(71, 60, 10, 12, "#fbcbd4")],
  // Seal
  "avatar-30": [eye(33, 47, 8, 8, "#cecdcf"), eye(65, 50, 8, 8, "#cfced0")],
  // Whale
  "avatar-31": [eye(24, 70, 7, 7, "#74c8f9"), eye(60, 70, 7, 8, "#71c8f8")],
  // Octopus
  "avatar-32": [eye(43, 56, 11, 12, "#c5a0f6"), eye(75, 56, 11, 12, "#c5a0f8")],
  // Dragon
  "avatar-33": [eye(31, 40, 13, 17, "#8cd795"), eye(59, 44, 16, 18, "#8dd795")],
  // Dinosaur
  "avatar-34": [eye(25, 39, 11, 17, "#38baae"), eye(57, 44, 15, 20, "#38baae")],
  // Ghost
  "avatar-35": [eye(40, 44, 11, 14, "#ebe4fb"), eye(70, 49, 11, 14, "#ebe4fb")],
  // Slime
  "avatar-36": [eye(33, 69, 18, 19, "#abf4b5"), eye(77, 69, 19, 19, "#abf6b5")],
  // Mushroom
  "avatar-37": [eye(48, 80, 7, 10, "#f9ebd3"), eye(72, 80, 7, 10, "#faebd3")],
  // Sprout
  "avatar-38": [eye(49, 87, 8, 12, "#bd794a"), eye(72, 90, 9, 11, "#c07b4c")],
  // Cactus
  "avatar-39": [eye(45, 47, 10, 11, "#7fc142"), eye(74, 47, 9, 11, "#7fc144")],
  // Sunflower
  "avatar-40": [eye(45, 60, 10, 11, "#b06639"), eye(73, 60, 10, 11, "#b1663a")],
  // Robot
  "avatar-41": [eye(45, 48, 11, 13, "#72cefa"), eye(73, 48, 11, 13, "#74cffb")],
  // Astronaut
  "avatar-42": [eye(50, 47, 6, 9, "#fcba8f"), eye(72, 47, 7, 9, "#fbb98d")],
  // Alien
  "avatar-43": [eye(36, 56, 21, 22, "#abeba5"), eye(71, 56, 22, 22, "#abeba5")],
  // Star
  "avatar-44": [eye(43, 60, 10, 12, "#fad02f"), eye(75, 60, 11, 12, "#fbd02f")],
  // Moon
  "avatar-45": [eye(60, 70, 13, 15, "#fce391")],
  // Sun
  "avatar-46": [eye(43, 58, 11, 13, "#fbba16"), eye(74, 58, 12, 13, "#fbb815")],
  // Cloud
  "avatar-47": [eye(41, 60, 11, 13, "#d7effc"), eye(78, 60, 12, 13, "#d6eefb")],
  // Rainbow
  "avatar-48": [eye(50, 71, 7, 9, "#7ac0fb"), eye(72, 71, 7, 9, "#79bffb")],
  // Peach
  "avatar-49": [eye(35, 67, 11, 14, "#fbcd90"), eye(70, 72, 12, 14, "#fba67c")],
  // Strawberry
  "avatar-50": [eye(43, 61, 11, 15, "#fb2730"), eye(75, 64, 12, 14, "#fb272f")],
  // Avocado
  "avatar-51": [eye(51, 38, 10, 13, "#f1f4a0"), eye(78, 38, 9, 13, "#f1f4a0")],
  // Pineapple
  "avatar-52": [eye(43, 77, 9, 12, "#fcd330"), eye(68, 78, 10, 13, "#fcd32e")],
  // Cherry
  "avatar-53": [eye(31, 80, 8, 11, "#c00924"), eye(56, 82, 8, 10, "#c10824")],
  // Lemon
  "avatar-54": [eye(38, 62, 11, 12, "#fbd50f"), eye(68, 65, 12, 13, "#fcd60f")],
  // Cupcake
  "avatar-55": [eye(47, 89, 9, 10, "#fbc5a0"), eye(72, 89, 9, 10, "#fbc39d")],
  // Doughnut
  "avatar-56": [eye(44, 29, 11, 12, "#fb91c4"), eye(74, 29, 10, 12, "#fb90c3")],
  // Coffee cup
  "avatar-57": [eye(38, 67, 11, 14, "#f9ecd9"), eye(70, 70, 11, 14, "#f9ecd9")],
  // Teapot
  "avatar-58": [eye(47, 72, 8, 9, "#fcf2e1"), eye(73, 73, 8, 10, "#fcf2e1")],
  // Dumpling
  "avatar-59": [eye(39, 73, 11, 13, "#fbecd8"), eye(76, 74, 11, 14, "#faecd6")],
  // Toast
  "avatar-60": [eye(40, 59, 10, 13, "#fae6c3"), eye(74, 61, 11, 12, "#fbe7c1")],
  // Ice cream
  "avatar-61": [eye(46, 40, 9, 10, "#faf0de"), eye(75, 40, 9, 10, "#faf1dd")],
  // Sushi
  "avatar-62": [eye(40, 67, 8, 10, "#faf5ec"), eye(70, 70, 8, 10, "#fbf4ed")],
  // Book
  "avatar-63": [eye(53, 59, 11, 13, "#9e2b32"), eye(82, 56, 11, 14, "#a32e34")],
  // Potion
  "avatar-64": [eye(52, 81, 9, 11, "#0093fb"), eye(80, 81, 7, 9, "#0092fa")],
} satisfies Record<AgentAvatarId, readonly AvatarEye[]>;
