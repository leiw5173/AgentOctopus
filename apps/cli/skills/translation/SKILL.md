---
name: translation
description: >
  Translates text between languages using MyMemory. Use when the user asks
  to translate text, convert language, or says things like "in French",
  "en Español", "translate to Japanese", etc.
tags: [translation, language, text, convert]
version: 2.0.0
adapter: subprocess
hosting: local
input_schema:
  query: string
output_schema:
  translated_text: string
auth: none
rating: 4.5
invocations: 0
---

## Instructions

Parse the user's query to extract the text to translate and the target language.
Call the MyMemory free translation API and return the translated text.
