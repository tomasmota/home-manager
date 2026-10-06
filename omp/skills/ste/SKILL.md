---
name: ste
description: >
  Write replies in ASD-STE100 Simplified Technical English. Use when the user
  says "STE", "ASD-STE100", "Simplified Technical English", or asks for
  answers in simple controlled English.
metadata:
  verified: '2026-10-06'
  source: ASD-STE100 writing rules (approximation; the official dictionary is not bundled)
---

# ASD-STE100 replies

## Scope
- Apply to every reply prose from this point until the user tells you to stop.
- Do not change code, commands, paths, identifiers, log output or quotations.
- Technical names (product names, `kubectl`, "pod", "merge request") are permitted. Use the same name for the same thing every time.
- Keep the normal reply structure. STE changes the language, not the content.

## Words
- Use one word for one meaning. Do not use synonyms for variety.
- Use simple, common verbs: "do", not "perform"; "use", not "utilize"; "start", not "initiate"; "stop", not "terminate"; "make sure", not "ensure"; "show", not "indicate"; "get", not "obtain"; "help", not "facilitate"; "about", not "approximately".
- Do not use phrasal verbs: "install", not "set up"; "find", not "look up"; "remove", not "get rid of".
- Use only these verb forms: infinitive, imperative, simple present, simple past, simple future, and the past participle as an adjective or in the passive. Do not use "-ing" forms as verbs. Do not use "should", "could", "would" or "might" when a clear statement is possible.
- Do not use contractions, idioms, slang or jokes.
- Do not make clusters of more than three nouns. Break them up with "of", "for" or "in".
- Keep the articles ("the", "a") and "this", "these". Do not write in telegraphic style.

## Sentences
- Procedural sentences (instructions): 20 words or fewer.
- Descriptive sentences (explanations): 25 words or fewer.
- Give one instruction in each sentence. Two actions are permitted in one sentence only if the reader must do them at the same time.
- Write instructions in the imperative: "Run the build.", not "The build should be run."
- Put a condition before the instruction: "If the test fails, read the log."
- Use the active voice. Use the passive voice only in descriptions, and only when the doer is unknown or not important.
- Write the most important information first.

## Paragraphs and lists
- Keep one topic in each paragraph. Use 6 sentences or fewer in each paragraph.
- Use vertical lists for steps and for groups of items. Number the steps.
- Start a warning or caution with a short, clear command. Then give the reason: "Do not run `tofu apply` on prod. This command changes live resources."

## Check before you send
- Count the words in long sentences. Split sentences that are too long.
- Replace "-ing" verbs, phrasal verbs and modal verbs.
- Make sure each term has one meaning in the full reply.
