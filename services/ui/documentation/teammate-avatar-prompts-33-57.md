# Teammate avatar generation: 33–57

These static avatars were generated individually with the built-in `image_gen__imagegen` tool on 2026-10-11. No CLI fallback or code-drawn substitute artwork was used.

Each call used `transparent_background: true` and omitted reference-image arguments. The exact prompt is the template below with `{{subject}}` replaced by its literal subject-table value. Every subject received one distinct generation call; there were no retries or discarded variants.

The original PNGs remain at the tool-generated source paths listed below. They were copied into `services/ui/public/teammate-avatars/avatar-NN.png` for review and packaging. The application uses the corresponding `avatar-NN.webp` assets after a shared 128 × 128 web-asset optimization step that preserves transparency. These are single static frames; animation is not included.

## Exact prompt template

```text
Use case: stylized-concept
Asset type: static teammate avatar PNG for a web application, first frame ready for possible future animation.
Primary request: {{subject}}. One character only.
Scene/backdrop: genuinely transparent background with preserved alpha, no floor or environment.
Style/medium: carefully crafted 2D pixel-art sprite, chunky crisp square pixels on an apparent 32–48 pixel grid, no anti-aliasing, no gradients, no smooth vector curves, no 3D; a compact limited color palette, dark pixel outline and restrained one-step pixel shading.
Composition/framing: square canvas, full character centered, simple frontal or slight three-quarter pose, bold readable silhouette filling about 80% of the canvas with even clear padding; immediately recognizable and charming at 24, 48 and 64 pixels. No pedestal or surrounding scenery.
Mood: cute, calm and welcoming; polished cohesive collectible avatar style.
Constraints: static image only; no text, letters, numbers, watermark, logo, drop shadow, border, card, checkerboard pattern, extra characters or decorative surrounding objects. The image itself must have a transparent background.
```

## Subject replacements

| Number | Subject        | Exact replacement                                                                                                                                                 |
| ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 33     | dragon         | one adorable tiny baby dragon character with a friendly expressive face, mint-green scales, a soft yellow belly, two small horns, and tiny folded wings           |
| 34     | dinosaur       | a cheerful tiny teal baby dinosaur with a round head, short tail, little peach back spikes and an expressive friendly face                                        |
| 35     | ghost          | a tiny friendly pale lavender ghost with a rounded head, two simple dark eyes, rosy cheeks, a tiny smile and a wavy hem                                           |
| 36     | slime          | a tiny round mint-green slime creature with simple shiny dark eyes, a little smile and a soft square-pixel gleam                                                  |
| 37     | mushroom       | a tiny mushroom character with a terracotta-red cap, a few cream spots, a short cream stem and a sweet simple expressive face                                     |
| 38     | sprout         | a tiny cheerful leafy sprout character with two broad green leaves, a small pale-green stem and a compact warm-brown soil base with a simple expressive face      |
| 39     | cactus         | a tiny rounded green cactus character with two small arms, subtle pixel spines, a simple expressive face and a compact terracotta pot                             |
| 40     | sunflower      | a tiny golden sunflower character with a warm-brown round face, simple happy eyes, chunky yellow petals and two small green leaves                                |
| 41     | robot          | a tiny friendly retro robot with a rounded-square sky-blue metal head, two dark pixel eyes, a tiny smile, a short antenna and a compact simple body               |
| 42     | tiny astronaut | a tiny friendly astronaut in a compact white space suit with a warm peach face visible through a blue-tinted helmet visor                                         |
| 43     | alien          | a tiny cute mint-green alien with a rounded pear-shaped head, big dark friendly eyes, a small smile and a compact simple body                                     |
| 44     | star           | a tiny golden five-point star character with two dark happy pixel eyes, rosy cheeks and a tiny smile                                                              |
| 45     | moon           | a tiny sleepy pale-gold crescent moon character with one little friendly eye, a rosy cheek and a gentle smile                                                     |
| 46     | sun            | a tiny golden sun character with a round orange face, friendly simple dark eyes, rosy cheeks, a smile and short chunky square-pixel rays                          |
| 47     | cloud          | a tiny fluffy pale-blue cloud character with a simple friendly face, rosy cheeks and two small blue feet                                                          |
| 48     | rainbow        | a tiny friendly rainbow character with four chunky pastel color arcs, two little cream cloud feet and a simple expressive face centered on the lower arc          |
| 49     | peach          | a tiny ripe peach character with a warm coral-and-cream body, two green leaves on top, a simple expressive face and rosy cheeks                                   |
| 50     | strawberry     | a tiny bright coral-red strawberry character with a green leafy crown, small cream pixel seeds and a simple friendly face                                         |
| 51     | avocado        | a tiny halved avocado character with dark-green skin, a pale-green interior, one warm-brown round seed tummy and a simple friendly face                           |
| 52     | pineapple      | a tiny golden pineapple character with chunky dark-green spiky leaves, a few crisp pixel rind marks and a simple friendly face                                    |
| 53     | cherry         | a tiny pair of deep-red cherries joined by their stems with one green leaf, a simple cheerful face on the front cherry and no extra characters                    |
| 54     | lemon          | a tiny golden-yellow lemon character with one green leaf, a simple expressive friendly face and a compact oval silhouette                                         |
| 55     | cupcake        | a tiny cupcake character with a peach paper wrapper, a cream-and-pink frosting swirl, one little cherry and a simple friendly face on the wrapper                 |
| 56     | doughnut       | a tiny pink-frosted ring doughnut character with a few colorful pixel sprinkles, simple friendly eyes and a smile                                                 |
| 57     | coffee cup     | a tiny cream ceramic coffee mug character with a warm-brown coffee top, a single handle, a simple expressive friendly face and a tiny compact wisp of pixel steam |

## Original generation outputs

These paths identify the full original generated PNGs in this workspace session, outside the repository.

| Number | Original PNG                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------- |
| 33     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-58a55d51-5257-4c99-aa16-1db1eec13f0f.png` |
| 34     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-856243b8-d87e-4dda-94ce-b670f35d11dd.png` |
| 35     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-1a91da15-2b9a-4708-9248-1118877f7118.png` |
| 36     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-59f1552d-c2b6-4324-83f0-7f0bfe7ec12d.png` |
| 37     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-12f07e5b-b610-4be3-983e-d2db7f3de84e.png` |
| 38     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-1e02d138-850a-416f-a40a-6b8b95d6deec.png` |
| 39     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-8f6192af-06fd-433e-b09b-5ddd0efaf6de.png` |
| 40     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-a3e18dfa-5587-4ffd-9354-336cb92e5ccf.png` |
| 41     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-55928524-a9fd-4625-b02f-0d21e194baeb.png` |
| 42     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-77cb7794-77bf-4b24-b647-6d6906f14e4a.png` |
| 43     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-0da0f4ea-a3aa-46d3-aa67-900eca8a0ed7.png` |
| 44     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-35c16de7-1075-43f3-915d-109de5db1a65.png` |
| 45     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-e2f99c89-fb08-4ba2-9c6e-f165d9503236.png` |
| 46     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-972a73c8-e687-4aa6-bdbe-c45aed82e0cc.png` |
| 47     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-ff9d28c3-ec71-43ca-a336-01ff73c92694.png` |
| 48     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-27acb955-456c-42f9-90b2-68312c7e8514.png` |
| 49     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-d51d8620-066a-4ae1-9445-32e7dc60a9e4.png` |
| 50     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-9e299171-8883-4cca-b723-7c167ad6462c.png` |
| 51     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-e3a5577e-248d-4925-9e95-a910ef6bd893.png` |
| 52     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-2fc680fb-56bb-4d13-8916-3fb4c10e0d9a.png` |
| 53     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-3b551f44-3ff9-43c3-8eee-fd50de29cdd4.png` |
| 54     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-b829b69d-2384-4b2f-9d9f-fe2973ab8542.png` |
| 55     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-b03541fd-1001-4846-9b8c-2e5c2a622ecc.png` |
| 56     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-0d78242e-2ee6-4991-a4c3-dcaf849c9383.png` |
| 57     | `/home/vscode/.codex/generated_images/01a12d31-47ab-7601-80b1-8af92a6e8883/exec-3109f26d-416f-4bb4-84f1-7d35d70dc2a2.png` |

## Visual review

All 25 outputs were inspected for subject identity, a complete centered silhouette, readable expressive faces, pixel-art style, transparent backgrounds and absence of text. The set covers creatures, plants, space/weather characters and food. Source artwork is kept separate from web packaging so later animation work can reference the original character designs.
