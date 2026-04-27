---
name: install-heavy
description: A skill with many install specs
version: "3.0.0"
requires:
  bins: [docker]
  anyBins: [node, python3]
  env: [DOCKER_HOST]
install:
  - kind: brew
    formula: docker
  - kind: node
    package: heavy-cli
  - kind: download
    url: https://example.com/tool.tar.gz
    archive: tar.gz
    extract: true
    stripComponents: 1
---

# Install Heavy Skill

Multi-tool skill.
