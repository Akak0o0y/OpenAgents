# Licensing and credits

## What you may build on

OpenAgents-authored code is released under the [MIT License](../LICENSE). You may use, study, copy, modify, distribute, and contribute those portions under its terms, retaining the required notice. There is no app purchase or subscription fee imposed by this project.

**The entire current bundle is not MIT-only.** Third-party components retain their own terms; a root license does not relicense them. In particular, the adapted Aora expression engine and emotion data under `web/src/lib/aora-bot/` carry an upstream community license allowing non-commercial use/sharing with attribution and offering separate commercial licensing. Read the retained [license](../web/public/vendor/aora/LICENSE), [notice](../web/public/vendor/aora/NOTICE.md), [commercial terms](../web/public/vendor/aora/LICENSE-COMMERCIAL.md), and [third-party notices](../THIRD_PARTY_NOTICES.md).

The project's original silhouette geometry is in `shapes.ts`; the upstream restricted silhouette table is not bundled. That does **not** remove the separate expression-engine restriction. Developers distributing or commercializing the complete application must address that dependency's terms. Do not remove notices or label all bundled files MIT.

## Thank you

- **[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi)** and its community, for the optional self-hosted gateway that makes supported free-tier providers easier to configure. OpenAgents does not bundle your gateway accounts or keys, and availability/cost remains governed by the gateway and providers.
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**, for MIT-licensed streaming/assembly work adapted in the provider protocol layer, with notices retained.
- **[Aora / Emotion Ball](https://github.com/sam70361/aora-bot)**, for the separately licensed expression engine and emotion data described above.
- **Vercel and basement.studio**, for Geist and Geist Mono under the SIL Open Font License; the font notice is retained beside the font files.
- **Coss UI, Base UI, Tailwind CSS, Uiverse contributors**, and the React/Electron/TypeScript/Node/Playwright communities, for the libraries and tooling that support the application.
- Maintainers of the document, OCR, image, validation, and transport libraries listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and the package lockfiles.
- **Every contributor:** code, documentation, testing, translation, issue reports, design feedback, and patient debugging all count.

No acknowledgement implies sponsorship, endorsement, or affiliation. Preserve third-party author credits even when removing an installation owner's private data.

## Demo media

`docs/media/workspace-demo.png` uses the app UI with synthetic conversation data. `OpenAgents-45s-No-Music.mp4` is a promotional app introduction, not a recording of verified autonomous completion. Its narration was generated with an ElevenLabs engine through Higgsfield, and its motion graphics were created for the project. The video contains narration with no background music. Generated-service media can have service-specific usage terms; do not infer those are relicensed by the root code license.
