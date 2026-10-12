---
name: write-like-{{name}}
description: {{display_name}}'s written voice for Slack and other prose posted under {{their}} own name — use when drafting or rewriting a Slack message, thread, comment, announcement or short write-up for {{them}}, or when {{display_name}} asks for {{trigger_phrases}}.
---

# Write like {{display_name}}

{{display_name}}'s prose has a shape, and a draft that misses it reads as a report {{they}} would have
to rewrite. The failure mode is always the same direction: too structured, too explained, too many
numbers, too neatly concluded. **Assume the first draft is 30–40% too long and over-argued.**

Every rule below has to be earned by comparing a draft with what {{display_name}} actually sent. That
comparison is part of the job, not an afterthought: **start with step 0 and end with step 8** of
*Calibration loop*, at the bottom of this file.

Calibration data — `drafts/`, `sent/`, `calibration-log.md` — lives in
`~/.claude/personal-data/write-like-{{name}}/`, outside the skill directory; every relative `drafts/`
or `sent/` below is relative to it.

## The contract

- **{{post_language}}**, even when the working conversation is in another language. Never mixed.
  (Exception: a reply inside a thread in another language — see *DM register*.)
{{#if language_rules}}
{{language_rules}}
{{/if}}
{{voice_summary}}
{{formatting_rules}}
{{#if emoji_set}}
- **Emoji land {{emoji_density}}.** Always as workspace `:codes:`, never unicode. The set, which
  grows — don't refuse an apt one that isn't listed: {{emoji_set}}
{{else}}
- **No emoji.** The posts carry none.
{{/if}}
{{#if asides}}
- **Asides are the voice.** All short:
{{asides}}
{{/if}}
{{#if slang}}
- **Casual register, clipped:** {{slang}}. Not slang for its own sake — it's the shorthand of someone
  typing fast to people who already know the domain.
{{/if}}
- **Numbers: structural yes, anecdotal no.** Counts that define the system stay exact. One-off
  measurements and war stories get cut — they're the second example for a point that already
  landed. Never "significantly improved".
- **No ticket IDs** in prose. At most one link, and only if it genuinely helps.
- Length: {{length_rule}}.

## What gets cut from drafts — check these before delivering

1. **Verdict sentences.** "That table did more for me than any prompt tuning", "sounds like
   bureaucracy, but…". State the fact and move on; the reader draws the conclusion.
2. **The second example.** One claim, one illustration, maximum. If a paragraph has two proofs, the
   weaker one goes.
3. **Rationale spelled out as a sentence.** Keep the *what*, compress the *why* to a parenthetical
   or drop it.
4. **Design digressions.** Interesting-but-adjacent reasoning is exactly what gets deleted.
5. **The wrap-up.** No "TL;DR", no "key takeaways", no summarising closer. If anything ends the
   post it's a forward-looking line{{#if emoji_set}} or an emoji{{/if}}, not a recap.
6. **Institutional voice.** "a skill of ours", "we decided" → "a new skill", "I", when the work is
   {{display_name}}'s own.
7. **Sentences arguing that {{their}} own work was hard or well-built.** The length budget goes to
   what the reader cannot infer, never to justifying the engineering. Explain the thing the reader
   has never seen; state the thing that was built and stop.

{{#if people_notes_dir}}
## People notes — what this person needs before they agree

Before drafting anything addressed to **one named person**, check `{{people_notes_dir}}` for their
page. Take **one** sentence: what that person requires before they say yes, or what actually
convinces them. Let it change the message: lead with the evidence they will ask for anyway. It
changes content, never voice — the register rules still decide the wording, and the notes are never
quoted or named in the message. No page → do not guess.

**A pattern from the notes applies where the reader has to agree to something, not to every
message.** Ask first whether this message needs the reader's judgement; if it only needs their hand,
the note changes nothing.

{{/if}}
## DM register — a reply inside a thread, not a post

Everything above is written for a post or an announcement. A one-to-one reply is a different
register, and applying the post rules to it produces something stiffer than {{display_name}} would
ever send.

- **Match the thread's language.** Check what language the thread is actually in before drafting —
  do not infer it from the person's name. The {{post_language}} rule is about posts, not about how
  a person gets answered.
- **When someone misread {{their}} writing, own the writing, not just the fact.** Fixing the
  misunderstanding is the minimum; also name what went wrong as an author.
- **But a late reply gets no preamble at all** — and this is the opposite direction to the rule
  above, so keep them apart. Being slow is nothing to own to a colleague who is waiting: the message
  opens on the actual question and the delay goes unmentioned. **Ask, don't preface, and never price
  the favour** ("it only takes two minutes").
- **A small favour from a close colleague is an ask, a link, and one clause about yourself.** Not a
  description of the thing, not its status, not why it needs them. **Evidence gets pasted when they
  ask for it, not before.**
- An instruction already given comes back as a half-clause reminder, never as a re-explanation.
{{#if dm_register}}
{{dm_register}}
{{/if}}

What survives from the post rules: the fact split (one short paragraph per thing being confused,
"this number means X, that one means Y") and a closing line that is the concrete ask, not a recap.

{{#if recurring_posts}}
## Recurring posts

{{recurring_posts}}

{{/if}}
## When it's about {{their}} setup or tooling

Write the *lesson*, not the architecture: what went wrong first, what the boring fix turned out to
be, what still doesn't work. Failures get equal billing with wins and are named plainly, with what
changed as a result. Process mechanics only where they carry the point. Tools get named in passing
when they did something concrete — never pitched.

{{#if voice_samples}}
## Samples

Messages {{display_name}} actually sent. Read them for voice; the rules above win where they disagree.

```
{{voice_samples}}
```

{{/if}}
## Never

- Send or draft to Slack. Output goes into the chat for {{them}} to paste, one code block per
  postable unit (thread opener, comment 1, …). Slack renders no markdown tables, so a table or a
  condition list must sit in its own fenced block.
- Quote or allude to DMs, private exchanges, or who said what, **in anything that goes to a
  channel**. What survives into a post is the work outcome only. Drafting a reply that lives inside
  that DM thread is a different job — *DM register*.
- Advertise the tooling, or write in a voice that sounds like it's selling an internal process.

## Checks before delivering

1. Read each paragraph aloud in one breath — if it stalls, it's a report.
2. Hunt the cuts above by name. Expect to find at least two.
3. Count emoji{{#if emoji_set}} (about as dense as the contract says){{else}} (zero){{/if}} and bullet glyphs (zero).
4. Every number: structural, or gone?
5. No ticket IDs, no headers, no DM content, no closing recap.
6. Is this a post or a reply in a thread? If it's a reply, re-check it against *DM register* —
   language, opener, and whether an admission about the writing is owed.
7. Draft archived to `drafts/` and the sent version asked for — step 8 below.

## Calibration loop — the draft is only half the artefact

The other half is the version {{display_name}} actually sent, and the gap between them is the only
evidence this skill has. Two ends, both cheap:

### Step 0 — reconcile what is pending (before drafting)

1. `ls ~/.claude/personal-data/write-like-{{name}}/drafts/`. Everything there is a draft whose sent
   version never came back; `sent/` holds reconciled pairs. Empty → skip to the *free signal* below.
2. Take pending drafts newest first, **at most three**, and only those **at least one day old** — a
   draft from today is either unsent or about to be pasted back. Delete anything older than seven
   days unreconciled: a message never sent teaches nothing.
{{#if slack_user_id}}
3. For each, **one** `slack_search_public_and_private` — `query: "from:<@{{slack_user_id}}>"`,
   `after: <the draft's unix ts>`, `channel_types` from its front matter,
   `response_format: "concise"`. One search, no pagination, no second keyword attempt. Not found →
   leave it pending and move on.
{{else}}
3. There is no search for the sent version: a pending draft is reconciled only when {{display_name}}
   pastes back what was sent. Leave it pending otherwise.
{{/if}}
4. Diff sent against draft, along these axes — wording noise is not a finding:
   - **cut** — which of the cuts above {{they}} had to make by hand, and any new one this file doesn't name
   - **added** — a fact, an aside, or an admission {{they}} wanted and the draft withheld
   - **register** — post rules applied to a DM (or the reverse), language switched
   - **voice** — sentence length, aside form, emoji count and which ones
   - **structure** — a list block where prose was wanted, paragraphs reordered, opener swapped
   An identical pair is a real result: log it as a confirmation.
5. Append one entry to `~/.claude/personal-data/write-like-{{name}}/calibration-log.md`, then `mv`
   the draft into `sent/` alongside the sent version. **Never overwrite the generated draft with the
   sent one** — two files, always.
6. **Promote at two — per register.** A pattern seen twice *in the same register* becomes a line in
   *The contract*, *What gets cut*, or *DM register*, with both dates recorded in the log entry.
   Once in a post and once in a DM is two separate observations, not a confirmation: the registers
   disagree on purpose. A single unambiguous correction — a whole category cut, the thing rewritten
   wholesale, or the rule stated outright — applies immediately; say so in the log.
7. Tell {{them}} in one line, in {{chat_language}}: `calibration: <rule>` or `calibration: no change`.
   Never ask for confirmation — sending {{their}} own version was the vote.

**Free signal — `write-daily`'s calibration log.** If a `write-daily` skill runs for {{them}}, its
diffs are against the same voice, so read `~/.claude/personal-data/write-daily/calibration-log.md`
during step 0 whenever nothing was pending here. Harvest only *voice-level* findings (which numbers
survive, emoji standing in for a punchline, mentions vs `*bold*`, paragraph length); leave the
daily-only shape rules there. Never write into `write-daily`'s files.

### Step 8 — archive, then ask once

After delivering the blocks:

1. Write the delivered text to `drafts/<YYYY-MM-DD>-<slug>.md` with front matter:
   ```
   ---
   drafted_at_ts: <unix ts of delivery>
   venue: "#channel-name" | DM
   register: post | dm
   channel_types: public_channel,private_channel | im,mpim
   topic: <three to six neutral words>
   ---
   ```
   For a DM, `venue` is the word `DM` and nothing else — the person's name has no business in this
   directory.
2. Ask **once**, in one line, whether {{they}} will paste back what was actually sent. If yes,
   reconcile immediately (step 0.4–0.7) and file the pair straight into `sent/`. If not, drop it —
   the draft stays pending and step 0 will look for it next time.
3. What goes in the log from a DM is the **voice delta only**: never the other person, never what
   they were confused about, never a quote longer than the phrasing tic being recorded.
