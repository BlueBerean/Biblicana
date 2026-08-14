# Biblicana v1.6.0 — top.gg announcement

Copy-paste ready. Line breaks fall between paragraphs, never mid-sentence.

---

## Short version (for the top.gg update box)

**Biblicana v1.6.0 is live.**

Three big additions: the **Septuagint** is now searchable in English, **admins can control who uses AI chat by role**, and long lists of verses come back as **one browsable card instead of a wall of text**.

Plus a batch of accuracy fixes, including one that had been quietly getting every Isaiah reference wrong.

---

## Full version

**Biblicana v1.6.0 — the Septuagint, role controls, and a much better way to read long verse lists.**

### The Septuagint, in English

Biblicana now carries **Brenton's English Septuagint (1851)** — 28,690 verses of the Greek Old Testament that the New Testament authors actually quoted from.

Use `/lxx` to see how the Septuagint renders any Old Testament passage, with your Hebrew-based translation shown right alongside it. Try `/lxx Isaiah 7:14` and see why Matthew quotes it the way he does.

You can also just ask. Mention Biblicana and say "how does the Septuagint render Isaiah 7:14" and it will pull the actual text rather than paraphrasing from memory.

The Septuagint numbers many chapters differently from the Hebrew — what your Bible calls Psalm 51:10 is Psalm 50:12 in the Greek. Biblicana handles that translation for you and always shows the Septuagint's own reference, so you can cite it accurately.

Septuagint-only books are included too: Sirach, Tobit, Wisdom, Baruch, Judith, 1–4 Maccabees, and Psalm 151. These sit outside the Protestant Old Testament and Biblicana says so when you look one up.

### Control who can use AI chat

Server admins can now decide who AI chat responds to, in `/config ai`.

**Required roles** — leave it empty and the AI responds to everyone, as before. Pick roles and it responds only to members holding one of them, which is useful for keeping AI chat to a study group or a supporter tier.

**Blocked roles** — hand out a "No AI" role and holders get no response. Blocked always overrules required, so the role stays authoritative without unpicking anyone's other roles.

Members with Manage Server bypass both, so you can't lock yourself out of your own bot. None of this touches slash commands — those are still governed by Discord's own permission controls.

### Passive detection got a lot more useful

Post a message with a dozen verse references and Biblicana used to show three and tell you to look up the rest yourself.

Now `/config passive` offers a **paginated layout**: one card with a "Jump to a reference" menu listing every verse in your message, with no three-verse cap.

By default the person who posted the references drives the card, and anyone else who taps a control gets their own private copy showing several verses at once — so two people reading at the same time never pull the view away from each other. Admins who prefer the old shared behaviour can switch it.

You can also now **limit passive detection to specific channels**, instead of it watching everywhere it can read.

### AI answers now show you the verses

When Biblicana cites a list of references in an AI chat answer, it now posts those verses underneath as a browsable card. Ask for verses about joy and you get the passages, not just the addresses.

### Accuracy fixes

**Isaiah was broken, and had been for a long time.** A parsing bug read "Isa" as Roman numeral one plus "Sa" — a real abbreviation for 1 Samuel — so Isaiah references silently became 1 Samuel, and the full spelling "Isaiah 53:3" resolved to nothing at all and was dropped. Every Isaiah citation in the bot was affected. Fixed and pinned by tests.

**Verse lists that share a book name now parse.** "Acts 3:15, 3:26, 4:33, 17:31" and "Acts 3:15, 26; 4:33" used to yield one reference. Now they yield all of them.

**AI answers no longer cut off mid-word.** Replies had a ceiling roughly 30% tighter than intended, and hitting it truncated the answer with no indication. The ceiling now matches what Discord actually allows, and a reply that still runs long ends on a complete sentence.

**Chapter references show the chapter.** Typing "John 1" gave you a card with no scripture in it. Now it gives you the chapter.

**Multi-verse passages have verse numbers.** A range used to run together as one paragraph.

---

## Notes for the post

- Anything user-facing that is **opt-in** is called out as such, so admins don't think behaviour changed under them.
- The Isaiah fix is stated plainly rather than buried. It was live for a long time, it affected one of the most-cited books in Scripture, and users who noticed odd results deserve to know it was real and is fixed.
- Deuterocanonical books are described neutrally — present in the Septuagint, not in the Protestant Old Testament — without arguing a position either way.
