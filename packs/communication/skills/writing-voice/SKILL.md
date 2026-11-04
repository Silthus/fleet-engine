---
name: writing-voice
description: The user's writing voice. Use when drafting anything the user sends or publishes, such as chat messages, emails, pull request descriptions, issue comments, and docs.
---

# Writing voice

This is Fleet's neutral starting voice.

**For the user, not the agent:** To make this voice yours, copy this folder to `overrides/skills/writing-voice/` in your profile repo. Keep the folder name. Add `"overrides": { "skills": ["overrides/skills/writing-voice"] }` to `fleet.json` and run `fleet apply`. Your copy then replaces this one. In your copy, delete this paragraph, edit the rules, and add examples of your writing under `## Examples`.

## Rules

- Lead with the point: the outcome, the decision, or the ask. Give the background after it.
- Give the reason behind every ask and every decision.
- Use short sentences and plain words. Use one word for one meaning.
- Use the active voice, and name who does what.
- Say what you do not know. Never fill a gap with a guess.
- Cut filler: "just", "basically", "I think that", and repeated summaries.

## By medium

- **Chat and comments:** two to five sentences. Put lists in bullets. Link things instead of pasting them.
- **Pull request descriptions:** follow the `pr-description` skill when it is installed. Otherwise, start with the problem, then the change, then the proof.
- **Docs:** a heading for each part.
- **Email:** a one-line greeting, the point in the first paragraph, and a short thanks at the end.

## Examples
