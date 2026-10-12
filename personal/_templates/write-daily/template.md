---
name: write-daily
description: Use when {{display_name}} asks for the daily standup note or {{standup_tool}} update — {{trigger_phrases}} — for the {{channel_name}} Slack channel.
---

# Write Daily ({{channel_name}})

Produce a copy-paste-ready update for {{standup_tool}} from the Claude Code sessions inside the
window, in {{display_name}}'s channel voice. The note is pasted into the chat only — never sent or
drafted to Slack.

Drafts and the calibration log live in `~/.claude/personal-data/write-daily/`, outside the skill
directory; every relative `drafts/` below is relative to it.

## Steps

1. **Find the window start** — read the last ~25 messages of channel `{{channel_id}}` with the Slack
   MCP `slack_read_channel` tool, **with `response_format: "detailed"`** (bot-posted update text
   lives in message attachments, invisible in concise mode):
   - Find {{display_name}}'s most recent update. Updates posted by a bot under other people's names
     are matched on the body text `{{post_header}}`, not the author field.
   - The new note covers work **since that post**. That post's Unix timestamp is the **window start**
     for steps 2–4. Establish it *before* collecting anything — every other source is filtered by it.
   - The window usually reaches back into the previous afternoon and evening, and after a weekend or
     a skipped day it spans several days. Never assume the window starts at midnight.
   - Don't repeat items already reported there; a continuation of reported work is fine when framed
     as today's progress.
1b. **Today's draft may already exist** — runs after step 1 and **before step 2**, because steps 2–4
   are the expensive part. Today's note can already be on disk in `drafts/<today>.md` (step 7 of an
   interactive run){{#if scheduled_draft_path}} or in `{{scheduled_draft_path}}` (the scheduled run);
   take the newer of the ones that exist{{/if}}. Then decide from step 1's answer:
   - **The last post is older than that file** → nothing has moved: this is still a note not yet
     posted. Deliver that text in the step 6 code blocks, say in one line where it came from, and ask
     whether to re-gather. **Do not run steps 2–4.**
   - **The last post is newer than the file** → the file belongs to the previous note; carry on with
     steps 2–4 normally.
   - **A fresh or different note is asked for** → steps 2–4, no questions.

2. **Collect the work** — run the session collector **once per calendar day the window touches**,
   from the window-start date through today:
   ```bash
   python3 ~/.claude/skills/write-daily/gather_sessions.py             # today
   python3 ~/.claude/skills/write-daily/gather_sessions.py 2026-01-29  # and each earlier day in the window
   ```
   The script selects sessions by their **start** date, so calling it for today alone silently drops
   everything done after the previous day's post. Drop sessions that started before the window
   start, plus empty/test sessions and the current session. If an OUTCOME is truncated mid-fact you
   need, read that session's `.jsonl` directly.
3. **Slack activity** — work outside Claude Code (reviews, coordination, announcements). Two
   `slack_search_public_and_private` searches, both with `query: "from:<@{{slack_user_id}}>"`,
   `after: <window-start unix ts>`, `sort: "timestamp"`, `include_context: false`,
   `response_format: "concise"`; paginate with the cursor until the window is covered:
   - `channel_types: "public_channel,private_channel"` — the main work signal. Skip messages in the
     daily channel itself.
   - `channel_types: "im,mpim"` — DMs are **evidence of work only**: what enters the note is the work
     outcome (helped X debug Y, coordinated testing, unblocked a PR), never the exchange itself.
     Social chatter, jokes, opinions about people, and anything personal are invisible to the note —
     not quoted, not paraphrased, not hinted at. Unsure whether an exchange is work or private →
     leave it out.
{{#if notion_user_id}}
4. **Notion activity** — pages created inside the window. `notion-search` with
   `query_type: "internal"`, `filters: {"created_by_user_ids": ["{{notion_user_id}}"],
   "created_date_range": {"start_date": "<window-start date>", "end_date": "<today>"}}`, and a
   `query` built from the day's themes (from step 2) — run it twice with different theme keywords if
   the first returns nothing. Edits to pages created earlier may not surface, and AI-search questions
   like "what did I edit today" return stale results — don't use them. Notion is a supplementary
   source; an empty result is normal.
{{/if}}
4b. **Check what actually shipped** — a merged PR beats a session transcript claiming completion.
{{#if board_check}}
   Dispatch {{board_check}} with the window start from step 1. It reconciles the status of every
   ticket touched inside the window against its artefacts (merged PR, open PR, verification), moves
   the ones that drifted, and returns what it changed. Runs in parallel with steps 3–4; the note does
   not wait on it.
   - Cross-check step 2 against its changes: a ticket it moved to a done-like status is work you may
     report as done; work the sessions call finished that it did **not** move is work with no
     artefact, so report it as prepared, not shipped.
   - Its output is **evidence for you, not text for the note**: no ticket IDs reach the note, and
     board hygiene is not something the team needs reported.
   - **If it reports a transition it could not execute, surface it in the delivery message** as one
     line after the note: `<KEY> <from> → <to>, to do by hand`.
   - No answer or a failed dispatch → use the fallback below. The note never blocks on the tracker.

   **Fallback**, when nothing can be dispatched:
{{/if}}
   `gh pr list --state merged` and `--state open` on the repos the day's work is in, filtered by
   the window start. A merge inside the window is a shipped fact; an open PR is "up for review".

5. **Write the note** — exactly two sections matching the standup's questions{{#if skipped_questions}}
   ({{skipped_questions}} is intentionally omitted — {{display_name}} answers that one by hand){{/if}}:
   - *{{done_question}}* — one narrative lead with the day's main theme, then at most one more short
     paragraph (see *Style contract*). No "Also:" header, no bullet list.
   - *{{next_question}}* — **one thing**, taken from explicit "tomorrow" statements in the sessions or
     the obvious next step. One line{{#if emoji_set}}, one emoji{{/if}}, done.
     - **Never repeat the previous note's plans line, and never promise what waits on someone else's
       gate.** Read the previous note's plans line before writing this one; if the same words would
       come out, the note ships **without the plans section** — no plans line is better than a
       repeated one. A plans line names something {{display_name}} can finish alone.
     - Given two candidates, drop the one that waits on somebody else's approval.
     - **No rationale clause.** The plans line names the thing; why it matters is not part of it.
   - Merge sources: sessions (step 2) are the primary story; Slack{{#if notion_user_id}}/Notion{{/if}}
     add the non-Claude work — meetings, code reviews, coordination, docs; step 4b is the artefact
     check on what actually shipped. One fact appearing in several sources is still one item.
6. **Deliver** each section in its own plain code block for copy-paste, then ask if tweaks are wanted.
7. **Archive the draft** — write the delivered text (both sections, after any in-session tweaks) to
   `~/.claude/personal-data/write-daily/drafts/<YYYY-MM-DD>.md`. One file per note; overwrite if the
   same day is redrafted. Without this file step 0 has nothing to compare against, so the
   calibration loop dies silently.
{{#if copy_tool}}
8. **The archived draft is the copy-paste source** — {{copy_tool}} reads `drafts/<today>.md`, because
   it holds the delivered note and nothing else. Step 7 is therefore not bookkeeping — it is the
   delivery.{{#if scheduled_draft_path}} `{{scheduled_draft_path}}` is a different artefact (the whole
   output of the scheduled session) and is **not** a substitute; never hand it over as the note.{{/if}}
   If step 7 was refused, say the note is only in the chat.
{{/if}}

## Step 0 — calibrate against what was actually posted

**Runs first, every single invocation, before step 1** (step 1 already fetches the last post, so the
comparison is free). Its purpose: the note this skill writes should converge on the note
{{display_name}} would have written.

1. Take the posted update found in step 1 and the archived draft for that same note
   (`drafts/<date>.md`). No archived draft → skip step 0 and go to step 1.
2. Diff them for **what changed**, not for wording noise. Look for:
   - facts **cut** (over-reporting: too granular, process mechanics, work that doesn't count),
   - facts **added** (a source this skill doesn't read, or something it saw and judged unimportant),
   - **reframing** (claimed-as-done → planned, a theme regrouped, a lead swapped),
   - **voice** edits that repeat (sentence length, emoji use, which names get `*bold*`),
   - the **plans** section — how much of what was proposed survived.
   Identical draft and post is a real result: log it as a confirmation, it is evidence the rules hold.
3. Append one dated entry to `~/.claude/personal-data/write-daily/calibration-log.md` (create on first use):
   ```
   ## <YYYY-MM-DD>
   - kept: <what survived unchanged — the rules that are working>
   - cut: <what was removed, and the likely rule behind it>
   - added: <what was added, and where it should have come from>
   - reframed: <how>
   - verdict: <one line: which rule this confirms, contradicts, or is missing>
   ```
4. **Edit this SKILL.md when a pattern has appeared twice** — once is noise, twice is a rule. Turn it
   into a line under *Style contract* or *Common mistakes*, and note the two dates it came from in the
   log entry. A single very clear edit (a whole category of work cut, a fact corrected) may be
   applied immediately; say so in the log.
5. Tell {{them}} in one line, in {{chat_language}}, what step 0 changed (`calibration: <rule>` or
   `calibration: no change`), then carry on with step 1. Never ask for confirmation — the edit was
   the vote.

If the final version never appears, leave the draft archived and try again on the next run; drafts
older than ~14 days with no matching post can be deleted.

## Style contract — the note IS this shape

**The voice lives in the `write-like-{{name}}` skill** (`~/.claude/skills/write-like-{{name}}/SKILL.md`).
Read it and apply it; don't re-derive the voice here. Only the daily-specific constraints stay below.

- **{{post_language}}**, narrative, no ticket IDs, no headers.
- **No bullet lists at all in this note** — the daily flows as paragraphs, grouped by theme.
- **One paragraph is the default; a second is the exception that has to earn its place.** The day's
  headline, and *at most* one thing that matters to somebody else. A day with eight things done
  still produces one or two paragraphs. **A second paragraph has to be a different story, not more
  of the lead's** — draft it only when you can name the reader who changes what they do tomorrow
  because of it, and when that reader is not the person who already owns the work. Work done inside
  somebody else's epic is *their* daily. More output from the same theme goes **nowhere** — not into
  a second paragraph, and not into an "Also …" clause bolted onto the lead. If a fact does not earn a
  paragraph, it does not earn a clause either. When in doubt, deliver one paragraph.
- **Lead shape: a one-line hook{{#if emoji_set}} with its emoji{{/if}}, a blank line, then one
  paragraph of detail.**{{#if lead_example}} The hook names what landed ("{{lead_example}}");{{else}}
  The hook names what landed;{{/if}} the paragraph says what it means for the person on the other
  end. The hook is the first thing that gets cut, so the detail paragraph must stand on its own: it
  names the subject itself, and never lets a fact live only in the hook.
- **Only shipped things earn a paragraph — or even a sentence.** A conversation, an agreement, a
  coordination thread or a discovery with no artefact behind it is not note material, however
  consequential it felt. If nothing landed from it, it goes at most into the plans line.
- **A correction of something reported earlier is not note material.** A wrong fact gets corrected
  **in the place it was stated** (the weekly, the ticket, the status doc); the channel gets today's work.
- **If a discussion ever does get reported, read the thread to its end first.** The opening position
  is not the outcome; facts about a live thread come from the thread, never from a session
  transcript's paraphrase of it.
- **Cut work about the personal setup and tooling outright** — machine limits, the agent fleet,
  orchestration, skills, board hygiene. Nobody in the daily is running that rig.
- **No investigation maths, and no mechanics of how the work went.** Sample counts, hit rates,
  merge conflicts, rebases, where the afternoon went. Keep the outcome, drop both the derivation and
  the struggle-story. The voice skill's exact-numbers rule holds only for numbers that are the point,
  never for evidence. **The count of findings is the point, the anatomy of them is not**: any clause
  beginning *because*, *the pattern is*, or *the same shape each time* is the writer showing their work.
- **{{audience}}** The rule is not "less detail" — it is **no sentence whose meaning lives outside
  it**: review rounds, gates, blockers, commits and which PR carried what. A technical sentence that
  explains itself as it goes stays. Gate language survives in the plans line, where it reads as plain
  English; it does not survive in the body.
- **"Also" is the connective.** Do not build a bridge between two facts; put them side by side.
- **Never overstate an absence.** Before writing that something was never done or never reviewed,
  check whether it happened somewhere this skill cannot see, and say *where it was missing*.
- **No board states.** Column names are tracker vocabulary, same family as ticket IDs. Say what
  landed, not where it sits.
- **People:** real Slack mentions, not `*bold*` names — the daily is the one place the person should
  actually get pinged. Name only who was really involved, singular if it was one person. **Never
  state what a colleague was blocked on.** Credit is welcome, flat credit is not: give it the
  concrete detail or reaction that made it worth saying, or drop it.
{{#if emoji_set}}
- **Emoji always as workspace `:codes:`, never unicode** — translate keyboard emoji when lifting text
  written elsewhere. Emoji can *replace* a closing sentence rather than decorate one. **Rotate them**:
  read the last two drafts in `drafts/` and pick emoji that are not in them, as long as they fit the
  sentence. Two is the floor, not the ceiling; never cut one {{display_name}} wrote. The set:
  {{emoji_set}}
{{/if}}
- **Material asked for by name overrides the one-paragraph rule.** The paragraph budget governs what
  this skill *selects*; it does not veto what {{display_name}} hands over.
- The two standup sections are the shape; nothing else is added.

## Common mistakes

- Regenerating the note when today's draft is already on disk and nothing was posted since → step 1b.
  "I lost my daily" means *hand me the text*, not *compute it again*.
{{#if scheduled_draft_path}}
- Looking only in `drafts/` for today's draft → the scheduled run writes `{{scheduled_draft_path}}`;
  check both, take the newer.
{{/if}}
- One paragraph per session → group by theme.
- Reporting work as shipped with no artefact for it → a session saying "done" is a claim, a merged PR
  is a fact. No artefact → "prepared/planned X". Committed-but-unpushed code counts as done — just
  don't claim a PR or merge that doesn't exist.
- Putting ticket keys or board tidy-up into the note → it is evidence for the writer.
- Trusting file mtimes → sessions are filtered by message timestamps; the script already handles this.
- Running the collector for today only → the window starts at the last post, not at midnight.
- Writing in another language than {{post_language}} or with ticket IDs.
- Mentioning a DM exchange (who, about what) instead of its work outcome.
- Delivering the note and stopping → the draft is archived (step 7) or the next run has nothing to
  calibrate against. If the draft is edited in-session or the posted version is pasted back, archive
  **that** version and run step 0's comparison immediately.
- Logging a calibration entry and changing nothing forever → a pattern seen twice must become a line
  in this file; the log is the evidence, the skill is the fix.
{{#if notion_user_id}}
- Treating an empty Notion result as an error → most days have no new Notion pages; move on.
{{/if}}
