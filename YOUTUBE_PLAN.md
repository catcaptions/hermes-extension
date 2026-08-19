# Lasisi — YouTube Dev Channel Plan

Model: personal dev brand, Theo / David Ondrej style (build-in-public, hot takes, tutorials).
Tagline: "Local-first AI tools, built in public."

## Channel setup
- Name: Lasisi
- Handle: @Lasisi (verify availability; alt: @DavidLasisi)
- Avatar: your face or a clean wordmark
- Banner: "Local-first AI · built in public"
- First 3 videos released ~weekly, then settle into a rhythm.

## Content pillars (rotate these)
1. Build logs — "I built X" (extension, paid API, anything you ship)
2. Hot takes — "local-first AI is underrated", "stop putting code in someone's cloud"
3. Tutorials — "build a Chrome extension with no build step", "write an MCP server in 50 lines"
4. Tool/ecosystem commentary — react to AI-dev headlines

---

## EPISODE 1 — Launch / walkthrough

Title: "I built my own private ChatGPT that runs on my PC and controls my browser"
A/B alt titles:
- "Stop sending your data to the cloud — I built a local AI sidebar"
- "I replaced ChatGPT in my browser with one I built myself"

### Script (line-by-line, timestamps)

[0:00 HOOK]
Everyone's AI assistant ships your prompts off to someone else's server.
I got tired of that — so I built one that runs 100% on my own machine,
sits in my browser's side panel, and can even click buttons on the
websites I'm already logged into. And it's open source. Let me show you.

[0:15 PROBLEM]
Here's the daily friction. You're reading docs, you want to ask an AI
something about the page — you open a new tab, go to chatgpt, paste
context, lose your train of thought. And every message? It leaves your
computer. For a dev, that's a bad habit.

[0:35 THE BUILD]
I called it Hermes Minimal. The whole thing is vanilla HTML, CSS, JS —
no React, no build step, no frameworks. It talks to a local gateway over
plain HTTP and server-sent events. You load it unpacked, paste your
gateway URL and API key, and you've got a ChatGPT-clean panel on the
right side of any tab.

[0:55 DEMO — CHAT]
(screen: load extension, paste key, send a message)
Watch — I send a message, it streams the reply. Markdown renders, code
blocks look right, and if I throw a LaTeX equation at it — dollar-sign
math — KaTeX typesets it inline. No copy-paste to a separate renderer.

[1:25 DEMO — LOCAL MEDIA]
Here's something cloud tools can't easily do — I paste a screenshot
straight from clipboard, it downscales and the model sees it. Local
images, audio, video, all bridged from my machine. My files never
upload anywhere.

[1:50 DEMO — LIVE BROWSER (the wow)]
And the part I love — the live-browser bridge. My AI agent can attach to
this tab, read what's on screen, and click. (demo: agent navigates /
clicks something on a logged-in site) That's my real logged-in session,
driven by my local agent. No RPA cloud, no per-action API bill.

[2:30 WHY LOCAL-FIRST]
Why bother? Three reasons. Privacy — your prompts stay on your box.
Cost — it's your own model, no token meter. And control — you wire it
into your actual workflow, not a walled garden. Local-first AI is
underrated and I think more devs should be doing it.

[2:55 CTA]
Full source is linked below — MIT, audit it yourself. If you want to see
what I build next, including a paid API I'm working on for developers,
hit subscribe. Next video: how I built this extension with zero
frameworks.

[END — ~3:15]

### Description (SEO)
In this video I show Hermes Minimal — a zero-build Chrome/Edge side-panel
extension that gives you a private, local-first ChatGPT-style chat in
your browser. It streams replies from your own Hermes Agent gateway over
HTTP + SSE, renders Markdown and LaTeX, bridges local media
(images/audio/video) from your machine, and can drive your real
logged-in tabs via a local browser bridge.

No cloud. No frameworks. No token meter. Open source (MIT).

Links:
- Hermes Minimal repo: [URL]
- Hermes Agent: [URL]
- My config / setup: [URL]

Chapters:
0:00  The problem with cloud AI assistants
0:35  Building a local side-panel chat
0:55  Streaming + Markdown + LaTeX demo
1:25  Local media bridge
1:50  AI that controls your real browser
2:30  Why local-first
2:55  Subscribe

#localai #chromeextension #buildinpublic #privacy #aiagents

### Tags
local ai, chrome extension, edge extension, hermes agent, side panel,
privacy, ai agent, build in public, mcp, browser automation, local first,
open source, devlog

---

## EPISODE 2 — Build log / tutorial

Title: "How I built a Chrome extension with ZERO frameworks (and why)"
Angle: devlog + tutorial. Attracts dev viewers, ranks for "no build step
extension" searches. Show manifest.json, sidepanel.js, the SSE parser,
the 4 gateway endpoints.

### Description (SEO)
Most Chrome extension tutorials start with Vite, a framework, and a
dependency tree. I did the opposite — Hermes Minimal is vanilla
HTML/CSS/JS, no build step, and it's easier to read because of it. In
this video I walk through the architecture: the MV3 manifest, the
side-panel client, how Server-Sent Events stream tokens, and how I kept
the whole thing node-testable. If you've wanted to ship an extension
without a toolchain, this is for you.

Tags: chrome extension tutorial, mv3, no build step, vanilla js,
manifest v3, side panel, sse, web dev, build in public

---

## EPISODE 3 — The wow feature

Title: "I let an AI agent control my real browser — here's how"
Angle: the live-browser bridge. Your most demo-able unique feature. Show
the agent clicking / filling a logged-in site, the debugger banner
lifecycle, the local MCP hub.

### Description (SEO)
Your AI shouldn't need a separate RPA subscription to use the web you're
already logged into. In this video I show the live-browser bridge in
Hermes Minimal: a local MCP hub + the extension's debugger relay let my
local agent observe and act on my real tabs — click, type, fill,
navigate — using my actual cookies and logins. Loopback only, no cloud.
I cover the setup, the pairing, and what you can (and can't) do safely.

Tags: ai agent browser, browser automation, mcp, chrome debugger,
local ai, agentic, rpa alternative, build in public

---

## 10-video roadmap
1. Extension launch (ep1)
2. Zero-framework build log (ep2)
3. AI controls your browser (ep3)
4. Hot take: "Why I run all my AI locally (and you should too)"
5. Tutorial: "Build an MCP server from scratch"
6. Preview of your credit-billed paid API (funnel payoff)
7. "What I learned shipping my first extension"
8. Hot take / commentary on a current AI-dev headline
9. Devlog: building the paid API, build-in-public
10. "My local-first AI dev setup" (evergreen tools tour)

## Open question for you
Are you the Hermes Agent maintainer (github abundantbeing) or building
the extension on top of it? If you maintain Hermes, episode 4's
"local-first" angle can name-drop the ecosystem; if not, it stays generic.
Tell me and I'll tighten ep4 + the paid-API tease in ep6.
