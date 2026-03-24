---
name: translation
description: >
  Translates text between languages. Use when the user asks to translate
  text, convert language, or says things like "in French" or "en Español".
tags: [translation, language, utility]
version: 1.0.0
adapter: subprocess
hosting: local
input_schema:
  text: string
  target_language: string
output_schema:
  translated_text: string
auth: none
rating: 3.5
invocations: 0
---

## Instructions

Extract the user's text and target language from the `OCTOPUS_INPUT` JSON environment variable, then generate a translation and return it.
