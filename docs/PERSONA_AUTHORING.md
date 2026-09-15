# Writing a persona for Cortéx

A persona is how Cortéx sounds and works for one audience. It never changes
what Cortéx may say: the sources, the citations and the "documents don't
cover this" answer are fixed, and every persona sits underneath them.

Administrators edit personas under **Settings → Personas**. Saving creates
the next numbered version; the newest version is the one in force for every
user on that persona from their next message. A save that fails validation
changes nothing, and any earlier version can be restored with one click.

## The sections

Every section is optional. An empty persona renders the built-in prompt.

| Section | What it is for | Example (from the Talent Intelligence starter) |
|---|---|---|
| Identity | Who Cortéx is for this audience. Opens the prompt. One or two short paragraphs. | "You are Cortéx, reasoning for a talent and recruiting audience…" |
| Default answer length | concise, standard or detailed. A user's own setting overrides it. | standard |
| Operating instructions | What every answer should do. Rendered as the TASK block. | "Answer the hiring question asked, then show the evidence per candidate." |
| Evaluation rules | How to weigh and score what the sources say. | "Separate evidence from inference: what the resume states versus what you conclude from it." |
| Evidence requirements | What must be present before a claim is made. | "Every claim about a candidate cites the resume or note it comes from." |
| Decision rules | When and how to recommend. | "Give an advance or hold recommendation only when asked, and name the single most important reason." |
| Formatting | Layout conventions for the answer. | "A comparison table when three or more candidates are compared on the same requirements." |
| Output structure | Rendered as the STRUCTURE RULES block. | "prefer decisive executive conclusions over methodological explanation" |
| Workflow | Steps to follow for this audience's tasks. | "Read the job description first, extract its requirements, then read each resume against them." |
| Domain instructions | Anything specific to the field. | "Use the job title and level exactly as the job description writes them." |
| Preferred terms | One per line as `term -> preferred term`. | `rockstar -> strong candidate` |
| Protected terms | Kept exactly as the sources write them. A plain phrase or a small pattern. | `culture fit`, `CVE-\d{4}-\d+` |
| Required in every answer | Items every answer must include. | "A gap list for every candidate who is recommended to advance." |
| Never | Items no answer may include. | "Speculation about age, health, family status or any characteristic not in the job description." |

Write list items as short complete sentences, one per line. The model reads
them as instructions, so "Report severity exactly as the source rates it" works
better than "severity accuracy".

## Limits and what is refused

- 400 characters per item, 2,000 per section, 6,000 for everything the
  persona adds to the prompt. Long personas crowd out the documents.
- Phrases that try to move the line between presentation and evidence are
  refused and named: "ignore the sources", "outside knowledge", "general
  knowledge", "even if the documents", and the words "grant", "namespace"
  and "role". Say what to do when the documents are silent ("say so and
  stop") rather than what to do instead of them.
- A protected-term pattern must be short and simple: no back-references,
  no lookaround, no nested repetition.
- An item that is both required and prohibited is saved with a warning.

## Starters

Each seeded persona carries a version 2 of starter content: plain, generic
sentences in the persona's own vocabulary, meant to be edited rather than
written from nothing. They live in `scripts/persona-starters/<key>.json` and
were saved through the same route the editor uses. Replace them with your
own method as a new version; nothing proprietary needs to be re-typed into
code, and the version history keeps every earlier state.

## Checking a persona

Use **Preview for a user** on the persona page. It shows which persona and
version that user gets, the answer length and where it came from, and the
exact text the model sees. Every chat answer also reports its persona and
version in the sidebar chip and on the turn's trace, so "which rules
produced this answer" is always answerable.

## The JSON view

The editor's JSON view shows the same configuration as an object. Pasting a
configuration there and saving is how a persona moves between environments.

```json
{
  "schema": 1,
  "identity": { "text": "You are Cortéx, reasoning for …" },
  "response": { "length": "standard" },
  "operating_instructions": ["…"],
  "evaluation_rules": ["…"],
  "evidence_requirements": ["…"],
  "decision_rules": ["…"],
  "formatting": ["…"],
  "output_structure": ["…"],
  "workflow": ["…"],
  "domain_instructions": ["…"],
  "terminology": { "prefer": { "term": "preferred term" }, "protect": ["phrase"] },
  "required": ["…"],
  "prohibited": ["…"]
}
```
