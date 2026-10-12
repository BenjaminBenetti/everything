# Everything planning

Planning documents and the interactive UI concept, kept together as reference for building Everything.

| Reference | Contents |
| --- | --- |
| [Overview](documents/overview.md) | Core concept, main agents, Fleet delegation, asynchronous work, memory, and shared artifacts. |
| [Architecture](documents/architecture.md) | Pi, Kubernetes pods, APIs, authentication, persistence, and the artifact service. |
| [User Surfaces](documents/user-surfaces.md) | Web app, design tokens, iPhone PWA, and push notifications. |
| [UI concept](ui-concept/README.md) | Interactive login, dashboard, team, chat, artifacts, themes, and provider connection. |

The three documents were exported from ChatGPT Pages on 2026-10-11. Their text and Mermaid diagrams are preserved, with titles and source details added and links between the pages changed to local files. The original Markdown and Page metadata are saved in [the source snapshot](sources/pages.json).

These documents capture the Pages as written, except for the artifact design. On 2026-10-12, the Overview and Architecture replaced the shared Nginx folder with a tracked artifact service for shared static and dynamic artifacts; the source snapshot keeps the original text. The mockup's README records later visual refinements, including six themes; the User Surfaces Page still describes the original four.

## Preview the UI concept

Serve `planning/ui-concept/dist` with a static HTTP server, then open `index.html` for the desktop/mobile preview controls or `app.html` for the application alone. The mockup uses buildless HTML, CSS, and JavaScript. Its sign-in, agents, notifications, and provider connection are simulated.

The source files now belong to this repository as ordinary reference files. The separate Git metadata and active Sites configuration have been removed from the mockup folder. [UI provenance](sources/ui-concept.json) records the original source commit, hosting configuration, and file checksums. The existing [hosted preview](https://everything-ui-concept.solar-tapir-0156.chatgpt.site) remains available independently of this local copy.
