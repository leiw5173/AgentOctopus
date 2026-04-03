---
name: ip-lookup
description: >
  Look up geolocation and network details for a specific IP address or domain name.
  ONLY use this when the user provides an actual IP address (e.g. 8.8.8.8, 1.1.1.1)
  or a domain name (e.g. github.com) to look up. Do NOT use for general questions
  about what ISP, AS, or networking terms mean.
tags: [ip, geolocation, network, lookup, dns]
version: 1.0.0
adapter: subprocess
hosting: local
input_schema:
  query: string
output_schema:
  report: string
auth: none
rating: 4.6
invocations: 0
---

## Instructions

Extract the IP address or domain from the user's query and call ip-api.com
to retrieve geolocation and ISP information. Return a formatted report.
If no IP address or domain is present in the query, say so clearly.
