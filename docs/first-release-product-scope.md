# OpenAgents: first-release product scope

> Historical implementation notes retained for source context. Date-specific tests and delivery claims below are not verification of this public snapshot. Private raw evidence was excluded; use the current [setup](getting-started.md), [limitations](known-limitations.md), and [validation](validation.md) guides.


Status: requirements captured from the product discussion; implementation not authorized by this document. Last reviewed: 12 September 2026. Read with the [system audit](known-limitations.md).

## Product definition

OpenAgents is a local desktop system for persistent, user-created AI workers. A user chooses supported models, including free or inexpensive models, and directs bots through conversation. Bots should complete useful objectives with tools, memory, verification, and retained results. Cortex explains each bot's actual configuration, connections, activity, progress, and blockers.

“Thousands of daily users” means thousands of independent desktop installations. The current target does not require thousands of users to share one daemon or database. Each installation must remain reliable over extended use and predictable under its own bot workload.

Free tokens are an input, not the success measure. Success means useful, verified work delivered within the user's permissions and resource limits. Provider availability, pricing, and quotas must be reported from current information; an arbitrary model cannot be assumed to support every tool or modality.

## Confirmed first-release requirements

| ID | Requirement | Observable acceptance condition |
| --- | --- | --- |
| R01 | Desktop and local ownership | Installation opens a usable application; configuration, bot data, and outputs belong to that installation's profile. No central execution service is required. |
| R02 | Persistent, user-created bots | Each bot retains its identity, role, model, permissions, routines, knowledge, and workspace references across restarts. Logical isolation must be enforced even when records share a database. |
| R03 | Direct requests | Conversation can initiate supported work, obtain missing details, use authorized tools, report progress, and return the result. A text answer alone is insufficient when the request requires an action. |
| R04 | Scheduled routines | A bot executes a defined objective at its schedule or supported trigger, using explicit timezone and missed-run policy. Every occurrence has a linked run and an accurate result. |
| R05 | Continuous missions | A bot retains an objective and its progress, generates useful next work, uses previous results, avoids repeated attempts, and can continue, wait, stop, or ask for input. It does not need to create other agents. |
| R06 | Complete work lifecycle | Supported work follows understand → plan → obtain context → execute → verify → deliver → remember → continue/wait/finish. Success has evidence appropriate to the objective. |
| R07 | Model choice | Users choose among supported providers/models. Capabilities and limitations are explicit. Fallback to another model is opt-in; provider identity and usage remain attributable. |
| R08 | Actual tool access | Allowed tools are usable by the runtime. Permissions are checked for the owning bot and action. Installing or drawing a connection is not proof of invocation. |
| R09 | Useful memory | Working context, structured agent data, Obsidian knowledge, and retained artifacts have defined roles. Relevant knowledge can be recalled; compaction preserves objectives, decisions, evidence, pending work, and source references. |
| R10 | Durable results | Deliverables remain accessible after a task's temporary container is removed. The user receives a completion or blocker report linked to evidence and artifacts. |
| R11 | Local interruption and recovery | No work runs while the computer is powered off. On startup the system recovers mission progress, reconciles interrupted actions, and resumes eligible work. Intentional pauses remain paused. This resumes the mission, not necessarily an interrupted model request at the same token. |
| R12 | Operator control | Pause, resume, cancellation, approval, and any supported steering have clear scope and truthful status. Work stays within granted authority. |
| R13 | Resource controls | Dollar spend, request/token limits, elapsed time, concurrency, repeated failures, and local machine resources bound autonomous work, including zero-dollar models. |
| R14 | Faithful Cortex | Bot and run selection agree. Relationships distinguish configured, permitted, connected, and actively used tools. Layers show observed activity and missing capabilities without implying access to private model reasoning. |

R11 records the explicit power-off/resume decision. The subsequent deferral concerned automatic specialist agents and delegation, as confirmed by the preceding question and response in the product discussion.

## Explicitly deferred

- Automatic specialist creation, automatic delegation, and multi-agent coordination beyond independent user-created bots: after first release and feature review.
- Remote workers that continue executing while the user's computer is off: outside the selected local execution model.

The architecture may leave extension points for these features. Their absence is not a first-release defect.

## Important distinctions

- A bot can be persistent without keeping every execution container alive. Persist workspace/artifact references and knowledge; use disposable execution environments where appropriate.
- `agent_data` is storage. It becomes memory only when ownership, retrieval, updates, provenance, and compaction are implemented.
- A model response is not evidence that an external action succeeded. Verification must inspect the actual result.
- A routine is a trigger for work. A mission owns an objective across work items. A run is one execution attempt. A chat thread is an interaction surface. These concepts need relationships, not interchangeable status flags.
- A “computer” file view and an interactive browser/desktop are different capabilities. The interface must identify which one is available.
- Matching Grokbot's appearance is a design reference. It is not evidence of functional parity or permission to claim every reference feature works.

## Proposed release acceptance scenarios

These are recommended checks derived from the requirements, not claims that they pass today.

1. Create two bots with different roles and tool permissions. Give the same research request to both; the permitted bot can use its tool and the other explains the missing permission without attempting it.
2. Ask for a supported direct objective. Inspect the evidence, retained output, cost, and completion report after restarting the app.
3. Schedule a report. Verify timezone behavior, one linked run, actual report contents, correct terminal status, and the chosen missed-run policy. Edit its prompt and verify the next occurrence uses the edit.
4. Run a continuous mission that researches a problem and produces a verified deliverable. Its next decision must use the previous outcome and avoid repeating completed work.
5. Interrupt before a tool action, after the action but before recording its result, and after verification. Recovery must reconcile state and avoid duplicate external actions. Repeat with a manually paused bot; it stays paused.
6. Refuse an approval, reach a quota, cancel an in-flight operation, and disconnect a provider. The application must show an accurate wait/failure state and bounded resource use.
7. Fill enough conversation history to require compaction. Confirm that task commitments and evidence survive and that a new run recalls relevant knowledge from the correct bot and vault scope.
8. Switch bots/runs in Cortex and change an actual permission. The graph and activity must reflect the backend state after reconnect and restart.

## Decisions still needed before implementation plans are final

The product direction is sufficient for the audit. The following details remain design work rather than permission to invent behavior:

| Decision | Proposed starting point |
| --- | --- |
| Exact first-release task domains | Prove a narrow set of coding and research objectives end to end before promising arbitrary office/browser work. |
| Supported operating systems at launch | State the tested launch matrix explicitly; current desktop documentation reports Windows only tested historically. |
| Closing the window versus quitting | Define background/tray behavior separately from power-off recovery; always show how to stop all work. |
| Obsidian synchronization | Choose a vault scope and conflict policy; structured execution state should remain in the database. |
| Sharing between bots | Default to private knowledge and explicit shared collections. |
| Model/local endpoint coverage | Publish a tested capability matrix; add providers through one adapter contract. |
| Approval policy | Decide which action classes require review, remembered grants, and scopes; avoid treating a one-time dispatch approval as unlimited authority. |
| External webhooks | Local-only by default; remote ingress needs a separately designed authenticated route. |

Do not treat earlier pasted “built and active” feature tables or the narrow UI stabilization roadmap as a verified completion checklist. The audit identifies the current implementation evidence.
