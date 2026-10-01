# How OpenAgents works today

> Historical implementation notes retained for source context. Date-specific tests and delivery claims below are not verification of this public snapshot. Private raw evidence was excluded; use the current [setup](getting-started.md), [limitations](known-limitations.md), and [validation](validation.md) guides.


These are answers to the questions raised after using the 0.2.0 app on 15 September 2026:
- How does a chat request turn into work?
- Where do results appear?
- What does "computer use" mean?
- What is still missing?

They describe the code as it stands after the fixes in [product-experience-todo.md](known-limitations.md), checked by using the app on a copy of your profile with your real OpenRouter connection and Docker.

## 1. How a chat request becomes work

You talk to a bot the way you would to a person. Each message goes to the bot's work runtime, which can use these tools:

- web search and web pages
- GitHub issue search
- its own browser
- memory
- an Obsidian vault
- MCP servers you have installed
- an offline code sandbox

The bot decides which shape the request has:

| You say | What the bot does | What you see |
| --- | --- | --- |
| A question, or "look this up" | Answers now, using tools when needed | The answer in the chat, with sources |
| "Every morning at 9, send me…" | Proposes a **routine**: name, schedule, timezone, instruction | A card: *Create the routine "…"?* |
| "Keep working on…", "watch for…" | Proposes a **mission**: goal, number of steps, pace | A card: *Start this mission?* |
| "Use my Obsidian vault at …" | Proposes connecting that folder | A card with the folder |
| A task that needs a login | Asks for an **account** on that site | A card with username and password fields |

What the cards do:

- **Nothing starts until you approve.** The bot's turn ends as soon as it has proposed, so a card never expires while you read it.
- Approving or declining is answered in the same conversation, for example: "Created **Three AI news stories each morning**. It runs every day at 9am (Asia/Riyadh)…".
- You never fill in a form to start work. The routine editor is still there so you can change a routine afterwards.

## 2. Where results appear

**In the conversation.** This is where most results go:

- answers
- each routine run, headed "Routine · *name*"
- each mission step
- confirmations after you decide on a card

The chat refreshes by itself when one arrives.

**In the Workspace panel** (the panel beside the chat):

- *Routines*: every routine, its schedule in words, and its next run. Open one to edit, pause, **Test run**, or see its run history with **View result**.
- *Background work*: running missions with their progress, the latest result, and Pause, Resume and Stop.
- *What it remembers*: memory notes, each with Forget.
- *Browser*:
  - where the browser runs
  - the accounts it signs in with
  - how freely it may use forms and buttons

**In Cortex.** This is where you see *how* a run was done:

- Pick a run, and each layer shows how many events it recorded.
- Clicking a layer lists what happened in words.
- *Answer Shaping* shows the run's final result.
- Tool nodes show their configuration: MCP servers and their tools, the vault, Docker, and the run's cost.
- The Run panel lists the run's timeline and its files.

## 3. What "computer use" means today

**The bot's own browser, in a Docker sandbox.**
- When Docker is running, Chromium runs inside a container built from Microsoft's Playwright image, not on your desktop.
- It can reach the whole public internet, on any port.
- It cannot reach your home network, this computer or cloud metadata addresses.
- The first time, the image downloads once (about 2 GB). On this computer that took under 3 minutes.
- Until the image is ready, the browser runs on this computer with the same network rules, and the panel says so.

Checked on this computer:
- `example.com`, `github.com/trending` and a site on port 8080 loaded.
- `192.168.1.1`, `host.docker.internal`, the container's own server port and `169.254.169.254` were refused.

**Accounts it signs in with.** When a task needs a login, the bot asks for the account on a card. Then:

- The details are encrypted with Windows' per-user protection and stored on this computer only.
- The bot never sees them. It asks the browser to type "the saved username" or "the saved password", and the daemon types them.
- A password is typed only into a password box, and only on its own site or that site's subdomains. It is never typed on a page that merely asks for it.
- If a page shows the username back (for example "Signed in as …"), the bot reads **[saved username]** instead.

**How freely it acts** is set per bot:

- *Ask me on every site*
- *Ask only where no account is saved* (the default)
- *Never ask*

You can also still open a sign-in window and log in for the bot yourself; it keeps those cookies for itself.

**Code.** Code and tests run in offline Docker containers that cannot see your files.

**What it is not.** The bot cannot move your mouse, see your screen, or use other desktop apps.

## 4. What is still missing

- **Desktop control.** Only the browser and the code sandbox are the bot's "computer".
- **Model habits.**
  - DeepSeek (through OpenRouter) sometimes writes its own tool-call format instead of OpenAgents' actions, or sends an empty reply.
  - OpenAgents now turns the first into the action it names, and asks again after the second.
  - A weaker model still gives weaker answers, and some runs will fail and say so.
- **One conversation per bot.**
  - Routine and mission results go into the bot's current conversation, not a separate thread.
  - There is no unread badge for them.
  - "New conversation" opens the bot's existing chat.
- **Missions with a real model** were proposed and run in automated tests, but not started from chat during this walkthrough.
- **MCP servers** are added from Marketplace → Plugins and connect after the daemon restarts. There are no per-tool on/off switches, because the runtime has none.
- **Publishing.** The bot prepares tested changes to GitHub repositories, but it does not push, open pull requests or post comments by itself.
- **Your old conversation** still shows the failures from before these fixes ("Blocked: Conversation…"). They are history and were left as they are.
