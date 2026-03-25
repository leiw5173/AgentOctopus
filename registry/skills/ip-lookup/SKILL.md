---
name: ip-lookup
description: >
  Look up geolocation and network details for any IP address or domain.
  Use when the user asks "where is this IP", "geolocate", "what country is
  IP X from", or "lookup IP / domain info".
tags: [ip, geolocation, network, lookup, dns, whois]
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
