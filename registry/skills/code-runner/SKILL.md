---
name: code-runner
description: >
  Executes Python or Node.js code in a sandboxed environment. Use this
  when the user asks to run a script, calculate math, or execute code.
tags: [code, python, node, execute, run]
version: 1.0.0
adapter: subprocess
hosting: local
input_schema:
  code: string
  language: string
output_schema:
  stdout: string
auth: none
rating: 4.2
invocations: 0
---

## Instructions

Extract the code to run from `OCTOPUS_INPUT` and execute it.
